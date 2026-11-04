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

export const WAITING_TOOL = {
  type: 'function',
  function: {
    name: 'get_waiting_replies',
    description: "Threads across texts, Messenger/Instagram and email where someone else sent the last message, so they may be waiting on a reply. Use this for \"is anyone waiting for me to reply\", \"who do I need to get back to\", \"what haven't I replied to\".",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max threads to return, default 25' },
      },
    },
  },
};

export const UNBOOKED_JOBS_TOOL = {
  type: 'function',
  function: {
    name: 'get_unbooked_jobs',
    description: "Recent conversational messages paired with the calendar, for spotting work that was agreed in a message but never booked. Use for \"are there any jobs I haven't put in my calendar\", \"what have I agreed to that isn't booked\", \"did I miss scheduling anything\".",
    parameters: {
      type: 'object',
      properties: {
        days_back: { type: 'integer', description: 'How far back to read messages, default 14' },
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
// was abandoned rather than kept on life support. notify-cmd's sender is a
// raw phone number with no name attached, so we borrow text-cmd's `contacts`
// table purely as a phonebook (it's still Jesse's actively-maintained
// phone->name mapping, just no longer the message source) to resolve display
// names and let the `contact` filter match by name, not just raw digits.
// Chat's tool-calling path only ever wants the .text string (see ChatView's
// call sites in server.js's proxyChat); gatherSources (Sweep/Work) also
// wants the structured .items so it can track senders in the contacts table
// without a second round-trip to the same source.
export async function getRecentTexts({ contact, limit = 20 } = {}) {
  let r;
  try {
    r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/sms?limit=${limit}`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach browser-bridge: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach browser-bridge (status ${r.status})`, items: [] };
  const { sms = [], health = {} } = await r.json();

  // A dead source used to look identical to a quiet week. Say which one it is.
  if (!sms.length) return { text: `No texts available (${health.sms || 'unknown'}).`, items: [] };

  let msgs = sms;
  if (contact) {
    const needle = contact.toLowerCase();
    msgs = msgs.filter(m => (m.name || '').toLowerCase().includes(needle));
  }
  if (!msgs.length) return { text: 'No matching text messages found.', items: [] };

  const items = msgs.map(m => ({
    identifier: m.name, displayName: m.name, snippet: m.snippet, occurred_at: m.at,
  }));
  const text = msgs
    .map(m => `[${m.at}] ${m.name}${m.outbound ? ' (you replied last)' : ''}${m.unread ? ' (unread)' : ''}: ${m.snippet}`)
    .join('\n');
  return { text, items };
}

export async function getWaitingReplies({ limit = 25 } = {}) {
  let r;
  try {
    r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/waiting?limit=${limit}`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach browser-bridge: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach browser-bridge (status ${r.status})`, items: [] };
  const { waiting = [], bulk = [], bulkCount = 0, alsoUnanswered = 0, health = {} } = await r.json();

  // A source that died should be visible in the answer, not hidden behind a short list.
  const broken = Object.entries(health)
    .filter(([k, v]) => !k.startsWith('newest') && v !== 'ok')
    .map(([k, v]) => `${k}: ${v}`);
  const caveat = broken.length ? `\n\nSOURCE PROBLEMS - this list is incomplete: ${broken.join(' | ')}` : '';

  if (!waiting.length) return { text: `Nothing is waiting on a reply.${caveat}`, items: [] };

  const items = waiting.map(w => ({
    identifier: w.who, displayName: w.who, snippet: w.snippet, occurred_at: w.at, kind: w.source,
  }));
  const line = w => `[${w.source}] ${w.who}${w.unread ? ' (unread)' : ''} - ${w.when}: ${w.subject ? w.subject + ' - ' : ''}${w.snippet}`;

  // The bulk rows are deliberately NOT in what the model receives. Telling it to
  // exclude automated senders from one combined list failed (it listed a parcel
  // notice and a car dealership as people awaiting a reply); labelling them as
  // already set aside failed too (it pulled an Instagram spam DM back out and
  // suggested replying). If the model can see them it will use them. They stay in
  // /api/waiting's response for the UI, so nothing is hidden from Jesse - only
  // from the prompt. Same rule the Rules drawer already follows.
  const bulkBlock = bulkCount
    ? `\n\n(${bulkCount} automated senders - parcel and appointment notices, dealership form letters, cold sales - were set aside and are not listed here.)`
    : '';

  const text = `${waiting.length} threads where someone else sent the last message. Some of these are conversations that simply ended with a thanks - judge from the wording whether a reply is actually needed, and say so. ${alsoUnanswered} further unanswered items were excluded as non-conversational.\n\n${waiting.map(line).join('\n')}${bulkBlock}${caveat}`;
  return { text, items };
}

export async function getUnbookedJobs({ days_back = 14 } = {}) {
  const since = Date.now() - days_back * 86400000;

  let msgs = [], health = {};
  try {
    const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/waiting?limit=200`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
    if (!r.ok) return { text: `Could not reach browser-bridge (status ${r.status})`, items: [] };
    const j = await r.json();
    health = j.health || {};
    // Only conversational rows, and only recent ones. A job is agreed in a
    // conversation, never in a parcel notice, so the bulk bucket stays out.
    msgs = (j.waiting || []).filter(w => w.at && Date.parse(w.at) >= since);
  } catch (err) { return { text: `Could not reach browser-bridge: ${err.message}`, items: [] }; }

  let events = [];
  try {
    const r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/events`);
    if (r.ok) events = await r.json();
  } catch { /* calendar block says it is missing, below */ }

  const from = new Date(since).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const window = events.filter(e => e.date >= from && e.date <= to);

  const broken = Object.entries(health)
    .filter(([k, v]) => !k.startsWith('newest') && v !== 'ok')
    .map(([k, v]) => `${k}: ${v}`);

  if (!msgs.length) return { text: `No conversational messages in the last ${days_back} days to check against the calendar.`, items: [] };

  // The bridge only sees the LAST message per thread, and a reply like "Thursday
  // works" is meaningless without the question it answers - the model correctly
  // reported "no unbooked jobs" when shown only those. notify-cmd holds
  // message-level SMS history with direction, so pull the preceding few lines in.
  // Joined on the last 9 digits, which identifies an AU mobile however either side
  // formats it. A thread the bridge shows under a contact NAME has no number to
  // join on and gets no transcript - stated in the block below rather than hidden.
  const phoneKey = v => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : null; };
  const history = new Map();
  try {
    const params = new URLSearchParams({ source: 'sms', limit: '500', since: new Date(since).toISOString() });
    const hr = await fetch(`${process.env.NOTIFY_CMD_BASE_URL}/api/notifications/recent?${params}`, {
      headers: { 'X-Service-Token': process.env.NOTIFY_CMD_SERVICE_TOKEN },
    });
    if (hr.ok) {
      for (const row of await hr.json()) {
        const k = phoneKey(row.sender);
        if (!k) continue;
        if (!history.has(k)) history.set(k, []);
        history.get(k).push(row);
      }
    }
  } catch { /* transcripts are an enrichment; the messages still stand without them */ }

  let noContext = 0;
  const msgBlock = msgs.map(m => {
    const head = `[${m.source}] ${m.who} - ${m.when}: ${m.snippet}`;
    const k = phoneKey(m.who);
    const thread = k && history.get(k);
    if (!thread) { if (m.source === 'sms') noContext++; return head; }
    const lines = thread
      .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))
      .slice(-6)
      .map(x => `    ${x.direction === 'out' ? 'me' : 'them'}: ${String(x.body || '').replace(/\s+/g, ' ').slice(0, 160)}`)
      .join('\n');
    return `${head}\n  thread:\n${lines}`;
  }).join('\n');
  const calBlock = window.length
    ? window.map(e => `${e.date}${e.time ? ' ' + e.time : ''}: ${e.text}${e.location ? ' @ ' + e.location : ''}`).join('\n')
    : events.length ? '(no events in this window)' : '(CALENDAR UNAVAILABLE - could not read it, so nothing below can be confirmed as booked)';

  const gap = noContext ? `\n\n(${noContext} SMS threads are shown under a saved contact name, so no message history could be matched for them - judge those from the single line alone.)` : '';
  const text = `Messages from the last ${days_back} days, then the calendar from ${from} to ${to}. Find only messages that agree to or request actual work or an appointment - a date someone proposed, a job someone asked for - and say which have no matching calendar entry. Quote the message verbatim. Ignore chit-chat, thanks and anything already on the calendar. If you are not sure a message is a job, leave it out.${broken.length ? `\n\nSOURCE PROBLEMS - this is incomplete: ${broken.join(' | ')}` : ''}

MESSAGES (a "thread:" block is the recent back-and-forth, oldest first):
${msgBlock}${gap}

CALENDAR:
${calBlock}`;

  return { text, items: msgs.map(m => ({ identifier: m.who, displayName: m.who, snippet: m.snippet, occurred_at: m.at, kind: m.source })) };
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
