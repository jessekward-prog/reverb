import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, createHash } from 'crypto';
import pg from 'pg';
import {
  TEXTS_TOOL, CALENDAR_TOOL, EMAIL_TOOL, BUSINESS_EMAIL_TOOL, NOTIFICATIONS_TOOL, SWITCHCRAFT_JOBS_TOOL,
  getRecentTexts, getUpcomingEvents, getRecentEmails, getRecentBusinessEmails, getRecentNotifications, getSwitchcraftJobs,
} from './src/lib/tools.js';

const { Pool } = pg;

const PORT         = process.env.PORT || 3000;
const LM_URL       = process.env.LM_STUDIO_BASE_URL || 'http://localhost:1235';
const LM_HEADERS   = { 'Content-Type': 'application/json', ...(process.env.LM_STUDIO_API_KEY ? { Authorization: `Bearer ${process.env.LM_STUDIO_API_KEY}` } : {}) };
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-in-prod';
const DIST         = join(fileURLToPath(import.meta.url), '..', 'dist');
// Sweep/Work only — a plain instruct model, deliberately NOT gemma-4-e4b
// (ChatView's client-side preference). gemma-4-e4b writes ~900 tokens of
// hidden chain-of-thought before answering, which alone blew past the
// Cloudflare tunnel's ~125s edge timeout on these background scan endpoints.
// qwen2.5-7b-instruct does the same classification/summary task correctly
// in ~7s with zero reasoning overhead.
const PREFER_MODEL  = 'qwen2.5-7b-instruct';

// ── Postgres ──────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT 'New chat',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS swept_done (
      task_id    TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS work_summary (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      summary    TEXT NOT NULL,
      categories JSONB NOT NULL,
      scanned_at TIMESTAMPTZ NOT NULL,
      CHECK (id = 1)
    );
  `);
}

// Global lockout, not per-IP — single-user app, single PIN, no accounts.
// 5 wrong hashes in a row locks /api/pin/verify for 5 minutes, closing the
// brute-force window a 4-digit space would otherwise leave wide open.
const pinLockout = { fails: 0, until: 0 };

// ── Auth tokens ───────────────────────────────────────────
function djb2(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function signToken(role) {
  const payload = JSON.stringify({ role, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const sig = createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

function verifyToken(token) {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const { role, exp } = JSON.parse(payload);
    if (Date.now() > exp) return null;
    return role;
  } catch { return null; }
}

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function requireAuth(req) {
  return verifyToken(getToken(req));
}

// ── Static file server ────────────────────────────────────
const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'application/javascript',
  '.css':         'text/css',
  '.svg':         'image/svg+xml',
  '.ico':         'image/x-icon',
  '.png':         'image/png',
  '.woff2':       'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

async function serveStatic(req, res) {
  let filePath = join(DIST, req.url === '/' ? 'index.html' : req.url);
  try { await stat(filePath); } catch { filePath = join(DIST, 'index.html'); }

  const isIndex  = filePath.endsWith('index.html');
  const isSW     = req.url === '/sw.js' || req.url.startsWith('/workbox-');
  const isHashed = req.url.startsWith('/assets/');
  const cache = (isIndex || isSW) ? 'no-cache, must-revalidate'
              : isHashed           ? 'public, max-age=31536000, immutable'
              :                      'no-cache';

  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  } catch { res.writeHead(500); res.end('error'); }
}

// ── PIN endpoints ─────────────────────────────────────────
// Single-user app — only the owner PIN exists, no guest role. Everything
// this PIN unlocks (texts, email, calendar) is sensitive enough that a
// shared/guest fallback like ai-cmd's isn't appropriate here.
async function handlePin(req, res) {
  const url = req.url;

  if (req.method === 'GET') {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key='owner_pin_hash'");
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ set: rows.length > 0 }));
    return;
  }

  const body = JSON.parse(await readBody(req));

  if (url === '/api/pin/set') {
    const { hash } = body;
    if (!hash) { res.writeHead(400); res.end('{}'); return; }
    await pool.query(
      "INSERT INTO settings (key,value) VALUES ('owner_pin_hash',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
      [hash]
    );
    const token = signToken('owner');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token, role: 'owner' }));
    return;
  }

  if (url === '/api/pin/verify') {
    if (Date.now() < pinLockout.until) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, locked: true })); return; }
    const { hash } = body;
    const { rows } = await pool.query("SELECT value FROM settings WHERE key='owner_pin_hash'");
    if (rows.length && rows[0].value === hash) {
      pinLockout.fails = 0;
      const token = signToken('owner');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token, role: 'owner' }));
      return;
    }
    pinLockout.fails++;
    if (pinLockout.fails >= 5) pinLockout.until = Date.now() + 5 * 60 * 1000;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  }
}

// ── Conversations ─────────────────────────────────────────
async function handleConversations(req, res) {
  const role = requireAuth(req);
  if (!role) { res.writeHead(401); res.end('{}'); return; }

  if (req.method === 'GET') {
    const { rows } = await pool.query(
      'SELECT id, title, created_at FROM conversations ORDER BY updated_at DESC'
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  if (req.method === 'POST') {
    const { rows } = await pool.query(
      "INSERT INTO conversations DEFAULT VALUES RETURNING id, title, created_at"
    );
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows[0]));
  }
}

async function handleConversationById(req, res, id) {
  const role = requireAuth(req);
  if (!role) { res.writeHead(401); res.end('{}'); return; }

  if (req.method === 'DELETE') {
    await pool.query('DELETE FROM conversations WHERE id=$1', [id]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  }
}

async function handleConversationMessages(req, res, id) {
  const role = requireAuth(req);
  if (!role) { res.writeHead(401); res.end('{}'); return; }

  if (req.method === 'GET') {
    const { rows } = await pool.query(
      'SELECT role, content, created_at FROM chat_messages WHERE conversation_id=$1 ORDER BY created_at ASC',
      [id]
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  if (req.method === 'POST') {
    const { role: msgRole, content, model } = JSON.parse(await readBody(req));
    await pool.query(
      'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,$2,$3)',
      [id, msgRole, content]
    );
    await pool.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1', [id]);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    // Fire-and-forget auto-title after the first assistant message
    if (msgRole === 'assistant' && model) autoTitle(id, model).catch(() => {});
  }
}

async function generateTitle(model, userText, aiText) {
  try {
    const r = await fetch(`${LM_URL}/v1/chat/completions`, {
      method:  'POST',
      headers: LM_HEADERS,
      body: JSON.stringify({
        model,
        messages: [{
          role:    'user',
          content: `Summarize this exchange as a short 3-6 word title. Reply with only the title — no quotes, no punctuation at the end.\n\nUser: ${userText.slice(0, 400)}\nAssistant: ${aiText.slice(0, 400)}`,
        }],
        stream:     false,
        max_tokens: 20,
      }),
    });
    const data = await r.json();
    return data.choices?.[0]?.message?.content?.trim().replace(/^["'.]+|["'.]+$/g, '').slice(0, 60) || null;
  } catch { return null; }
}

async function autoTitle(conversationId, model) {
  const { rows: c } = await pool.query('SELECT title FROM conversations WHERE id=$1', [conversationId]);
  if (!c.length || c[0].title !== 'New chat') return;

  const { rows: msgs } = await pool.query(
    'SELECT role, content FROM chat_messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 2',
    [conversationId]
  );
  if (msgs.length < 2) return;

  const title = await generateTitle(model, msgs[0].content, msgs[1].content);
  if (title) await pool.query('UPDATE conversations SET title=$1 WHERE id=$2', [title, conversationId]);
}

// ── LM Studio proxy ───────────────────────────────────────
async function proxyModels(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  try {
    const upstream = await fetch(`${LM_URL}/v1/models`, { headers: LM_HEADERS });
    const data = await upstream.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const TOOLS = [TEXTS_TOOL, CALENDAR_TOOL, EMAIL_TOOL, BUSINESS_EMAIL_TOOL, NOTIFICATIONS_TOOL, SWITCHCRAFT_JOBS_TOOL];

async function proxyChat(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const body = JSON.parse(await readBody(req));

  let firstData;
  try {
    const abort = AbortSignal.timeout(120_000);
    const r = await fetch(`${LM_URL}/v1/chat/completions`, {
      signal: abort,
      method: 'POST',
      headers: LM_HEADERS,
      body: JSON.stringify({ model: body.model, messages: body.messages, tools: TOOLS, tool_choice: 'auto', stream: false }),
    });
    firstData = await r.json();
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'status', message: 'LM Studio did not respond — is it loaded?' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const choice     = firstData.choices?.[0];
  const needsTools = choice?.finish_reason === 'tool_calls' && choice?.message?.tool_calls?.length;

  if (needsTools) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const toolMessages = [choice.message];
    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      if (tc.function.name === 'get_recent_texts') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking texts…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await getRecentTexts(args) });
      } else if (tc.function.name === 'get_upcoming_events') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking calendar…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await getUpcomingEvents(args) });
      } else if (tc.function.name === 'get_recent_emails') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking email…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await getRecentEmails(args) });
      } else if (tc.function.name === 'get_recent_business_emails') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking business email…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await getRecentBusinessEmails(args) });
      } else if (tc.function.name === 'get_recent_notifications') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking WhatsApp/Messenger/Instagram…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await getRecentNotifications(args) });
      } else if (tc.function.name === 'get_switchcraft_jobs') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking Switch Craft jobs…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await getSwitchcraftJobs() });
      }
    }
    const final = await fetch(`${LM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: LM_HEADERS,
      body: JSON.stringify({ model: body.model, messages: [...body.messages, ...toolMessages], stream: true }),
    });
    const reader = final.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } else {
    const content = choice?.message?.content || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    // Send in small chunks so a long response never becomes one giant SSE event
    // that may split across TCP segments and confuse the client's line parser.
    for (let i = 0; i < content.length; i += 6) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 6) } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// ── Sweep / Work shared source-gathering ───────────────────
// Stable id derived from source content (not model output) so the same
// underlying message/event maps to the same id across sweeps even though
// the model regenerates the surrounding task list text each time.
function taskId(t) {
  return createHash('sha1').update(`${t.kind}|${t.from}|${t.snippet}`).digest('hex').slice(0, 12);
}

// Work's categories are dynamic/LLM-chosen, so the id can't depend on a
// stable "kind" the way Sweep's does — hash on source content only.
function workItemId(t) {
  return createHash('sha1').update(`${t.from}|${t.snippet}`).digest('hex').slice(0, 12);
}

const countLines = s => (s || '').split('\n').filter(Boolean).length;

async function gatherSources(perSource = 20, jobsCap = 20) {
  const [texts, events, emails, bizEmails, whatsapp, messenger, instagram, jobsRaw] = await Promise.all([
    getRecentTexts({ limit: perSource }),
    getUpcomingEvents({ days_ahead: 7 }),
    getRecentEmails({ limit: Math.round(perSource * 0.75) }),
    getRecentBusinessEmails({ limit: Math.round(perSource * 0.75) }),
    getRecentNotifications({ source: 'whatsapp', limit: Math.round(perSource * 0.75) }),
    getRecentNotifications({ source: 'messenger', limit: Math.round(perSource * 0.75) }),
    getRecentNotifications({ source: 'instagram', limit: Math.round(perSource * 0.75) }),
    getSwitchcraftJobs(),
  ]);
  // getSwitchcraftJobs has no limit param (its endpoint caps at 50 server-side);
  // trim here too since job descriptions can be long free text and this is the
  // single biggest contributor to prompt size once there's real backlog.
  const jobs = jobsRaw.split('\n').slice(0, jobsCap).join('\n');
  return { texts, events, emails, bizEmails, whatsapp, messenger, instagram, jobs };
}

function sourcesBlock({ texts, events, emails, bizEmails, whatsapp, messenger, instagram, jobs }) {
  return `TEXTS:
${texts}

CALENDAR:
${events}

EMAIL:
${emails}

BUSINESS EMAIL:
${bizEmails}

WHATSAPP:
${whatsapp}

MESSENGER:
${messenger}

INSTAGRAM:
${instagram}

SWITCH CRAFT JOBS:
${jobs}`;
}

async function pickModel() {
  const modelsRes = await fetch(`${LM_URL}/v1/models`, { headers: LM_HEADERS });
  const models = await modelsRes.json();
  const ids = (models.data || []).map(m => m.id);
  return ids.find(id => id.toLowerCase().includes(PREFER_MODEL)) || ids[0];
}

async function askModel(prompt) {
  const model = await pickModel();
  const cr = await fetch(`${LM_URL}/v1/chat/completions`, {
    // Cloudflare's tunnel edge timeout sits around 125s (observed via 524s);
    // give generation up to just under that rather than aborting early.
    signal: AbortSignal.timeout(115_000),
    method: 'POST',
    headers: LM_HEADERS,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2, max_tokens: 1400 }),
  });
  const data = await cr.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseJsonFence(raw, fallback) {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/```\s*$/, '');
    return JSON.parse(cleaned);
  } catch { return fallback; }
}

async function handleSweep(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }

  const sources = await gatherSources();
  const { texts, events, emails, bizEmails, whatsapp, messenger, instagram, jobs } = sources;

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Read the raw data below from several sources (texts, calendar, personal email, business email, WhatsApp, Messenger, Instagram, Switch Craft jobs) and produce a JSON array of action items — things the user owes a reply on, needs to act on, or should know about. Ignore routine or no-action items (read receipts, newsletters, confirmations needing no response).

Respond with ONLY a JSON array, no prose, no markdown fences. Each item:
{"kind":"sms"|"email"|"cal"|"bizemail"|"whatsapp"|"messenger"|"instagram"|"job","from":"string","when":"short string like '2d' or 'tomorrow 09:00'","bucket":0|1|2,"text":"imperative one-line action","snippet":"verbatim quote from the source, never paraphrase","reply":true|false}
bucket: 0 = needs a reply, 1 = this week, 2 = no specific date.
reply: true only if the action is answering someone directly.
If nothing needs action, respond with [].

${sourcesBlock(sources)}`;

  let raw;
  try {
    raw = await askModel(prompt);
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scanned: 0, counts: {}, tasks: [], error: 'LM Studio unreachable' }));
    return;
  }

  const parsedRaw = parseJsonFence(raw, []);
  const parsed = Array.isArray(parsedRaw) ? parsedRaw : [];

  const { rows: doneRows } = await pool.query('SELECT task_id FROM swept_done');
  const doneSet = new Set(doneRows.map(r => r.task_id));

  const tasks = parsed
    .filter(t => t && t.kind && t.text && t.snippet)
    .map(t => ({ ...t, id: taskId(t) }))
    .filter(t => !doneSet.has(t.id));

  const countEmailBlock = s => (s.includes('No matching') ? 0 : s.split('\n\n').filter(Boolean).length);
  const countBy = k => tasks.filter(t => t.kind === k).length;
  const emailCount = countEmailBlock(emails);
  const bizEmailCount = countEmailBlock(bizEmails);
  const counts = {
    sms:       `${countLines(texts)} msgs · ${countBy('sms')}`,
    email:     `${emailCount} msgs · ${countBy('email')}`,
    cal:       `${countLines(events)} events · ${countBy('cal')}`,
    call:      'not connected',
    bizemail:  `${bizEmailCount} msgs · ${countBy('bizemail')}`,
    whatsapp:  `${countLines(whatsapp)} msgs · ${countBy('whatsapp')}`,
    messenger: `${countLines(messenger)} msgs · ${countBy('messenger')}`,
    instagram: `${countLines(instagram)} msgs · ${countBy('instagram')}`,
    job:       `${countLines(jobs)} jobs · ${countBy('job')}`,
  };
  const scanned = countLines(texts) + countLines(events) + emailCount + bizEmailCount
    + countLines(whatsapp) + countLines(messenger) + countLines(instagram) + countLines(jobs);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ scanned, counts, tasks }));
}

// Shared by Sweep and Work — both dismiss items into the same swept_done
// table, keyed by their own content hash (taskId vs workItemId).
async function handleTaskDone(req, res, id) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { done } = JSON.parse(await readBody(req));
  if (done) {
    await pool.query('INSERT INTO swept_done (task_id) VALUES ($1) ON CONFLICT (task_id) DO NOTHING', [id]);
  } else {
    await pool.query('DELETE FROM swept_done WHERE task_id=$1', [id]);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// ── Work ──────────────────────────────────────────────────
// Same 9 sources as Sweep, but asks the model for a narrative summary plus
// dynamic categories ("people to message back", "bills to pay", ...) instead
// of Sweep's fixed per-source kind grouping. Persisted so the page loads
// instantly; POST /api/work/scan is the only path that re-runs the model.
async function buildWorkResponse(summary, categories, scannedAt) {
  const { rows: doneRows } = await pool.query('SELECT task_id FROM swept_done');
  const doneSet = new Set(doneRows.map(r => r.task_id));
  const filtered = categories
    .map(c => ({
      label: c.label,
      items: c.items.map(t => ({ ...t, id: workItemId(t) })).filter(t => !doneSet.has(t.id)),
    }))
    .filter(c => c.items.length);
  return { summary, categories: filtered, scannedAt };
}

async function handleWork(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { rows } = await pool.query('SELECT summary, categories, scanned_at FROM work_summary WHERE id=1');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (!rows.length) { res.end(JSON.stringify({ summary: '', categories: [], scannedAt: null })); return; }
  const { summary, categories, scanned_at } = rows[0];
  res.end(JSON.stringify(await buildWorkResponse(summary, categories, scanned_at)));
}

async function handleWorkScan(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }

  // Smaller than Sweep's — Work is a digest, not exhaustive per-item triage,
  // and the summarize+categorize task already runs slower than Sweep's flat
  // classification per token, so a lighter input matters more here.
  const sources = await gatherSources(10, 10);
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Read the raw data below from several sources (texts, calendar, personal email, business email, WhatsApp, Messenger, Instagram, Switch Craft jobs).

Write a 2-sentence summary of how the day/week is shaping up, then group the most important actionable items into at most 5 categories that make sense for what's actually here (e.g. "people to message back", "bills to pay", "jobs to schedule") — don't invent empty categories. Cap each category at 5 items — pick the most important/urgent ones if there are more. Keep "text" and "snippet" each under 100 characters.

Respond with ONLY a JSON object, no prose outside it, no markdown fences:
{"summary":"2-sentence overview","categories":[{"label":"short category name","items":[{"from":"string","when":"short string like '2d' or 'tomorrow 09:00'","text":"imperative one-line action, under 100 chars","snippet":"verbatim quote from the source, under 100 chars, never paraphrase","reply":true|false}]}]}
If nothing needs action, categories should be [] and the summary should say things look clear.

${sourcesBlock(sources)}`;

  let raw;
  try {
    raw = await askModel(prompt);
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ summary: '', categories: [], error: 'LM Studio unreachable' }));
    return;
  }

  const parsed = parseJsonFence(raw, {});
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const categories = (Array.isArray(parsed.categories) ? parsed.categories : [])
    .filter(c => c && typeof c.label === 'string' && Array.isArray(c.items))
    .map(c => ({ label: c.label, items: c.items.filter(t => t && t.text && t.snippet && t.from) }))
    .filter(c => c.items.length);

  await pool.query(
    `INSERT INTO work_summary (id, summary, categories, scanned_at) VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET summary=$1, categories=$2, scanned_at=NOW()`,
    [summary, JSON.stringify(categories)]
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(await buildWorkResponse(summary, categories, new Date().toISOString())));
}

// ── Texts ─────────────────────────────────────────────────
// Real SMS via MacroDroid -> notify-cmd (source=sms), grouped into threads
// by phone number. No LLM involved — a straight read-and-group, so it's
// always fast regardless of what's happening with the LM Studio backend.
async function handleTexts(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const since = new Date(Date.now() - 5 * 86400000).toISOString();
  const params = new URLSearchParams({ source: 'sms', limit: '500', since });
  let msgs = [];
  try {
    const r = await fetch(`${process.env.NOTIFY_CMD_BASE_URL}/api/notifications/recent?${params}`, {
      headers: { 'X-Service-Token': process.env.NOTIFY_CMD_SERVICE_TOKEN },
    });
    if (r.ok) msgs = await r.json();
  } catch { /* threads stays empty, frontend shows the empty state */ }

  const byPhone = new Map();
  for (const m of msgs) {
    if (!byPhone.has(m.sender)) byPhone.set(m.sender, []);
    byPhone.get(m.sender).push({ id: m.id, body: m.body, occurred_at: m.occurred_at });
  }
  const threads = [...byPhone.entries()]
    .map(([phone, messages]) => ({ phone, messages, lastAt: messages[messages.length - 1].occurred_at }))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ threads }));
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return HTML_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

// Scrapes OG tags for a link-preview card under a chat message. Ported from
// bit-prompt's /api/link-preview (same regex approach, no new dependency).
async function handleLinkPreview(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { searchParams } = new URL(req.url, 'http://internal');
  const url = searchParams.get('url');
  if (!url) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'url required' })); return; }
  let parsed;
  try { parsed = new URL(url); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid url' })); return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid url' })); return; }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkPreviewBot/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) { res.end(JSON.stringify({ domain: parsed.hostname, url })); return; }
    const reader = upstream.body.getReader();
    let html = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      if (html.length > 100000) break;
    }
    const meta = (patterns) => { for (const p of patterns) { const m = html.match(p); if (m?.[1]) return decodeEntities(m[1].trim()); } return ''; };
    const title       = meta([/property="og:title"\s+content="([^"]+)"/i, /content="([^"]+)"\s+property="og:title"/i, /<title[^>]*>([^<]+)<\/title>/i]);
    const description = meta([/property="og:description"\s+content="([^"]+)"/i, /content="([^"]+)"\s+property="og:description"/i, /name="description"\s+content="([^"]+)"/i]);
    let image         = meta([/property="og:image"\s+content="([^"]+)"/i, /content="([^"]+)"\s+property="og:image"/i]);
    if (image && !image.startsWith('http')) { try { image = new URL(image, url).href; } catch { image = ''; } }
    res.end(JSON.stringify({ title: title.slice(0, 200), description: description.slice(0, 300), image, domain: parsed.hostname, url }));
  } catch {
    res.end(JSON.stringify({ domain: parsed.hostname, url }));
  }
}

// ── Router ────────────────────────────────────────────────
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  try {
    const u = req.url.split('?')[0];
    if (u === '/api/pin' || u === '/api/pin/set' || u === '/api/pin/verify') return await handlePin(req, res);
    if (u === '/api/conversations') return await handleConversations(req, res);
    const msgsMatch = u.match(/^\/api\/conversations\/(\d+)\/messages$/);
    if (msgsMatch) return await handleConversationMessages(req, res, msgsMatch[1]);
    const convMatch = u.match(/^\/api\/conversations\/(\d+)$/);
    if (convMatch) return await handleConversationById(req, res, convMatch[1]);
    if (req.method === 'GET'  && u === '/api/models') return await proxyModels(req, res);
    if (req.method === 'POST' && u === '/api/chat')   return await proxyChat(req, res);
    if (req.method === 'GET'  && u === '/api/link-preview') return await handleLinkPreview(req, res);
    if (req.method === 'POST' && u === '/api/sweep')  return await handleSweep(req, res);
    const sweepDoneMatch = u.match(/^\/api\/sweep\/([a-f0-9]+)\/done$/);
    if (sweepDoneMatch) return await handleTaskDone(req, res, sweepDoneMatch[1]);
    if (req.method === 'GET'  && u === '/api/work')      return await handleWork(req, res);
    if (req.method === 'POST' && u === '/api/work/scan') return await handleWorkScan(req, res);
    const workDoneMatch = u.match(/^\/api\/work\/([a-f0-9]+)\/done$/);
    if (workDoneMatch) return await handleTaskDone(req, res, workDoneMatch[1]);
    if (req.method === 'GET' && u === '/api/texts') return await handleTexts(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end('internal error'); }
  }
}).listen(PORT, async () => {
  await initDb();
  console.log(`reverb on :${PORT}`);
});
