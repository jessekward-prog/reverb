import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, createHash } from 'crypto';
import pg from 'pg';
import {
  TEXTS_TOOL, SEARCH_TEXTS_TOOL, searchTexts, CALENDAR_TOOL, EMAIL_TOOL, BUSINESS_EMAIL_TOOL, NOTIFICATIONS_TOOL, SWITCHCRAFT_JOBS_TOOL,
  WAITING_TOOL, getWaitingReplies, UNBOOKED_JOBS_TOOL, getUnbookedJobs,
  getRecentTexts, getRecentTextsBrief, getUpcomingEvents, getRecentEmails, getRecentBusinessEmails, getRecentNotifications, getSwitchcraftJobs,
} from './src/lib/tools.js';
import { normalizeIdentifier, upsertContact, deriveTier, signalContact, hasMoneyFlag, matchRules } from './src/lib/contacts.js';

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
    -- Memory of what has already been surfaced. first_seen_at is the point: it
    -- survives every regeneration (ON CONFLICT keeps it), so an item that keeps
    -- reappearing and never gets done can be aged and chased. swept_done still
    -- removes the ones you have actioned; this only tracks the ones you haven't.
    CREATE TABLE IF NOT EXISTS surfaced_items (
      task_id       TEXT PRIMARY KEY,
      bucket        TEXT NOT NULL,
      kind          TEXT,
      from_label    TEXT,
      snippet       TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS work_summary (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      summary    TEXT NOT NULL,
      categories JSONB NOT NULL,
      scanned_at TIMESTAMPTZ NOT NULL,
      CHECK (id = 1)
    );
    CREATE TABLE IF NOT EXISTS life_summary (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      summary    TEXT NOT NULL,
      categories JSONB NOT NULL,
      scanned_at TIMESTAMPTZ NOT NULL,
      CHECK (id = 1)
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id               SERIAL PRIMARY KEY,
      kind             TEXT NOT NULL,
      identifier       TEXT NOT NULL,
      display_name     TEXT,
      tier             TEXT,
      seen_count       INTEGER NOT NULL DEFAULT 0,
      replied_count    INTEGER NOT NULL DEFAULT 0,
      dismissed_count  INTEGER NOT NULL DEFAULT 0,
      last_seen_at     TIMESTAMPTZ,
      UNIQUE (kind, identifier)
    );
    CREATE TABLE IF NOT EXISTS rules (
      id         SERIAL PRIMARY KEY,
      pattern    TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('priority','ignore')),
      created_at TIMESTAMPTZ DEFAULT NOW()
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

const TOOLS = [WAITING_TOOL, UNBOOKED_JOBS_TOOL, TEXTS_TOOL, SEARCH_TEXTS_TOOL, CALENDAR_TOOL, EMAIL_TOOL, BUSINESS_EMAIL_TOOL, NOTIFICATIONS_TOOL, SWITCHCRAFT_JOBS_TOOL];

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
      if (tc.function.name === 'get_waiting_replies') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking who is waiting…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await getWaitingReplies(args)).text });
      } else if (tc.function.name === 'get_unbooked_jobs') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Cross-checking messages against the calendar…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await getUnbookedJobs(args)).text });
      } else if (tc.function.name === 'get_recent_texts') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking texts…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await getRecentTexts(args)).text });
      } else if (tc.function.name === 'search_texts') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: `Searching texts for “${args.query || ''}”…` })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await searchTexts(args)).text });
      } else if (tc.function.name === 'get_upcoming_events') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking calendar…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await getUpcomingEvents(args) });
      } else if (tc.function.name === 'get_recent_emails') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking email…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await getRecentEmails(args)).text });
      } else if (tc.function.name === 'get_recent_business_emails') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking business email…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await getRecentBusinessEmails(args)).text });
      } else if (tc.function.name === 'get_recent_notifications') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking WhatsApp/Messenger/Instagram…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await getRecentNotifications(args)).text });
      } else if (tc.function.name === 'get_switchcraft_jobs') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking Switch Craft jobs…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await getSwitchcraftJobs()).text });
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

// ── Pull / Report shared source-gathering ───────────────────
// Categories are dynamic/LLM-chosen (both Work's and Life's), so an item's
// id can't depend on a stable "kind" — hash on source content only.
function workItemId(t) {
  return createHash('sha1').update(`${t.from}|${t.snippet}`).digest('hex').slice(0, 12);
}

// Sweep's "Pull Data" caches one raw gather here; "Generate Report" reads it
// to produce both the Work and Life reports from the same pull rather than
// re-fetching every source twice. Single-user app, no request concurrency to
// worry about — a module-level variable is enough, no need for a DB table
// that would only ever hold one transient row.
let pullCache = null;

const countLines = s => (s || '').split('\n').filter(Boolean).length;

// ── Contact memory ───────────────────────────────────────
// Every scan upserts each source's senders into `contacts` (seen_count/
// last_seen_at), then tags each line with what's known: {vip} (manually
// pinned or earned via replies/frequency), {attachment}, {money} (invoice/
// payment keywords). Muted contacts are dropped before the model ever sees
// them. The model still writes the task list, but importance ranking is
// deterministic afterward — see importanceScore below — so a real VIP
// doesn't depend on the model noticing on its own.
const indexKey = (kind, snippet) => `${kind}|${(snippet || '').trim().slice(0, 80).toLowerCase()}`;

const tagSuffix = i => {
  const tags = [];
  if (i.tier === 'vip') tags.push('vip');
  if (i.hasAttachment) tags.push('attachment');
  if (i.moneyFlag) tags.push('money');
  if (i.rulePriority) tags.push('priority');
  return tags.length ? ` {${tags.join(',')}}` : '';
};
const lineSms   = i => `[${i.occurred_at}] ${i.identifier}${tagSuffix(i)}: ${i.snippet}`;
const lineEmail = i => `From: ${i.identifier}${tagSuffix(i)}\nSubject: ${i.subject}\n${i.snippet}`;
const lineJob   = i => `[${i.status}] ${i.when} — ${i.snippet} (${i.identifier}${tagSuffix(i)})`;

// ponytail: contact match after the model responds is a best-effort lookup
// keyed on (kind, first 80 chars of snippet) — relies on the model quoting
// snippets close to verbatim, which the prompt asks for but can't guarantee.
// A miss just means importanceScore falls back to 0, not a crash.
//
// Also corrects `from`: the model writes that field itself rather than
// copying it, and it can misattribute a sender when several similarly-named
// senders appear close together in the source dump (seen in practice: a
// one-off job got attributed to a frequent client's name instead of its
// actual, different client). The scraped displayName is ground truth, so it
// wins whenever a snippet match is found.
function applyContactMatch(t, index) {
  const hit = index.get(indexKey(t.kind, t.snippet)) || {};
  return { ...t, from: hit.displayName || t.from, tier: hit.tier, moneyFlag: hit.moneyFlag, hasAttachment: hit.hasAttachment, rulePriority: !!hit.rulePriority };
}
function importanceScore(t) {
  return (t.tier === 'vip' ? 3 : 0) + (t.moneyFlag ? 2 : 0) + (t.hasAttachment ? 2 : 0) + (t.rulePriority ? 3 : 0);
}

async function annotateAndFormat(kind, items, lineFn, sep, index, rules) {
  const kept = [];
  for (const item of items) {
    const identifier = normalizeIdentifier(kind, item.identifier);
    const contact = await upsertContact(pool, kind, identifier, item.displayName);
    const tier = deriveTier(contact);
    if (tier === 'muted') continue;
    const ruleHit = matchRules(`${item.displayName || ''} ${identifier} ${item.subject || ''} ${item.snippet || ''}`, rules);
    if (ruleHit === 'ignore') continue;
    const annotated = {
      ...item, identifier, tier,
      moneyFlag: hasMoneyFlag(`${item.subject || ''} ${item.snippet || ''}`),
      rulePriority: ruleHit === 'priority',
    };
    kept.push(annotated);
    index.set(indexKey(kind, item.snippet), {
      tier, moneyFlag: annotated.moneyFlag, hasAttachment: !!item.hasAttachment,
      displayName: item.displayName, rulePriority: annotated.rulePriority,
    });
  }
  return kept.length ? kept.map(lineFn).join(sep) : 'No matching items found.';
}

async function gatherSources(perSource = 20, jobsCap = 20) {
  const { rows: rules } = await pool.query('SELECT pattern, action FROM rules');

  const [texts, events, emails, bizEmails, whatsapp, messenger, instagram, jobsRes] = await Promise.all([
    getRecentTextsBrief({ limit: perSource }),
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
  const jobItems = jobsRes.items.slice(0, jobsCap);

  const contactIndex = new Map();
  const [textsText, emailsText, bizEmailsText, whatsappText, messengerText, instagramText, jobsText] = await Promise.all([
    annotateAndFormat('sms', texts.items, lineSms, '\n', contactIndex, rules),
    annotateAndFormat('email', emails.items, lineEmail, '\n\n', contactIndex, rules),
    annotateAndFormat('bizemail', bizEmails.items, lineEmail, '\n\n', contactIndex, rules),
    annotateAndFormat('whatsapp', whatsapp.items, lineSms, '\n', contactIndex, rules),
    annotateAndFormat('messenger', messenger.items, lineSms, '\n', contactIndex, rules),
    annotateAndFormat('instagram', instagram.items, lineSms, '\n', contactIndex, rules),
    annotateAndFormat('job', jobItems, lineJob, '\n', contactIndex, rules),
  ]);

  return {
    texts: textsText, textsRaw: texts.text, events,
    emails: emailsText, emailsRaw: emails.text,
    bizEmails: bizEmailsText, bizEmailsRaw: bizEmails.text,
    whatsapp: whatsappText, whatsappRaw: whatsapp.text,
    messenger: messengerText, messengerRaw: messenger.text,
    instagram: instagramText, instagramRaw: instagram.text,
    jobs: jobsText, jobsRaw: jobsRes.text,
    contactIndex,
  };
}

const TAG_LEGEND = `Some lines carry a {tag} suffix from Reverb's contact memory: {vip} = someone you interact with often, reply to, or have flagged as important; {attachment} = the email has an attachment; {money} = mentions an invoice, bill, or payment; {priority} = matches one of the user's own priority rules. Weight tagged items higher — they should usually lead their bucket/category, and {money}/{priority} items are a strong hint for importance.`;

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

async function askModel(prompt, maxTokens = 1400) {
  const model = await pickModel();
  const cr = await fetch(`${LM_URL}/v1/chat/completions`, {
    // Cloudflare's tunnel edge timeout sits around 125s (observed via 524s);
    // give generation up to just under that rather than aborting early.
    signal: AbortSignal.timeout(115_000),
    method: 'POST',
    headers: LM_HEADERS,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2, max_tokens: maxTokens }),
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

async function handlePull(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }

  const sources = await gatherSources();
  const { textsRaw, events, emailsRaw, bizEmailsRaw, whatsappRaw, messengerRaw, instagramRaw, jobsRaw } = sources;
  pullCache = { sources, pulledAt: new Date().toISOString() };

  const countEmailBlock = s => (s.includes('No matching') ? 0 : s.split('\n\n').filter(Boolean).length);
  const emailCount = countEmailBlock(emailsRaw);
  const bizEmailCount = countEmailBlock(bizEmailsRaw);
  const counts = {
    sms:       `${countLines(textsRaw)} msgs`,
    email:     `${emailCount} msgs`,
    cal:       `${countLines(events)} events`,
    call:      'not connected',
    bizemail:  `${bizEmailCount} msgs`,
    whatsapp:  `${countLines(whatsappRaw)} msgs`,
    messenger: `${countLines(messengerRaw)} msgs`,
    instagram: `${countLines(instagramRaw)} msgs`,
    job:       `${countLines(jobsRaw)} jobs`,
  };
  const scanned = countLines(textsRaw) + countLines(events) + emailCount + bizEmailCount
    + countLines(whatsappRaw) + countLines(messengerRaw) + countLines(instagramRaw) + countLines(jobsRaw);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ scanned, counts, pulledAt: pullCache.pulledAt }));
}

// Shared by Work and Life dismiss actions — both content-hash into the same
// swept_done table via workItemId. Optional kind+from also nudges the
// sender's contact memory: dismissing without ever replying is the "this
// wasn't important" signal.
async function handleTaskDone(req, res, id) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { done, kind, from } = JSON.parse(await readBody(req));
  if (done) {
    await pool.query('INSERT INTO swept_done (task_id) VALUES ($1) ON CONFLICT (task_id) DO NOTHING', [id]);
    if (kind && from) await signalContact(pool, kind, normalizeIdentifier(kind, from), 'dismiss');
  } else {
    await pool.query('DELETE FROM swept_done WHERE task_id=$1', [id]);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// Fired when the user acts on an item (currently: "draft reply") — the
// positive counterpart to handleTaskDone's dismiss signal.
async function handleContactSignal(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { kind, from, action } = JSON.parse(await readBody(req));
  if (kind && from && action === 'reply') {
    await signalContact(pool, kind, normalizeIdentifier(kind, from), 'reply');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// Contact list for the manual VIP/mute drawer.
async function handleContacts(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { rows } = await pool.query(
    'SELECT id, kind, identifier, display_name, tier, seen_count, replied_count, dismissed_count, last_seen_at FROM contacts ORDER BY seen_count DESC, last_seen_at DESC LIMIT 200'
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows));
}

async function handleContactTier(req, res, id) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { tier } = JSON.parse(await readBody(req));
  if (tier !== null && !['vip', 'normal', 'muted'].includes(tier)) { res.writeHead(400); res.end('{}'); return; }
  await pool.query('UPDATE contacts SET tier=$1 WHERE id=$2', [tier, id]);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// User-editable priority/ignore rules (Rules drawer) — plain substring
// patterns, matched in code via matchRules, not interpreted by the model.
async function handleRules(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  if (req.method === 'GET') {
    const { rows } = await pool.query('SELECT id, pattern, action, created_at FROM rules ORDER BY created_at DESC');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  if (req.method === 'POST') {
    const { pattern, action } = JSON.parse(await readBody(req));
    if (!pattern || !String(pattern).trim() || !['priority', 'ignore'].includes(action)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'pattern and a valid action are required' }));
      return;
    }
    const { rows } = await pool.query(
      'INSERT INTO rules (pattern, action) VALUES ($1,$2) RETURNING id, pattern, action, created_at',
      [pattern.trim(), action]
    );
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows[0]));
  }
}

async function handleRuleDelete(req, res, id) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  await pool.query('DELETE FROM rules WHERE id=$1', [id]);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// ── Work / Life reports ──────────────────────────────────
// Both read the same pulled sources (see pullCache above) — one prompt asks
// for business-relevant items, the other for personal ones. Persisted so
// each tab loads instantly; POST /api/report/generate is the only path that
// re-runs the model, and it always writes both reports from one pull.
// Upsert every live item into the memory. first_seen_at is set once and never
// moved; last_seen_at and the preview text follow the latest report. Called
// only from the generate path, so "first seen" means "first reported", not
// "first opened the tab".
async function recordSurfaced(bucket, categories) {
  for (const c of categories || []) {
    for (const t of c.items || []) {
      await pool.query(
        `INSERT INTO surfaced_items (task_id, bucket, kind, from_label, snippet)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (task_id) DO UPDATE SET last_seen_at=NOW(), snippet=EXCLUDED.snippet, bucket=EXCLUDED.bucket`,
        [workItemId(t), bucket, t.kind || null, t.from || null, t.snippet || null]
      );
    }
  }
}

async function buildCategorizedResponse(summary, categories, scannedAt) {
  const [{ rows: doneRows }, { rows: seenRows }] = await Promise.all([
    pool.query('SELECT task_id FROM swept_done'),
    pool.query('SELECT task_id, first_seen_at FROM surfaced_items'),
  ]);
  const doneSet = new Set(doneRows.map(r => r.task_id));
  const firstSeen = new Map(seenRows.map(r => [r.task_id, r.first_seen_at]));
  const filtered = categories
    .map(c => ({
      label: c.label,
      items: c.items
        .map(t => {
          const id = workItemId(t);
          return { ...t, id, firstSeenAt: firstSeen.get(id) || scannedAt };
        })
        .filter(t => !doneSet.has(t.id)),
    }))
    .filter(c => c.items.length);
  // How many have been sitting unactioned for 2+ days — the number the UI nags with.
  const twoDaysAgo = Date.now() - 2 * 86400000;
  const outstanding = filtered
    .flatMap(c => c.items)
    .filter(t => new Date(t.firstSeenAt).getTime() < twoDaysAgo).length;
  return { summary, categories: filtered, scannedAt, outstanding };
}

async function readSummaryTable(table) {
  const { rows } = await pool.query(`SELECT summary, categories, scanned_at FROM ${table} WHERE id=1`);
  if (!rows.length) return { summary: '', categories: [], scannedAt: null };
  const { summary, categories, scanned_at } = rows[0];
  return buildCategorizedResponse(summary, categories, scanned_at);
}

async function handleWork(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(await readSummaryTable('work_summary')));
}

async function handleLife(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(await readSummaryTable('life_summary')));
}

// ── Generate pipeline: classify -> work report -> life report ───────────
// Three narrower sequential calls instead of two mega-prompts run
// concurrently. Sequential because LM Studio is one GPU/one model server —
// concurrent requests almost certainly queue there anyway, so staggering
// costs little wall-clock time while keeping each call's job small:
// classify only ever sorts+labels (no summary/categories to juggle), and
// each report call only ever sees its own already-filtered item list, never
// the full raw source dump the old prompts each had to re-read.
const CLASSIFY_SCHEMA = `[{"kind":"sms"|"email"|"cal"|"bizemail"|"whatsapp"|"messenger"|"instagram"|"job","from":"string","when":"short string like '2d' or 'tomorrow 09:00'","bucket":"work"|"life","text":"imperative one-line action naming the specific channel/app, under 100 chars","snippet":"verbatim quote from the source, under 100 chars, never paraphrase","reply":true|false}]`;

function classifyPrompt(sources, today) {
  return `Today is ${today}. Read the raw data below from several sources (texts, calendar, personal email, business email, WhatsApp, Messenger, Instagram, Switch Craft jobs).

${TAG_LEGEND}

For every item that needs a reply, needs action, or is worth knowing about, decide which report it belongs in:
- WORK: Switch Craft jobs, clients, suppliers, business money.
- LIFE: personal messages from friends or family, upcoming personal events (not job appointments), anything involving the kids Peyton and Jude, plans or invites.
Ignore routine or no-action items entirely — read receipts, newsletters, marketing/promotional emails, delivery notifications, and automated confirmations never belong in either bucket, even if their subject line happens to mention something family- or kids-adjacent. Only include something under Peyton/Jude if it is genuinely about them (school, an appointment, an activity), not because a word matched.

Include at most 25 items total across both buckets combined — if there's more than that, pick the most urgent/important and drop the rest, but never drop an item tagged {money}, {vip}, or {priority} — those are always included even if it means cutting an untagged item first. This list must stay short enough to fit in one response; going over 25 breaks the output.

Every item's "text" must name the specific channel/app it needs action on (e.g. "Reply to Adam Johnson's booking request on Messenger", "Pay AWM's June invoice") so it can be found again without re-searching. "snippet" must be copied from exactly one source line — never combine or summarize two different items into one snippet.

Respond with ONLY a JSON array, no prose, no markdown fences:
${CLASSIFY_SCHEMA}
If nothing needs action, respond with [].

${sourcesBlock(sources)}`;
}

async function runClassify(sources) {
  const today = new Date().toISOString().slice(0, 10);
  let raw;
  try {
    // Higher budget than the default — this is the one call that reads
    // every source at once, so its output is the largest in the pipeline
    // even with the 25-item cap above.
    raw = await askModel(classifyPrompt(sources, today), 2200);
  } catch {
    return { work: [], life: [], error: 'LM Studio unreachable' };
  }
  const parsedRaw = parseJsonFence(raw, []);
  const parsed = Array.isArray(parsedRaw) ? parsedRaw : [];
  const items = parsed
    .filter(t => t && t.kind && t.text && t.snippet && (t.bucket === 'work' || t.bucket === 'life'))
    .map(t => applyContactMatch(t, sources.contactIndex))
    .sort((a, b) => importanceScore(b) - importanceScore(a));
  const strip = ({ bucket, ...rest }) => rest;
  return {
    work: items.filter(t => t.bucket === 'work').map(strip),
    life: items.filter(t => t.bucket === 'life').map(strip),
  };
}

const REPORT_SCHEMA = `{"summary":"2-sentence overview","categories":[{"label":"short category name","indexes":[0,2]}]}`;
const REPORT_EXAMPLES = { work: '"jobs to confirm", "bills to pay", "parts to grab before tomorrow"', life: '"people to get back to", "upcoming events", "peyton & jude"' };
const REPORT_CLEAR = { work: 'work looks clear', life: 'things look quiet' };

// Items are given fully-formed (classify already wrote "text" and picked a
// channel) and referenced only by index — the model groups and summarizes,
// it never re-touches the actual content, so it can't mangle a snippet or
// invent a detail while writing this report.
function reportPrompt(items, label) {
  const listing = items.map((t, i) => `${i}. [${t.kind}] ${t.from}${t.when ? ` (${t.when})` : ''}: ${t.text}${tagSuffix(t)}`).join('\n');
  return `These are today's ${label} items, already filtered and numbered:

${listing}

Write a 2-sentence summary of how things look, then group the items into at most 5 categories that fit what's actually here (e.g. ${REPORT_EXAMPLES[label]}) — don't invent empty categories. Cap each category at 5 item indexes — pick the most important/urgent ones if there are more (priority-tagged items should usually be included). Reference items ONLY by their index number, never rewrite their text.

Respond with ONLY a JSON object, no prose outside it, no markdown fences:
${REPORT_SCHEMA}`;
}

async function runReport(items, label) {
  if (!items.length) return { summary: `Nothing on ${label} today.`, categories: [] };
  let raw;
  try {
    raw = await askModel(reportPrompt(items, label));
  } catch {
    return { summary: '', categories: [], error: 'LM Studio unreachable' };
  }
  const parsed = parseJsonFence(raw, {});
  const summary = typeof parsed.summary === 'string' && parsed.summary ? parsed.summary : REPORT_CLEAR[label];
  const categories = (Array.isArray(parsed.categories) ? parsed.categories : [])
    .filter(c => c && typeof c.label === 'string' && Array.isArray(c.indexes))
    .map(c => ({
      label: c.label,
      items: [...new Set(c.indexes)].map(i => items[i]).filter(Boolean).slice(0, 5),
    }))
    .filter(c => c.items.length);
  return { summary, categories };
}

async function persistSummary(table, result) {
  if (result.error) return;
  await pool.query(
    `INSERT INTO ${table} (id, summary, categories, scanned_at) VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET summary=$1, categories=$2, scanned_at=NOW()`,
    [result.summary, JSON.stringify(result.categories)]
  );
}

async function handleReportGenerate(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  if (!pullCache) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'pull data first' }));
    return;
  }

  const { sources } = pullCache;
  const classified = await runClassify(sources);
  if (classified.error) {
    const errResult = { summary: '', categories: [], error: classified.error };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ work: errResult, life: errResult }));
    return;
  }

  const work = await runReport(classified.work, 'work');
  const life = await runReport(classified.life, 'life');
  await Promise.all([persistSummary('work_summary', work), persistSummary('life_summary', life)]);

  // Remember what this report surfaced, so first_seen_at can age items that keep
  // reappearing without being actioned. Done at generate time, not on every GET,
  // so "first seen" means "first reported".
  if (!work.error) await recordSurfaced('work', work.categories);
  if (!life.error) await recordSurfaced('life', life.categories);

  const scannedAt = new Date().toISOString();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    work: work.error ? work : await buildCategorizedResponse(work.summary, work.categories, scannedAt),
    life: life.error ? life : await buildCategorizedResponse(life.summary, life.categories, scannedAt),
  }));
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
    if (req.method === 'POST' && u === '/api/pull')            return await handlePull(req, res);
    if (req.method === 'POST' && u === '/api/report/generate') return await handleReportGenerate(req, res);
    if (req.method === 'GET'  && u === '/api/work') return await handleWork(req, res);
    if (req.method === 'GET'  && u === '/api/life') return await handleLife(req, res);
    const workDoneMatch = u.match(/^\/api\/work\/([a-f0-9]+)\/done$/);
    if (workDoneMatch) return await handleTaskDone(req, res, workDoneMatch[1]);
    const lifeDoneMatch = u.match(/^\/api\/life\/([a-f0-9]+)\/done$/);
    if (lifeDoneMatch) return await handleTaskDone(req, res, lifeDoneMatch[1]);
    if (req.method === 'GET' && u === '/api/texts') return await handleTexts(req, res);
    if (req.method === 'GET'  && u === '/api/contacts') return await handleContacts(req, res);
    if (req.method === 'POST' && u === '/api/contacts/signal') return await handleContactSignal(req, res);
    const contactMatch = u.match(/^\/api\/contacts\/(\d+)$/);
    if (req.method === 'PATCH' && contactMatch) return await handleContactTier(req, res, contactMatch[1]);
    if (u === '/api/rules') return await handleRules(req, res);
    const ruleMatch = u.match(/^\/api\/rules\/(\d+)$/);
    if (req.method === 'DELETE' && ruleMatch) return await handleRuleDelete(req, res, ruleMatch[1]);
    return await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end('internal error'); }
  }
}).listen(PORT, async () => {
  await initDb();
  console.log(`reverb on :${PORT}`);
});
