export const TEXTS_TOOL = {
  type: 'function',
  function: {
    name: 'get_recent_texts',
    description: 'Get recent SMS text messages, optionally filtered to one contact. Use this for questions like "what did mom text me" or "any new messages".',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Optional contact name or phone number to filter by, e.g. "mom"' },
        limit:   { type: 'integer', description: 'Max messages to return, default 20' },
      },
    },
  },
};

export const CALENDAR_TOOL = {
  type: 'function',
  function: {
    name: 'get_upcoming_events',
    description: 'Get upcoming calendar events. Use for questions like "what\'s on my calendar today" or "what do I have this week".',
    parameters: {
      type: 'object',
      properties: {
        days_ahead: { type: 'integer', description: 'How many days ahead to look, default 1 (today only)' },
      },
    },
  },
};

export const EMAIL_TOOL = {
  type: 'function',
  function: {
    name: 'get_recent_emails',
    description: 'Get recent Gmail messages with subject/sender/snippet. Use for questions like "summarize my unread email".',
    parameters: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Only return unread emails, default false' },
        limit:       { type: 'integer', description: 'Max emails to return, default 10' },
      },
    },
  },
};

export const BUSINESS_EMAIL_TOOL = {
  type: 'function',
  function: {
    name: 'get_recent_business_emails',
    description: 'Get recent Gmail messages from the separate business account (scegeelong@gmail.com), not the personal inbox. Use for questions like "any new business emails".',
    parameters: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Only return unread emails, default false' },
        limit:       { type: 'integer', description: 'Max emails to return, default 10' },
      },
    },
  },
};

export const NOTIFICATIONS_TOOL = {
  type: 'function',
  function: {
    name: 'get_recent_notifications',
    description: 'Get recent WhatsApp, Messenger, or Instagram DM notifications captured from the phone. These are notification-preview text only (often truncated, no full thread) — not a full inbox mirror. Use for questions like "any new WhatsApp messages".',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['whatsapp', 'messenger', 'instagram'], description: 'Optional: filter to one app. Omit to get all three.' },
        limit:  { type: 'integer', description: 'Max notifications to return, default 30' },
      },
    },
  },
};

export const SWITCHCRAFT_JOBS_TOOL = {
  type: 'function',
  function: {
    name: 'get_switchcraft_jobs',
    description: 'Get non-completed jobs from the Switch Craft Electrics booking system — pending, accepted, in-progress, and quoted work. Use for questions like "what jobs are on" or "any unquoted work".',
    parameters: { type: 'object', properties: {} },
  },
};

// SMS flows through notify-cmd now (MacroDroid "SMS Received" trigger), not
// text-cmd — that pipeline went stale (no ingested messages for a month) and
// was abandoned rather than kept on life support. sender is a raw phone
// number (no contact-name resolution available from this path), so the
// `contact` filter matches against it as a substring.
// Chat's tool-calling path only ever wants the .text string (see ChatView's
// call sites in server.js's proxyChat); gatherSources (Sweep/Work) also
// wants the structured .items so it can track senders in the contacts table
// without a second round-trip to the same source.
export async function getRecentTexts({ contact, limit = 20 } = {}) {
  const params = new URLSearchParams({ source: 'sms', limit: String(limit) });
  let r;
  try {
    r = await fetch(`${process.env.NOTIFY_CMD_BASE_URL}/api/notifications/recent?${params}`, {
      headers: { 'X-Service-Token': process.env.NOTIFY_CMD_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach notify-cmd: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach notify-cmd (status ${r.status})`, items: [] };
  let msgs = await r.json();
  if (contact) msgs = msgs.filter(m => (m.sender || '').includes(contact));
  if (!msgs.length) return { text: 'No matching text messages found.', items: [] };
  const items = msgs.map(m => ({ identifier: m.sender, displayName: m.sender, snippet: m.body, occurred_at: m.occurred_at }));
  return { text: msgs.map(m => `[${m.occurred_at}] ${m.sender}: ${m.body}`).join('\n'), items };
}

export async function getUpcomingEvents({ days_ahead = 1 } = {}) {
  let r;
  try {
    r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/events`);
  } catch (err) { return `Could not reach LIFE_CMD: ${err.message}`; }
  if (!r.ok) return `Could not reach LIFE_CMD (status ${r.status})`;
  const all = await r.json();
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + days_ahead * 86400000).toISOString().slice(0, 10);
  const upcoming = all.filter(e => e.date >= today && e.date <= end);
  if (!upcoming.length) return 'No upcoming events in that window.';
  return upcoming.map(e => `${e.date}${e.time ? ' ' + e.time : ''}: ${e.text}${e.location ? ' @ ' + e.location : ''}`).join('\n');
}

export async function getRecentEmails({ unread_only = false, limit = 10 } = {}) {
  const params = new URLSearchParams({ unreadOnly: String(unread_only), limit: String(limit) });
  let r;
  try {
    r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/google/gmail/recent?${params}`, {
      headers: { 'X-Service-Token': process.env.LIFECMD_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach Gmail via LIFE_CMD: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach Gmail via LIFE_CMD (status ${r.status})`, items: [] };
  const emails = await r.json();
  if (!emails.length) return { text: 'No matching emails found.', items: [] };
  const items = emails.map(e => ({ identifier: e.from, displayName: e.from, subject: e.subject, snippet: e.snippet, hasAttachment: !!e.hasAttachment }));
  const text = emails.map(e => `From: ${e.from}${e.hasAttachment ? ' [has attachment]' : ''}\nSubject: ${e.subject}\n${e.snippet}`).join('\n\n');
  return { text, items };
}

export async function getRecentBusinessEmails({ unread_only = false, limit = 10 } = {}) {
  const params = new URLSearchParams({ unreadOnly: String(unread_only), limit: String(limit) });
  let r;
  try {
    r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/google/gmail/recent/business?${params}`, {
      headers: { 'X-Service-Token': process.env.LIFECMD_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach business Gmail via LIFE_CMD: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach business Gmail via LIFE_CMD (status ${r.status})`, items: [] };
  const emails = await r.json();
  if (!emails.length) return { text: 'No matching business emails found.', items: [] };
  const items = emails.map(e => ({ identifier: e.from, displayName: e.from, subject: e.subject, snippet: e.snippet, hasAttachment: !!e.hasAttachment }));
  const text = emails.map(e => `From: ${e.from}${e.hasAttachment ? ' [has attachment]' : ''}\nSubject: ${e.subject}\n${e.snippet}`).join('\n\n');
  return { text, items };
}

export async function getRecentNotifications({ source, limit = 30 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (source) params.set('source', source);
  let r;
  try {
    r = await fetch(`${process.env.NOTIFY_CMD_BASE_URL}/api/notifications/recent?${params}`, {
      headers: { 'X-Service-Token': process.env.NOTIFY_CMD_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach notify-cmd: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach notify-cmd (status ${r.status})`, items: [] };
  const notifs = await r.json();
  if (!notifs.length) return { text: 'No matching notifications found.', items: [] };
  const items = notifs.map(n => ({ identifier: n.sender || 'unknown', displayName: n.sender || 'unknown', snippet: n.body || '', occurred_at: n.occurred_at }));
  const text = notifs.map(n => `[${n.occurred_at}] ${n.source} — ${n.sender || 'unknown'}: ${n.body || ''}`).join('\n');
  return { text, items };
}

export async function getSwitchcraftJobs() {
  let r;
  try {
    r = await fetch(`${process.env.SWITCHCRAFT_BASE_URL}/api/reverb/jobs?key=${process.env.SWITCHCRAFT_FEED_KEY}`);
  } catch (err) { return { text: `Could not reach switch-craft-booking: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach switch-craft-booking (status ${r.status})`, items: [] };
  const jobs = await r.json();
  if (!jobs.length) return { text: 'No open jobs found.', items: [] };
  const items = jobs.map(j => ({
    identifier: j.client_name || 'unknown client', displayName: j.client_name || 'unknown client',
    snippet: j.description || '', status: j.status,
    when: j.scheduled_date ? `${j.scheduled_date.slice(0, 10)}${j.scheduled_time ? ' ' + j.scheduled_time : ''}` : 'unscheduled',
  }));
  const text = items.map(j => `[${j.status}] ${j.when} — ${j.snippet} (${j.identifier})`).join('\n');
  return { text, items };
}
