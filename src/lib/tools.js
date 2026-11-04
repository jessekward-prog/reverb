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
