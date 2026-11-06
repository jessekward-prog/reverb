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
  fetchThreads, fetchEvents, fetchChannel,
} from './src/lib/tools.js';
import { parseExtraction, reconcileStatus, projectCommitments, ymd } from './src/lib/commitments.js';
import { normalizeIdentifier, upsertContact, deriveTier, signalContact, hasMoneyFlag, matchRules,
         extractAddress, phoneLast9 } from './src/lib/contacts.js';

const { Pool } = pg;

const PORT         = process.env.PORT || 3000;
const LM_URL       = process.env.LM_STUDIO_BASE_URL || 'http://localhost:1235';
const LM_HEADERS   = { 'Content-Type': 'application/json', ...(process.env.LM_STUDIO_API_KEY ? { Authorization: `Bearer ${process.env.LM_STUDIO_API_KEY}` } : {}) };
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-in-prod';
const DIST         = join(fileURLToPath(import.meta.url), '..', 'dist');
// Sweep/Work classify+report. Was qwen2.5-7b-instruct — fast, but it
// CONFABULATES on this task: it invented a VIP contact "Sarah Ward" sending six
// urgent messages (none existed; the only real "Sarah" is a voicemail notice)
// and emitted {not_text}/{vip} placeholders as snippets. gemma-4-12b-qat does
// the same job accurately with no reasoning preamble (~9s, well under the
// Cloudflare edge timeout). gemma-4-e4b is avoided here specifically — it writes
// ~900 tokens of hidden chain-of-thought and blew past the timeout; the 12b-qat
// does not.
const PREFER_MODEL  = 'gemma-4-12b-qat';

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
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_source TEXT;
    CREATE TABLE IF NOT EXISTS rules (
      id         SERIAL PRIMARY KEY,
      pattern    TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('priority','ignore')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Work agreed in a message, as structured fact. Not a second copy of the
    -- threads: a row is a few fields plus the one line it came from, and it is
    -- re-derived from the bridge index on every report, so the table stays
    -- small and can never drift away from what was actually said.
    --   status  unbooked      - that day is empty, so it really isn't in the calendar
    --           booked        - an event that day clearly refers to this
    --           needs_confirm - no resolvable day, or can't tell it apart from
    --                           something else already on that day -> ask, don't assert
    --           superseded    - no longer agreed in the thread (talked away)
    CREATE TABLE IF NOT EXISTS commitments (
      id            TEXT PRIMARY KEY,
      who           TEXT NOT NULL,
      what          TEXT NOT NULL,
      quote         TEXT NOT NULL,
      when_text     TEXT,
      when_date     DATE,
      when_time     TEXT,
      status        TEXT NOT NULL,
      source_thread TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await unbookedForChat(args) });
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

  // WhatsApp/Messenger/Instagram notification feeds (via notify-cmd) were dropped:
  // stale, noisy, and not channels acted on here. The report is built from the
  // deterministic tools now (collectGroundedItems), so this only feeds the Pull
  // step's counts.
  const [texts, events, emails, bizEmails, jobsRes] = await Promise.all([
    getRecentTextsBrief({ limit: perSource }),
    getUpcomingEvents({ days_ahead: 7 }),
    getRecentEmails({ limit: Math.round(perSource * 0.75) }),
    getRecentBusinessEmails({ limit: Math.round(perSource * 0.75) }),
    getSwitchcraftJobs(),
  ]);
  const jobItems = jobsRes.items.slice(0, jobsCap);

  const contactIndex = new Map();
  const [textsText, emailsText, bizEmailsText, jobsText] = await Promise.all([
    annotateAndFormat('sms', texts.items, lineSms, '\n', contactIndex, rules),
    annotateAndFormat('email', emails.items, lineEmail, '\n\n', contactIndex, rules),
    annotateAndFormat('bizemail', bizEmails.items, lineEmail, '\n\n', contactIndex, rules),
    annotateAndFormat('job', jobItems, lineJob, '\n', contactIndex, rules),
  ]);

  return {
    texts: textsText, textsRaw: texts.text, events,
    emails: emailsText, emailsRaw: emails.text,
    bizEmails: bizEmailsText, bizEmailsRaw: bizEmails.text,
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
    // gemma-4-12b-qat is a reasoning model: without this it spends the whole
    // budget on hidden chain-of-thought and returns EMPTY content (so every
    // report came back "nothing today"). reasoning_effort:none makes it answer
    // directly. See the token-floor lesson in memory.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2, max_tokens: maxTokens, reasoning_effort: 'none' }),
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
  const { textsRaw, events, emailsRaw, bizEmailsRaw, jobsRaw } = sources;
  pullCache = { sources, pulledAt: new Date().toISOString() };

  const countEmailBlock = s => (s.includes('No matching') ? 0 : s.split('\n\n').filter(Boolean).length);
  const emailCount = countEmailBlock(emailsRaw);
  const bizEmailCount = countEmailBlock(bizEmailsRaw);
  const counts = {
    sms:       `${countLines(textsRaw)} msgs`,
    email:     `${emailCount} msgs`,
    cal:       `${countLines(events)} events`,
    bizemail:  `${bizEmailCount} msgs`,
    job:       `${countLines(jobsRaw)} jobs`,
  };
  const scanned = countLines(textsRaw) + countLines(events) + emailCount + bizEmailCount + countLines(jobsRaw);

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
    'SELECT id, kind, identifier, display_name, tier, address, address_source, seen_count, replied_count, dismissed_count, last_seen_at FROM contacts ORDER BY seen_count DESC, last_seen_at DESC LIMIT 200'
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
      synopsis: c.synopsis || '',
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

// ── To-do: the one championed list ────────────────────────
// Work and Life are the two reports to read; the to-do list is the single
// actionable thing to DO, pulled from both and ranked so the right item is at
// the top. No new generation, no new store — it reads the same persisted
// reports (so it's always in step with them), merges their groups, drops what's
// already ticked off (swept_done, via readSummaryTable), then ranks:
//   priority rule > VIP > money > chased (2+ days open) > age.
// That ranking is the trust contract: the list says what to do first, by rule,
// not by model whim. Ticking an item posts to /api/tasks/:id/done, the same
// swept_done both reports already use.
const CHASE_DAYS = 2;
const daysOpen = iso => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0;
const taskScore = t => {
  const d = daysOpen(t.firstSeenAt);
  return (t.rulePriority ? 4 : 0) + (t.tier === 'vip' ? 3 : 0) + (t.moneyFlag ? 2 : 0)
    + (d >= CHASE_DAYS ? 2 : 0) + Math.min(d, 20) * 0.01; // age as a tiny tiebreak
};
const groupHeat = c => c.items.reduce((m, t) => Math.max(m, taskScore(t)), 0);

async function handleTasks(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const [work, life] = await Promise.all([
    readSummaryTable('work_summary'), readSummaryTable('life_summary'),
  ]);
  const tag = (r, bucket) => (r.categories || []).map(c => ({
    label: c.label, synopsis: c.synopsis || '', bucket, items: c.items.map(t => ({ ...t, bucket })),
  }));
  const categories = [...tag(work, 'work'), ...tag(life, 'life')];
  for (const c of categories) c.items.sort((a, b) => taskScore(b) - taskScore(a));
  categories.sort((a, b) => groupHeat(b) - groupHeat(a));

  const all = categories.flatMap(c => c.items);
  const total = all.length;
  const chase = all.filter(t => daysOpen(t.firstSeenAt) >= CHASE_DAYS).length;
  const scannedAt = [work.scannedAt, life.scannedAt].filter(Boolean).sort().pop() || null;
  const summary = total
    ? `${total} ${total === 1 ? 'thing' : 'things'} on the list${chase ? `, ${chase} need chasing` : ''}.`
    : 'nothing on the list right now.';

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ actions: await nextActions().catch(() => []), summary, categories, scannedAt, outstanding: chase }));
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

Write a 2-sentence summary of how things look, then group the items into at most 5 categories that fit what's actually here. Prefer grouping by WHO it's for: when two or more items are for the same person or customer (the name after the channel), put them in one category named for that person, e.g. "jobs for Murpheys — book asap" — do NOT scatter one customer's jobs across task-type categories like "lighting" and "troubleshooting". Only fall back to task-type categories (e.g. ${REPORT_EXAMPLES[label]}) for leftover items that don't cluster on one person. Don't invent empty categories. A person's category should list ALL of that person's items; otherwise cap a category at about 8 indexes, keeping the most urgent (priority-tagged items should usually be included). Reference items ONLY by their index number, never rewrite their text.

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
      items: [...new Set(c.indexes)].map(i => items[i]).filter(Boolean).slice(0, 10),
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

// ── Live browser proxy ────────────────────────────────────
// The user's browser can't reach the bridge (host LAN, behind the firewall);
// this container can, so Reverb proxies the frame feed and input back. Auth is
// Reverb's PIN — the bridge token stays server-side.
const BROWSER_SOURCES = ['messages', 'email', 'bizemail', 'meta', 'calendar'];
const SOURCE_ALIAS = { messages: 'sms' }; // UI label -> bridge source key

async function handleBrowserFrame(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const label = new URL(req.url, 'http://x').searchParams.get('source');
  if (!BROWSER_SOURCES.includes(label)) { res.writeHead(404); res.end('{}'); return; }
  const source = SOURCE_ALIAS[label] || label;
  try {
    const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/frame?source=${source}`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
    if (!r.ok) { res.writeHead(502); res.end('{}'); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Content-Length': buf.length,
      'X-Viewport': r.headers.get('x-viewport') || '', 'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
}

async function handleBrowserInput(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const body = JSON.parse(await readBody(req));
  const label = body.source;
  if (!BROWSER_SOURCES.includes(label)) { res.writeHead(404); res.end('{}'); return; }
  try {
    const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
      body: JSON.stringify({ ...body, source: SOURCE_ALIAS[label] || label }),
    });
    res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json' });
    res.end(await r.text());
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
}

// ── Job photos ────────────────────────────────────────────
// The booking app holds the photos; Reverb proxies them behind its own PIN so
// the browser never needs the booking app's address. Numeric ids only.
async function handleJobPhoto(req, res, id) {
  if (!requireAuth(req)) { res.writeHead(401); res.end(); return; }
  try {
    const r = await fetch(`${process.env.SWITCHCRAFT_BASE_URL}/api/photos/${id}`);
    if (!r.ok) { res.writeHead(r.status === 404 ? 404 : 502); res.end(); return; }
    const type = r.headers.get('content-type') || '';
    if (!type.startsWith('image/')) { res.writeHead(415); res.end(); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length,
                         'Cache-Control': 'private, max-age=86400' });
    res.end(buf);
  } catch { res.writeHead(502); res.end(); }
}

// ── Agentic report: assemble from the deterministic tools, not a raw dump ──
// The old flow dumped every source's raw text into one classify prompt and let
// the model structure it — which is where it confabulated a "Sarah Ward". This
// instead gathers FACTS from the tools (waiting replies, unbooked jobs, open
// jobs, email, calendar), each of which traces to code that can't invent a
// contact or a message. The model's only job is to split work/life and group —
// it organises verified items, so it cannot fabricate one.
// A short automated message (an OTP, a verification code, a "do not reply")
// slips under the waiting tool's length-based bulk filter and looks like a
// person awaiting a reply. Drop those here so they don't become report items.
const AUTOMATED_SNIPPET = /\b(verification code|security code|is your\b.{0,20}\bcode|one.?time|do not (share|reply)|unsubscribe|password reset)\b/i;

async function collectGroundedItems() {
  // Unbooked jobs is deliberately NOT here: its .items are the raw messages it
  // inspects, not the jobs it finds (the finding is a model judgment on .text),
  // so pulling .items would label every recent text a "job". It stays a chat
  // tool you can ask explicitly. Waiting replies already surface the job-
  // agreement texts, and switch-craft covers actual bookings.
  const [waiting, jobs, email, bizEmail, messenger, whatsapp] = await Promise.all([
    getWaitingReplies({ limit: 25 }).catch(() => ({ items: [] })),
    getSwitchcraftJobs().catch(() => ({ items: [] })),
    getRecentEmails({ limit: 10 }).catch(() => ({ items: [] })),
    getRecentBusinessEmails({ limit: 10 }).catch(() => ({ items: [] })),
    workChannel('messenger').catch(() => []),
    workChannel('whatsapp').catch(() => []),
  ]);

  let events = [];
  try {
    const r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/events`);
    if (r.ok) {
      const all = await r.json();
      // ymd, not toISOString: in AEDT a UTC date reads as yesterday before 11am,
      // which would pull in yesterday's events and drop day+2 from the window.
      const today = ymd(new Date());
      const end = ymd(new Date(Date.now() + 2 * 86400000));
      events = all.filter(e => e.date >= today && e.date <= end);
    }
  } catch {}

  const items = [];
  for (const w of waiting.items || []) {
    if (AUTOMATED_SNIPPET.test(w.snippet || '')) continue;
    items.push({ kind: w.kind || 'sms', from: w.identifier, snippet: w.snippet,
                 text: `Reply to ${w.identifier}`, reply: true, hintBucket: null });
  }
  await learnFromJobs(jobs.items || []).catch(e => console.error('directory:', e.message));

  for (const j of jobs.items || []) {
    // Lead with the WORK, not the status: "pending job — yes plz" told the user
    // nothing. The description is the only thing that says what the job is, so
    // it becomes the card's title; status and client ride alongside as metadata.
    const desc = String(j.snippet || '').replace(/\s+/g, ' ').trim();
    // The checklist is the real breakdown of the work; the description is the
    // lumped version of the same thing. Prefer what's still outstanding.
    const todo = (j.tasks || []).filter(t => !t.done).map(t => String(t.text || '').trim()).filter(Boolean);
    const title = (todo.length ? todo.join(' · ') : desc) || 'job with no description';
    items.push({ kind: 'job', from: j.identifier, snippet: desc, when: j.when,
                 status: j.status, overdue: j.overdue, jobId: j.id,
                 address: j.address, phone: j.phone, business: j.business,
                 preferredDays: j.preferredDays, timeline: j.timeline,
                 tasks: j.tasks, noteCount: j.noteCount, photoCount: j.photoCount,
                 photos: j.photos, lastNote: j.lastNote, raised: j.raised,
                 text: title.slice(0, 140), hintBucket: 'work' });
  }
  for (const m of messenger || [])
    items.push({ kind: 'messenger', from: m.name, snippet: m.snippet, when: m.when,
                 text: `Reply to ${m.name}`, reply: true, hintBucket: 'work' });

  for (const m of whatsapp || [])
    items.push({ kind: 'whatsapp', from: m.name, snippet: m.snippet, when: m.when,
                 text: `Reply to ${m.name}`, reply: true, hintBucket: 'work' });

  for (const e of bizEmail.items || [])
    items.push({ kind: 'bizemail', from: e.identifier, snippet: e.snippet, subject: e.subject,
                 text: `Business email: ${e.subject}`, reply: true, hintBucket: 'work' });
  for (const e of email.items || [])
    items.push({ kind: 'email', from: e.identifier, snippet: e.snippet, subject: e.subject,
                 text: `Email from ${e.identifier}: ${e.subject}`, reply: true, hintBucket: 'life' });
  for (const ev of events)
    items.push({ kind: 'cal', from: ev.text,
                 snippet: `${ev.date}${ev.time ? ' ' + ev.time : ''}${ev.location ? ' @ ' + ev.location : ''}`,
                 when: `${ev.date}${ev.time ? ' ' + ev.time : ''}`, text: ev.text, hintBucket: 'life' });
  return briefConversations(await annotateGrounded(items));
}

// A one-line snippet ("Yes Tuesday next week is good for us") carries none of
// the story - what the work is, what was proposed, what is still missing. This
// reads each conversation back and writes a short brief in plain English, so a
// card says where things actually stand instead of quoting the last message.
// One call covering every conversation on the report; grounded in the messages
// only, and silently skipped if the bridge or the model is unavailable.
async function briefConversations(items) {
  const convo = items.filter(t => t.kind === 'sms' || t.kind === 'meta');
  if (!convo.length) return items;

  let threads = [];
  try { threads = await fetchThreads(20); }
  catch (e) { console.error('briefs: bridge unreachable —', e.message); return items; }
  if (!threads.length) { console.error('briefs: bridge returned no threads'); return items; }

  const digits = v => String(v || '').replace(/\D/g, '');
  const findThread = from => {
    const f = String(from || '').toLowerCase().trim();
    const d = digits(from);
    return threads.find(t => String(t.name || '').toLowerCase().trim() === f)
        || threads.find(t => d.length >= 9 && digits(t.name).includes(d.slice(-9)))
        || threads.find(t => f.length > 2 && String(t.name || '').toLowerCase().includes(f));
  };

  await learnFromThreads(threads).catch(e => console.error('directory:', e.message));

  const pairs = [];
  for (const t of convo) {
    const th = findThread(t.from);
    if (th && (th.messages || []).length > 1) pairs.push({ item: t, thread: th });
  }
  if (!pairs.length) {
    console.error(`briefs: none of ${convo.length} conversations matched a thread`);
    return items;
  }

  const listing = pairs.map((p, i) => {
    const lines = (p.thread.messages || []).slice(-14)
      .map(m => `    ${m.outbound ? 'you' : 'them'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
    return `${i}. ${p.thread.name}\n${lines}`;
  }).join('\n\n');

  const now = new Date();
  const prompt = `Today is ${now.toLocaleDateString('en-AU', { weekday: 'long' })} ${ymd(now)}. Below are text conversations between Jesse, an electrician ("you"), and other people.

For EACH numbered conversation write ONE line, exactly:
<number> :: <brief>

The brief is 2-4 short sentences written TO Jesse as "you", in plain spoken English, like an assistant who has just read the thread back for him. Cover, only where the messages actually show it:
- what this has been about, and roughly how long it has been going on
- what was most recently proposed or agreed
- what is still missing (a time, a date, a price, a confirmation)
- the single next thing worth doing

Tone to match: "You and this client have been going back and forth for a couple of weeks about installing a new oven. You asked about Tuesday next week, they agreed but haven't given you a time. Worth pinning that down, then it can go on the calendar."

Ground every word in the messages shown. Never state a job, name, date, price or promise that is not in the thread. Where something has not been said, say it is not clear rather than guessing. No greeting, no preamble, no markdown, no numbering beyond the required "<number> :: ".

CONVERSATIONS:
${listing}`;

  let raw = '';
  try { raw = await askModel(prompt, 2200); }
  catch (e) { console.error('briefs: model call failed —', e.message); return items; }
  if (!raw.trim()) { console.error('briefs: model returned empty content'); return items; }

  let written = 0;
  for (const line of String(raw).split('\n')) {
    // The model answers "0. Some Name :: ..." - it numbers with a full stop
    // and repeats the thread name before the separator, even when told not to.
    // Take the leading index, then everything after the first "::".
    const m = line.match(/^\s*(\d+)\s*[.)]?\s*(.*)$/);
    if (!m) continue;
    const sep = m[2].indexOf('::');
    if (sep === -1) continue;
    const p = pairs[Number(m[1])];
    if (!p) continue;
    const text = m[2].slice(sep + 2).trim();
    if (text.length > 20) { p.item.brief = text.slice(0, 600); written++; }
  }
  console.log(`briefs: ${written} written for ${pairs.length} matched threads (${convo.length} conversations)`);
  return items;
}

// The deterministic rule layer — the part you can trust, because no model
// touches it. Runs over the grounded facts before they're grouped:
//   - an `ignore` rule or a muted contact drops the item entirely;
//   - a `priority` rule, a VIP contact, or an invoice/payment keyword flags it
//     so /api/tasks floats it to the top of the list.
// Rules and contact tiers come from the user's own Rules/People drawers, matched
// in code (matchRules/deriveTier), so a rule always sticks regardless of what
// the model does next. This is what moved the user's rules from the old dead
// pull path onto the live report.
async function annotateGrounded(items) {
  const [{ rows: rules }, { rows: contactRows }] = await Promise.all([
    pool.query('SELECT pattern, action FROM rules'),
    pool.query('SELECT kind, identifier, tier, seen_count, replied_count, dismissed_count, last_seen_at FROM contacts'),
  ]);
  const tierOf = new Map(contactRows.map(c => [`${c.kind}|${c.identifier}`, deriveTier(c)]));
  const out = [];
  for (const t of items) {
    const rule = matchRules(`${t.from || ''} ${t.subject || ''} ${t.snippet || ''} ${t.text || ''}`, rules);
    if (rule === 'ignore') continue;
    const tier = tierOf.get(`${t.kind}|${normalizeIdentifier(t.kind, t.from)}`) || null;
    if (tier === 'muted') continue;
    out.push({
      ...t,
      tier: tier === 'vip' ? 'vip' : (t.tier || null),
      rulePriority: rule === 'priority',
      moneyFlag: hasMoneyFlag(`${t.subject || ''} ${t.snippet || ''}`),
    });
  }
  return out;
}

// If the model call fails, never lose the grounded facts — fall back to one
// category per bucket, split by hint.
function fallbackGroup(items) {
  const by = b => items.filter(t => (t.hintBucket || 'life') === b);
  const synopsis = 'Check off anything already handled, then book or reply to the rest.';
  const mk = (b, label) => { const its = by(b); return { summary: its.length ? `${its.length} grounded items.` : `${b} looks clear`, categories: its.length ? [{ label, synopsis, items: its }] : [] }; };
  return { work: mk('work', 'to do'), life: mk('life', 'to do') };
}

async function groupGrounded(items) {
  if (!items.length) return { work: { summary: 'work looks clear', categories: [] }, life: { summary: 'things look quiet', categories: [] } };
  const age = t => t.daysOnList >= 1 ? `${t.daysOnList}d on list` : 'new';
  const listing = items.map((t, i) =>
    `${i}. [${t.kind}] ${t.from}${t.when ? ` (${t.when})` : ''} — ${t.text} · ${age(t)}${t.hintBucket ? ` (hint: ${t.hintBucket})` : ''}\n   "${String(t.snippet || '').slice(0, 120)}"`
  ).join('\n');
  const prompt = `Today's items, already gathered as FACTS. Do not invent, add, or reword any — only organise these exact items by their index:

${listing}

Split them into two buckets:
- work = Switch Craft Electrics jobs, trade customers, business email, bookings.
- life = family, personal messages/email, personal appointments, the kids (Peyton/Jude).
Respect any (hint: ...). For EACH bucket write a one-sentence summary and group its items into at most 5 categories. Prefer grouping by WHO it's for: two or more items for the same person go in one category named for them, e.g. "jobs for <name>". Reference items ONLY by index number. Each index goes in exactly one bucket. A bucket with no items gets an empty categories array. Every category label must be DISTINCT and must say what the pile is — never reuse a label, and never use a generic one like "to do", "tasks" or "other"; if two groups would get the same name, merge them or name them by what actually separates them.

For EACH category also write a "synopsis": 1-3 short, plain sentences, like a capable assistant who just sorted this pile for them. Say what's in the group and what to do next — check off anything already handled, check the calendar and book the rest, or reply. When the items differ in age (see "Nd on list" vs "new"), say so plainly, e.g. "some have been sitting a while and may already be done, a couple are fresh." Ground every word in the listed items only: never state a job, name, date, or count that isn't shown, and hedge ("may", "perhaps") rather than assert anything you can't see. Keep it brief and practical, no filler.

Respond with ONLY this JSON, no prose, no markdown:
{"work":{"summary":"...","categories":[{"label":"...","synopsis":"...","indexes":[0]}]},"life":{"summary":"...","categories":[{"label":"...","synopsis":"...","indexes":[1]}]}}`;

  let parsed = null;
  try { parsed = parseJsonFence(await askModel(prompt, 2600), null); } catch {}
  if (!parsed || typeof parsed !== 'object') return fallbackGroup(items);

  const build = key => {
    const b = parsed[key] || {};
    const cats = (b.categories || [])
      .map(c => ({
        label: c.label || key,
        synopsis: typeof c.synopsis === 'string' ? c.synopsis.trim().slice(0, 400) : '',
        items: [...new Set(c.indexes || [])].map(i => items[i]).filter(Boolean),
      }))
      .filter(c => c.items.length);
    return { summary: b.summary || (key === 'work' ? 'work looks clear' : 'things look quiet'), categories: cats };
  };
  return { work: build('work'), life: build('life') };
}

// Full thread behind a report item — "get context" so the user can see what a
// one-line snippet ("👍 to '...'") is actually about.
async function handleItemContext(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const from = new URL(req.url, 'http://x').searchParams.get('from');
  if (!from) { res.writeHead(400); res.end('{}'); return; }
  try {
    const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/threads?contact=${encodeURIComponent(from)}&limit=1`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
    const { threads = [] } = r.ok ? await r.json() : {};
    const messages = (threads[0]?.messages || []).map(m => ({ outbound: !!m.outbound, text: m.text }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ from, messages }));
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
}

// "Add to cal": read the real thread, extract the agreed job/appointment as a
// structured event (grounded in the conversation, so it can't invent a time),
// and open a pre-filled Google Calendar event in the logged-in calendar tab for
// the user to confirm and save. Nothing is written without the user's click.
async function handleItemToCal(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { from, text } = JSON.parse(await readBody(req));
  try {
    // 1. context
    const tr = await fetch(`${process.env.BRIDGE_BASE_URL}/api/threads?contact=${encodeURIComponent(from)}&limit=1&live=1`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
    const { threads = [] } = tr.ok ? await tr.json() : {};
    const convo = (threads[0]?.messages || [])
      .map(m => `${m.outbound ? 'me' : 'them'}: ${m.text}`).join('\n');
    if (!convo) { res.writeHead(200); res.end(JSON.stringify({ error: 'no conversation found to read' })); return; }

    // 2. extract a structured event, grounded in the thread.
    // ymd, not toISOString: this date is what "Friday" gets resolved against
    // before an event is written into the real calendar, so a UTC date would
    // book the job on the wrong day for anything done before 11am in AEDT.
    const today = ymd(new Date());
    const prompt = `Today is ${today}. This is a text conversation with ${from}:

${convo}

If a specific job, appointment, or meeting has been AGREED here, extract it as JSON:
{"found":true,"title":"short event title","date":"YYYY-MM-DD","time":"HH:MM 24h or empty if none","durationMins":60}
Resolve relative dates ("Friday", "Tuesday next week", "tomorrow") against today. If NOTHING concrete was agreed, respond {"found":false}. Respond with ONLY the JSON.`;
    const ev = parseJsonFence(await askModel(prompt, 400), { found: false });
    if (!ev || !ev.found || !ev.date) {
      res.writeHead(200); res.end(JSON.stringify({ error: 'no concrete time was agreed in this conversation' })); return;
    }

    // 3. build a Google Calendar event-edit URL (pre-filled; user saves)
    const pad = n => String(n).padStart(2, '0');
    const [y, mo, d] = ev.date.split('-').map(Number);
    let start, end;
    if (ev.time && /^\d{1,2}:\d{2}$/.test(ev.time)) {
      const [hh, mm] = ev.time.split(':').map(Number);
      const s = new Date(y, mo - 1, d, hh, mm);
      const e = new Date(s.getTime() + (ev.durationMins || 60) * 60000);
      const fmt = t => `${t.getFullYear()}${pad(t.getMonth()+1)}${pad(t.getDate())}T${pad(t.getHours())}${pad(t.getMinutes())}00`;
      start = fmt(s); end = fmt(e);
    } else {
      const day = `${y}${pad(mo)}${pad(d)}`; // all-day
      start = day; end = day;
    }
    // Name and address from the directory, so the event says who and where
    // instead of a bare number with an empty location field. Anything the
    // thread itself mentions is learned here too, for next time.
    const known = await lookupContact(from).catch(() => null);
    const inThread = extractAddress(convo);
    if (inThread && !known?.address) {
      await rememberContact({ phone: from, address: inThread, source: 'chat' }).catch(() => {});
    }
    const place = known?.address || inThread || ev.location || null;
    const who = known?.display_name || from;

    const title = ev.title || text || `Job for ${who}`;
    const details = `Agreed over text with ${who}. Added via Reverb.`;
    const calUrl = 'https://calendar.google.com/calendar/u/0/r/eventedit'
      + `?text=${encodeURIComponent(title)}`
      + `&dates=${start}/${end}`
      + (place ? `&location=${encodeURIComponent(place)}` : '')
      + `&details=${encodeURIComponent(details)}`;

    // 4. open it in the logged-in calendar tab
    await fetch(`${process.env.BRIDGE_BASE_URL}/api/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
      body: JSON.stringify({ source: 'calendar', url: calUrl }),
    }).catch(() => {});

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, event: { title, date: ev.date, time: ev.time || '' } }));
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
}

// ── Commitments ledger ────────────────────────────────────
// The model only decides WHETHER work was agreed and copies the thread
// verbatim; the day is resolved deterministically in commitments.js, and the
// calendar decides "booked". Line output, not JSON — gemma is unreliable at
// strict JSON (see Agentic-LM-Pipeline-Pattern).
function commitmentPrompt(threads, today, weekday) {
  const convos = threads.map(t => {
    const lines = (t.messages || []).slice(-12)
      .map(m => `  ${m.outbound ? 'me' : 'them'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
    return `— ${t.name} —\n${lines}`;
  }).join('\n\n');

  return `Today is ${weekday} ${today}. Below are recent text conversations. "me" is Jesse, an electrician; "them" is the customer.

Find every point where WORK or an APPOINTMENT was actually agreed, requested or scheduled. Output ONE LINE per commitment, exactly four fields separated by " :: ", and nothing else:

WHO :: WHAT :: WHEN :: QUOTE

WHO   - the conversation heading, copied exactly as it appears after the dash
WHAT  - the work itself, a few words (e.g. "ceiling fan installation")
WHEN  - the timing words COPIED VERBATIM from the thread ("Thursday", "tomorrow", "next week", "9am"). Leave empty if no timing was stated.
QUOTE - the one message line where the work was agreed or asked for, COPIED VERBATIM

Copy WHEN and QUOTE exactly as they appear - anything you reword or invent is discarded. Do not work out dates yourself. If a job was later called off in the thread, leave it out. Ignore chit-chat, thanks, deliveries and parcel notices. If you are unsure something is work, leave it out. No numbering, no headings, no commentary.

CONVERSATIONS:
${convos}`;
}

// Re-derive the ledger from the threads. A projection, not an accumulator:
// anything still open that is no longer agreed in its thread is superseded, so
// a job that was talked away drops itself instead of becoming a phantom.
async function refreshCommitments() {
  let threads;
  try { threads = await fetchThreads(20); }
  catch (err) { console.error('commitments: bridge unreachable —', err.message); return { ok: false, reason: err.message }; }
  if (!threads.length) return { ok: false, reason: 'no threads' };

  const now = new Date();
  // ymd, not toISOString: weekday below is local, so before 11am in AEDT a UTC
  // date would make the prompt contradict itself ("Today is Thursday 2026-11-04").
  const today = ymd(now);
  const weekday = now.toLocaleDateString('en-AU', { weekday: 'long' });

  const raw = await askModel(commitmentPrompt(threads, today, weekday), 1600);
  const extracted = parseExtraction(raw, threads, now);
  const events = await fetchEvents();

  for (const c of extracted) {
    const status = reconcileStatus(c, events);
    await pool.query(
      `INSERT INTO commitments (id, who, what, quote, when_text, when_date, when_time, status, source_thread)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         what=EXCLUDED.what, when_text=EXCLUDED.when_text, when_date=EXCLUDED.when_date,
         when_time=EXCLUDED.when_time, status=EXCLUDED.status, last_seen_at=NOW()`,
      [c.id, c.who, c.what, c.quote, c.whenText || null, c.date, c.time, status, c.threadName],
    );
  }

  // Only supersede within the threads actually scanned — a thread that has
  // simply dropped out of the index's recent window must not cancel its jobs.
  const names = threads.map(t => t.name);
  const { rows: open } = await pool.query(
    `SELECT id FROM commitments WHERE status <> 'superseded' AND source_thread = ANY($1)`, [names],
  );
  const { supersede } = projectCommitments(open.map(r => r.id), extracted);
  if (supersede.length) {
    await pool.query(`UPDATE commitments SET status='superseded', last_seen_at=NOW() WHERE id = ANY($1)`, [supersede]);
  }
  return { ok: true, found: extracted.length, superseded: supersede.length, scanned: threads.length };
}

const openCommitments = async () => (await pool.query(
  `SELECT who, what, quote, when_text, when_date, when_time, status, first_seen_at
     FROM commitments WHERE status IN ('unbooked','needs_confirm','booked')
     ORDER BY when_date NULLS LAST, first_seen_at`,
)).rows;

async function handleCommitments(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const rows = await openCommitments();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    commitments: rows.map(r => ({
      who: r.who, what: r.what, quote: r.quote,
      when: r.when_date ? `${ymd(r.when_date)}${r.when_time ? ' ' + r.when_time : ''}` : (r.when_text || null),
      whenText: r.when_text, status: r.status, firstSeenAt: r.first_seen_at,
    })),
    unbooked: rows.filter(r => r.status === 'unbooked').length,
  }));
}

// What the chat reads. Prefers the ledger (already extracted, dates resolved,
// reconciled) and falls back to reading the threads live when it is still empty.
async function unbookedForChat(args) {
  const rows = await openCommitments();
  if (!rows.length) return (await getUnbookedJobs(args)).text;
  const line = r => {
    const when = r.when_date
      ? `${ymd(r.when_date)}${r.when_time ? ' at ' + r.when_time : ''}${r.when_text ? ` ("${r.when_text}")` : ''}`
      : (r.when_text ? `no clear date ("${r.when_text}")` : 'no date given');
    return `- ${r.who} — ${r.what} — ${when} — ${r.status}\n    said: "${r.quote}"`;
  };
  const by = s => rows.filter(r => r.status === s).map(line).join('\n');
  const parts = [];
  if (rows.some(r => r.status === 'unbooked')) parts.push(`AGREED BUT NOT IN THE CALENDAR:\n${by('unbooked')}`);
  if (rows.some(r => r.status === 'needs_confirm')) parts.push(`NEEDS CONFIRMING (no clear day, or something else is already on that day):\n${by('needs_confirm')}`);
  if (rows.some(r => r.status === 'booked')) parts.push(`ALREADY IN THE CALENDAR:\n${by('booked')}`);
  return `Work agreed in messages, checked against the calendar. Every line below was quoted verbatim from a real conversation — report them as they are and do not invent any others.\n\n${parts.join('\n\n')}`;
}

// ── Messenger, filtered to work ───────────────────────────
// Personal Messenger carries family and private conversations, so the default
// is to let NOTHING through. A model marks which conversations are about the
// electrical business; only those become items, and only those are ever
// written to the database. An unreadable or unparseable answer means nothing
// is surfaced, which is the safe direction to fail in.
async function workChannel(channel) {
  let rows = [];
  try { ({ rows } = await fetchChannel(channel, 40)); }
  catch (e) { console.error(`${channel}: bridge —`, e.message); return []; }
  if (!rows.length) return [];

  const listing = rows.map((r, i) =>
    `${i}. ${r.name} :: ${String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');

  const prompt = `Jesse is an electrician. Below are the latest lines from his personal ${channel === 'whatsapp' ? 'WhatsApp' : 'Messenger'} conversations.

Say which are about his ELECTRICAL WORK: a quote or estimate, a job or callout, booking a visit, materials or parts, a site or address, an invoice or payment for work, or a tradesman arranging work with him.

Everything else is private and must be left out: family, friends, relationships, kids, social plans, social or family group chats, marketplace, promotions, automated notices, and anything you are unsure about.

A group chat counts as work if it is about jobs, sites, trades or the business - judge it on what is being said, not on it being a group.

Answer with ONLY the numbers of the work conversations, comma separated, for example: 0, 4, 9
If none are about work, answer: none

${listing}`;

  let raw = '';
  try { raw = await askModel(prompt, 400); }
  catch (e) { console.error(`${channel}: model —`, e.message); return []; }

  const picked = new Set((raw.match(/\d+/g) || []).map(Number));
  if (/\bnone\b/i.test(raw) && !picked.size) return [];
  const work = rows.filter((_, i) => picked.has(i));
  console.log(`${channel}: ${work.length} of ${rows.length} conversations read as work`);
  return work;
}

// ── Contact directory ─────────────────────────────────────
// A number on its own tells Jesse nothing and puts nothing in the calendar's
// location field. Switch Craft already holds client_name + address +
// contact_number for every client, so phone -> name + address is a lookup, not
// a guess. Anything learned is written back to `contacts` so the next calendar
// entry doesn't have to work it out again.
//
// Precedence: an address from Switch Craft is authoritative and is never
// overwritten by one guessed from a chat message.

// Deliberately tight: a street number, up to four name words, a street type,
// and optionally suburb/state/postcode. Loose patterns turn "12 Sample Drive"
// in a sentence into a false positive on every number that passes by.

async function rememberContact({ phone, name, address, source }) {
  const id = normalizeIdentifier('sms', phone);
  if (!id) return;
  await pool.query(
    `INSERT INTO contacts (kind, identifier, display_name, address, address_source, last_seen_at)
     VALUES ('sms', $1, $2, $3, $4, NOW())
     ON CONFLICT (kind, identifier) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
       -- switch-craft wins; a chat guess only fills a gap
       address = CASE WHEN EXCLUDED.address_source = 'switch-craft' THEN COALESCE(EXCLUDED.address, contacts.address)
                      WHEN contacts.address IS NULL THEN EXCLUDED.address
                      ELSE contacts.address END,
       address_source = CASE WHEN EXCLUDED.address_source = 'switch-craft' THEN 'switch-craft'
                             WHEN contacts.address IS NULL THEN EXCLUDED.address_source
                             ELSE contacts.address_source END`,
    [id, name || null, address || null, source || null],
  );
}

// Matched on the last 9 digits, which identifies an AU mobile however either
// side formats it.
async function lookupContact(who) {
  const key = phoneLast9(who);
  if (!key) {
    const { rows } = await pool.query(
      `SELECT display_name, address FROM contacts WHERE kind='sms' AND lower(display_name)=lower($1) LIMIT 1`, [String(who || '')]);
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT display_name, address FROM contacts
      WHERE kind='sms' AND right(regexp_replace(identifier, '\\D', '', 'g'), 9) = $1 LIMIT 1`, [key]);
  return rows[0] || null;
}

async function learnFromJobs(jobs = []) {
  for (const j of jobs) {
    if (!j.phone) continue;
    await rememberContact({ phone: j.phone, name: j.identifier, address: j.address, source: 'switch-craft' })
      .catch(e => console.error('directory: job —', e.message));
  }
}

// Fallback: someone texting an address is often the only record of it.
async function learnFromThreads(threads = []) {
  for (const t of threads) {
    const key = phoneLast9(t.name);
    if (!key) continue;
    for (const m of (t.messages || [])) {
      const addr = extractAddress(m.text);
      if (!addr) continue;
      await rememberContact({ phone: t.name, address: addr, source: 'chat' })
        .catch(e => console.error('directory: thread —', e.message));
      break;
    }
  }
}

// ── Next actions: the pressure band ───────────────────────
// Every row here is a state transition the data already shows, not a model
// judgment - a thing agreed but not booked, a job whose day has passed, a job
// still open with nothing booked next. Amber in this app means "act on this
// now", so this is the only place it is earned.
const ONGOING = new Set(['on_my_way', 'in_progress']);
const stamp = (date, time, addH = 0) => {
  const [h, m] = (time || '09:00').split(':').map(Number);
  const d = new Date(`${date}T00:00:00`);
  d.setHours(h + addH, m || 0, 0, 0);
  return `${ymd(d).replace(/-/g, '')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
};
const calendarUrl = (title, date, time, details, location) => {
  if (!date) return null;
  return 'https://calendar.google.com/calendar/u/0/r/eventedit'
    + `?text=${encodeURIComponent(title)}`
    + `&dates=${stamp(date, time)}/${stamp(date, time, 2)}`
    + (location ? `&location=${encodeURIComponent(location)}` : '')
    + (details ? `&details=${encodeURIComponent(details)}` : '');
};

async function nextActions() {
  const today = ymd(new Date());
  const out = [];

  // Agreed in a message, absent from the calendar.
  try {
    const { rows } = await pool.query(
      `SELECT id, who, what, quote, when_date, when_time FROM commitments
        WHERE status = 'unbooked' ORDER BY when_date NULLS LAST, first_seen_at LIMIT 5`);
    for (const r of rows) {
      const when = r.when_date ? ymd(r.when_date) : null;
      const known = await lookupContact(r.who).catch(() => null);
      const who = known?.display_name || r.who;
      out.push({
        id: `book-${r.id}`, kind: 'book',
        urgency: when && when <= today ? 4 : 2,
        title: `Get ${who} in the calendar`,
        detail: `${r.what}${when ? ` — agreed for ${when}` : ', no day pinned down yet'}`
              + `${known?.address ? ` at ${known.address}` : ''}.`,
        quote: r.quote,
        href: calendarUrl(`${r.what} — ${who}`, when, r.when_time, r.quote, known?.address),
        cta: when ? 'add to calendar' : null,
      });
    }
  } catch (e) { console.error('actions: commitments —', e.message); }

  // Jobs whose scheduled day has already passed, and jobs left open.
  let jobs = [];
  try { jobs = (await getSwitchcraftJobs()).items || []; }
  catch (e) { console.error('actions: jobs —', e.message); }

  for (const j of jobs) {
    const past = j.scheduledDate && j.scheduledDate < today;
    const ongoing = ONGOING.has(j.status);
    const href = `${process.env.SWITCHCRAFT_BASE_URL}/admin/jobs/${j.id}`;
    if (past && !ongoing) {
      out.push({
        id: `invoice-${j.id}`, kind: 'invoice', urgency: 5,
        title: `Invoice ${j.identifier}`,
        detail: `${j.when}. If it is finished, invoice it — if it is not, mark it ongoing.`,
        href, cta: 'open the job',
      });
    } else if (ongoing && (past || !j.scheduledDate)) {
      out.push({
        id: `next-${j.id}`, kind: 'next-visit', urgency: 6,
        title: `Book the next visit with ${j.identifier}`,
        detail: past
          ? `Still marked ${String(j.status).replace(/_/g, ' ')} and ${j.when}. Lock the next visit in before it stalls.`
          : `Marked ${String(j.status).replace(/_/g, ' ')} with nothing booked next. Lock the next visit in before it stalls.`,
        href, cta: 'open the job',
      });
    }
  }

  out.sort((a, b) => b.urgency - a.urgency);
  // Four is a list you act on; ten is a second to-do list.
  return out.slice(0, 4);
}

async function handleReportGenerate(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }

  const items = await collectGroundedItems();
  // How long each item has already been on the list, so the per-category synopsis
  // can tell old from new ("some have been sitting a while and may be done").
  const { rows: seen } = await pool.query('SELECT task_id, first_seen_at FROM surfaced_items');
  const firstSeen = new Map(seen.map(r => [r.task_id, r.first_seen_at]));
  for (const t of items) {
    const fs = firstSeen.get(workItemId(t));
    t.daysOnList = fs ? daysOpen(fs) : 0;
  }
  const { work, life } = await groupGrounded(items);
  await Promise.all([persistSummary('work_summary', work), persistSummary('life_summary', life)]);

  // Remember what this report surfaced, so first_seen_at can age items that keep
  // reappearing without being actioned. Done at generate time, not on every GET,
  // so "first seen" means "first reported".
  await recordSurfaced('work', work.categories);
  await recordSurfaced('life', life.categories);

  const scannedAt = new Date().toISOString();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    work: await buildCategorizedResponse(work.summary, work.categories, scannedAt),
    life: await buildCategorizedResponse(life.summary, life.categories, scannedAt),
  }));

  // Refresh the ledger after answering: the report doesn't depend on it, and
  // this keeps the generate latency unchanged while staying serial on LM Studio
  // (the report's own calls are finished by now).
  refreshCommitments()
    .then(r => console.log('commitments:', JSON.stringify(r)))
    .catch(e => console.error('commitments refresh failed:', e.message));
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
    if (req.method === 'GET'  && u === '/api/commitments')     return await handleCommitments(req, res);
    if (req.method === 'POST' && u === '/api/commitments/refresh') {
      if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
      const r = await refreshCommitments();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r));
    }
    if (req.method === 'GET'  && u === '/api/work') return await handleWork(req, res);
    if (req.method === 'GET'  && u === '/api/life') return await handleLife(req, res);
    if (req.method === 'GET'  && u === '/api/tasks') return await handleTasks(req, res);
    const workDoneMatch = u.match(/^\/api\/work\/([a-f0-9]+)\/done$/);
    if (workDoneMatch) return await handleTaskDone(req, res, workDoneMatch[1]);
    const lifeDoneMatch = u.match(/^\/api\/life\/([a-f0-9]+)\/done$/);
    if (lifeDoneMatch) return await handleTaskDone(req, res, lifeDoneMatch[1]);
    const tasksDoneMatch = u.match(/^\/api\/tasks\/([a-f0-9]+)\/done$/);
    if (tasksDoneMatch) return await handleTaskDone(req, res, tasksDoneMatch[1]);
    if (req.method === 'GET' && u === '/api/texts') return await handleTexts(req, res);
    if (req.method === 'GET'  && u === '/api/contacts') return await handleContacts(req, res);
    if (req.method === 'POST' && u === '/api/contacts/signal') return await handleContactSignal(req, res);
    const contactMatch = u.match(/^\/api\/contacts\/(\d+)$/);
    if (req.method === 'PATCH' && contactMatch) return await handleContactTier(req, res, contactMatch[1]);
    if (u === '/api/rules') return await handleRules(req, res);
    const ruleMatch = u.match(/^\/api\/rules\/(\d+)$/);
    if (req.method === 'DELETE' && ruleMatch) return await handleRuleDelete(req, res, ruleMatch[1]);
    if (req.method === 'GET'  && u === '/api/browser/frame') return await handleBrowserFrame(req, res);
    if (req.method === 'POST' && u === '/api/browser/input') return await handleBrowserInput(req, res);
    const jobPhotoMatch = u.match(/^\/api\/job-photo\/(\d+)$/);
    if (req.method === 'GET' && jobPhotoMatch) return await handleJobPhoto(req, res, jobPhotoMatch[1]);
    if (req.method === 'GET'  && u === '/api/item/context') return await handleItemContext(req, res);
    if (req.method === 'POST' && u === '/api/item/tocal')   return await handleItemToCal(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end('internal error'); }
  }
}).listen(PORT, async () => {
  await initDb();
  console.log(`reverb on :${PORT}`);
});
