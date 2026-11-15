import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, createHash } from 'crypto';
import pg from 'pg';
import {
  TEXTS_TOOL, SEARCH_TEXTS_TOOL, searchTexts, CALENDAR_TOOL, EMAIL_TOOL, BUSINESS_EMAIL_TOOL, NOTIFICATIONS_TOOL, SWITCHCRAFT_JOBS_TOOL,
  WAITING_TOOL, getWaitingReplies, UNBOOKED_JOBS_TOOL, getUnbookedJobs, DRAFT_TEXT_TOOL,
  SEARCH_EMAIL_TOOL, searchEmail,
  ADD_TO_CALENDAR_TOOL, TODO_TOOL, MARK_DONE_TOOL,
  MUTE_SENDER_TOOL, LOOKUP_DOSSIER_TOOL,
  getRecentTexts, getRecentTextsBrief, getUpcomingEvents, getRecentEmails, getRecentBusinessEmails, getRecentNotifications, getSwitchcraftJobs,
  fetchThreads, fetchEvents, fetchCalendar, fetchChannel,
} from './src/lib/tools.js';
import { parseExtraction, reconcileStatus, projectCommitments, ymd, msgLine, resolveWhen } from './src/lib/commitments.js';
import { normalizeIdentifier, upsertContact, deriveTier, signalContact, hasMoneyFlag, matchRules,
         extractAddress, extractContactIntro, phoneLast9, hasUnrepliedCall,
         extractQuoteAmount, canonicalPersonKey, cleanDossierValue, mergeDossierFields,
         parseDossierResponse, formatDossierBlock,
         normalizeAddressKey, extractSuburb, extractTradeSignals, deriveDeterministicStage } from './src/lib/contacts.js';
import { enrichReplyOwed, jobUrl, looksLikePhone, bookingWindow, calendarDraftUrl } from './src/lib/actionMeta.js';

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
    -- Topics: the user's own tabs down the left rail. Kinder, daycare,
    -- Peyton's school, receipts - subjects that must never be missed and that
    -- do not belong to either the work or the life report. A topic is just a
    -- few substrings; matching is done in code like every other rule, so a
    -- topic always catches what it says it catches.
    CREATE TABLE IF NOT EXISTS topics (
      id         SERIAL PRIMARY KEY,
      slug       TEXT UNIQUE NOT NULL,
      label      TEXT NOT NULL,
      patterns   TEXT NOT NULL,
      summary    TEXT,
      summary_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- One row per matching item, kept forever: this is the dated record you
    -- scroll back through, so it is deliberately not rebuilt from the current
    -- inbox (mail ages out of a 10-item pull in a day). item_id is the same
    -- content hash the reports use, so the same email never files twice.
    CREATE TABLE IF NOT EXISTS topic_entries (
      id         SERIAL PRIMARY KEY,
      topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      item_id    TEXT NOT NULL,
      kind       TEXT,
      from_label TEXT,
      subject    TEXT,
      snippet    TEXT,
      seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at    TIMESTAMPTZ,
      UNIQUE (topic_id, item_id)
    );
    -- A band row he has dealt with. Keyed by the row id AND a fingerprint of
    -- the state that justified it, so "done" means "I handled this", not
    -- "never show me this again": when the client sends something new, the
    -- fingerprint changes and the row comes back.
    CREATE TABLE IF NOT EXISTS action_done (
      action_id TEXT PRIMARY KEY,
      fact      TEXT NOT NULL,
      done_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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
    -- What the job actually is, in a sentence, read off the thread the
    -- commitment came from. The extractor's WHAT is a few words copied out of
    -- one line ("put them in"), which is not something you can turn up to.
    ALTER TABLE commitments ADD COLUMN IF NOT EXISTS detail TEXT;
    -- Permanent archive of every surfaced item across channels, plus raw thread
    -- messages and a progressively accumulated per-person dossier so context
    -- never disappears when an inbox rolls over.
    CREATE TABLE IF NOT EXISTS item_archive (
      item_id       TEXT PRIMARY KEY,
      person_key    TEXT NOT NULL,
      kind          TEXT NOT NULL,
      from_label    TEXT NOT NULL,
      phone         TEXT,
      email         TEXT,
      address       TEXT,
      subject       TEXT,
      title         TEXT,
      snippet       TEXT,
      brief         TEXT,
      when_text     TEXT,
      status        TEXT,
      job_id        INTEGER,
      meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_item_archive_person ON item_archive (person_key, last_seen_at DESC);
    CREATE TABLE IF NOT EXISTS message_archive (
      id          SERIAL PRIMARY KEY,
      person_key  TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      sender_name TEXT,
      outbound    BOOLEAN NOT NULL DEFAULT FALSE,
      msg_at      TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL,
      seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (thread_key, outbound, msg_at, body)
    );
    CREATE INDEX IF NOT EXISTS idx_message_archive_person ON message_archive (person_key, id ASC);
    CREATE TABLE IF NOT EXISTS person_dossiers (
      person_key      TEXT PRIMARY KEY,
      display_name    TEXT,
      phone           TEXT,
      email           TEXT,
      address         TEXT,
      address_source  TEXT,
      business        TEXT,
      channels        TEXT[] NOT NULL DEFAULT '{}',
      job_ids         INTEGER[] NOT NULL DEFAULT '{}',
      work_scope      TEXT,
      quote_estimate  TEXT,
      parts_materials TEXT,
      preferred_times TEXT,
      access_notes    TEXT,
      current_stage   TEXT,
      open_next_step  TEXT,
      summary_notes   TEXT,
      source_hash     TEXT,
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    // First-run only. Once a PIN exists, replacing it needs a valid session:
    // without this anyone could overwrite the PIN and be handed an owner token.
    const existing = await pool.query("SELECT 1 FROM settings WHERE key='owner_pin_hash'");
    if (existing.rows.length && !requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
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

const TOOLS = [DRAFT_TEXT_TOOL, ADD_TO_CALENDAR_TOOL, TODO_TOOL, MARK_DONE_TOOL, MUTE_SENDER_TOOL, LOOKUP_DOSSIER_TOOL, SEARCH_EMAIL_TOOL, WAITING_TOOL, UNBOOKED_JOBS_TOOL, TEXTS_TOOL, SEARCH_TEXTS_TOOL, CALENDAR_TOOL, EMAIL_TOOL, BUSINESS_EMAIL_TOOL, NOTIFICATIONS_TOOL, SWITCHCRAFT_JOBS_TOOL];

// ── What the chat can do, not just read ───────────────────
// The bot had every source and a send button but no way to finish anything:
// it could tell you a job wasn't booked and then leave you to book it. These
// three close that loop, and each one maps onto a button the cards already
// have, so the two surfaces can't drift into doing different things.

async function calendarForChat(args = {}) {
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(args.date))) {
    return 'No event was created: a real date in YYYY-MM-DD form is required. Ask the user which day, or work it out from today, and call again.';
  }
  // The two things only he knows, enforced here rather than left to the tool
  // description: a model that is merely asked to check will book an hour with
  // no parts the first time it is in a hurry. durationMins must be given, and
  // parts must be answered either way ("none" is a real answer).
  if (!Number(args.durationMins)) {
    return 'Nothing was created yet. Ask the user how long the job will take, then call add_to_calendar again with durationMins set. Do not guess a duration.';
  }
  if (args.parts === undefined || args.parts === null || String(args.parts).trim() === '') {
    return 'Nothing was created yet. Ask the user whether the job needs any parts. Call add_to_calendar again with parts listing what to bring, or parts set to "none" if they say it needs nothing. Do not assume.';
  }
  const known = args.contact ? await lookupContact(args.contact).catch(() => null) : null;
  const raw = String(args.parts).trim();
  const parts = /^(none|no|nothing|n\/a)$/i.test(raw) ? '' : raw;
  const base = String(args.title || 'Job').slice(0, 150);
  const title = parts ? `${base} [parts]` : base;
  const isWork = args.bucket !== 'life' && args.work !== false;
  const booking = await createCalendarBooking({
    title,
    date: args.date,
    time: /^\d{1,2}:\d{2}$/.test(String(args.time || '')) ? args.time : '',
    durationMins: Number(args.durationMins),
    place: args.location || known?.address || null,
    details: [
      parts ? `PARTS TO BRING: ${parts}` : 'No parts needed.',
      `Allowed ${Number(args.durationMins)} minutes.`,
      `Added from Vita Switch chat${known?.display_name ? ` — ${known.display_name}` : ''}.`,
    ].join('\n'),
    isWork,
  });
  const when = `${args.date}${args.time ? ` at ${args.time}` : ' (all day)'}`;
  if (booking.saved) {
    const colorNote = booking.colorId === '6' ? ' (Mango)' : '';
    return `Saved to your ${booking.calendar}${colorNote} calendar for ${when}: ${booking.url}`;
  }
  return `A pre-filled event for ${when} is ready, but it is NOT saved. Give the user this link exactly as it is, on its own line, and tell them to open it and press save in the calendar: ${booking.url}`;
}

async function todoForChat({ bucket = 'all' } = {}) {
  let list;
  try { list = await buildTaskList(); }
  catch (e) { return `Could not read the to-do list: ${e.message}`; }
  const cats = (list.categories || [])
    .filter(c => bucket === 'all' || c.bucket === bucket);
  if (!cats.length) return 'The to-do list is empty — nothing is outstanding.';
  const block = cats.map(c => {
    const rows = c.items.map(t => {
      const age = daysOpen(t.firstSeenAt);
      return `  - [id ${t.id}] (${t.kind}${t.from ? `, ${t.from}` : ''}) ${String(t.text || '').replace(/\s+/g, ' ')}`
        + `${t.when ? ` — ${t.when}${t.overdue ? ' OVERDUE' : ''}` : ''}`
        + `${age >= 2 ? ` — sitting ${age} days` : ''}`
        + `${t.brief ? `\n      where it stands: ${t.brief}` : ''}`;
    }).join('\n');
    return `${c.label} (${c.bucket}):${c.synopsis ? `\n  ${c.synopsis}` : ''}\n${rows}`;
  }).join('\n\n');
  return `The user's to-do list as the app ranks it, highest first. ${list.summary}\n\n${block}\n\nThe ids are needed for mark_item_done. Answer from this list; do not go and re-read the raw sources.`;
}

// "Stop showing me their promos." Same tier the card's button sets, so the
// two routes cannot drift: muted keeps anything with money in it and drops
// the rest.
async function muteForChat({ kind, from, name } = {}) {
  const identifier = normalizeIdentifier(kind, from);
  if (!kind || !identifier) return 'Nothing was muted: both the kind (email, bizemail, sms, ...) and the sender address or number are required. Get them from get_todo_list.';
  try {
    await upsertContact(pool, kind, identifier, name || from);
    await pool.query('UPDATE contacts SET tier=$1 WHERE kind=$2 AND identifier=$3', ['muted', kind, identifier]);
  } catch (e) { return `Could not mute ${identifier}: ${e.message}`; }
  return `${identifier} is muted. Tell the user that their marketing and general mail will stop appearing, but anything about an invoice, receipt, payment or quote from them still comes through, and they can undo it in the People drawer.`;
}

async function markDoneForChat({ id, kind, from } = {}) {
  if (!id || !/^[a-f0-9]{6,}$/.test(String(id))) {
    return 'Nothing was marked done: a valid item id from get_todo_list is required. Call get_todo_list and use the id it gives for the item the user means.';
  }
  try {
    await pool.query('INSERT INTO swept_done (task_id) VALUES ($1) ON CONFLICT (task_id) DO NOTHING', [id]);
    if (kind && from) await signalContact(pool, kind, normalizeIdentifier(kind, from), 'dismiss').catch(() => {});
    return `Item ${id} is cleared off the to-do list. Confirm that briefly; it is gone from the user's cards already.`;
  } catch (e) { return `Could not mark it done: ${e.message}`; }
}

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
      if (tc.function.name === 'draft_text') {
        const who = await resolveRecipient(args.to);
        const body = String(args.message || '').trim();
        const channel = ['sms', 'whatsapp', 'messenger'].includes(args.channel) ? args.channel : 'sms';
        // The UI renders this as a card with a send button. Nothing is sent here.
        res.write(`data: ${JSON.stringify({ type: 'draft', to: who.number, name: who.name, message: body, channel })}\n\n`);
        toolMessages.push({
          role: 'tool', tool_call_id: tc.id,
          content: (who.number || channel !== 'sms')
            ? `A ${channel} draft to ${who.name || who.number} is now in front of the user with a send button. It has NOT been sent. Tell them it is ready and let them press send; do not claim you sent it.`
            : `No phone number is on file for "${args.to}", so nothing can be drafted to them. Tell the user that and ask for the number.`,
        });
      } else if (tc.function.name === 'add_to_calendar') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Opening the calendar…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await calendarForChat(args) });
      } else if (tc.function.name === 'get_todo_list') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Reading the to-do list…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await todoForChat(args) });
      } else if (tc.function.name === 'mute_sender') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Muting that sender…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await muteForChat(args) });
      } else if (tc.function.name === 'mark_item_done') {
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await markDoneForChat(args) });
      } else if (tc.function.name === 'get_waiting_replies') {
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
      } else if (tc.function.name === 'search_email') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: `Searching email for “${args.query || ''}”…` })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: (await searchEmail(args)).text });
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
      } else if (tc.function.name === 'lookup_client_dossier') {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Checking stored client dossiers…' })}\n\n`);
        toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: await lookupDossierForChat(args) });
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
    const money = hasMoneyFlag(`${item.subject || ''} ${item.snippet || ''}`);
    // Muted means "only when there is money in it", not total silence. The
    // promo and the receipt arrive from the same sender, so silencing the
    // sender outright loses the receipt too - which is the one thing worth
    // keeping. An `ignore` RULE is still absolute; that one is typed on purpose.
    if (tier === 'muted' && !money) continue;
    const ruleHit = matchRules(`${item.displayName || ''} ${identifier} ${item.subject || ''} ${item.snippet || ''}`, rules);
    if (ruleHit === 'ignore') continue;
    const annotated = {
      ...item, identifier, tier,
      moneyFlag: money,
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

// Clear a band row. The fact fingerprint comes back with it, so the row stays
// gone only while nothing about it has changed - a new message from the client
// brings it straight back rather than leaving it dismissed forever.
async function handleActionDone(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { id, fact, done = true } = JSON.parse(await readBody(req));
  if (!id) { res.writeHead(400); res.end('{"error":"id required"}'); return; }
  if (done) {
    await pool.query(
      `INSERT INTO action_done (action_id, fact) VALUES ($1, $2)
       ON CONFLICT (action_id) DO UPDATE SET fact = EXCLUDED.fact, done_at = now()`,
      [id, String(fact ?? '')]);
  } else {
    await pool.query('DELETE FROM action_done WHERE action_id=$1', [id]);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// Re-check every open commitment against the calendar. Shared by the band's
// check button and the full refresh, so both answer "is it booked?" the same
// way. Only a definite match clears one; needs_confirm means something is on
// that day but nothing ties it to this job, and is counted, never acted on.
// A calendar nobody can read looks exactly like an empty one, and an empty one
// means "nothing is booked" - which is how the app spent weeks telling him jobs
// were not in a diary it could not see. A working week always has something in
// it, so no events at all across a seven-week window means the feed is dark,
// not the diary.
// Ask, do not infer. A frozen feed with one stale event still inside the
// window reads as live to any heuristic - which is exactly the state this was
// written for, so the heuristic alone would have missed the very case it was
// meant to catch. LIFE_CMD knows whether its Google token is alive; the window
// check below survives only as a fallback for when it cannot be reached.
async function calendarUnreadable({ events = [], source = 'none' } = {}) {
  // Read straight from the browser: that is the session he is signed into, so
  // if it answered, the calendar is readable. No token to interrogate.
  if (source === 'browser') return false;
  if (source === 'none') return true;
  // Only the LIFE_CMD fallback needs the token question asked of it.
  try {
    const r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/google/status`,
                          { signal: AbortSignal.timeout(6000) });
    if (r.ok) return !(await r.json()).connected;
  } catch { /* fall back to the shape of the data */ }
  return calendarIsDark(events);
}

function calendarIsDark(events = []) {
  const from = ymd(new Date(Date.now() - 7 * 86400000));
  const to = ymd(new Date(Date.now() + 42 * 86400000));
  return !events.some(e => {
    const d = String(e.date || '').slice(0, 10);
    return d >= from && d <= to;
  });
}

async function reconcileOpenCommitments() {
  let booked = 0, unsure = 0, blind = false;
  try {
    const cal = await fetchCalendar({ fresh: true });
    const events = cal.events;
    if (await calendarUnreadable(cal)) {
      // Do not touch a single status. Everything would read as unbooked, which
      // is the safe thing to show but a lie to act on.
      const { rows } = await pool.query(
        "SELECT count(*)::int n FROM commitments WHERE status = 'unbooked'");
      return { booked: 0, unsure: rows[0].n, blind: true };
    }
    const { rows } = await pool.query(
      "SELECT id, who, what, when_date FROM commitments WHERE status = 'unbooked'");
    for (const r of rows) {
      const status = reconcileStatus(
        { who: r.who, what: r.what, date: r.when_date ? ymd(r.when_date) : null }, events);
      if (status === 'booked') {
        await pool.query("UPDATE commitments SET status = 'booked' WHERE id = $1", [r.id]);
        booked++;
      } else if (status === 'needs_confirm') unsure++;
    }
  } catch (e) { console.error('reconcile:', e.message); blind = true; }
  return { booked, unsure, blind };
}

// Which sources can actually be read, straight from the bridge. A signed-out
// tab is the failure that empties every list while the app looks fine, so it
// has to be answerable at a glance rather than discovered when a day's work
// quietly goes missing.
async function handleSources(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  try {
    const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/sources`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
      signal: AbortSignal.timeout(240000),
    });
    const body = r.ok ? await r.json() : { ok: false, error: `bridge status ${r.status}` };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `bridge unreachable: ${e.message}` }));
  }
}

// Verify instead of trusting. Every band row is derived from state that can be
// re-checked, so a refresh re-reads the sources and lets the rows that are
// genuinely done fall away on the evidence rather than on a button press. The
// jobs feed and the waiting index are already read live on every call; the one
// thing that was not was the calendar, which only reconciled on a timer - so
// adding an event and expecting the row to go was a wait, not an action.
//
// Only a definite match clears a booking. reconcileStatus also returns
// needs_confirm, meaning "something is on that day but nothing ties it to this
// job"; that is reported, never used to clear, because the whole point here is
// that nothing disappears unless it has been proven done.
async function handleActionsRefresh(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const before = await nextActions().catch(() => []);
  const { booked, unsure, blind } = await reconcileOpenCommitments();
  const after = await nextActions().catch(() => []);
  const cleared = before.filter(b => !after.some(a => a.id === b.id))
                        .map(b => ({ kind: b.kind, title: b.title }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, actions: after, cleared, booked, unsure, blind }));
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

// Contact list + unified person dossiers for the People drawer.
async function handleContacts(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const [directory, { rows: contactRows }, { rows: itemStats }, { rows: msgStats }] = await Promise.all([
    loadPersonDirectory().catch(() => ({ byPhone: {}, byName: {}, byEmail: {}, byKey: new Map() })),
    pool.query('SELECT id, kind, identifier, display_name, tier, address, address_source, seen_count, replied_count, dismissed_count, last_seen_at FROM contacts ORDER BY seen_count DESC, last_seen_at DESC LIMIT 200'),
    pool.query('SELECT person_key, COUNT(*)::int AS cnt FROM item_archive GROUP BY person_key'),
    pool.query('SELECT person_key, COUNT(*)::int AS cnt FROM message_archive GROUP BY person_key'),
  ]);
  const itemCounts = new Map(itemStats.map(r => [r.person_key, r.cnt]));
  const msgCounts = new Map(msgStats.map(r => [r.person_key, r.cnt]));
  const seenKeys = new Set();
  const out = contactRows.map(c => {
    const pKey = canonicalPersonKey({ kind: c.kind, from: c.identifier, name: c.display_name }, directory);
    seenKeys.add(pKey);
    const dRow = directory.byKey.get(pKey) || null;
    return {
      ...c,
      personKey: pKey,
      dossier: dRow ? toDossierDto(dRow) : null,
      itemCount: itemCounts.get(pKey) || 0,
      messageCount: msgCounts.get(pKey) || 0,
    };
  });
  for (const [pKey, dRow] of directory.byKey.entries()) {
    if (seenKeys.has(pKey)) continue;
    out.push({
      id: null,
      kind: dRow.channels?.[0] || 'sms',
      identifier: dRow.phone || dRow.email || dRow.display_name || pKey,
      display_name: dRow.display_name || null,
      tier: null,
      address: dRow.address || null,
      address_source: dRow.address_source || null,
      seen_count: itemCounts.get(pKey) || 0,
      replied_count: 0,
      dismissed_count: 0,
      last_seen_at: dRow.updated_at || dRow.first_seen_at || null,
      personKey: pKey,
      dossier: toDossierDto(dRow),
      itemCount: itemCounts.get(pKey) || 0,
      messageCount: msgCounts.get(pKey) || 0,
    });
  }
  out.sort((a, b) => (b.itemCount + b.messageCount + (b.seen_count || 0)) - (a.itemCount + a.messageCount + (a.seen_count || 0)));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out.slice(0, 250)));
}

const DOSSIER_EDIT_MAP = {
  displayName: 'display_name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  business: 'business',
  workScope: 'work_scope',
  quoteEstimate: 'quote_estimate',
  partsMaterials: 'parts_materials',
  preferredTimes: 'preferred_times',
  accessNotes: 'access_notes',
  currentStage: 'current_stage',
  openNextStep: 'open_next_step',
  summaryNotes: 'summary_notes',
};

async function handleDossierPatch(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const body = JSON.parse(await readBody(req) || '{}');
  const personKey = String(body.personKey || '').trim();
  if (!personKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'personKey is required' }));
    return;
  }
  const { rows: [existing] } = await pool.query('SELECT * FROM person_dossiers WHERE person_key = $1', [personKey]);
  const next = existing ? { ...existing } : { person_key: personKey, channels: [], job_ids: [] };
  for (const [camel, snake] of Object.entries(DOSSIER_EDIT_MAP)) {
    if (body[camel] !== undefined) next[snake] = cleanDossierValue(body[camel]);
    else if (body[snake] !== undefined) next[snake] = cleanDossierValue(body[snake]);
  }
  if (body.address !== undefined) next.address_source = next.address ? 'manual' : null;
  const { rows: [saved] } = await pool.query(
    `INSERT INTO person_dossiers (
       person_key, display_name, phone, email, address, address_source, business,
       channels, job_ids, work_scope, quote_estimate, parts_materials, preferred_times,
       access_notes, current_stage, open_next_step, summary_notes, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (person_key) DO UPDATE SET
       display_name=EXCLUDED.display_name, phone=EXCLUDED.phone, email=EXCLUDED.email,
       address=EXCLUDED.address, address_source=EXCLUDED.address_source, business=EXCLUDED.business,
       work_scope=EXCLUDED.work_scope, quote_estimate=EXCLUDED.quote_estimate,
       parts_materials=EXCLUDED.parts_materials, preferred_times=EXCLUDED.preferred_times,
       access_notes=EXCLUDED.access_notes, current_stage=EXCLUDED.current_stage,
       open_next_step=EXCLUDED.open_next_step, summary_notes=EXCLUDED.summary_notes,
       updated_at=NOW()
     RETURNING *`,
    [
      personKey, next.display_name || null, next.phone || null, next.email || null,
      next.address || null, next.address_source || null, next.business || null,
      next.channels || [], next.job_ids || [],
      next.work_scope || null, next.quote_estimate || null, next.parts_materials || null,
      next.preferred_times || null, next.access_notes || null, next.current_stage || null,
      next.open_next_step || null, next.summary_notes || null,
    ]
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, dossier: toDossierDto(saved) }));
}

async function handleContactTier(req, res, id) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { tier } = JSON.parse(await readBody(req));
  if (tier !== null && !['vip', 'normal', 'muted'].includes(tier)) { res.writeHead(400); res.end('{}'); return; }
  await pool.query('UPDATE contacts SET tier=$1 WHERE id=$2', [tier, id]);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// One press from a card: stop this sender filling the list with promos while
// keeping anything with money in it. Identified by kind+from the way every
// other contact write is, so it works for a sender never opened in the People
// drawer. Reversible there (set the tier back to normal).
async function handleContactMute(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { kind, from, name, tier = 'muted' } = JSON.parse(await readBody(req));
  const identifier = normalizeIdentifier(kind, from);
  if (!kind || !identifier) { res.writeHead(400); res.end(JSON.stringify({ error: 'kind and from are required' })); return; }
  if (!['muted', 'normal', 'vip'].includes(tier)) { res.writeHead(400); res.end('{}'); return; }
  await upsertContact(pool, kind, identifier, name || from);
  await pool.query('UPDATE contacts SET tier=$1 WHERE kind=$2 AND identifier=$3', [tier, kind, identifier]);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, tier, identifier }));
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
  const [directory, { rows: doneRows }, { rows: seenRows }] = await Promise.all([
    loadPersonDirectory().catch(() => null),
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
          const href = t.href || (t.kind === 'job' ? jobUrl(process.env.SWITCHCRAFT_BASE_URL, t.jobId) : null);
          const dRow = directory ? lookupDossierInDir(t, directory) : null;
          const dossier = dRow ? toDossierDto(dRow) : (t.dossier || null);
          const displayName = dRow?.display_name || t.displayName || null;
          const address = t.address || dRow?.address || null;
          let text = t.text;
          if (phoneLast9(t.from) && typeof text === 'string' && text.includes(t.from)) {
            if (/^reply to\b/i.test(text) || text.startsWith(`${t.from} tried to call`)) {
              if (displayName && displayName !== t.from) {
                text = text.replace(t.from, `${displayName} (${t.from})`);
              } else if (address) {
                text = `${text} — ${address}`;
              }
            }
          }
          return {
            ...t,
            id,
            text,
            ...(href ? { href } : {}),
            ...(dRow?.person_key || t.personKey ? { personKey: dRow?.person_key || t.personKey } : {}),
            ...(dossier ? { dossier } : {}),
            address,
            phone: t.phone || dRow?.phone || null,
            displayName,
            firstSeenAt: firstSeen.get(id) || scannedAt,
          };
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
  const payload = await buildTaskList();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// The to-do list, exactly as the cards see it. Factored out so the chat can
// answer "what's on my list" from the same ranked data rather than re-reading
// every source and arriving at a different answer than the screen shows.
async function buildTaskList() {
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

  return { actions: await nextActions().catch(() => []), summary, categories, scannedAt, outstanding: chase };
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
const BROWSER_SOURCES = ['messages', 'whatsapp', 'messenger', 'email', 'bizemail', 'meta', 'calendar'];
const SOURCE_ALIAS = { messages: 'sms' }; // UI label -> bridge source key

async function handleBrowserFrame(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const label = new URL(req.url, 'http://x').searchParams.get('source');
  if (!BROWSER_SOURCES.includes(label)) { res.writeHead(404); res.end('{}'); return; }
  const source = SOURCE_ALIAS[label] || label;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  try {
    const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/frame?source=${source}`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
      signal: ctrl.signal,
    });
    if (!r.ok) { res.writeHead(502); res.end('{}'); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Content-Length': buf.length,
      'X-Viewport': r.headers.get('x-viewport') || '', 'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
  finally { clearTimeout(timer); }
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

// Only sms threads get a model-written brief (they are the only ones the
// bridge can read back), so every other row's title has to carry the content
// itself. A bare "Reply to <name>" told you nothing you could act on; the
// message does. The id hashes from|snippet, not text, so retitling an item
// does not resurrect something already dismissed.
const callFlagTitle = who => `${who} tried to call and I can't see a reply`;

function replyTitle(kind, who, snippet, intro = null) {
  if (hasUnrepliedCall(snippet)) return callFlagTitle(who);
  if (intro?.isDetailsDrop) {
    const label = intro.name || who;
    return intro.address ? `Follow up with ${label} — ${intro.address}` : `Follow up with ${label}`;
  }
  if (kind === 'sms' || kind === 'meta') return `Reply to ${who}`;
  const line = String(snippet || '').replace(/\s+/g, ' ').trim();
  return line ? `${who}: ${line.slice(0, 120)}` : `Reply to ${who}`;
}

// Deterministic half: read every source and annotate from the rules and the
// contact directory. No model call anywhere in here, which is what lets the
// scheduler run it often and only pay for the model when something changed.
async function collectRawItems() {
  // Unbooked jobs is deliberately NOT here: its .items are the raw messages it
  // inspects, not the jobs it finds (the finding is a model judgment on .text),
  // so pulling .items would label every recent text a "job". It stays a chat
  // tool you can ask explicitly. Waiting replies already surface the job-
  // agreement texts, and switch-craft covers actual bookings.
  const [waiting, jobs, email, bizEmail, personal] = await Promise.all([
    getWaitingReplies({ limit: 25 }).catch(() => ({ items: [] })),
    getSwitchcraftJobs().catch(() => ({ items: [] })),
    getRecentEmails({ limit: 10 }).catch(() => ({ items: [] })),
    getRecentBusinessEmails({ limit: 10 }).catch(() => ({ items: [] })),
    // Sequential, not parallel: the bridge drives a single browser, so two
    // concurrent tab reads contend and one silently comes back empty.
    (async () => ({
      messenger: await workChannel('messenger').catch(e => { console.error('messenger:', e.message); return []; }),
      whatsapp:  await workChannel('whatsapp').catch(e => { console.error('whatsapp:', e.message); return []; }),
    }))(),
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
    const intro = extractContactIntro(w.snippet);
    items.push({ kind: w.kind || 'sms', from: w.identifier, snippet: w.snippet,
                 text: replyTitle(w.kind || 'sms', w.identifier, w.snippet, intro),
                 reply: true, hintBucket: intro.isDetailsDrop ? 'work' : null });
  }
  // record what each source said about itself, for the watchdog
  noteHealth('personal email', email.health || 'ok');
  noteHealth('business email', bizEmail.health || 'ok');

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
                 href: jobUrl(process.env.SWITCHCRAFT_BASE_URL, j.id),
                 address: j.address, phone: j.phone, business: j.business,
                 preferredDays: j.preferredDays, timeline: j.timeline,
                 tasks: j.tasks, noteCount: j.noteCount, photoCount: j.photoCount,
                 photos: j.photos, lastNote: j.lastNote, raised: j.raised,
                 text: title.slice(0, 140), hintBucket: 'work' });
  }
  for (const m of personal.messenger || [])
    items.push({ kind: 'messenger', from: m.name, snippet: m.snippet, when: m.when,
                 text: replyTitle('messenger', m.name, m.snippet), reply: true, hintBucket: 'work' });

  for (const m of personal.whatsapp || [])
    items.push({ kind: 'whatsapp', from: m.name, snippet: m.snippet, when: m.when,
                 text: replyTitle('whatsapp', m.name, m.snippet), reply: true, hintBucket: 'work' });

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
  await archiveItemsAndThreads(items).catch(e => console.error('archive items:', e.message));
  return annotateGrounded(items);
}

// The full read: the facts, plus the model-written conversation briefs.
async function collectGroundedItems() {
  return briefConversations(await collectRawItems());
}

// A one-line snippet ("Yes Tuesday next week is good for us") carries none of
// the story - what the work is, what was proposed, what is still missing. This
// reads each conversation back and writes a short brief in plain English, so a
// card says where things actually stand instead of quoting the last message.
// One call covering every conversation on the report; grounded in the messages
// only, and silently skipped if the bridge or the model is unavailable.
const CONVO_KINDS = new Set(['sms', 'meta', 'whatsapp', 'messenger', 'email', 'bizemail']);

function mergeThreadMessages(archived = [], live = []) {
  const out = archived.map(m => ({ outbound: !!m.outbound, text: String(m.text || '') })).filter(m => m.text);
  const seen = new Set(out.map(m => `${m.outbound ? 1 : 0}:${m.text.trim()}`));
  for (const m of live || []) {
    const text = String(m?.text || '');
    if (!text.trim()) continue;
    const key = `${m.outbound ? 1 : 0}:${text.trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ outbound: !!m.outbound, text });
    }
  }
  return out;
}

async function briefConversations(items) {
  const convo = items.filter(t => CONVO_KINDS.has(t.kind));
  if (!convo.length) return items;

  let threads = [];
  try { threads = await fetchThreads(35); }
  catch (e) { console.error('briefs: bridge unreachable —', e.message); }

  const digits = v => String(v || '').replace(/\D/g, '');
  const findThread = from => {
    const f = String(from || '').toLowerCase().trim();
    const d = digits(from);
    return threads.find(t => String(t.name || '').toLowerCase().trim() === f)
        || threads.find(t => d.length >= 9 && digits(t.name).includes(d.slice(-9)))
        || threads.find(t => f.length > 2 && String(t.name || '').toLowerCase().includes(f));
  };

  if (threads.length) {
    await learnFromThreads(threads).catch(e => console.error('directory:', e.message));
    await archiveItemsAndThreads(items, threads).catch(e => console.error('archive threads:', e.message));
  }

  const contexts = await Promise.all(
    convo.map(t => (t.personKey && t.personKey !== 'unknown'
      ? loadPersonContext(t.personKey).catch(() => ({ dossier: null, messages: [], history: [] }))
      : Promise.resolve({ dossier: null, messages: [], history: [] })))
  );

  const pairs = [];
  for (let idx = 0; idx < convo.length; idx++) {
    const t = convo[idx];
    const ctx = contexts[idx];
    const th = (t.kind === 'sms' || t.kind === 'meta') ? findThread(t.from) : null;
    const msgs = mergeThreadMessages(ctx.messages, th?.messages || []);
    if (th && hasUnrepliedCall(t.snippet, msgs)) t.text = callFlagTitle(t.from);
    const dBlock = formatDossierBlock(t.dossier || ctx.dossier);
    if (msgs.length > 1 || dBlock || ctx.history.length > 1) {
      pairs.push({ item: t, thread: th, msgs, dBlock, label: th?.name || t.displayName || t.from });
    }
    if (pairs.length >= 25) break;
  }
  if (!pairs.length) {
    console.error(`briefs: none of ${convo.length} conversations had multi-message or dossier context`);
    return items;
  }

  const CHUNK = 8;
  const now = new Date();
  const todayLabel = `${now.toLocaleDateString('en-AU', { weekday: 'long' })} ${ymd(now)}`;
  let written = 0;

  for (let start = 0; start < pairs.length; start += CHUNK) {
    const chunk = pairs.slice(start, start + CHUNK);
    const listing = chunk.map((p, i) => {
      const lines = p.msgs.slice(-14)
        .map(m => `    ${m.outbound ? 'you' : 'them'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}`)
        .join('\n');
      const fallbackLine = `    latest (${p.item.kind}): ${String(p.item.snippet || '').replace(/\s+/g, ' ').slice(0, 200)}`;
      return `${i}. ${p.label}${p.dBlock ? `\n   Known dossier: ${p.dBlock}` : ''}\n${lines || fallbackLine}`;
    }).join('\n\n');

    const prompt = `Today is ${todayLabel}. Below are text conversations and stored client dossiers between Jesse, an electrician ("you"), and other people.

For EACH numbered conversation write ONE line, exactly:
<number> :: <brief>

The brief is 2-4 short sentences written TO Jesse as "you", in plain spoken English, like an assistant who has just read the thread back for him. Use the Known dossier (prior stored facts, address, quote, or Switch Craft job info) as background context, and prefer newer messages if anything changed. Cover, only where the messages or dossier actually show it:
- what this has been about, and roughly how long it has been going on
- what was most recently proposed or agreed
- what is still missing (a time, a date, a price, a confirmation)
- the single next thing worth doing

Carrier alerts ("... called. No Voicemail message was left ... free call 147") mean they tried to call, and "buzz" / "buzz if can" / "call plz" means they are asking for a phone call. Reverb can only see text messages — not phone calls — so when they tried to call or asked for a buzz/call with no text reply after it, lead plainly with that (e.g. they tried to call and you can't see a reply in texts) before noting any earlier context.

Tone to match: "You and this client have been going back and forth for a couple of weeks about installing a new oven. You asked about Tuesday next week, they agreed but haven't given you a time. Worth pinning that down, then it can go on the calendar."

Ground every word in the messages and dossiers shown. Never state a job, name, date, price or promise that is not in the material. Where something has not been said, say it is not clear rather than guessing. No greeting, no preamble, no markdown, no numbering beyond the required "<number> :: ".

CONVERSATIONS:
${listing}`;

    let raw = '';
    try { raw = await askModel(prompt, 1600); }
    catch (e) { console.error('briefs: model call failed —', e.message); continue; }
    if (!raw.trim()) { console.error('briefs: model returned empty content'); continue; }

    for (const line of String(raw).split('\n')) {
      // The model answers "0. Some Name :: ..." - it numbers with a full stop
      // and repeats the thread name before the separator, even when told not to.
      // Take the leading index, then everything after the first "::".
      const m = line.match(/^\s*(\d+)\s*[.)]?\s*(.*)$/);
      if (!m) continue;
      const sep = m[2].indexOf('::');
      if (sep === -1) continue;
      const p = chunk[Number(m[1])];
      if (!p) continue;
      const text = m[2].slice(sep + 2).trim();
      if (text.length > 20) {
        p.item.brief = text.slice(0, 600);
        await pool.query('UPDATE item_archive SET brief = $1 WHERE item_id = $2', [p.item.brief, workItemId(p.item)]).catch(() => {});
        written++;
      }
    }
  }
  console.log(`briefs: ${written} written for ${pairs.length} matched threads (${convo.length} conversations)`);
  return items;
}

// The deterministic rule layer — the part you can trust, because no model
// touches it. Runs over the grounded facts before they're grouped:
//   - an `ignore` rule drops the item entirely, and a muted contact drops it
//     unless it is about money (see the mute route: "only invoices from them");
//   - a `priority` rule, a VIP contact, or an invoice/payment keyword flags it
//     so /api/tasks floats it to the top of the list.
// Rules and contact tiers come from the user's own Rules/People drawers, matched
// in code (matchRules/deriveTier), so a rule always sticks regardless of what
// the model does next. This is what moved the user's rules from the old dead
// pull path onto the live report.
async function annotateGrounded(items) {
  const [{ rows: rules }, { rows: contactRows }, { rows: topics }] = await Promise.all([
    pool.query('SELECT pattern, action FROM rules'),
    pool.query('SELECT kind, identifier, tier, seen_count, replied_count, dismissed_count, last_seen_at FROM contacts'),
    pool.query('SELECT id, slug, label, patterns FROM topics'),
  ]);
  const tierOf = new Map(contactRows.map(c => [`${c.kind}|${c.identifier}`, deriveTier(c)]));
  const out = [];
  for (const t of items) {
    // A topic tab is a standing instruction: "always tell me about this".
    // So it outranks every drop below it - a muted sender, an ignore rule,
    // anything. Missing a kinder closure because the sender was muted months
    // ago is exactly the failure these tabs exist to prevent.
    const hits = topicHits(t, topics);
    const rule = matchRules(`${t.from || ''} ${t.subject || ''} ${t.snippet || ''} ${t.text || ''}`, rules);
    if (rule === 'ignore' && !hits.length) continue;
    const tier = tierOf.get(`${t.kind}|${normalizeIdentifier(t.kind, t.from)}`) || null;
    const money = hasMoneyFlag(`${t.subject || ''} ${t.snippet || ''}`);
    // See annotateAndFormat: a muted sender still gets through when the item
    // is about money, so muting the promos never costs you the invoice.
    if (tier === 'muted' && !money && !hits.length) continue;
    out.push({
      ...t,
      tier: tier === 'vip' ? 'vip' : (t.tier || null),
      rulePriority: rule === 'priority' || hits.length > 0,
      topics: hits.map(h => ({ slug: h.slug, label: h.label })),
      moneyFlag: money,
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
  const listing = items.map((t, i) => {
    const dBlock = formatDossierBlock(t.dossier);
    return `${i}. [${t.kind}] ${t.from}${t.when ? ` (${t.when})` : ''} — ${t.text} · ${age(t)}${t.hintBucket ? ` (hint: ${t.hintBucket})` : ''}${dBlock ? `\n   dossier: ${dBlock}` : ''}\n   "${String(t.snippet || '').slice(0, 120)}"`;
  }).join('\n');
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

async function loadMergedItemContext({ kind, from, phone, name, live = false, timeoutMs = 15000 }) {
  const directory = await loadPersonDirectory().catch(() => ({ byPhone: {}, byName: {}, byEmail: {}, byKey: new Map() }));
  const { email, name: parsedName } = extractEmailIdentity(kind, from);
  const resolvedName = cleanDossierValue(name) || parsedName || (!phoneLast9(from) && !email ? from : null);
  const pKey = canonicalPersonKey({ kind, from, phone, email, name: resolvedName }, directory);

  let liveMsgs = [];
  let threadName = from;
  const queryContact = (kind === 'job' && looksLikePhone(phone)) ? phone : from;
  const tryBridge = !kind || kind === 'sms' || kind === 'meta' || (kind === 'job' && looksLikePhone(phone));
  if (tryBridge && queryContact && process.env.BRIDGE_BASE_URL) {
    try {
      const qs = `contact=${encodeURIComponent(queryContact)}&limit=1${live ? '&live=1' : ''}`;
      const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/threads?${qs}`, {
        headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const { threads = [] } = r.ok ? await r.json() : {};
      if (threads[0]?.messages?.length) {
        threadName = threads[0].name || queryContact;
        liveMsgs = threads[0].messages;
        for (const m of liveMsgs) {
          await insertArchivedMessage({
            personKey: pKey,
            threadKey: `sms:${threadName}`,
            kind: 'sms',
            senderName: m.outbound ? 'me' : threadName,
            outbound: !!m.outbound,
            msgAt: m.at || '',
            body: m.text || '',
          }).catch(() => {});
        }
        let addr = null;
        let quote = null;
        for (let i = liveMsgs.length - 1; i >= 0; i--) {
          if (!addr) addr = extractAddress(liveMsgs[i]?.text);
          if (!quote) quote = extractQuoteAmount(liveMsgs[i]?.text);
          if (addr && quote) break;
        }
        await upsertPersonDossier(pKey, {
          display_name: resolvedName,
          phone: phone || (looksLikePhone(queryContact) ? queryContact : null),
          email,
          channels: ['sms'],
          address: addr,
          address_source: addr ? 'chat' : null,
          quote_estimate: quote,
        }, directory).catch(() => {});
      }
    } catch { /* fall back to archive */ }
  }

  const ctx = await loadPersonContext(pKey).catch(() => ({ dossier: null, messages: [], history: [] }));
  const dossier = ctx.dossier || directory.byKey?.get(pKey) || null;
  return {
    directory,
    personKey: pKey,
    dossier,
    dossierDto: dossier ? toDossierDto(dossier) : null,
    messages: mergeThreadMessages(ctx.messages, liveMsgs),
    history: ctx.history || [],
  };
}

// Full thread behind a report item — "get context" so the user can see what a
// one-line snippet ("👍 to '...'") is actually about, plus stored dossier & history.
async function handleItemContext(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const u = new URL(req.url, 'http://x');
  const from = u.searchParams.get('from');
  if (!from) { res.writeHead(400); res.end('{}'); return; }
  try {
    const ctx = await loadMergedItemContext({
      kind: u.searchParams.get('kind') || '',
      from,
      phone: u.searchParams.get('phone') || '',
      name: u.searchParams.get('name') || '',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      from,
      personKey: ctx.personKey,
      dossier: ctx.dossierDto,
      messages: ctx.messages,
      history: ctx.history,
    }));
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
}

// "Add to cal": read the real thread, extract the agreed job/appointment as a
// structured event (grounded in the conversation, so it can't invent a time),
// and open a pre-filled Google Calendar event in the logged-in calendar tab for
// the user to confirm and save. Nothing is written without the user's click.
// A suggested reply for an item, grounded in the thread behind it. The model
// only ever writes into a box the user then edits and presses send on - there
// is no path from here to an actual message (see handleTextSend).
// "Generate more detail from the card." A card is a summary by construction,
// and when the summary isn't enough the only options used to be leaving the app
// or regenerating the whole report. This expands one item on demand, grounded
// in whatever that item actually has behind it: the full thread for a text, the
// job record for a job, plus stored client dossier. It never invents a fact it wasn't given.
async function handleItemDetail(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const t = JSON.parse(await readBody(req));
  if (!t.from) { res.writeHead(400); res.end(JSON.stringify({ error: 'who?' })); return; }

  const ctx = await loadMergedItemContext({
    kind: t.kind, from: t.from, phone: t.phone, name: t.displayName, timeoutMs: 20000,
  });
  const thread = ctx.messages.slice(-24)
    .map(m => `${m.outbound ? 'me' : 'them'}: ${m.text}`).join('\n');
  const dBlock = formatDossierBlock(ctx.dossier);
  const historyLines = ctx.history.slice(0, 8)
    .map(h => `- [${h.kind}${h.status ? `/${h.status}` : ''}] ${h.title || h.subject || h.snippet || ''}${h.when_text ? ` (${h.when_text})` : ''}`)
    .join('\n');

  const known = ctx.dossier || await lookupContact(t.from).catch(() => null);
  const todo = (t.tasks || []).filter(x => x && x.text)
    .map(x => `${x.done ? '[done]' : '[open]'} ${x.text}`).join('\n');
  const record = [
    t.business ? `Business: ${t.business}` : null,
    t.status ? `Status: ${String(t.status).replace(/_/g, ' ')}` : null,
    t.when ? `Scheduled: ${t.when}${t.overdue ? ' (OVERDUE)' : ''}` : 'Scheduled: not booked',
    (t.address || known?.address) ? `Address: ${t.address || known.address}` : null,
    (t.phone || known?.phone) ? `Phone: ${t.phone || known.phone}` : null,
    t.preferredDays ? `Client prefers: ${t.preferredDays}` : null,
    t.timeline ? `Timeline: ${t.timeline}` : null,
    t.raised ? `Raised: ${String(t.raised).slice(0, 10)}` : null,
    todo ? `Checklist:\n${todo}` : null,
    t.lastNote?.message ? `Last note (${t.lastNote.author}): ${String(t.lastNote.message).slice(0, 400)}` : null,
    t.subject ? `Subject: ${t.subject}` : null,
    t.snippet ? `Content: ${t.snippet}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `You are briefing Jesse, a self-employed electrician in Geelong, on one item from his to-do list. Today is ${ymd(new Date())}.

Item: ${t.text || ''}
Who: ${known?.display_name || t.from}
Source: ${t.kind || 'unknown'}
${dBlock ? `Stored client dossier:\n${dBlock}\n\n` : ''}${thread ? `The conversation (live + archived):\n${thread}` : `The record:\n${record || '(nothing beyond the title)'}`}${thread && record ? `\n\nItem record:\n${record}` : ''}${historyLines ? `\n\nPrior archived items for this client:\n${historyLines}` : ''}

Write a short brief, 3-5 sentences of plain English, covering only what the material above actually supports:
- what this is really about
- what has already been settled or agreed (quote figures, dates and addresses exactly as they appear)
- what is still open, and the single next thing he should do

Carrier notices ("called. No Voicemail message was left") mean they tried to call, and "buzz" / "buzz if can" / "call plz" means they want a phone call. Note plainly when a call/buzz request has no visible text reply after it (phone calls aren't visible here). Do not invent details. If something important is missing - no price, no date, no address - say plainly that it is missing. No headings, no bullet points, no preamble.`;

  try {
    const detail = String(await askModel(prompt, 900) || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail, grounded: thread ? 'thread' : (dBlock ? 'dossier' : 'record') }));
  } catch (e) {
    res.writeHead(200); res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleItemDraft(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { from, text, snippet, brief, kind, phone } = JSON.parse(await readBody(req));
  if (!from) { res.writeHead(400); res.end(JSON.stringify({ error: 'who?' })); return; }

  const ctx = await loadMergedItemContext({ kind, from, phone, timeoutMs: 20000 });
  const thread = ctx.messages.slice(-12)
    .map(m => `${m.outbound ? 'me' : 'them'}: ${m.text}`).join('\n');

  const known = ctx.dossier || await lookupContact(from).catch(() => null);
  const dBlock = formatDossierBlock(ctx.dossier);
  const prompt = `You are drafting a reply that Jesse, a self-employed electrician in Geelong, will read and edit before sending. Write as him: plain, warm, short, no corporate phrasing, no emoji, Australian spelling.

Who: ${known?.display_name || from}${known?.address ? ` (${known.address})` : ''}
Channel: ${kind || 'sms'}
${dBlock ? `Stored client dossier: ${dBlock}\n` : ''}${brief ? `Where it stands: ${brief}\n` : ''}${thread ? `The conversation so far:\n${thread}\n` : `Their last message: "${snippet || ''}"\n`}
What he needs to do: ${text || 'reply'}

Write ONLY the message body, 1-3 sentences. No greeting line if the thread is already mid-conversation, no sign-off, no quotes around it, no preamble.`;

  try {
    const draft = String(await askModel(prompt, 400) || '').trim()
      .replace(/^["']|["']$/g, '').replace(/^(reply|draft|message)\s*:\s*/i, '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ draft, grounded: !!thread }));
  } catch (e) {
    res.writeHead(200); res.end(JSON.stringify({ error: e.message }));
  }
}

// Cache the dedicated Work calendar ID in memory so fallback draft links can
// target `&src=` too without paying an extra lookup on every booking.
let cachedWorkCalendarId = null;

async function getWorkCalendarId() {
  if (cachedWorkCalendarId) return cachedWorkCalendarId;
  if (!process.env.LIFECMD_BASE_URL || !process.env.LIFECMD_SERVICE_TOKEN) return null;
  try {
    const r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/google/work-calendar`, {
      headers: { 'x-service-token': process.env.LIFECMD_SERVICE_TOKEN },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (d?.calendarId) cachedWorkCalendarId = d.calendarId;
  } catch {}
  return cachedWorkCalendarId;
}

// Save bookings directly into Google Calendar via LIFE_CMD so work jobs land on
// the Mango-coloured 'Work' sub-calendar (URL eventedit links ignore colours);
// falls back to a pre-filled eventedit URL if LIFE_CMD cannot be reached.
async function createCalendarBooking({ title, date, time, durationMins = 60, place, details, isWork = true }) {
  const win = bookingWindow({ date, time, durationMins });
  const fallbackUrl = async () => calendarDraftUrl({
    title, date, time, durationMins, place, details,
    src: isWork ? (cachedWorkCalendarId || await getWorkCalendarId()) : null,
  });

  if (process.env.LIFECMD_BASE_URL && process.env.LIFECMD_SERVICE_TOKEN) {
    try {
      const r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/google/create-event/main`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-token': process.env.LIFECMD_SERVICE_TOKEN,
        },
        body: JSON.stringify({
          title,
          start: win.start,
          end: win.end,
          allDay: win.allDay,
          location: place || undefined,
          description: details || undefined,
          calendar: isWork ? 'work' : 'primary',
        }),
        signal: AbortSignal.timeout(10000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.success && d.event) {
        if (isWork && d.calendarId) cachedWorkCalendarId = d.calendarId;
        return {
          saved: true,
          url: d.event.htmlLink || await fallbackUrl(),
          event: d.event,
          calendar: d.calendar || (isWork ? 'Work' : 'primary'),
          calendarId: d.calendarId || null,
          colorId: d.colorId || (isWork ? '6' : null),
        };
      }
      console.error('tocal LIFE_CMD error:', d.error || r.status);
    } catch (e) {
      console.error('tocal LIFE_CMD failed:', e.message);
    }
  }

  return {
    saved: false,
    url: await fallbackUrl(),
    calendar: isWork ? 'Work' : 'primary',
    colorId: isWork ? '6' : null,
  };
}

async function handleItemToCal(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const body = JSON.parse(await readBody(req));
  const { from, text } = body;

  // Manual path: you had the conversation on the phone, so there is nothing to
  // read and nothing to extract. The form sends the event straight through.
  if (body.date) {
    const directory = from ? await loadPersonDirectory().catch(() => null) : null;
    const dRow = from ? lookupDossierInDir({ kind: body.kind, from, phone: body.phone }, directory) : null;
    const known = dRow || (from ? await lookupContact(from).catch(() => null) : null);
    const parts = String(body.parts !== undefined ? body.parts : (dRow?.parts_materials || '')).replace(/\s+/g, ' ').trim();
    // Parts go in the title, not only the notes: the month view shows the
    // title and nothing else, and the whole reason for asking is to see on
    // Sunday night what has to be picked up on Monday morning.
    const base = (body.title || text || `Job for ${known?.display_name || from || 'client'}`).slice(0, 150);
    const isWork = body.isWork !== false && body.bucket !== 'life';
    const booking = await createCalendarBooking({
      title: parts ? `${base} [parts]` : base,
      date: body.date,
      time: body.time || '',
      durationMins: Number(body.durationMins) || 60,
      place: body.location || known?.address || null,
      details: [
        parts ? `PARTS TO BRING: ${parts}` : 'No parts needed.',
        `Allowed ${Number(body.durationMins) || 60} minutes.`,
        `Added by hand in Vita Switch${from ? ` — ${known?.display_name || from}` : ''}.`,
      ].join('\n'),
      isWork,
    });
    if (booking.saved && typeof body.actionId === 'string' && body.actionId.startsWith('book-')) {
      const cid = Number(body.actionId.slice(5));
      if (Number.isInteger(cid) && cid > 0) {
        await pool.query("UPDATE commitments SET status = 'booked' WHERE id = $1 AND status = 'unbooked'", [cid]).catch(() => {});
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      manual: true,
      saved: booking.saved,
      url: booking.url,
      calendar: booking.calendar,
      color: booking.colorId === '6' ? 'mango' : null,
      event: { id: booking.event?.id || null, title: body.title || text, date: body.date, time: body.time || '' },
    }));
    return;
  }

  try {
    // 1. context (live + archived + dossier)
    const ctx = await loadMergedItemContext({ kind: body.kind || 'sms', from, phone: body.phone, live: true, timeoutMs: 25000 });
    const convo = ctx.messages.slice(-20)
      .map(m => `${m.outbound ? 'me' : 'them'}: ${m.text}`).join('\n');
    if (!convo) { res.writeHead(200); res.end(JSON.stringify({ error: 'no conversation found to read' })); return; }

    // 2. extract a structured event, grounded in the thread.
    // ymd, not toISOString: this date is what "Friday" gets resolved against
    // before an event is written into the real calendar, so a UTC date would
    // book the job on the wrong day for anything done before 11am in AEDT.
    const today = ymd(new Date());
    const dBlock = formatDossierBlock(ctx.dossier);
    const prompt = `Today is ${today}. This is a text conversation with ${from}:

${dBlock ? `Stored client dossier:\n${dBlock}\n\n` : ''}${convo}

Only if a specific job, appointment, or meeting has actually been AGREED by both sides (not an unanswered availability offer like "I'm free Friday if you are around"), extract it as JSON:
{"found":true,"title":"short event title","date":"YYYY-MM-DD","time":"HH:MM 24h or empty if none","durationMins":60}
Resolve relative dates ("Friday", "Tuesday next week", "tomorrow") against today. If NOTHING concrete was agreed yet, respond {"found":false}. Respond with ONLY the JSON.`;
    const ev = parseJsonFence(await askModel(prompt, 400), { found: false });
    if (!ev || !ev.found || !ev.date) {
      res.writeHead(200); res.end(JSON.stringify({ error: 'no concrete time was agreed in this conversation' })); return;
    }

    // 3. pre-fill the event and open it in the live calendar tab.
    // Name and address from the directory, so the event says who and where
    // instead of a bare number with an empty location field. Anything the
    // thread itself mentions is learned here too, for next time.
    const known = ctx.dossier || await lookupContact(from).catch(() => null);
    const inThread = extractAddress(convo);
    if (inThread && !known?.address) {
      await rememberContact({ phone: from, address: inThread, source: 'chat' }).catch(() => {});
      await upsertPersonDossier(ctx.personKey, { address: inThread, address_source: 'chat' }, ctx.directory).catch(() => {});
    }
    const who = known?.display_name || from;
    const title = ev.title || text || `Job for ${who}`;

    // Nothing is opened here. The model can read a day and a time out of the
    // thread; it cannot know how long the job will take or what you need to
    // bring, and those are the two things that make a booking useful. So this
    // hands the form a filled-in draft and the two questions get answered
    // before anything reaches the calendar.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, draft: {
      title, date: ev.date, time: ev.time || '09:00',
      durationMins: ev.durationMins || 60,
      location: known?.address || inThread || ev.location || '',
      parts: cleanDossierValue(ctx.dossier?.parts_materials) || '',
    } }));
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
}

// ── Commitments ledger ────────────────────────────────────
// The model only decides WHETHER work was agreed and copies the thread
// verbatim; the day is resolved deterministically in commitments.js, and the
// calendar decides "booked". Line output, not JSON — gemma is unreliable at
// strict JSON (see Agentic-LM-Pipeline-Pattern).
function commitmentPrompt(threads, today, weekday, directory = null) {
  const convos = threads.map(t => {
    const d = directory ? lookupDossierInDir(t.name, directory) : null;
    const dBlock = formatDossierBlock(d);
    const lines = (t.messages || []).slice(-12)
      .map(m => `  ${msgLine(m)}`)
      .join('\n');
    return `— ${t.name} —${dBlock ? `\n  [Dossier: ${dBlock}]` : ''}\n${lines}`;
  }).join('\n\n');

  return `Today is ${weekday} ${today}. Below are recent text conversations. "me" is Jesse, an electrician; "them" is the customer.

Find ONLY appointments or work where BOTH sides have actually AGREED on a day/time or confirmed a booking. Do NOT include one-sided availability offers with no confirmation yet (e.g. "I'm free on Friday if you are around", "Does Tuesday work?", "How about Thursday?"), unanswered requests ("What sort of availability do you have?", "Could you please make time Tuesday?"), or fault reports without an agreed time. If the client hasn't agreed yet, leave it out. Output ONE LINE per confirmed agreement, exactly four fields separated by " :: ", and nothing else:

WHO :: WHAT :: WHEN :: QUOTE

WHO   - the conversation heading, copied exactly as it appears after the dash
WHAT  - the work itself, a few words (e.g. "ceiling fan installation")
WHEN  - the agreed timing words COPIED VERBATIM from the thread ("Thursday", "tomorrow", "next week", "9am"). Do not output lines with no timing words.
QUOTE - the one message line confirming or settling the booking, COPIED VERBATIM

Copy WHEN and QUOTE exactly as they appear, without the [date] in front of each line - anything you reword or invent is discarded. Do not work out dates yourself. If a job was later called off, rescheduled or already done in the thread, leave out the old arrangement and give only the latest one. Ignore chit-chat, thanks, deliveries, parcel notices, and unconfirmed proposals. If you are unsure both sides agreed, leave it out. No numbering, no headings, no commentary.

CONVERSATIONS:
${convos}`;
}

// Re-derive the ledger from the threads. A projection, not an accumulator:
// anything still open that is no longer agreed in its thread is superseded, so
// a job that was talked away drops itself instead of becoming a phantom.
async function refreshCommitments() {
  let threads;
  try { threads = await fetchThreads(35); }
  catch (err) { console.error('commitments: bridge unreachable —', err.message); return { ok: false, reason: err.message }; }
  if (!threads.length) return { ok: false, reason: 'no threads' };

  const directory = await archiveItemsAndThreads([], threads)
    .catch(() => loadPersonDirectory().catch(() => null));

  const now = new Date();
  // ymd, not toISOString: weekday below is local, so before 11am in AEDT a UTC
  // date would make the prompt contradict itself ("Today is Thursday 2026-11-04").
  const today = ymd(now);
  const weekday = now.toLocaleDateString('en-AU', { weekday: 'long' });

  const raw = await askModel(commitmentPrompt(threads, today, weekday, directory), 1600);
  const offered = String(raw || '').split('\n').filter(l => l.includes('::')).length;
  const extracted = parseExtraction(raw, threads, now);
  if (!extracted.length) {
    console.error(`commitments: 0 kept from ${offered} offered line(s); raw starts: ${JSON.stringify(String(raw).slice(0, 160))}`);
  }
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

  await describeCommitments(threads, directory);

  // Only supersede within the threads actually scanned — a thread that has
  // simply dropped out of the index's recent window must not cancel its jobs.
  const names = threads.map(t => t.name);
  const { rows: open } = await pool.query(
    `SELECT id FROM commitments WHERE status <> 'superseded' AND source_thread = ANY($1)`, [names],
  );
  const { supersede } = projectCommitments(open.map(r => r.id), extracted);

  // ...but its day can still pass. Out-of-window rows are re-read from their
  // own WHEN text as of when first seen; the message was sent before that,
  // so if even this reading is in the past, the real day is too.
  const { rows: aged } = await pool.query(
    `SELECT id, when_date, when_text, first_seen_at FROM commitments
      WHERE status <> 'superseded' AND NOT (source_thread = ANY($1))`, [names]);
  for (const r of aged) {
    const day = r.when_date ? ymd(r.when_date) : r.when_text ? resolveWhen(r.when_text, r.first_seen_at).date : null;
    if ((!r.when_date && !r.when_text) || (day && day < today)) supersede.push(r.id);
  }
  if (supersede.length) {
    await pool.query(`UPDATE commitments SET status='superseded', last_seen_at=NOW() WHERE id = ANY($1)`, [supersede]);
  }
  return { ok: true, found: extracted.length, superseded: supersede.length, scanned: threads.length };
}

// One sentence per commitment saying what the work is, written off the whole
// conversation rather than the one line the extractor copied. Only for rows
// that have none yet and are still unbooked, so this is a handful of calls on
// the tick a new job appears and none at all on every other tick.
async function describeCommitments(threads, directory = null) {
  const { rows } = await pool.query(
    `SELECT id, who, what, quote, source_thread FROM commitments
      WHERE detail IS NULL AND status = 'unbooked' ORDER BY first_seen_at DESC LIMIT 6`);
  if (!rows.length) return 0;
  const byName = new Map(threads.map(t => [t.name, t]));
  let written = 0;
  for (const r of rows) {
    const t = byName.get(r.source_thread);
    const d = directory ? (lookupDossierInDir(r.who, directory) || lookupDossierInDir(r.source_thread, directory)) : null;
    const ctx = d ? await loadPersonContext(d.person_key).catch(() => ({ messages: [] })) : { messages: [] };
    const msgs = mergeThreadMessages(ctx.messages, t?.messages || []);
    const convo = msgs.slice(-14)
      .map(m => `${m.outbound ? 'me' : 'them'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');
    const dBlock = formatDossierBlock(d);
    if (!convo && !dBlock) continue;
    const prompt = `This is a text conversation between Jesse (an electrician, "me") and a customer ("them").

${dBlock ? `Client dossier: ${dBlock}\n\n` : ''}${convo}

In ONE sentence, say what the JOB is: the actual electrical work, where it is, and anything agreed about it. Write it the way you would write a line in a diary, so he knows what he is turning up to do. Do not mention the texting, do not greet, do not add advice. If the material never says what the work is, reply with exactly: UNCLEAR`;
    let line = String(await askModel(prompt, 200) || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    if (!line || /^unclear\b/i.test(line)) line = '';
    // Empty string, not NULL, when the thread never says what the work is -
    // NULL is the "not looked at yet" state, and writing it back would ask
    // the model the same unanswerable question on every tick forever.
    await pool.query('UPDATE commitments SET detail=$1 WHERE id=$2', [line, r.id]);
    if (line) written++;
  }
  if (written) console.log(`commitments: ${written} described`);
  return written;
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
// Membership and system notices are not conversations. A card reading "Reply
// to a work group chat / You created group" is noise even though the
// group genuinely is work - there is nothing in it to act on. Dropped in code
// before the model sees them, which also keeps the classifier cheap.
const SYSTEM_NOTICE = /^(you (were added|created group|joined|added|left|deleted)|.{0,40}\b(added you|joined using|left the group)\b|.{0,30}changed the (subject|group|icon|description)|messages and calls are end-to-end|you received a one-time passcode|missed (voice|video) call|this message was deleted)/i;

async function workChannel(channel) {
  console.log(`${channel}: reading…`);
  let rows = [];
  try { ({ rows } = await fetchChannel(channel, 40)); }
  catch (e) { console.error(`${channel}: bridge —`, e.message); noteHealth(channel, `The bridge could not read it (${e.message})`); return []; }
  // A signed-in inbox is never empty, so zero rows is a dark source, not a
  // quiet day. Without this the watchdog only ever knew about email.
  if (!rows.length) { console.log(`${channel}: bridge returned no conversations`); noteHealth(channel, 'It returned no conversations'); return []; }
  noteHealth(channel, 'ok');

  // Drop system notices, then anything duplicated by name+last line.
  const seen = new Set();
  rows = rows.filter(r => {
    const snip = String(r.snippet || '').trim();
    if (!snip || SYSTEM_NOTICE.test(snip)) return false;
    const key = `${r.name}|${snip}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!rows.length) { console.log(`${channel}: nothing but system notices`); return []; }

  const CHUNK = 8;
  const work = [];
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const listing = chunk.map((r, i) =>
      `${i}. ${r.name} :: ${String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');

    const prompt = `Jesse is an electrician. Below are the latest lines from his personal ${channel === 'whatsapp' ? 'WhatsApp' : 'Messenger'} conversations.

Say which are about his ELECTRICAL WORK: a quote or estimate, a job or callout, booking a visit, materials or parts, a site or address, an invoice or payment for work, or a tradesman arranging work with him.

Everything else is private and must be left out: family, friends, relationships, kids, social plans, social or family group chats, marketplace, promotions, automated notices, and anything you are unsure about.

A group chat counts as work ONLY if it is about paid electrical work for a client - a job, a site, a quote, materials, scheduling. A household, family, neighbourhood or friends group is private even when it mentions a light, a switch or something broken at home. If the conversation would not appear on an invoice, leave it out.

When in doubt, leave it out: a missed work conversation costs little, a surfaced private one is a real problem.

Answer with ONLY the numbers of the work conversations, comma separated, for example: 0, 4, 9
If none are about work, answer: none

${listing}`;

    let raw = '';
    try { raw = await askModel(prompt, 300); }
    catch (e) { console.error(`${channel}: model —`, e.message); continue; }

    const picked = new Set((raw.match(/\d+/g) || []).map(Number));
    if (/\bnone\b/i.test(raw) && !picked.size) continue;
    work.push(...chunk.filter((_, i) => picked.has(i)));
  }
  console.log(`${channel}: ${work.length} of ${rows.length} conversations read as work`);
  return work;
}

// Turn "reply to Michael" into a number the phone can actually text. Looks in
// the learned contact directory first, then falls back to anything that is
// already a plausible number.
async function resolveRecipient(to) {
  const raw = String(to || '').trim();
  const digits = raw.replace(/[^\d+]/g, '');
  const known = await lookupContact(raw).catch(() => null);
  if (known?.display_name || phoneLast9(raw)) {
    return {
      name: known?.display_name || (phoneLast9(raw) ? raw : null),
      number: phoneLast9(raw) ? digits : null,
      address: known?.address || null,
    };
  }
  // A name with no number on file: say so rather than guessing a recipient.
  return { name: raw || null, number: null, address: known?.address || null };
}

async function archiveOutboundSent({ channel, threadLabel, who, number, text }) {
  const dir = await loadPersonDirectory();
  const label = threadLabel || who || number;
  const pKey = canonicalPersonKey({ kind: channel, from: label, phone: number, name: who }, dir);
  await insertArchivedMessage({
    personKey: pKey,
    threadKey: `${channel}:${label}`,
    kind: channel,
    senderName: 'me',
    outbound: true,
    msgAt: new Date().toISOString().slice(0, 16),
    body: text,
  });
  await upsertPersonDossier(pKey, {
    display_name: who || null,
    phone: number || null,
    channels: [channel],
    current_stage: 'replied',
  }, dir);
}

// The only place a message actually leaves. Requires the owner token AND is
// only ever called by the send button in the chat - the model cannot reach it.
async function handleTextSend(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { to, name, message, channel: ch } = JSON.parse(await readBody(req));
  const channel = ['sms', 'whatsapp', 'messenger'].includes(ch) ? ch : 'sms';
  const number = String(to || '').replace(/[^\d+]/g, '');
  const text = String(message || '').trim();
  const who = String(name || '').trim();

  if ((!number && !who) || !text) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'a recipient and a message are both required' })); return;
  }

  // Preferred path: type it into the logged-in Messages session through the
  // bridge. It needs no webhook, and the message lands in the real thread so
  // the conversation stays in one place.
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const candidates = [];
  for (const c of [who, number]) {
    if (c && !candidates.some(x => norm(x) === norm(c))) candidates.push(c);
  }
  console.log(`text/send ${channel} -> [${candidates.join(', ')}]`);
  let lastErr = '';
  for (const contact of candidates) {
    try {
      const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
        body: JSON.stringify({ channel, contact, text, send: true }),
        signal: AbortSignal.timeout(120000),
      });
      const d = await r.json().catch(() => ({}));
      if (d.sent) {
        console.log(`sent via ${channel} to ${d.thread}`);
        await archiveOutboundSent({ channel, threadLabel: d.thread, who, number, text }).catch(() => {});
        res.writeHead(200); res.end(JSON.stringify({ ok: true, via: channel, thread: d.thread })); return;
      }
      lastErr = d.error || (r.status === 404 ? `no ${channel} thread matching "${contact}"` : 'send rejected');
      console.error(`${channel} send did not go through:`, d.error || JSON.stringify(d));
      if (r.status !== 404) break;
    } catch (e) {
      lastErr = e.message;
      console.error(`${channel} send failed:`, e.message);
      break;
    }
  }

  // Fallback: the MacroDroid webhook switch-craft uses. Needs a real number.
  if (channel !== 'sms' || !process.env.MACRODROID_WEBHOOK_URL || !number || !phoneLast9(number)) {
    const error = lastErr
      ? `could not send through Messages (${lastErr})`
      : 'could not send through Messages, and no webhook fallback is configured';
    res.writeHead(200);
    res.end(JSON.stringify({ error }));
    return;
  }
  try {
    const r = await fetch(`${process.env.MACRODROID_WEBHOOK_URL}?phone=${encodeURIComponent(number)}&message=${encodeURIComponent(text)}`,
                          { signal: AbortSignal.timeout(15000) });
    console.log(`text sent via webhook (${text.length} chars): ${r.status}`);
    if (r.ok) {
      await archiveOutboundSent({ channel: 'sms', threadLabel: who || number, who, number, text }).catch(() => {});
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: r.ok, via: 'webhook' }));
  } catch (e) {
    console.error('webhook send failed:', e.message);
    res.writeHead(200); res.end(JSON.stringify({ error: e.message }));
  }
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

// Fallback: someone texting an address or self-intro is often the only record of it.
async function learnFromThreads(threads = []) {
  for (const t of threads) {
    const key = phoneLast9(t.name);
    if (!key) continue;
    let name = null;
    let address = null;
    for (const m of (t.messages || [])) {
      const intro = extractContactIntro(m.text);
      if (!address && intro.address) address = intro.address;
      if (!name && !m.outbound && intro.name) name = intro.name;
      if (name && address) break;
    }
    if (!name && !address) continue;
    await rememberContact({ phone: t.name, name, address, source: address ? 'chat' : null })
      .catch(e => console.error('directory: thread —', e.message));
  }
}

// ── Progressive person dossiers & permanent archive ───────
function toDossierDto(d) {
  if (!d) return null;
  return {
    personKey: d.person_key,
    displayName: d.display_name || null,
    phone: d.phone || null,
    email: d.email || null,
    address: d.address || null,
    addressSource: d.address_source || null,
    business: d.business || null,
    channels: Array.isArray(d.channels) ? d.channels : [],
    jobIds: Array.isArray(d.job_ids) ? d.job_ids : [],
    workScope: d.work_scope || null,
    quoteEstimate: d.quote_estimate || null,
    partsMaterials: d.parts_materials || null,
    preferredTimes: d.preferred_times || null,
    accessNotes: d.access_notes || null,
    currentStage: d.current_stage || null,
    openNextStep: d.open_next_step || null,
    summaryNotes: d.summary_notes || null,
    updatedAt: d.updated_at || null,
  };
}

function extractEmailIdentity(kind, from) {
  const s = String(from || '').trim();
  if (kind !== 'email' && kind !== 'bizemail' && !s.includes('@')) return { email: null, name: null };
  const m = s.match(/^([^<]+)<([^>]+)>/);
  const email = m ? m[2].trim().toLowerCase() : (s.includes('@') ? normalizeIdentifier('email', s) : null);
  const name = m ? m[1].replace(/["']/g, '').trim() : null;
  return { email, name };
}

function registerDossierInDir(d, dir) {
  if (!d?.person_key) return;
  dir.byKey.set(d.person_key, d);
  const last9 = phoneLast9(d.phone) || (d.person_key.startsWith('phone:') ? d.person_key.slice(6) : null);
  if (last9) dir.byPhone[last9] = d.person_key;
  const em = d.email
    ? normalizeIdentifier('email', d.email)
    : (d.person_key.startsWith('email:') ? d.person_key.slice(6) : '');
  if (em && em.includes('@')) dir.byEmail[em] = d.person_key;
  const addrKey = normalizeAddressKey(d.address);
  if (addrKey && (!dir.byAddress?.[addrKey] || d.person_key.startsWith('phone:'))) {
    if (!dir.byAddress) dir.byAddress = {};
    dir.byAddress[addrKey] = d.person_key;
  }
  const nm = String(d.display_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (nm && /[a-z]/i.test(nm) && (!dir.byName[nm] || d.person_key.startsWith('phone:'))) {
    dir.byName[nm] = d.person_key;
  }
}

async function loadPersonDirectory() {
  const dir = { byPhone: {}, byName: {}, byEmail: {}, byAddress: {}, byKey: new Map() };
  const [{ rows: dossierRows }, { rows: contactRows }] = await Promise.all([
    pool.query('SELECT * FROM person_dossiers'),
    pool.query('SELECT kind, identifier, display_name, address FROM contacts'),
  ]);
  for (const d of dossierRows) registerDossierInDir(d, dir);
  for (const c of contactRows) {
    const nm = String(c.display_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const addrKey = normalizeAddressKey(c.address);
    if (c.kind === 'sms') {
      const p9 = phoneLast9(c.identifier);
      if (!p9) continue;
      const pk = dir.byPhone[p9] || `phone:${p9}`;
      dir.byPhone[p9] = pk;
      if (nm && /[a-z]/i.test(nm) && !dir.byName[nm]) dir.byName[nm] = pk;
      if (addrKey && !dir.byAddress[addrKey]) dir.byAddress[addrKey] = pk;
    } else if (c.kind === 'email' || c.kind === 'bizemail') {
      const em = normalizeIdentifier(c.kind, c.identifier);
      if (!em.includes('@')) continue;
      const pk = dir.byEmail[em] || `email:${em}`;
      dir.byEmail[em] = pk;
      if (nm && /[a-z]/i.test(nm) && !dir.byName[nm]) dir.byName[nm] = pk;
      if (addrKey && !dir.byAddress[addrKey]) dir.byAddress[addrKey] = pk;
    }
  }
  return dir;
}

function lookupDossierInDir(whoOrItem, directory) {
  if (!directory?.byKey) return null;
  if (whoOrItem && typeof whoOrItem === 'object') {
    if (whoOrItem.personKey && directory.byKey.has(whoOrItem.personKey)) {
      return directory.byKey.get(whoOrItem.personKey);
    }
    const { email, name } = extractEmailIdentity(whoOrItem.kind, whoOrItem.from);
    const key = canonicalPersonKey({
      kind: whoOrItem.kind,
      from: whoOrItem.from,
      phone: whoOrItem.phone,
      email,
      name: name || whoOrItem.displayName,
      address: whoOrItem.address,
    }, directory);
    return directory.byKey.get(key) || null;
  }
  const key = canonicalPersonKey({ from: String(whoOrItem || '') }, directory);
  return directory.byKey.get(key) || null;
}

async function loadPersonContext(personKey) {
  if (!personKey || personKey === 'unknown') return { dossier: null, messages: [], history: [] };
  const [{ rows: [dossier] }, { rows: msgRows }, { rows: history }] = await Promise.all([
    pool.query('SELECT * FROM person_dossiers WHERE person_key = $1', [personKey]),
    pool.query(
      `SELECT id, thread_key, kind, sender_name, outbound, msg_at, body, seen_at
         FROM message_archive WHERE person_key = $1 ORDER BY id DESC LIMIT 50`,
      [personKey]
    ),
    pool.query(
      `SELECT item_id, kind, from_label, phone, email, address, subject, title, snippet, brief, when_text, status, job_id, first_seen_at, last_seen_at
         FROM item_archive WHERE person_key = $1 ORDER BY last_seen_at DESC LIMIT 15`,
      [personKey]
    ),
  ]);
  const messages = msgRows.reverse().map(m => ({
    outbound: !!m.outbound,
    text: m.body,
    at: m.msg_at || null,
    kind: m.kind,
    seenAt: m.seen_at,
  }));
  return { dossier: dossier || null, messages, history };
}

async function upsertPersonDossier(personKey, incoming, directory, { sourceHash = null } = {}) {
  if (!personKey || personKey === 'unknown') return null;
  let existing = directory?.byKey?.get(personKey) || null;
  if (!existing) {
    const { rows } = await pool.query('SELECT * FROM person_dossiers WHERE person_key = $1', [personKey]);
    existing = rows[0] || { person_key: personKey, channels: [], job_ids: [] };
  }
  let merged = mergeDossierFields(existing, { ...incoming, person_key: personKey });

  if (personKey.startsWith('phone:')) {
    const absorbKeys = new Set();
    if (merged.display_name) {
      absorbKeys.add(`name:${merged.display_name.toLowerCase().replace(/\s+/g, ' ').trim()}`);
    }
    const addrKey = normalizeAddressKey(merged.address);
    if (addrKey && directory?.byKey) {
      for (const [k, row] of directory.byKey) {
        if (k.startsWith('name:') && normalizeAddressKey(row.address) === addrKey) absorbKeys.add(k);
      }
    }
    for (const oldKey of absorbKeys) {
      let oldRow = directory?.byKey?.get(oldKey) || null;
      if (!oldRow) {
        const { rows } = await pool.query('SELECT * FROM person_dossiers WHERE person_key = $1', [oldKey]);
        oldRow = rows[0] || null;
      }
      if (!oldRow) continue;
      merged = mergeDossierFields(oldRow, { ...merged, person_key: personKey });
      await pool.query('UPDATE item_archive SET person_key = $1 WHERE person_key = $2', [personKey, oldKey]);
      await pool.query('UPDATE message_archive SET person_key = $1 WHERE person_key = $2', [personKey, oldKey]);
      await pool.query('DELETE FROM person_dossiers WHERE person_key = $1', [oldKey]);
      directory?.byKey?.delete(oldKey);
    }
  }

  const { rows: [saved] } = await pool.query(
    `INSERT INTO person_dossiers (
       person_key, display_name, phone, email, address, address_source, business,
       channels, job_ids, work_scope, quote_estimate, parts_materials, preferred_times,
       access_notes, current_stage, open_next_step, summary_notes, source_hash, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
     ON CONFLICT (person_key) DO UPDATE SET
       display_name=EXCLUDED.display_name, phone=EXCLUDED.phone, email=EXCLUDED.email,
       address=EXCLUDED.address, address_source=EXCLUDED.address_source, business=EXCLUDED.business,
       channels=EXCLUDED.channels, job_ids=EXCLUDED.job_ids, work_scope=EXCLUDED.work_scope,
       quote_estimate=EXCLUDED.quote_estimate, parts_materials=EXCLUDED.parts_materials,
       preferred_times=EXCLUDED.preferred_times, access_notes=EXCLUDED.access_notes,
       current_stage=EXCLUDED.current_stage, open_next_step=EXCLUDED.open_next_step,
       summary_notes=EXCLUDED.summary_notes,
       source_hash=COALESCE($18, person_dossiers.source_hash),
       updated_at=NOW()
     RETURNING *`,
    [
      personKey, merged.display_name, merged.phone, merged.email,
      merged.address, merged.address_source, merged.business,
      merged.channels, merged.job_ids, merged.work_scope, merged.quote_estimate,
      merged.parts_materials, merged.preferred_times, merged.access_notes,
      merged.current_stage, merged.open_next_step, merged.summary_notes, sourceHash,
    ]
  );
  if (saved && directory) registerDossierInDir(saved, directory);
  return saved;
}

async function insertArchivedMessage({ personKey, threadKey, kind, senderName, outbound, msgAt, body }) {
  const cleanBody = String(body || '').trim().slice(0, 1800);
  if (!personKey || !threadKey || !cleanBody) return;
  await pool.query(
    `INSERT INTO message_archive (person_key, thread_key, kind, sender_name, outbound, msg_at, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (thread_key, outbound, msg_at, body) DO NOTHING`,
    [personKey, threadKey, kind || 'sms', senderName || null, !!outbound, String(msgAt || ''), cleanBody]
  );
}

async function archiveItemsAndThreads(items = [], threads = []) {
  const directory = await loadPersonDirectory();

  // Pass 1: register Switch Craft job links first so name<->phone matches resolve cleanly.
  for (const t of items) {
    if (t.kind !== 'job') continue;
    const pKey = canonicalPersonKey({ kind: t.kind, from: t.from, phone: t.phone, name: t.from, address: t.address }, directory);
    const quote = extractQuoteAmount(`${t.snippet || ''} ${t.lastNote?.message || ''}`);
    await upsertPersonDossier(pKey, {
      display_name: t.from,
      phone: t.phone || null,
      address: t.address || null,
      address_source: t.address ? 'switch-craft' : null,
      business: t.business || null,
      job_ids: t.jobId ? [t.jobId] : [],
      preferred_times: t.preferredDays || t.timeline || null,
      work_scope: t.text || t.snippet || null,
      quote_estimate: quote,
      current_stage: t.status || null,
      channels: ['job'],
    }, directory).catch(e => console.error('archive job dossier:', e.message));
  }

  // Pass 2: store full scraped SMS threads and deterministic extractions.
  for (const th of threads) {
    if (!th?.name) continue;
    const isPhone = !!phoneLast9(th.name);
    const msgs = Array.isArray(th.messages) ? th.messages : [];
    let foundAddr = null;
    let foundQuote = null;
    let foundIntro = null;
    let introIdx = -1;
    let foundSuburb = null;
    const foundJobIds = new Set();
    const foundParts = [];
    const seenPartKeys = new Set();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      const txt = msg?.text || '';
      if (!foundAddr) foundAddr = extractAddress(txt);
      if (!foundQuote) foundQuote = extractQuoteAmount(txt);
      const sig = extractTradeSignals(txt);
      for (const jid of sig.jobIds) foundJobIds.add(jid);
      if (!foundSuburb && sig.suburb) foundSuburb = sig.suburb;
      for (const p of sig.parts) {
        const pk = p.toLowerCase();
        if (!seenPartKeys.has(pk)) { seenPartKeys.add(pk); foundParts.push(p); }
      }
      if (!foundIntro && !msg?.outbound) {
        const intro = extractContactIntro(txt);
        if (intro.name || intro.email || intro.isDetailsDrop) {
          foundIntro = intro;
          introIdx = i;
        }
      }
    }
    const resolvedAddr = foundAddr || foundIntro?.address || null;
    const pKey = canonicalPersonKey({
      kind: 'sms',
      from: th.name,
      name: foundIntro?.name || th.name,
      address: resolvedAddr,
    }, directory);
    for (const m of msgs) {
      await insertArchivedMessage({
        personKey: pKey,
        threadKey: `sms:${th.name}`,
        kind: 'sms',
        senderName: m.outbound ? 'me' : th.name,
        outbound: !!m.outbound,
        msgAt: m.at || '',
        body: m.text || '',
      }).catch(() => {});
    }
    const existingDossier = directory?.byKey?.get(pKey);
    const introUnreplied = !!(foundIntro?.isDetailsDrop && introIdx >= 0 && !msgs.slice(introIdx + 1).some(m => m?.outbound));
    const finalAddr = resolvedAddr || (!existingDossier?.address ? foundSuburb : null);
    await upsertPersonDossier(pKey, {
      display_name: foundIntro?.name || (isPhone ? null : th.name),
      phone: isPhone ? th.name : null,
      email: foundIntro?.email || null,
      channels: ['sms'],
      job_ids: [...foundJobIds],
      address: finalAddr,
      address_source: finalAddr ? 'chat' : null,
      quote_estimate: foundQuote,
      parts_materials: !existingDossier?.parts_materials && foundParts.length ? foundParts.join(', ') : null,
      ...(introUnreplied && !existingDossier?.current_stage ? {
        current_stage: 'New client sent contact details',
        open_next_step: 'Reply or call back to discuss the job and book a time',
      } : {}),
    }, directory).catch(e => console.error('archive thread dossier:', e.message));
  }

  // Pass 3: store every surfaced item permanently & enrich item objects in memory.
  const MSG_KINDS = new Set(['sms', 'whatsapp', 'messenger', 'meta', 'email', 'bizemail']);
  for (const t of items) {
    if (t.kind === 'cal') continue;
    const { email, name } = extractEmailIdentity(t.kind, t.from);
    const pKey = canonicalPersonKey({ kind: t.kind, from: t.from, phone: t.phone, email, name, address: t.address }, directory);
    const itemId = workItemId(t);
    const meta = {
      tasks: t.tasks || null,
      lastNote: t.lastNote || null,
      photos: t.photos || null,
      preferredDays: t.preferredDays || null,
      timeline: t.timeline || null,
      business: t.business || null,
      raised: t.raised || null,
      overdue: !!t.overdue,
      href: t.href || null,
      noteCount: t.noteCount || 0,
      photoCount: t.photoCount || 0,
      displayName: t.displayName || null,
    };
    await pool.query(
      `INSERT INTO item_archive (
         item_id, person_key, kind, from_label, phone, email, address,
         subject, title, snippet, brief, when_text, status, job_id, meta
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (item_id) DO UPDATE SET
         person_key=EXCLUDED.person_key,
         phone=COALESCE(EXCLUDED.phone, item_archive.phone),
         email=COALESCE(EXCLUDED.email, item_archive.email),
         address=COALESCE(EXCLUDED.address, item_archive.address),
         subject=COALESCE(EXCLUDED.subject, item_archive.subject),
         title=COALESCE(EXCLUDED.title, item_archive.title),
         snippet=COALESCE(EXCLUDED.snippet, item_archive.snippet),
         brief=COALESCE(item_archive.brief, EXCLUDED.brief),
         when_text=COALESCE(EXCLUDED.when_text, item_archive.when_text),
         status=COALESCE(EXCLUDED.status, item_archive.status),
         job_id=COALESCE(EXCLUDED.job_id, item_archive.job_id),
         meta=EXCLUDED.meta,
         last_seen_at=NOW()`,
      [
        itemId, pKey, t.kind, String(t.from || ''), t.phone || null, email || null,
        t.address || null, t.subject || null, t.text || null, t.snippet || null,
        t.brief || null, t.when || null, t.status || null, t.jobId || null,
        JSON.stringify(meta),
      ]
    ).catch(e => console.error('archive item:', e.message));

    if (MSG_KINDS.has(t.kind) && t.snippet) {
      await insertArchivedMessage({
        personKey: pKey,
        threadKey: `${t.kind}:${t.from}`,
        kind: t.kind,
        senderName: t.from,
        outbound: false,
        msgAt: t.when || '',
        body: t.subject ? `${t.subject} — ${t.snippet}` : t.snippet,
      }).catch(() => {});
    }

    if (t.kind !== 'job') {
      const combined = `${t.subject || ''} ${t.snippet || ''}`;
      const intro = extractContactIntro(combined);
      const signals = extractTradeSignals(combined);
      const existingDossier = directory?.byKey?.get(pKey);
      const addr = intro.address || extractAddress(combined) || (!existingDossier?.address ? (t.address || signals.suburb) : null);
      const quote = signals.quote;
      const resolvedEmail = email || intro.email || null;
      const resolvedName = name || intro.name || (!phoneLast9(t.from) && !email ? t.from : null);
      if (t.kind === 'sms' && phoneLast9(t.from) && (intro.name || intro.address)) {
        await rememberContact({
          phone: t.from,
          name: intro.name,
          address: intro.address,
          source: intro.address ? 'chat' : null,
        }).catch(() => {});
      }
      await upsertPersonDossier(pKey, {
        display_name: resolvedName,
        phone: t.phone || (t.kind === 'sms' && phoneLast9(t.from) ? t.from : null),
        email: resolvedEmail,
        channels: [t.kind],
        job_ids: signals.jobIds,
        address: addr,
        address_source: addr ? 'chat' : null,
        quote_estimate: quote,
        parts_materials: !existingDossier?.parts_materials && signals.parts.length ? signals.parts.join(', ') : null,
        ...(intro.isDetailsDrop && !existingDossier?.current_stage ? {
          current_stage: 'New client sent contact details',
          open_next_step: 'Reply or call back to discuss the job and book a time',
        } : {}),
      }, directory).catch(e => console.error('archive item dossier:', e.message));
    }

    const dRow = directory.byKey.get(pKey) || null;
    t.personKey = pKey;
    t.dossier = dRow ? toDossierDto(dRow) : null;
    if (dRow) {
      t.address = t.address || dRow.address || null;
      t.phone = t.phone || dRow.phone || null;
      t.displayName = dRow.display_name || t.displayName || null;
    }
  }
  return directory;
}

const CAL_FIRST_STOP = new Set(['jesse', 'jude', 'peyton', 'work', 'home', 'job', 'jobs', 'call', 'quote', 'test', 'info', 'help', 'client']);
const SCOPE_STOP = new Set(['with', 'that', 'this', 'from', 'your', 'will', 'have', 'need', 'needs', 'work', 'jobs', 'quote', 'client', 'reply']);
const escapeRe = s => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchPersonEventsAndCommitments(existing = {}, events = [], commitments = []) {
  const last9 = phoneLast9(existing.phone) || (String(existing.person_key || '').startsWith('phone:') ? existing.person_key.slice(6) : null);
  const addrKey = normalizeAddressKey(existing.address);
  const fullName = String(existing.display_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const nameParts = fullName.split(' ').filter(w => w.length >= 3);
  const scopeWords = String(existing.work_scope || '').toLowerCase().split(/\W+/).filter(w => w.length >= 4 && !SCOPE_STOP.has(w));

  const matchedCommitments = (commitments || []).filter(c => {
    const whoDigits = String(c.who || '').replace(/\D/g, '');
    const whoLow = String(c.who || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (last9 && whoDigits.includes(last9)) return true;
    if (fullName && (whoLow === fullName || (fullName.length >= 5 && whoLow.includes(fullName)))) return true;
    return nameParts.length >= 2 && nameParts.every(w => whoLow.includes(w));
  });

  const matchedEvents = (events || []).filter(ev => {
    const hay = `${ev.text || ''} ${ev.location || ''}`.toLowerCase();
    if (last9 && hay.replace(/\D/g, '').includes(last9)) return true;
    const evAddrKey = normalizeAddressKey(hay);
    if (addrKey && evAddrKey && addrKey === evAddrKey) return true;
    if (fullName && fullName.length >= 5 && hay.includes(fullName)) return true;
    const first = nameParts[0];
    if (!first || first.length < 4 || CAL_FIRST_STOP.has(first)) return false;
    if (!new RegExp(`\\b${escapeRe(first)}(?:\\b|'s)`, 'i').test(hay)) return false;
    return Boolean(
      evAddrKey
      || (nameParts[1] && new RegExp(`\\b${escapeRe(nameParts[1])}\\b`, 'i').test(hay))
      || scopeWords.some(w => hay.includes(w))
      || /\b(?:property|fan|fans|light|lights|switchboard|gpo|oven|quote)\b/i.test(hay)
    );
  });

  return { matchedEvents, matchedCommitments };
}

async function refreshDossiers({ maxContacts = 8 } = {}) {
  const [{ rows: candidates }, events, commitments] = await Promise.all([
    pool.query(`
      SELECT k.person_key,
             MAX(k.latest) AS latest_at,
             pd.source_hash,
             string_agg(k.sig, '|' ORDER BY k.sig) AS cur_sig
        FROM (
          SELECT person_key, last_seen_at AS latest,
                 'i:' || item_id || ':' || extract(epoch from last_seen_at)::bigint || ':' || coalesce(status, '') AS sig
            FROM item_archive
          UNION ALL
          SELECT person_key, seen_at AS latest,
                 'm:' || id AS sig
            FROM message_archive
        ) k
        LEFT JOIN person_dossiers pd ON pd.person_key = k.person_key
       WHERE k.person_key <> 'unknown'
       GROUP BY k.person_key, pd.source_hash
       ORDER BY MAX(k.latest) DESC
       LIMIT 60
    `),
    fetchEvents().catch(() => []),
    openCommitments().catch(() => []),
  ]);

  const directory = await loadPersonDirectory();
  const today = ymd(new Date());
  let updated = 0;
  for (const row of candidates) {
    if (updated >= maxContacts) break;
    const existing = directory.byKey.get(row.person_key) || { person_key: row.person_key, channels: [], job_ids: [] };
    const { matchedEvents, matchedCommitments } = matchPersonEventsAndCommitments(existing, events, commitments);
    const calCommitSig = [
      matchedCommitments.map(c => `${c.status}:${c.when_date ? ymd(c.when_date) : ''}`).join(','),
      matchedEvents.map(e => `${e.date}:${e.text}`).join(','),
    ].join(';');
    const currentHash = djb2(`v2|${row.cur_sig || ''}|${calCommitSig}`);
    if (row.source_hash === currentHash) continue;

    const [{ rows: itemRows }, { rows: msgRows }] = await Promise.all([
      pool.query(
        `SELECT kind, title, when_text, status, subject, snippet, address, meta
           FROM item_archive WHERE person_key = $1 ORDER BY last_seen_at DESC LIMIT 10`,
        [row.person_key]
      ),
      pool.query(
        `SELECT kind, outbound, msg_at, body
           FROM message_archive WHERE person_key = $1 ORDER BY id DESC LIMIT 25`,
        [row.person_key]
      ),
    ]);

    const chronoMsgs = [...msgRows].reverse();
    const jobStatus = itemRows.find(it => it.kind === 'job' && it.status)?.status || null;
    const detStage = deriveDeterministicStage({
      messages: chronoMsgs,
      commitments: matchedCommitments,
      events: matchedEvents,
      jobStatus,
      today,
    });

    const dBlock = formatDossierBlock(existing);
    const itemsText = itemRows.map(it => {
      const m = it.meta || {};
      const todo = Array.isArray(m.tasks) ? m.tasks.filter(x => x?.text).map(x => `${x.done ? '[done]' : '[open]'} ${x.text}`).join('; ') : '';
      const note = m.lastNote?.message ? `last note (${m.lastNote.author}): ${String(m.lastNote.message).slice(0, 180)}` : '';
      return `[${it.kind}${it.status ? `/${it.status}` : ''}] ${it.title || it.subject || ''}${it.when_text ? ` (${it.when_text})` : ''}${it.address ? ` @ ${it.address}` : ''}\n  ${it.snippet || ''}${todo ? `\n  checklist: ${todo}` : ''}${note ? `\n  ${note}` : ''}`.trim();
    }).join('\n');
    const msgsText = chronoMsgs
      .map(m => `[${m.kind}${m.msg_at ? ` ${m.msg_at}` : ''}] ${m.outbound ? 'me' : 'them'}: ${String(m.body || '').replace(/\s+/g, ' ').slice(0, 220)}`)
      .join('\n');
    const calText = matchedEvents
      .map(ev => `[${ev.date}${ev.time ? ' ' + ev.time : ''}] ${ev.text || ''}${ev.location ? ' @ ' + ev.location : ''}`)
      .join('\n');
    const commText = matchedCommitments
      .map(c => `[${c.status}${c.when_date ? ' ' + ymd(c.when_date) : ''}${c.when_time ? ' ' + c.when_time : ''}] ${c.what || ''}${c.quote ? ` — "${c.quote}"` : ''}`)
      .join('\n');

    if (!itemsText && !msgsText && !calText) continue;

    const signals = extractTradeSignals(`${itemsText}\n${msgsText}`);
    const signalsText = [
      signals.jobIds.length ? `Job IDs: ${signals.jobIds.map(id => `#${id}`).join(', ')}` : null,
      signals.quote ? `Quote amount: ${signals.quote}` : null,
      signals.parts.length ? `Parts/scope terms: ${signals.parts.join(', ')}` : null,
      signals.suburb ? `Suburb: ${signals.suburb}` : null,
      detStage.stage ? `Computed stage: ${detStage.stage}` : null,
    ].filter(Boolean).join('\n');

    const prompt = `You maintain an accurate client dossier for Jesse, an electrician in Geelong. Today is ${today}.
Merge what is ALREADY KNOWN with the archived items, messages, calendar bookings, and detected signals below. Only record facts explicitly supported by the data — NEVER invent addresses, quotes, dates, or parts. Preserve accurate prior facts unless clearly superseded. Write NONE for any field with no information.

${dBlock ? `EXISTING DOSSIER:\n${dBlock}\n\n` : ''}${calText ? `CALENDAR BOOKINGS:\n${calText}\n\n` : ''}${commText ? `OPEN COMMITMENTS:\n${commText}\n\n` : ''}${signalsText ? `DETECTED SIGNALS:\n${signalsText}\n\n` : ''}${itemsText ? `ARCHIVED ITEMS / JOBS:\n${itemsText}\n\n` : ''}${msgsText ? `ARCHIVED MESSAGES:\n${msgsText}\n\n` : ''}Respond with ONLY these lines:
EVIDENCE :: short verbatim quote from the messages/items/bookings above supporting your extraction
NAME :: client/person name (NONE if only a bare phone number)
ADDRESS :: street address or suburb (NONE if unknown)
SCOPE :: concise summary of the electrical work or topic
QUOTE :: quoted/discussed price or estimate verbatim
PARTS :: parts/materials needed or client-supplied items
TIMES :: preferred days/times or agreed schedule
ACCESS :: site access, keys, gate, tenant notes
STAGE :: current status/stage (use Computed stage if given, else inquiry, quoted, agreed awaiting booking, scheduled, ongoing, awaiting payment)
NEXT :: concrete next step for Jesse
SUMMARY :: 1-2 sentence cumulative overview covering context + open questions`;

    const sourceCorpus = [dBlock, itemsText, msgsText, calText, commText].filter(Boolean).join('\n');

    try {
      const raw = await askModel(prompt, 750);
      const parsed = parseDossierResponse(raw, existing, sourceCorpus);
      if (signals.jobIds.length) {
        parsed.job_ids = [...new Set([...(parsed.job_ids || []), ...signals.jobIds])].sort((a, b) => a - b);
      }
      if (!parsed.parts_materials && signals.parts.length) parsed.parts_materials = signals.parts.join(', ');
      if (!parsed.address && signals.suburb) {
        parsed.address = signals.suburb;
        parsed.address_source = 'chat';
      }
      if (detStage.stage) parsed.current_stage = detStage.stage;
      if (detStage.nextStep) parsed.open_next_step = detStage.nextStep;
      await upsertPersonDossier(row.person_key, parsed, directory, { sourceHash: currentHash });
      updated++;
    } catch (e) {
      console.error(`dossier refresh (${row.person_key}):`, e.message);
    }
  }
  if (updated) console.log(`dossiers: ${updated} updated`);
  return { updated, scanned: candidates.length };
}

async function lookupDossierForChat({ query } = {}) {
  const q = String(query || '').trim();
  if (!q) return 'Give a client name, phone number, address, or keyword to look up.';
  const like = `%${q}%`;
  const last9 = phoneLast9(q);
  const { rows } = await pool.query(
    `SELECT DISTINCT pd.*
       FROM person_dossiers pd
       LEFT JOIN item_archive ia ON ia.person_key = pd.person_key
       LEFT JOIN message_archive ma ON ma.person_key = pd.person_key
      WHERE pd.display_name ILIKE $1 OR pd.phone ILIKE $1 OR pd.email ILIKE $1
         OR pd.address ILIKE $1 OR pd.business ILIKE $1 OR pd.work_scope ILIKE $1
         OR pd.quote_estimate ILIKE $1 OR pd.parts_materials ILIKE $1
         OR pd.summary_notes ILIKE $1 OR pd.person_key ILIKE $1
         OR ia.title ILIKE $1 OR ia.snippet ILIKE $1 OR ia.subject ILIKE $1
         OR ma.body ILIKE $1
         OR ($2::text IS NOT NULL AND right(regexp_replace(coalesce(pd.phone, ''), '\\D', '', 'g'), 9) = $2)
      ORDER BY pd.updated_at DESC
      LIMIT 5`,
    [like, last9]
  );
  if (!rows.length) return `No stored client dossier or archived messages matched "${q}".`;
  const blocks = [];
  for (const d of rows) {
    const { history, messages } = await loadPersonContext(d.person_key);
    const dLine = formatDossierBlock(d) || d.person_key;
    const hLines = history.slice(0, 6).map(h =>
      `  - [${h.kind}${h.status ? `/${h.status}` : ''}] ${h.title || h.subject || h.snippet || ''}${h.when_text ? ` (${h.when_text})` : ''}`
    ).join('\n');
    const mLines = messages.slice(-10).map(m =>
      `  - ${m.outbound ? 'me' : 'them'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 180)}`
    ).join('\n');
    blocks.push([
      `DOSSIER: ${dLine}`,
      hLines ? `RECENT ARCHIVED ITEMS:\n${hLines}` : null,
      mLines ? `ARCHIVED MESSAGES:\n${mLines}` : null,
    ].filter(Boolean).join('\n'));
  }
  return blocks.join('\n\n---\n\n');
}

// What each browser source last reported. A signed-out tab or an expired
// session is the one failure that silently blinds the whole app, so it is
// surfaced as an action rather than left for the model to describe vaguely as
// "a technical issue".
const sourceHealth = {};
function noteHealth(source, state) {
  sourceHealth[source] = { state, at: Date.now() };
}

// ── Topics: the user's own tabs ───────────────────────────
// Substring matching in code, never a model judgment - the whole reason these
// tabs exist is that something about kinder or Peyton's school must never be
// quietly dropped, and a model that "decides" relevance will eventually drop
// one. A blank pattern is rejected at the API, and ignored here too: a topic
// that matches everything is a topic that tells you nothing.
const topicText = t => `${t.from || ''} ${t.displayName || ''} ${t.subject || ''} ${t.snippet || ''} ${t.text || ''}`.toLowerCase();
const splitPatterns = raw => String(raw || '').split(',').map(p => p.trim()).filter(Boolean);
function topicHits(t, topics) {
  const hay = topicText(t);
  return topics.filter(tp => splitPatterns(tp.patterns).some(p => hay.includes(p.toLowerCase())));
}

// Called once per auto tick with the raw pull. Files anything new and returns
// which topics changed, so only those get a fresh write-up.
async function fileTopics(items) {
  const { rows: topics } = await pool.query('SELECT id, slug, label, patterns FROM topics');
  if (!topics.length) return [];
  const touched = new Set();
  for (const t of items) {
    const id = workItemId(t);
    for (const tp of topicHits(t, topics)) {
      const { rowCount } = await pool.query(
        `INSERT INTO topic_entries (topic_id, item_id, kind, from_label, subject, snippet)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (topic_id, item_id) DO NOTHING`,
        [tp.id, id, t.kind || null, t.displayName || t.from || null,
         t.subject || null, String(t.text || t.snippet || '').slice(0, 600)]);
      if (rowCount) touched.add(tp.id);
    }
  }
  for (const id of touched) await writeTopicUpdate(id).catch(e => console.error('topic update:', e.message));
  return [...touched];
}

// The standing update: what is going on in this topic right now, written off
// the dated entries rather than off whatever happens to be in the inbox today.
// Regenerated only when something new files, the same way the reports are.
async function writeTopicUpdate(topicId) {
  const [{ rows: [tp] }, { rows: entries }] = await Promise.all([
    pool.query('SELECT label, patterns FROM topics WHERE id=$1', [topicId]),
    pool.query(`SELECT kind, from_label, subject, snippet, seen_at FROM topic_entries
                 WHERE topic_id=$1 ORDER BY seen_at DESC LIMIT 30`, [topicId]),
  ]);
  if (!tp || !entries.length) return;
  const lines = entries.map(e =>
    `${ymd(e.seen_at)} — ${e.from_label || e.kind}${e.subject ? ` — ${e.subject}` : ''}: `
    + String(e.snippet || '').replace(/\s+/g, ' ').slice(0, 300)).join('\n');
  const prompt = `These are the messages that have come in about "${tp.label}", newest first. Today is ${ymd(new Date())}.

${lines}

Write the user a short update on where this stands — 3 to 6 sentences, plain prose, no headings and no bullet points. Cover: what has happened lately, anything with a DATE or DEADLINE coming up, anything that is waiting on the user to do or pay something, and what is still unresolved. Quote dates, amounts and names exactly as they appear. If something important is missing or unclear, say so plainly rather than guessing. Do not pad it out and do not repeat the messages back line by line.`;
  const summary = String(await askModel(prompt, 700) || '').trim();
  if (summary) {
    await pool.query('UPDATE topics SET summary=$1, summary_at=NOW() WHERE id=$2', [summary, topicId]);
  }
}

// Fire-and-forget refile of the current pull. Guarded so two rapid edits
// cannot stack two browser-driven pulls on top of each other.
let backfilling = false;
async function backfillTopics() {
  if (backfilling) return;
  backfilling = true;
  try { await fileTopics(await collectRawItems()); }
  catch (e) { console.error('topic backfill:', e.message); }
  finally { backfilling = false; }
}

async function handleTopics(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  if (req.method === 'GET') {
    const { rows } = await pool.query(
      `SELECT t.id, t.slug, t.label, t.patterns, t.summary, t.summary_at,
              COUNT(e.id) FILTER (WHERE e.read_at IS NULL) AS unread,
              COUNT(e.id) AS total, MAX(e.seen_at) AS last_at
         FROM topics t LEFT JOIN topic_entries e ON e.topic_id = t.id
        GROUP BY t.id ORDER BY t.created_at`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows.map(r => ({ ...r, unread: Number(r.unread), total: Number(r.total) }))));
    return;
  }
  if (req.method === 'POST') {
    const { label, patterns } = JSON.parse(await readBody(req));
    const list = splitPatterns(patterns);
    if (!String(label || '').trim() || !list.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'a name and at least one keyword are required' }));
      return;
    }
    const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
                 || `topic-${Date.now()}`;
    try {
      const { rows } = await pool.query(
        'INSERT INTO topics (slug, label, patterns) VALUES ($1,$2,$3) RETURNING id, slug, label, patterns',
        [slug, String(label).trim(), list.join(', ')]);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows[0]));
      // Backfill from what is already on the list, so a new tab is not empty
      // until the next thing arrives. AFTER the response, deliberately: this
      // drives the browser bridge and takes tens of seconds, which is well
      // inside the window where Cloudflare would give up on the request.
      backfillTopics();
    } catch (e) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.code === '23505' ? 'there is already a tab with that name' : e.message }));
    }
  }
}

// One topic's dated report. Entries are grouped by the day they arrived, which
// is what makes this readable as a record rather than a pile.
async function handleTopic(req, res, slug) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const { rows: [tp] } = await pool.query(
    'SELECT id, slug, label, patterns, summary, summary_at FROM topics WHERE slug=$1', [slug]);
  if (!tp) { res.writeHead(404); res.end(JSON.stringify({ error: 'no such tab' })); return; }

  if (req.method === 'DELETE') {
    await pool.query('DELETE FROM topics WHERE id=$1', [tp.id]);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  if (req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.patterns !== undefined) {
      const list = splitPatterns(body.patterns);
      if (!list.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'at least one keyword is required' })); return; }
      await pool.query('UPDATE topics SET patterns=$1 WHERE id=$2', [list.join(', '), tp.id]);
      backfillTopics();   // same reason as on create: too slow to hold a response open
    }
    if (body.read) await pool.query('UPDATE topic_entries SET read_at=NOW() WHERE topic_id=$1 AND read_at IS NULL', [tp.id]);
    if (body.rewrite) await writeTopicUpdate(tp.id).catch(() => {});
    const { rows: [fresh] } = await pool.query('SELECT summary, summary_at, patterns FROM topics WHERE id=$1', [tp.id]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...fresh })); return;
  }

  const { rows: entries } = await pool.query(
    `SELECT id, kind, from_label, subject, snippet, seen_at, read_at
       FROM topic_entries WHERE topic_id=$1 ORDER BY seen_at DESC LIMIT 200`, [tp.id]);
  const days = [];
  for (const e of entries) {
    const d = ymd(e.seen_at);
    if (!days.length || days[days.length - 1].date !== d) days.push({ date: d, entries: [] });
    days[days.length - 1].entries.push(e);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...tp, days, unread: entries.filter(e => !e.read_at).length }));
}

// ── Next actions: the pressure band ───────────────────────
// Every row here is a state transition the data already shows, not a model
// judgment - a thing agreed but not booked, a job whose day has passed, a job
// still open with nothing booked next. Amber in this app means "act on this
// now", so this is the only place it is earned.
const ONGOING = new Set(['on_my_way', 'in_progress']);
const calendarUrl = (title, date, time, details, location, src) => {
  if (!date) return null;
  return calendarDraftUrl({ title, date, time: time || '09:00', durationMins: 120, place: location, details, src });
};

// What the work actually is, in the words the job record already holds. A row
// reading "Book the next visit with <name>" told you nothing you could prepare
// for - you had to open switch-craft to find out whether it was a switchboard
// or a downlight. Outstanding tasks first (they are the work that is left),
// then the description, then the job type.
function jobWork(j) {
  const todo = (j.tasks || []).filter(t => !t.done).map(t => String(t.text || '').trim()).filter(Boolean);
  if (todo.length) return `Still to do: ${todo.slice(0, 4).join('; ')}`;
  const desc = String(j.snippet || '').replace(/\s+/g, ' ').trim();
  if (desc) return desc.slice(0, 220);
  return j.jobType ? `Job type: ${j.jobType}` : null;
}
const jobWhere = j => [j.address, j.phone].filter(Boolean).join(' · ') || null;

// A commitment's extracted WHAT is sometimes a pronoun ("me", "it") - the
// model copied the wrong half of the line. A row built on that says nothing,
// so fall through to the job record and then to the quoted line rather than
// printing the pronoun back at him.
const THIN_WHAT = /^(me|them|it|this|that|him|her|us|you|there|job|work|one)$/i;

async function nextActions() {
  const today = ymd(new Date());
  let out = [];

  // Jobs first: a commitment that matches an open job can borrow its
  // description, which is always better than anything extracted from a text.
  let jobs = [];
  try { jobs = (await getSwitchcraftJobs()).items || []; }
  catch (e) { console.error('actions: jobs —', e.message); }
  const digits = v => String(v || '').replace(/\D/g, '').slice(-9);
  const jobFor = who => {
    const w = String(who || '').toLowerCase().trim();
    const d = digits(who);
    return jobs.find(j => (d && d.length >= 9 && digits(j.phone) === d)
                       || (w.length > 3 && String(j.identifier || '').toLowerCase().includes(w))) || null;
  };

  // Whether the calendar can be read at all, so the rows below can say "not in
  // the calendar" only when that has actually been checked.
  const [calDark, workCalId, directory] = await Promise.all([
    calendarUnreadable(await fetchCalendar().catch(() => ({}))),
    getWorkCalendarId().catch(() => null),
    loadPersonDirectory().catch(() => null),
  ]);
  const dossierFor = whoOrItem => (directory ? lookupDossierInDir(whoOrItem, directory) : null);

  // Agreed in a message, absent from the calendar.
  try {
    const { rows } = await pool.query(
      `SELECT id, who, what, quote, detail, when_date, when_time, source_thread FROM commitments
        WHERE status = 'unbooked' ORDER BY when_date NULLS LAST, first_seen_at LIMIT 8`);
    for (const r of rows) {
      const when = r.when_date ? ymd(r.when_date) : null;
      const known = await lookupContact(r.who).catch(() => null);
      const job = jobFor(r.who);
      const dRow = dossierFor(r.who) || dossierFor(r.source_thread);
      const who = dRow?.display_name || known?.display_name || job?.identifier || r.who;
      const said = String(r.what || '').trim();
      // In order of how much it actually tells him about the job. detail is
      // the sentence written off the whole thread and is almost always the
      // best of them; the extractor's WHAT is a few words copied out of one
      // line, which is how "put them in" ended up as the name of a job.
      const work = String(r.detail || '').trim()
                 || ((said && !THIN_WHAT.test(said) && said.length > 6) ? said : '')
                 || (job ? jobWork(job) : '')
                 || cleanDossierValue(dRow?.work_scope)
                 || String(r.quote || '').replace(/\s+/g, ' ').trim().slice(0, 160)
                 || 'work agreed over text';
      const place = known?.address || job?.address || dRow?.address || null;
      const phone = phoneLast9(r.who) ? r.who : (job?.phone || dRow?.phone || null);
      out.push({
        id: `book-${r.id}`, kind: 'book',
        // Re-based. These used to sit at 2-4, which was top of the band when
        // the band held nothing else. Adding a whole tier of client nags above
        // them pushed every one off - and "they agreed a time and it is not in
        // your diary" is the row most likely to cost a job he simply does not
        // turn up to. Today or already past outranks everything bar a dead
        // source.
        urgency: !when ? 5 : when <= today ? 8 : when <= ymd(new Date(Date.now() + 2 * 86400000)) ? 7 : 6,
        at: when ? new Date(`${when}T00:00:00`).getTime() : 0,
        fact: `${r.id}:${when || ''}`,
        dossier: dRow ? toDossierDto(dRow) : null,
        // The row is a contact card: who, how to reach them, where, and what
        // the job is. A title that was only the extracted phrase told him
        // neither who it was nor what he would be doing.
        person: {
          name: who,
          // Don't print the number twice when it is standing in for the name.
          phone: phone && phone !== who ? phone : null,
          address: place,
          // A thread name that is not just a number is the name his phone has
          // for them, which is better than anything else available here.
          via: r.source_thread && r.source_thread !== r.who ? r.source_thread : null,
        },
        work,
        title: who,
        detail: `${when ? `Agreed for ${when}` : 'No day pinned down yet'}. `
              + (calDark ? 'Cannot see your calendar to check — reconnect Google in LIFE_CMD.'
                         : 'Not in the calendar.'),
        quote: r.quote,
        // Structured, not a bare Google link: the button opens the booking
        // form so how long it will take and whether it needs parts get
        // answered before anything is written. The link is the fallback for
        // when the form cannot reach the calendar tab.
        book: {
          title: `${work} — ${who}`.slice(0, 180),
          date: when || today, time: r.when_time || '09:00',
          location: place || '', kind: 'sms', from: r.who,
          parts: cleanDossierValue(dRow?.parts_materials) || '',
        },
        phone: phone || null,
        reply: (phone || r.who) ? {
          channel: 'sms', to: phone || r.who, name: who, kind: 'sms',
          text: work, snippet: r.quote || work,
        } : null,
        chat: { kind: 'sms', from: r.who, snippet: r.quote || work },
        where: [phone && phone !== who ? phone : null, place].filter(Boolean).join(' · ') || null,
        href: calendarUrl(`${work} — ${who}`, when || today, r.when_time, r.quote, place, workCalId),
        cta: when ? 'add to calendar' : 'pick a day in the calendar',
      });
    }
  } catch (e) { console.error('actions: commitments —', e.message); }

  // Someone is waiting on HIM. These two outrank the housekeeping rows below,
  // and climb as they age, because a client left hanging is the only thing on
  // this list that costs work. Both are computed from timestamps, so neither
  // can nag about something that was already answered.
  const person = j => {
    const dRow = dossierFor({ kind: 'job', from: j.identifier, phone: j.phone });
    return {
      name: j.identifier,
      phone: j.phone || dRow?.phone || null,
      address: j.address || dRow?.address || null,
      via: null,
    };
  };
  const jobExtras = (j, snippet, allowBook = true) => {
    const text = jobWork(j) || j.jobType || j.identifier;
    const dRow = dossierFor({ kind: 'job', from: j.identifier, phone: j.phone });
    const phone = j.phone || dRow?.phone || null;
    return {
      phone,
      dossier: dRow ? toDossierDto(dRow) : null,
      reply: looksLikePhone(phone) ? {
        channel: 'sms', to: phone, name: j.identifier, kind: 'job',
        text, snippet: snippet || text,
      } : null,
      ...(allowBook ? {
        book: {
          title: `${text} — ${j.identifier}`.slice(0, 180),
          date: j.scheduledDate || today,
          time: j.scheduledTime || '09:00',
          location: j.address || dRow?.address || '', kind: 'job', from: j.identifier,
          parts: cleanDossierValue(dRow?.parts_materials) || '',
        },
      } : {}),
      chat: { kind: 'job', from: j.identifier, snippet: snippet || text },
    };
  };
  for (const j of jobs) {
    const href = `${process.env.SWITCHCRAFT_BASE_URL}/admin/jobs/${j.id}`;

    // A note or a photo the client added after his last reply. A photo with no
    // note is still a question - "is this okay" is usually the photo itself.
    const fromClient = j.lastNote && j.lastNote.author === 'client' ? new Date(j.lastNote.at).getTime() : 0;
    const photoAt = j.lastPhotoAt ? new Date(j.lastPhotoAt).getTime() : 0;
    const asked = Math.max(fromClient, photoAt);
    const replied = j.lastReplyAt ? new Date(j.lastReplyAt).getTime() : 0;
    // A photo on its own goes stale. Several jobs carry photos uploaded at
    // booking time and no admin note ever, because he answered by phone - four
    // months on that is not a client waiting, it is a job he closed off the
    // app, and it would sit on the band forever pushing today's out. An actual
    // typed question never expires; a bare photo stops counting after a
    // fortnight.
    const noteIsTheAsk = fromClient > replied;
    const stale = !noteIsTheAsk && (Date.now() - asked) > 14 * 86400000;
    if (asked && asked > replied && !stale) {
      const days = Math.floor((Date.now() - asked) / 86400000);
      const said = j.lastNote && j.lastNote.author === 'client'
        ? String(j.lastNote.message || '').replace(/\s+/g, ' ').trim() : '';
      const added = photoAt > replied && j.photoCount
        ? `${j.photoCount} photo${j.photoCount === 1 ? '' : 's'}` : '';
      const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
      out.push({
        id: `reply-${j.id}`, kind: 'waiting-on-you', fact: `${j.id}:${asked}`,
        urgency: Math.min(8, 6 + Math.floor(days / 2)),
        at: asked,
        title: j.identifier,
        person: person(j),
        work: jobWork(j),
        detail: [
          added ? `Put up ${added}` : 'Left a note',
          said ? `and asked, ${ago}.` : `${ago}.`,
          replied ? 'You have not answered since.' : 'You have never answered on this job.',
        ].join(' '),
        quote: said ? said.slice(0, 180) : null,
        ...jobExtras(j, said || jobWork(j)),
        href, cta: 'answer them on the job',
      });
    }

    // A quote asked for and never sent. Status 'quoted' is the only thing that
    // closes it, so this keeps turning up until an estimate actually goes out.
    if (j.jobType === 'quote' && j.status !== 'quoted') {
      const days = daysOpen(j.raised);
      if (days >= 1) {
        out.push({
          id: `quote-${j.id}`, kind: 'quote-owed', fact: `${j.id}:${j.status}`,
          urgency: Math.min(8, 6 + Math.floor(days / 3)),
          at: new Date(j.raised || 0).getTime(),
          title: j.identifier,
          person: person(j),
          work: jobWork(j),
          detail: `Asked for an estimate ${days} day${days === 1 ? '' : 's'} ago and nothing has gone out. It stays here until the job is marked quoted.`,
          ...jobExtras(j, jobWork(j)),
          href, cta: 'send the estimate',
        });
      }
    }
  }

  // Jobs whose scheduled day has already passed, and jobs left open.
  for (const j of jobs) {
    const past = j.scheduledDate && j.scheduledDate < today;
    const ongoing = ONGOING.has(j.status);
    const href = `${process.env.SWITCHCRAFT_BASE_URL}/admin/jobs/${j.id}`;
    if (past && !ongoing) {
      out.push({
        id: `invoice-${j.id}`, kind: 'invoice', urgency: 5,
        fact: `${j.id}:${j.status}:${j.scheduledDate || ''}`,
        title: `Invoice ${j.identifier}`,
        detail: `${j.when}. If it is finished, invoice it — if it is not, mark it ongoing.`,
        work: jobWork(j), where: jobWhere(j),
        ...jobExtras(j, jobWork(j) || j.when),
        href, cta: 'open the job',
      });
    } else if (ongoing && (past || !j.scheduledDate)) {
      const dRow = dossierFor({ kind: 'job', from: j.identifier, phone: j.phone });
      out.push({
        id: `next-${j.id}`, kind: 'next-visit', urgency: 6,
        fact: `${j.id}:${j.status}:${j.scheduledDate || ''}`,
        title: `Book the next visit with ${j.identifier}`,
        detail: past
          ? `Still marked ${String(j.status).replace(/_/g, ' ')} and ${j.when}. Lock the next visit in before it stalls.`
          : `Marked ${String(j.status).replace(/_/g, ' ')} with nothing booked next. Lock the next visit in before it stalls.`,
        work: jobWork(j), where: jobWhere(j),
        // The whole point of this row is to get a day in the diary, so it
        // offers the booking form as well as the job record.
        book: {
          title: `${jobWork(j) || j.jobType || 'Next visit'} — ${j.identifier}`.slice(0, 180),
          date: today, time: j.scheduledTime || '09:00',
          location: j.address || dRow?.address || '', kind: 'job', from: j.identifier,
          parts: cleanDossierValue(dRow?.parts_materials) || '',
        },
        ...jobExtras(j, jobWork(j) || j.when, false),
        href, cta: 'open the job',
      });
    }
  }

  // A person waiting on a reply. /api/waiting already works this out in code -
  // the last message in the thread is not his - and has the bulk senders
  // filtered out of it. It fed the reports and nothing else, so it told him
  // about his mum only if he went and read a category. This is the life-side
  // twin of the job rows above.
  try {
    const { items: owed = [] } = await getWaitingReplies({ limit: 25 });
    // Names the band is already nagging him about, so a client who also texted
    // does not take two slots.
    const covered = new Set(out.map(a => String(a.title || '').toLowerCase().trim()).filter(Boolean));
    const FLOOR_H = 12;   // replying the same morning is normal; this is for what got missed
    // Email belongs in the reports, not on the band. Everything transactional
    // is conversational by shape - a depot notice, an order confirmation - and
    // three of the first six rows this produced were mail nobody was waiting
    // on. On the top-six pressure surface precision beats reach; the reports
    // still carry every one of them.
    const BAND_SOURCES = new Set(['sms', 'whatsapp', 'messenger', 'meta']);
    // A conversation that ended with a thanks is not someone waiting. No
    // question asked, short, and grateful: that is a full stop, not a prompt.
    const THANKS = /\b(thanks|thank you|ta|cheers|no worries|all good|appreciate it)\b/i;
    const isEnder = t => !t.includes('?') && t.length <= 80 && THANKS.test(t);
    for (const w of owed) {
      if (!BAND_SOURCES.has(w.kind)) continue;
      const who = String(w.displayName || w.identifier || '').trim();
      if (!who || covered.has(who.toLowerCase())) continue;
      const at = w.occurred_at ? new Date(w.occurred_at).getTime() : 0;
      if (!at) continue;
      const hours = (Date.now() - at) / 3600000;
      const asked = String(w.snippet || '').replace(/\s+/g, ' ').trim();
      if (isEnder(asked)) continue;
      const intro = extractContactIntro(asked);
      // Same rule the job photos get: past a month this is a conversation that
      // ended, not a reply he owes, and left in it would sit at the urgency cap
      // forever pushing out the ones he can still answer. Details drops bypass
      // the 12h warm-up so new leads surface right away.
      if ((!intro.isDetailsDrop && hours < FLOOR_H) || hours > 30 * 24) continue;
      const days = Math.floor(hours / 24);
      const known = await lookupContact(w.identifier || who).catch(() => null);
      const job = jobFor(w.identifier || who);
      const dRow = dossierFor({ kind: w.kind, from: w.identifier || who, name: who });
      const mergedKnown = {
        ...(known || {}),
        display_name: known?.display_name || dRow?.display_name || intro.name || null,
        address: known?.address || dRow?.address || intro.address || null,
      };
      const displayWho = mergedKnown.display_name || job?.identifier || who;
      if (covered.has(displayWho.toLowerCase())) continue;
      const callFlag = hasUnrepliedCall(asked);
      const meta = enrichReplyOwed({
        w,
        who,
        displayWho,
        title: callFlag ? callFlagTitle(displayWho) : displayWho,
        asked,
        today,
        known: mergedKnown,
        job,
        extractedAddress: intro.address || extractAddress(asked),
      });
      if (meta.book && dRow?.parts_materials && !meta.book.parts) {
        meta.book.parts = cleanDossierValue(dRow.parts_materials) || '';
      }
      const baseUrgency = (callFlag || intro.isDetailsDrop) ? 6 : 5;
      out.push({
        id: `owed-${w.kind}-${who.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        kind: 'reply-owed',
        badge: callFlag
          ? 'callback · no reply seen'
          : intro.isDetailsDrop
            ? 'sent their details · follow up'
            : null,
        fact: `${w.kind}:${at}`,
        dossier: dRow ? toDossierDto(dRow) : null,
        // Below a client at the same age - work leads - but it still climbs,
        // so someone left a week gets to the top on their own.
        urgency: Math.min(8, baseUrgency + Math.floor(days / 2)),
        at,
        ...meta,
        work: asked ? asked.slice(0, 220) : null,
        detail: callFlag
          ? `${days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : 'Yesterday'} on ${w.kind}${w.unread ? ', still unread' : ''}. Reverb only sees texts, not phone calls.`
          : `${days >= 1 ? `Sent the last message ${days} day${days === 1 ? '' : 's'} ago` : hours < 12 ? 'Sent details recently' : 'Sent the last message yesterday'} on ${w.kind}${w.unread ? ', still unread' : ''}. You have not answered.`,
      });
    }
  } catch (e) { console.error('actions: waiting —', e.message); }

  // A dark source outranks everything: nothing else on this list can be
  // trusted to be complete while one is down.
  for (const [source, h] of Object.entries(sourceHealth)) {
    if (!h || h.state === 'ok') continue;
    out.push({
      id: `source-${source}`, kind: 'source-down', urgency: 9,
      title: `Reverb cannot read ${source}`,
      detail: `${h.state}. Until that is fixed this list is incomplete — open the browser tab and sign in again.`,
      browserSource: source,
      cta: 'open browser tab',
    });
  }

  // Urgency caps at 8, so without a tie-break a four-month-old row and
  // this morning's one sort by whatever order the feed happened to use.
  // Most recently asked wins the tie - that is the one he can still fix.
  out.sort((a, b) => b.urgency - a.urgency || (b.at || 0) - (a.at || 0));
  // Four is a list you act on; ten is a second to-do list. The exception is a
  // person left waiting: dropping one off the bottom is how it got missed in
  // the first place, so the band stretches to six while any are open. They
  // sort above everything else, so the extra slots are theirs.
  // Rows he has already dealt with, while the thing that justified them has
  // not changed.
  try {
    const { rows } = await pool.query('SELECT action_id, fact FROM action_done');
    const done = new Map(rows.map(r => [r.action_id, r.fact]));
    out = out.filter(a => !(done.has(a.id) && done.get(a.id) === String(a.fact ?? '')));
  } catch (e) { console.error('actions: done —', e.message); }

  const NAG = new Set(['waiting-on-you', 'quote-owed', 'reply-owed']);

  // Bookings do not compete. Giving them one guaranteed slot was still the
  // wrong shape: with several people having agreed a time, one showed and the
  // rest stayed invisible. There are never many - the ledger serves a handful -
  // and every one of them is a job he will otherwise not turn up to, so all of
  // them are shown and the ranked rows fill whatever is left.
  const bookings = out.filter(a => a.kind === 'book')
                      .sort((a, b) => (a.at || 0) - (b.at || 0));   // soonest first
  const rest = out.filter(a => a.kind !== 'book');
  const nagging = rest.some(a => NAG.has(a.kind));
  // Never shrink below two, so the band does not become bookings and nothing.
  const room = Math.max(2, (nagging ? 6 : 4) - bookings.length);
  const ranked = rest.slice(0, room);

  // Work always out-urgencies a personal message, so a busy day buries the one
  // he asked to be reminded about. It keeps a slot of its own.
  if (ranked.length && !ranked.some(a => a.kind === 'reply-owed')) {
    const want = rest.find(a => a.kind === 'reply-owed');
    if (want) ranked.splice(ranked.length - 1, 1, want);
  }
  ranked.sort((a, b) => b.urgency - a.urgency || (b.at || 0) - (a.at || 0));
  return [...bookings, ...ranked];
}

// Group the collected items into the two reports and persist them. The model
// call lives in groupGrounded; everything else here is bookkeeping.
async function buildReports(items) {
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
  return { work, life };
}

async function handleReportGenerate(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }

  generating = true;
  let work, life;
  try {
    const items = await collectGroundedItems();
    ({ work, life } = await buildReports(items));
    // Tell the scheduler this content is already grouped, so its next tick
    // doesn't immediately redo the work you just paid for by hand.
    lastItemHash = itemsHash(items);
  } finally {
    generating = false;
  }

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

// ── Auto-refresh ─────────────────────────────────
// Being asked to press "generate" is the app making its problem yours, so the
// server keeps itself current. Two tiers, because the two halves cost wildly
// different amounts:
//
//   tier 1 (every AUTO_MS): read every source and hash what came back. All
//           deterministic - browser reads and SQL, no model call.
//   tier 2 (only when that hash changed): the model work - conversation
//           briefs, grouping into reports, and the commitments ledger.
//
// So an idle day costs one browser sweep every ten minutes and nothing on the
// GPU, while a new message is grouped and briefed within one tick of arriving.
// Serial throughout: the bridge drives one browser and LM Studio is one GPU,
// so a tick never overlaps itself or a manual generate.
const AUTO_MS = Number(process.env.REVERB_AUTO_MS || 10 * 60 * 1000);
let generating = false;   // a manual /api/report/generate is in flight
let ticking = false;
let lastItemHash = null;

// Identity of the whole collection, not of its wording: workItemId is the same
// content hash the done-list uses, so a re-read of unchanged sources hashes
// identically and tier 2 is skipped.
const itemsHash = items => djb2(items.map(workItemId).sort().join('|'));

async function autoTick() {
  if (ticking || generating) return;
  ticking = true;
  try {
    const raw = await collectRawItems();
    // Before the change gate, deliberately: an item can already be in a report
    // that has not changed, and a topic that only files on a changed pull
    // would miss it. Filing is a cheap INSERT ... ON CONFLICT DO NOTHING.
    try {
      const touched = await fileTopics(raw);
      if (touched.length) console.log(`auto: ${touched.length} topic tab(s) updated`);
    } catch (e) { console.error('auto topics:', e.message); }
    const hash = itemsHash(raw);
    if (hash === lastItemHash) {
      console.log(`auto: ${raw.length} items, unchanged`);
      await refreshDossiers({ maxContacts: 4 }).catch(e => console.error('auto dossiers:', e.message));
      return;
    }
    const first = lastItemHash === null;
    await buildReports(await briefConversations(raw));
    lastItemHash = hash;
    console.log(`auto: ${raw.length} items, ${first ? 'first run' : 'changed'} - reports rebuilt`);
    const led = await refreshCommitments();
    console.log('auto commitments:', JSON.stringify(led));
    await refreshDossiers({ maxContacts: 8 }).catch(e => console.error('auto dossiers:', e.message));
  } catch (e) {
    // Leave lastItemHash alone on failure so the next tick retries instead of
    // treating a half-finished pass as the current state.
    console.error('auto refresh failed:', e.message);
  } finally {
    ticking = false;
  }
}

// "Refresh all data", by hand. The timer's own pass, with the change gate
// forced open: the gate exists so a quiet ten minutes costs nothing, but when
// he presses the button he wants the work done whether or not a hash moved.
//
// It is a slow pass - browser reads and model calls, minutes not seconds - so
// it runs detached and reports progress, rather than holding a request open
// past whatever Cloudflare is willing to wait. Every step is idempotent, so
// pressing it twice is harmless; `ticking` is shared with the timer so the two
// can never run over each other.
let refreshJob = null;

async function runFullRefresh() {
  const step = s => { if (refreshJob) refreshJob.step = s; console.log(`refresh all: ${s}`); };
  ticking = true;
  try {
    step('reading every source');
    const raw = await collectRawItems();

    step('filing topic tabs');
    try { await fileTopics(raw); } catch (e) { console.error('refresh topics:', e.message); }

    step('rewriting the lists');
    await buildReports(await briefConversations(raw));
    lastItemHash = itemsHash(raw);

    step('looking for times agreed in messages');
    const led = await refreshCommitments().catch(e => ({ ok: false, reason: e.message }));

    step('checking the calendar for what is already booked');
    const { booked, unsure, blind } = await reconcileOpenCommitments();

    step('updating client dossiers');
    const dossiers = await refreshDossiers({ maxContacts: 12 }).catch(e => ({ error: e.message }));

    refreshJob.result = {
      items: raw.length,
      found: led.found ?? 0, superseded: led.superseded ?? 0,
      booked, unsure, blind,
      dossiersUpdated: dossiers.updated ?? 0,
      actions: (await nextActions().catch(() => [])).length,
    };
  } catch (e) {
    console.error('refresh all failed:', e.message);
    refreshJob.error = e.message;
  } finally {
    ticking = false;
    refreshJob.running = false;
    refreshJob.step = null;
    refreshJob.finishedAt = Date.now();
  }
}

async function handleRefreshAll(req, res) {
  if (!requireAuth(req)) { res.writeHead(401); res.end('{}'); return; }
  const status = () => ({
    running: !!refreshJob?.running, step: refreshJob?.step || null,
    startedAt: refreshJob?.startedAt || null, finishedAt: refreshJob?.finishedAt || null,
    result: refreshJob?.result || null, error: refreshJob?.error || null,
  });
  if (req.method === 'POST' && !refreshJob?.running) {
    if (ticking || generating) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...status(), busy: true }));
      return;
    }
    refreshJob = { running: true, step: 'starting', startedAt: Date.now(),
                   finishedAt: null, result: null, error: null };
    runFullRefresh();                       // deliberately not awaited
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status()));
}

function startAutoRefresh() {
  if (AUTO_MS <= 0) { console.log('auto refresh: off'); return; }
  console.log(`auto refresh: every ${Math.round(AUTO_MS / 60000)}m`);
  setTimeout(autoTick, 15_000).unref?.();   // let the browser bridge settle first
  setInterval(autoTick, AUTO_MS);
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
    if (req.method === 'POST' && u === '/api/text/send')       return await handleTextSend(req, res);
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
    const topicMatch = u.match(/^\/api\/topics\/([a-z0-9-]+)$/);
    if (u === '/api/topics') return await handleTopics(req, res);
    if (topicMatch) return await handleTopic(req, res, topicMatch[1]);
    if (req.method === 'GET'  && u === '/api/contacts') return await handleContacts(req, res);
    if (req.method === 'POST' && u === '/api/contacts/signal') return await handleContactSignal(req, res);
    if (req.method === 'POST' && u === '/api/contacts/mute')   return await handleContactMute(req, res);
    if (req.method === 'GET'  && u === '/api/sources')         return await handleSources(req, res);
    if (req.method === 'POST' && u === '/api/actions/done')    return await handleActionDone(req, res);
    if (req.method === 'POST' && u === '/api/actions/refresh') return await handleActionsRefresh(req, res);
    if (u === '/api/refresh-all' && (req.method === 'POST' || req.method === 'GET')) return await handleRefreshAll(req, res);
    const contactMatch = u.match(/^\/api\/contacts\/(\d+)$/);
    if (req.method === 'PATCH' && contactMatch) return await handleContactTier(req, res, contactMatch[1]);
    if (req.method === 'PATCH' && u === '/api/dossiers') return await handleDossierPatch(req, res);
    if (u === '/api/rules') return await handleRules(req, res);
    const ruleMatch = u.match(/^\/api\/rules\/(\d+)$/);
    if (req.method === 'DELETE' && ruleMatch) return await handleRuleDelete(req, res, ruleMatch[1]);
    if (req.method === 'GET'  && u === '/api/browser/frame') return await handleBrowserFrame(req, res);
    if (req.method === 'POST' && u === '/api/browser/input') return await handleBrowserInput(req, res);
    const jobPhotoMatch = u.match(/^\/api\/job-photo\/(\d+)$/);
    if (req.method === 'GET' && jobPhotoMatch) return await handleJobPhoto(req, res, jobPhotoMatch[1]);
    if (req.method === 'GET'  && u === '/api/item/context') return await handleItemContext(req, res);
    if (req.method === 'POST' && u === '/api/item/tocal')   return await handleItemToCal(req, res);
    if (req.method === 'POST' && u === '/api/item/draft')   return await handleItemDraft(req, res);
    if (req.method === 'POST' && u === '/api/item/detail')  return await handleItemDetail(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end('internal error'); }
  }
}).listen(PORT, async () => {
  await initDb();
  console.log(`reverb on :${PORT}`);
  startAutoRefresh();
});
