-- Snapshot only. Authoritative source is initDb() in server.js.
-- Reverb deliberately holds no copy of SMS/email/calendar data — every
-- tool call fetches live from text-cmd / Lifecmd2 at query time.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- 'owner_pin_hash' lives here
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
