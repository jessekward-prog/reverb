import { msgLine, ymd } from './commitments.js';
export const TEXTS_TOOL = {
  type: 'function',
  function: {
    name: 'get_recent_texts',
    description: 'Read SMS from the live phone. WITHOUT contact: returns the latest line of each recent conversation (a quick index, not full threads). WITH contact (a name or number): returns that one conversation in full — every message, marked (you)/(them) — which is where the real detail lives, usually a few messages up from the latest line. For "what did I say about the range hood" or "what price did I quote Mark": first call with no contact to find the right conversation in the list, then call again with that person\'s name or number to read the whole thread. Marking a thread read is a side effect of opening it.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'A name or phone number, e.g. "mum" or "0438". Provide it to read that one conversation in full. Omit to get the list of recent conversations.' },
        limit:   { type: 'integer', description: 'Only used without contact: how many recent conversations to list, default 25.' },
      },
    },
  },
};

export const SEARCH_TEXTS_TOOL = {
  type: 'function',
  function: {
    name: 'search_texts',
    description: 'Search the full text of every recent SMS conversation for a word or phrase, across all contacts at once. This is how to answer "what day did I say I\'d do the range hood", "did I quote a price for X", "who mentioned Friday" — a topic with no particular person attached. Returns each matching message with the two messages either side for context, and who said each ((you)/(them)). Searches a local index of the live phone\'s threads, so it finds things buried mid-conversation that the latest-line list never shows.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The word or phrase to look for, e.g. "range hood" or "deposit".' },
      },
      required: ['query'],
    },
  },
};

export async function searchTexts({ query } = {}) {
  if (!query || !query.trim()) return { text: 'Give a word or phrase to search for.', items: [] };
  let r;
  try {
    r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach browser-bridge: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach browser-bridge (status ${r.status})`, items: [] };
  const { threads = [], indexing } = await r.json();

  if (!threads.length) {
    return {
      text: indexing
        ? `The text index is still building — ask again in a minute. Nothing for "${query}" yet.`
        : `No text messages found mentioning "${query}".`,
      items: [],
    };
  }

  // One full conversation per matching thread, messages oldest->newest, so the
  // model can read the whole exchange — the answer (a day, a price) is often far
  // from where the search term appears.
  const blocks = threads.map(t => {
    const body = (t.messages || [])
      .map(m => `${m.outbound ? '(you)' : '(them)'} ${m.text}`)
      .join('\n');
    return `— ${t.thread}${t.when ? ` (last activity ${t.when})` : ''} —\n${body}`;
  });
  const items = threads.map(t => ({ thread: t.thread, when: t.when, matchCount: t.matchCount }));
  const note = threads.length > 1
    ? `Found "${query}" in ${threads.length} conversations. Full threads below — check which one the user means.\n\n`
    : `Full conversation mentioning "${query}":\n\n`;
  return { text: note + blocks.join('\n\n'), items };
}

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
    description: "Reads recent text conversations in full (both sides) and pairs them with the calendar, to spot work agreed in a message but never booked - including jobs the user CONFIRMED themselves (where the user sent the last message). Use for \"are there any jobs I haven't put in my calendar\", \"what have I agreed to that isn't booked\", \"did I miss scheduling anything\", \"what did I book in for Thursday but forgot to add to my calendar\", \"what work did I agree to this week\".",
    parameters: {
      type: 'object',
      properties: {
        days_back: { type: 'integer', description: 'How far back to read messages, default 14' },
      },
    },
  },
};

// Drafting is NOT sending. This tool can only compose a message and resolve
// who it is for; the text leaves the building only when the user presses send
// in the chat. That is a structural guarantee, not an instruction the model
// could skip.
export const DRAFT_TEXT_TOOL = {
  type: 'function',
  function: {
    name: 'draft_text',
    description: "Compose a text message to someone for the user to review and send. Use this whenever the user asks you to reply to, text, message or get back to a person. It does NOT send: it puts a draft in front of the user with a send button. Give the person's name or number exactly as you know it; a known contact's number is looked up automatically.",
    parameters: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: "Who it is for: a name as it appears in their messages, or a phone number." },
        message: { type: 'string', description: "The full message to send, written as the user would write it. No placeholders." },
        channel: { type: 'string', enum: ['sms', 'whatsapp', 'messenger'],
                   description: "Which medium the conversation is on. Match it to where the item came from - an sms item is 'sms', a whatsapp item 'whatsapp', a messenger item 'messenger'. Defaults to sms." },
      },
      required: ['to', 'message'],
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

// SMS comes from the live Messages session via browser-bridge — not notify-cmd,
// not text-cmd. Two shapes for two needs:
//   getRecentTexts       full thread bodies (opens conversations) — the chat,
//                        for "what did I say about X".
//   getRecentTextsBrief  one latest line per thread (the list, nothing opened) —
//                        Sweep/Work, scanning every sender cheaply.
// Full thread bodies from the live Messages session, via the bridge. The
// conversation list only carries each thread's latest line, so anything said a
// few messages up is invisible to it; /api/threads opens the actual
// conversations and reads every bubble. Opening a thread marks it read on every
// device, so this is bounded and the bridge caches each thread briefly.
//
// With a `contact` the bridge opens just that thread (fast, exact) — the strong
// path. Without one it opens the few most-recent threads; that cannot see a
// topic buried in an older thread, because Messages web has no search box to
// find it by. So the model is told to pass a contact whenever the question
// names or implies a person.
export async function getRecentTexts({ contact, limit } = {}) {
  // No person named: don't open threads (slow, and marks them read). Hand back
  // the cheap conversation list — latest line per thread — and tell the model
  // how to pull a full thread once it knows who. The list is the only index
  // Messages web offers; a topic buried in an old thread with an unrelated
  // latest line genuinely can't be found without a name.
  if (!contact) {
    const brief = await getRecentTextsBrief({ limit: limit || 25 });
    if (!brief.items.length) return brief;
    const text =
      'Latest line of each recent conversation (not full threads). To read a '
      + 'whole conversation — e.g. to find what was said about a specific job or '
      + 'topic — call get_recent_texts again with contact set to that person\'s '
      + 'name or number:\n\n' + brief.text;
    return { text, items: brief.items };
  }

  const qs = new URLSearchParams({ limit: '1', contact });
  let r;
  try {
    r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/threads?${qs}`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach browser-bridge: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach browser-bridge (status ${r.status})`, items: [] };
  const { threads = [] } = await r.json();

  if (!threads.length) {
    return { text: `No text thread found matching "${contact}".`, items: [] };
  }

  // One readable transcript per thread, messages oldest->newest so the exchange
  // reads in order; (you)/(them) so the model can tell who committed to what.
  const blocks = threads.map(t => {
    const head = `— ${t.name}${t.when ? ` (last activity ${t.when})` : ''} —`;
    const body = (t.messages || [])
      .map(msg => `${msg.outbound ? '(you)' : '(them)'} ${msg.text}`)
      .join('\n');
    return `${head}\n${body || '(no readable messages)'}`;
  });
  const items = threads.map(t => ({
    identifier: t.name, displayName: t.name, when: t.when,
    messageCount: (t.messages || []).length,
  }));
  return { text: blocks.join('\n\n'), items };
}

// The cheap overview: one latest line per thread, from the bridge's conversation
// list — no thread is opened, so nothing is marked read. Sweep/Work use this to
// scan every sender quickly; the chat uses getRecentTexts (full bodies) instead.
// Items keep the per-row shape gatherSources formats with (occurred_at + snippet).
export async function getRecentTextsBrief({ contact, limit = 20 } = {}) {
  let r;
  try {
    r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/sms?limit=${limit}`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
    });
  } catch (err) { return { text: `Could not reach browser-bridge: ${err.message}`, items: [] }; }
  if (!r.ok) return { text: `Could not reach browser-bridge (status ${r.status})`, items: [] };
  const { sms = [], health = {} } = await r.json();
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
    // The band needs these to decide whether a thread is worth nagging about
    // and how long it has been sitting.
    subject: w.subject || null, unread: w.unread === true, when: w.when || '',
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

// Recent conversations from the bridge index, and the calendar. Shared so the
// commitments ledger and this tool read the same two sources, one fetcher each.
export async function fetchThreads(limit = 20) {
  const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/threads?limit=${limit}`, {
    headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
  });
  if (!r.ok) throw new Error(`browser-bridge status ${r.status}`);
  return (await r.json()).threads || [];
}

// The calendar, read from the browser he is already signed into. No OAuth
// token to expire - which is the failure that had the app insisting for weeks
// that booked jobs were not in a diary it could not see - and it sees every
// calendar he sees, not one account's primary. LIFE_CMD stays as a fallback
// for when the bridge is down.
//
// Driving the browser costs seconds, and the band asks for this on every load,
// so the answer is held briefly. Anything he presses to force a check asks for
// it fresh.
let calCache = { at: 0, events: [], source: 'none' };
const CAL_TTL = 5 * 60 * 1000;

export async function fetchCalendar({ fresh = false } = {}) {
  if (!fresh && calCache.source !== 'none' && Date.now() - calCache.at < CAL_TTL) return calCache;

  try {
    const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/calendar?back=7`, {
      headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
      signal: AbortSignal.timeout(120000),
    });
    if (r.ok) {
      const { events } = await r.json();
      if (Array.isArray(events) && events.length) {
        calCache = { at: Date.now(), events, source: 'browser' };
        return calCache;
      }
    }
  } catch { /* fall through to LIFE_CMD */ }

  try {
    const r = await fetch(`${process.env.LIFECMD_BASE_URL}/api/events`);
    if (r.ok) {
      const events = await r.json();
      calCache = { at: Date.now(), events, source: 'lifecmd' };
      return calCache;
    }
  } catch { /* nothing can read it */ }

  calCache = { at: Date.now(), events: [], source: 'none' };
  return calCache;
}

export async function fetchEvents() {
  return (await fetchCalendar()).events;
}

// Personal Messenger. Everything in here is private by default - only the
// conversations that are actually about Jesse's electrical work are allowed
// through to the report, and the filtering happens in server.js before
// anything is stored.
export async function fetchChannel(channel, limit = 40) {
  const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/${channel}?limit=${limit}`, {
    headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
  });
  if (!r.ok) throw new Error(`browser-bridge status ${r.status}`);
  const j = await r.json();
  return { rows: j[channel] || [], health: (j.health || {})[channel] };
}

export async function getUnbookedJobs({ days_back = 14 } = {}) {
  // Whole recent conversations from the bridge index, both directions. The old
  // path read /api/waiting, which only returns threads where the OTHER person
  // sent the last line - but a job the user CONFIRMED ("Thursday works, see you
  // at lunch") has the user replying last, so it never appeared. That is exactly
  // the booking "what did I agree to that isn't in my calendar" is asking about.
  // The index carries the full back-and-forth, so no notify-cmd enrichment.
  let threads = [];
  try {
    threads = await fetchThreads(20);
  } catch (err) { return { text: `Could not reach browser-bridge: ${err.message}`, items: [] }; }

  if (!threads.length) return { text: 'No recent conversations to check against the calendar.', items: [] };

  const events = await fetchEvents();

  const from = new Date(Date.now() - days_back * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const window = events.filter(e => e.date >= from && e.date <= to);

  // Last dozen lines per thread - a booking is settled near the end, and 20 full
  // conversations whole is more than the model needs to read.
  const msgBlock = threads.map(t => {
    const lines = (t.messages || []).slice(-12)
      .map(m => `    ${msgLine(m)}`)
      .join('\n');
    return `— ${t.name}${t.when ? ` (last activity ${t.when})` : ''} —\n${lines}`;
  }).join('\n\n');

  const calBlock = window.length
    ? window.map(e => `${e.date}${e.time ? ' ' + e.time : ''}: ${e.text}${e.location ? ' @ ' + e.location : ''}`).join('\n')
    : events.length ? '(no events in this window)' : '(CALENDAR UNAVAILABLE - could not read it, so nothing below can be confirmed as booked)';

  const now = new Date();
  const today = `${now.toLocaleDateString('en-AU', { weekday: 'long' })} ${ymd(now)}`;
  const text = `Today is ${today}. Below are recent text conversations in full (me = the user, them = the other person, each line prefixed with the day it was sent), then the calendar from ${from} to ${to}. Find where work or an appointment was actually agreed or requested - a day or time settled on ("Thursday works", "see you at lunch"), a job someone asked for - and say which have NO matching calendar entry. Resolve relative days ("Thursday", "tomorrow") against the day that message was SENT, not today, and skip anything whose day has already passed. Quote the message verbatim and name who it is with. Ignore chit-chat, thanks and anything already on the calendar. If you are not sure a message is a job, leave it out.

CONVERSATIONS (oldest line first within each):
${msgBlock}

CALENDAR:
${calBlock}`;

  return { text, items: threads.map(t => ({ identifier: t.name, displayName: t.name, snippet: (t.messages || []).slice(-1)[0]?.text || '', kind: 'sms' })) };
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

// Email comes from the logged-in Gmail tabs, not from an OAuth API. Reverb is
// a second pair of eyes on the browser the user is already signed into, so a
// token expiring somewhere else must never be able to blind it - which is
// exactly what happened: LIFE_CMD's Google auth dropped and every email
// question started failing.
async function emailsFrom(channel, { unread_only = false, limit = 10 } = {}) {
  let rows = [], health;
  try { ({ rows, health } = await fetchChannel(channel, Math.min(limit * 3, 60))); }
  catch (err) { return { text: `Could not reach the browser bridge: ${err.message}`, items: [], health: `unreachable — ${err.message}` }; }

  if (unread_only) rows = rows.filter(r => r.unread);
  rows = rows.slice(0, limit);
  if (!rows.length) {
    return { text: health && health !== 'ok' ? `No emails read — ${health}` : 'No matching emails found.', items: [], health };
  }
  const items = rows.map(e => ({
    identifier: e.address || e.from, displayName: e.from,
    subject: e.subject, snippet: e.snippet, unread: !!e.unread, when: e.when,
  }));
  const text = rows.map(e =>
    `From: ${e.from}${e.unread ? ' [unread]' : ''}${e.when ? ` (${e.when})` : ''}\nSubject: ${e.subject}\n${e.snippet}`).join('\n\n');
  return { text, items, health };
}

export const getRecentEmails = opts => emailsFrom('email', opts);
export const getRecentBusinessEmails = opts => emailsFrom('bizemail', opts);

// "Did I ever get ..." needs the whole mailbox, not the newest few. The bridge
// types the query into Gmail's own search box and reads the results, so it
// searches exactly what the user would see.
export const SEARCH_EMAIL_TOOL = {
  type: 'function',
  function: {
    name: 'search_email',
    description: "Search the user's email for anything older than the last few messages: \"did I ever get a login from X\", \"find the invoice from Y\", \"what did Z send me about the quote\". Searches with Gmail's own query syntax across the personal inbox, the business one, or both.",
    parameters: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: "What to look for, e.g. \"powertorque login\" or \"from:acme invoice\"." },
        account: { type: 'string', enum: ['both', 'personal', 'business'], description: 'Which mailbox. Defaults to both.' },
      },
      required: ['query'],
    },
  },
};

export async function searchEmail({ query, account = 'both' } = {}) {
  if (!query || !query.trim()) return { text: 'Give something to search for.', items: [] };
  const channels = account === 'personal' ? ['email'] : account === 'business' ? ['bizemail'] : ['email', 'bizemail'];
  const out = [];
  for (const ch of channels) {
    try {
      const r = await fetch(`${process.env.BRIDGE_BASE_URL}/api/email-search?q=${encodeURIComponent(query)}&account=${ch}&limit=10`, {
        headers: { 'X-Service-Token': process.env.BRIDGE_SERVICE_TOKEN },
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      for (const e of (d.results || [])) out.push({ ...e, mailbox: ch === 'bizemail' ? 'business' : 'personal' });
    } catch { /* one mailbox failing should not lose the other */ }
  }
  if (!out.length) return { text: `Nothing in the user's email matches "${query}".`, items: [] };
  const text = out.map(e =>
    `[${e.mailbox}] From: ${e.from}${e.when ? ` (${e.when})` : ''}\nSubject: ${e.subject}\n${e.snippet}`).join('\n\n');
  return { text: `Email matching "${query}":\n\n${text}`, items: out };
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

// A job's date is the single most useful thing on its card, and a raw
// "2026-06-30 01:50:00" says nothing a person can act on. Give the day in
// words, and say plainly when it is already in the past - a "pending" job
// scheduled months ago is either done or dead, and must not read as upcoming.
const DAY_MS = 86400000;
const localYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The booking form numbers each line, so nearly every description opens with
// "1. ". When there is no "2.", that prefix is noise in the card title.
export function cleanDescription(d) {
  const t = String(d || '').trim();
  return /\b2[.)]/.test(t) ? t : t.replace(/^\s*1[.)]\s*/, '');
}

export function isOverdue(date) {
  if (!date) return false;
  return String(date).slice(0, 10) < localYmd(new Date());
}

export function scheduleLabel(date, time) {
  if (!date) return 'unscheduled';
  const day = String(date).slice(0, 10);
  const today = localYmd(new Date());
  const hhmm = time ? ` ${String(time).slice(0, 5)}` : '';
  const d = new Date(`${day}T00:00:00`);
  const pretty = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  if (day === today) return `today${hhmm}`;
  if (day === localYmd(new Date(Date.now() + DAY_MS))) return `tomorrow${hhmm}`;
  if (day < today) {
    const days = Math.round((new Date(`${today}T00:00:00`) - d) / DAY_MS);
    return `overdue ${days}d — was ${pretty}`;
  }
  return `${pretty}${hhmm}`;
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
    snippet: cleanDescription(j.description), status: j.status, jobType: j.job_type, id: j.id,
    scheduledDate: j.scheduled_date ? j.scheduled_date.slice(0, 10) : null,
    scheduledTime: j.scheduled_time ? j.scheduled_time.slice(0, 5) : null,
    when: scheduleLabel(j.scheduled_date, j.scheduled_time),
    overdue: isOverdue(j.scheduled_date),
    // Context the feed now carries: where it is, who to ring, what the work
    // actually consists of, and where the information came from.
    address: j.address || null,
    phone: j.contact_number || null,
    business: j.business_name || null,
    timeline: j.timeline || null,
    preferredDays: j.preferred_days || null,
    tasks: Array.isArray(j.tasks) ? j.tasks.filter(t => t && t.text) : [],
    noteCount: j.note_count || 0,
    photoCount: j.photo_count || 0,
    // Ids only; the card pulls each image through /api/job-photo/:id when opened.
    photos: Array.isArray(j.photos)
      ? j.photos.filter(p => p && Number.isInteger(p.id)).map(p => ({ id: p.id, name: p.original_name || '' }))
      : [],
    lastNote: j.last_note && j.last_note.message ? j.last_note : null,
    // Who is waiting on whom: the latest thing the client put on the job
    // against the last time he answered it.
    lastPhotoAt: j.last_photo_at || null,
    lastReplyAt: j.last_reply_at || null,
    raised: j.created_at || null,
  }));
  const text = items.map(j => {
    const todo = j.tasks.filter(t => !t.done).map(t => t.text);
    return [
      `[${j.status}] ${j.when} — ${j.identifier}${j.business ? ` (${j.business})` : ''}`,
      j.address ? `  at ${j.address}` : null,
      j.phone ? `  ph ${j.phone}` : null,
      j.preferredDays ? `  client prefers ${j.preferredDays}` : null,
      todo.length ? `  outstanding: ${todo.join('; ')}` : `  ${j.snippet}`,
      j.lastNote ? `  last note (${j.lastNote.author}): ${String(j.lastNote.message).replace(/\s+/g, ' ').slice(0, 140)}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return { text, items };
}

// The bot could read everything and send a text, but not put anything in the
// calendar - so "I just got off the phone to Pat, book him in Thursday 9am"
// dead-ended in advice. This writes the event, the same way the card's manual
// form does: the pre-filled event opens in the logged-in calendar tab and the
// user presses save there. No OAuth, no API key, no silent write.
export const ADD_TO_CALENDAR_TOOL = {
  type: 'function',
  function: {
    name: 'add_to_calendar',
    description: "Put an appointment or job in the user's Google Calendar. Use it whenever they say to book, schedule, diarise or add something - including work agreed on a phone call, where there is no message to read. It opens the event pre-filled in their calendar for them to save; it does not write silently. Resolve relative days (\"Thursday\", \"tomorrow\") to a real date yourself before calling. ALWAYS ask the user two things first and put their answers in durationMins and parts: how long the job will take, and whether it needs any parts. Never guess either one - a wrong duration double-books his day and a missed part wastes the trip.",
    parameters: {
      type: 'object',
      properties: {
        title:        { type: 'string', description: 'What the event is, e.g. "Switchboard upgrade - 12 Example St".' },
        date:         { type: 'string', description: 'The day, as YYYY-MM-DD.' },
        time:         { type: 'string', description: '24h start time as HH:MM. Omit for an all-day entry.' },
        durationMins: { type: 'integer', description: 'How long the job will take, in minutes, as the USER stated it. Ask them; do not estimate it yourself.' },
        parts:        { type: 'string', description: 'What has to be picked up or ordered for the job, as the USER stated it, or the word "none" if they said it needs nothing. Ask them; this is never inferred.' },
        location:     { type: 'string', description: 'Address, if there is one. A known client\'s address is filled in automatically.' },
        contact:      { type: 'string', description: "Who it is with, if anyone - a name or number. Used to look up their address." },
      },
      required: ['title', 'date', 'durationMins', 'parts'],
    },
  },
};

export const TODO_TOOL = {
  type: 'function',
  function: {
    name: 'get_todo_list',
    description: "Read the user's actual to-do list - the ranked cards they are looking at in the app, work and life merged, with each item's id. Use this for \"what's on my list\", \"what should I do first\", \"what's been sitting too long\", and ALWAYS before marking anything done, since that needs the item's id from here. This is the same list the screen shows, so do not rebuild it from the raw sources.",
    parameters: {
      type: 'object',
      properties: {
        bucket: { type: 'string', enum: ['all', 'work', 'life'], description: 'Which half. Defaults to all.' },
      },
    },
  },
};

export const MARK_DONE_TOOL = {
  type: 'function',
  function: {
    name: 'mark_item_done',
    description: "Clear an item off the to-do list once it is handled. The id must come from get_todo_list - call that first and match the item by what it says, never guess an id. Only use it when the user says something is done or dealt with.",
    parameters: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'The item id from get_todo_list.' },
        kind: { type: 'string', description: "The item's kind from get_todo_list, e.g. sms or job." },
        from: { type: 'string', description: "The item's from field from get_todo_list." },
      },
      required: ['id'],
    },
  },
};

// A card can mute a sender in one press; the bot could not, so "stop showing me
// Pinterest" was advice about a drawer instead of an action. Muted is not
// silence: anything with an invoice, receipt, payment or quote in it still
// comes through, which is the only reason muting a shop is safe at all.
export const MUTE_SENDER_TOOL = {
  type: 'function',
  function: {
    name: 'mute_sender',
    description: "Stop a sender's everyday mail from appearing in the user's lists. Use it when they say a sender is junk, promos, marketing, noise, or that they only want the money ones from them. Anything that mentions an invoice, receipt, payment or quote still gets through, so say that when you confirm. Get kind and from from get_todo_list rather than guessing an address.",
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Which source the sender is on: email, bizemail, sms, whatsapp, messenger or meta.' },
        from: { type: 'string', description: 'The sender exactly as the list gives it - an email address or a phone number.' },
        name: { type: 'string', description: 'A display name for them, if the list has one.' },
      },
      required: ['kind', 'from'],
    },
  },
};
