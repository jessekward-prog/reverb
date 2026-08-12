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

export async function getRecentTexts({ contact, limit = 20 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (contact) params.set('contact', contact);
  let r;
  try {
    r = await fetch(`${process.env.TEXT_CMD_BASE_URL}/api/messages/recent?${params}`, {
      headers: { 'X-Service-Token': process.env.TEXT_CMD_SERVICE_TOKEN },
    });
  } catch (err) { return `Could not reach text-cmd: ${err.message}`; }
  if (!r.ok) return `Could not reach text-cmd (status ${r.status})`;
  const msgs = await r.json();
  if (!msgs.length) return 'No matching text messages found.';
  return msgs.map(m => `[${m.occurred_at}] ${m.contact_name || m.phone} (${m.direction === 'in' ? 'received' : 'sent'}): ${m.body}`).join('\n');
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
  } catch (err) { return `Could not reach Gmail via LIFE_CMD: ${err.message}`; }
  if (!r.ok) return `Could not reach Gmail via LIFE_CMD (status ${r.status})`;
  const emails = await r.json();
  if (!emails.length) return 'No matching emails found.';
  return emails.map(e => `From: ${e.from}\nSubject: ${e.subject}\n${e.snippet}`).join('\n\n');
}
