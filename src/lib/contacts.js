// Reverb's running memory of who's been in touch — durable across scans,
// unlike Sweep/Work's per-run task lists. Two independent signals feed
// prioritization:
//   - item-level: does *this* message look important (attachment, money words)?
//   - contact-level: has this *sender* historically mattered (replied-to a lot,
//     or manually pinned), or been ignored (dismissed repeatedly, or muted)?
// A manually-set tier always wins; otherwise tier is derived from counters.

const MONEY_WORDS = ['invoice', 'overdue', 'payment due', 'unpaid', 'quote', 'bill due', 'amount owing', 'past due'];

export function hasMoneyFlag(text) {
  const t = (text || '').toLowerCase();
  return MONEY_WORDS.some(w => t.includes(w));
}

// "Jaan Smith <jaan@example.com>" -> "jaan@example.com"; falls back to the
// raw string lowercased/trimmed for kinds with no angle-bracket format (sms
// numbers, WhatsApp/Messenger/Instagram/job sender names).
export function normalizeIdentifier(kind, raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (kind === 'email' || kind === 'bizemail') {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).toLowerCase();
  }
  if (kind === 'sms') return s.replace(/[^\d+]/g, '');
  return s.toLowerCase();
}

export async function upsertContact(pool, kind, identifier, displayName) {
  if (!identifier) return null;
  const { rows } = await pool.query(
    `INSERT INTO contacts (kind, identifier, display_name, seen_count, last_seen_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (kind, identifier) DO UPDATE
       SET seen_count = contacts.seen_count + 1,
           last_seen_at = NOW(),
           display_name = COALESCE(contacts.display_name, EXCLUDED.display_name)
     RETURNING tier, seen_count, replied_count, dismissed_count`,
    [kind, identifier, displayName || null]
  );
  return rows[0] || null;
}

// score>=8 needs two strong signals (e.g. 2 replies, or several visits) —
// deliberately harder to earn 'vip' than to earn 'muted', since a wrongly
// muted contact silently disappears from every future scan while a wrongly
// promoted one just sits at the top of a list you can see anyway.
export function deriveTier(contactRow) {
  if (!contactRow) return 'normal';
  if (contactRow.tier) return contactRow.tier;
  const score = contactRow.seen_count + contactRow.replied_count * 5 - contactRow.dismissed_count * 2;
  if (score >= 8) return 'vip';
  if (score <= -4) return 'muted';
  return 'normal';
}

export async function signalContact(pool, kind, identifier, action) {
  if (!identifier) return;
  const col = action === 'reply' ? 'replied_count' : 'dismissed_count';
  await pool.query(
    `INSERT INTO contacts (kind, identifier, ${col}, seen_count, last_seen_at)
     VALUES ($1, $2, 1, 0, NOW())
     ON CONFLICT (kind, identifier) DO UPDATE SET ${col} = contacts.${col} + 1`,
    [kind, identifier]
  );
}

// User-editable priority/ignore rules (Rules drawer) — plain substring patterns,
// matched in code, never interpreted by the model. "ignore" wins when rules of
// both kinds match the same item: dropping it is safer than surfacing it anyway.
export function matchRules(text, rules) {
  const t = String(text || '').toLowerCase();
  // A blank pattern matches every item, and a blank "ignore" rule silences the
  // whole assistant. The POST route rejects blanks; this is the second line of
  // defence, because that exact silence already cost a month of dead texts.
  const hit = pattern => String(pattern).trim() !== '' && t.includes(String(pattern).toLowerCase());
  if (rules.some(r => r.action === 'ignore' && hit(r.pattern))) return 'ignore';
  if (rules.some(r => r.action === 'priority' && hit(r.pattern))) return 'priority';
  return null;
}

// ── Address + phone helpers ─────────────────────────────────
// A number on its own puts nothing in a calendar's location field. These let
// Reverb learn where someone lives once and reuse it.
export const phoneLast9 = v => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
};

// Deliberately tight: a street number, one to four name words, a street type,
// then optional suburb/state/postcode. A loose pattern turns any number in a
// sentence into an address, while stop-words prevent "12 Sample Drive next
// week" from swallowing "next week" without cutting off "Waurn Ponds" or
// "East Geelong". State codes require trailing word boundaries so "Waurn" is
// never truncated to "Wa".
const STREET = 'st|street|rd|road|ave|avenue|dr|drive|ct|court|cres|crescent|pde|parade|pl|place|way|lane|ln|tce|terrace|blvd|hwy|highway';
const CORE_ADDRESS_RE = new RegExp(
  `\\b\\d{1,5}[a-z]?(?:\\/\\d{1,5})?\\s+(?:[a-z][a-z'\\-]*\\s+){1,4}(?:${STREET})\\b`,
  'i'
);
const SUBURB_STOP = new Set([
  'next', 'this', 'last', 'on', 'at', 'in', 'for', 'from', 'to', 'by', 'with',
  'and', 'or', 'but', 'if', 'when', 'while', 'before', 'after', 'around', 'about',
  'today', 'tonight', 'tomorrow', 'yesterday', 'mon', 'tue', 'wed', 'thu', 'fri',
  'sat', 'sun', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sunday', 'morning', 'afternoon', 'evening', 'week', 'month', 'year',
  'please', 'plz', 'pls', 'thanks', 'thank', 'cheers', 'ta', 'is', 'was', 'are',
  'were', 'has', 'have', 'had', 'can', 'could', 'will', 'would', 'should', 'we',
  'i', 'you', 'my', 'our', 'the', 'a', 'an', 'it', 'its', 'that', 'there', 'here',
  'hi', 'hey', 'hello', 'need', 'needs', 'needed', 'looking', 'want', 'wants',
  'quote', 'job', 'work', 'install', 'replace', 'fix', 'check', 'asap', 'soon',
  'vic', 'nsw', 'qld', 'sa', 'wa', 'tas', 'nt', 'act',
]);

export function extractAddress(text) {
  const src = String(text || '');
  const m = src.match(CORE_ADDRESS_RE);
  if (!m) return null;
  const head = m[0].replace(/\s+/g, ' ').trim();
  let rest = src.slice(m.index + m[0].length);
  const tailParts = [];

  const commaMatch = rest.match(/^(\s*,\s*[a-z][a-z'\-]*(?:\s+[a-z][a-z'\-]*){0,2})/i);
  if (commaMatch) {
    tailParts.push(commaMatch[1]);
    rest = rest.slice(commaMatch[0].length);
  } else {
    const nextChunk = rest.match(/^([ \t]*\r?\n(?![ \t]*\r?\n)|[ \t]+)([^.!?;,\r\n]*)/);
    if (nextChunk) {
      const words = [];
      for (const tok of nextChunk[2].trim().split(/\s+/).filter(Boolean)) {
        if (words.length >= 2) break;
        if (!/^[a-z][a-z'\-]*$/i.test(tok)) break;
        if (SUBURB_STOP.has(tok.toLowerCase())) break;
        words.push(tok);
      }
      if (words.length) {
        tailParts.push(` ${words.join(' ')}`);
        const consumedLen = nextChunk[2].indexOf(words[words.length - 1]) + words[words.length - 1].length;
        rest = rest.slice(nextChunk[1].length + consumedLen);
      }
    }
  }

  const stMatch = rest.match(/^,?\s+\b(vic|nsw|qld|sa|wa|tas|nt|act)\b/i);
  if (stMatch) {
    tailParts.push(stMatch[0]);
    rest = rest.slice(stMatch[0].length);
  }
  const pcMatch = rest.match(/^,?\s+\b(\d{4})\b/);
  if (pcMatch) tailParts.push(pcMatch[0]);

  const hit = (head + tailParts.join('')).replace(/\s+/g, ' ').trim().replace(/[.,;]$/, '');
  return hit.length >= 10 && hit.length <= 120 ? hit : null;
}

const INTRO_NAME_STOP = new Set([
  'jesse', 'me', 'you', 'we', 'they', 'he', 'she', 'it', 'i', 'a', 'an', 'the',
  'this', 'that', 'these', 'those', 'here', 'there', 'just', 'already', 'still',
  'back', 'again', 'only', 'really', 'very', 'too', 'so', 'not', 'no', 'yes',
  'yeah', 'yep', 'nope', 'sure', 'sorry', 'thanks', 'thank', 'cheers', 'please',
  'plz', 'pls', 'ok', 'okay', 'fine', 'good', 'great', 'urgent', 'emergency',
  'important', 'broken', 'tripping', 'dead', 'leaking', 'sparking', 'buzzing', 'flashing',
  'from', 'at', 'of', 'in', 'on', 'for', 'to', 'by', 'with', 'and', 'or', 'but',
  'about', 'regarding', 'home', 'house', 'work', 'working', 'job', 'jobs', 'switch',
  'craft', 'switchcraft', 'power', 'light', 'lights', 'fan', 'fans', 'quote',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'today', 'tomorrow', 'yesterday',
]);
const titleCase = s => s.replace(/\b([a-z])/g, (_, c) => c.toUpperCase());

// Parse self-introduction and contact-details SMS messages such as
// "Hi it's Jane Smith\n6 Example Drive Waurn Ponds\n0400111222\njane@example.com"
// or "Hey its Sam Taylor from 14 High Street Belmont".
export function extractContactIntro(text) {
  const src = String(text || '').replace(/\r/g, '');
  const address = extractAddress(src);
  const email = (src.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i) || [])[0]?.toLowerCase() || null;
  const phone = (src.match(/\b(?:04\d{2}[\s-]?\d{3}[\s-]?\d{3}|04\d{8}|\+?61\s?4\d{2}[\s-]?\d{3}[\s-]?\d{3})\b/) || [])[0]?.replace(/\s+/g, '') || null;

  let name = null;
  const introRe = /(?:^|\b)(?:hi|hey|hello|g'?day|morning|afternoon|evening)?[\s,!.:;-]*(?:it'?s|its|this\s+is|my\s+name\s+is|i'?m|i\s+am)\s+((?!(?:from|at|of|in|on|for|here)\b)[A-Za-z][A-Za-z'\-]+(?:\s+(?!(?:from|at|of|in|on|for|here)\b)[A-Za-z][A-Za-z'\-]+){0,2})(?=\s*(?:$|\n|[,.!?;]|\b(?:from|at|of|in|on|here)\b|\d))/gi;
  for (const m of src.matchAll(introRe)) {
    const raw = m[1].trim().replace(/\s+/g, ' ');
    const words = raw.split(' ');
    if (words.some(w => INTRO_NAME_STOP.has(w.toLowerCase()))) continue;
    const hasCaps = words.every(w => /^[A-Z]/.test(w));
    if (!hasCaps && !address) continue;
    name = hasCaps ? raw : titleCase(raw);
    break;
  }
  if (!name && address) {
    const firstLine = src.trim().split('\n')[0]?.trim() || '';
    const lineMatch = firstLine.match(/^([A-Z][a-z'\-]+\s+[A-Z][a-z'\-]+)$/);
    if (lineMatch && !lineMatch[1].split(' ').some(w => INTRO_NAME_STOP.has(w.toLowerCase()))) {
      name = lineMatch[1];
    }
  }

  const isDetailsDrop = Boolean(
    (name && address)
    || (address && (email || phone))
    || (name && (email || /\b(?:from|at)\s+\d{1,5}\b/i.test(src)))
  );
  return { name, address, email, phone, isDetailsDrop };
}

const MISSED_CALL_RE = /\b(?:called\.\s*No\s+Voicemail\s+message\s+was\s+left|free\s+call\s+147|missed\s+(?:a\s+)?call)\b/i;
const CALLBACK_RE = /\b(?:give\s+(?:me|us)\s+a\s+(?:buzz|call|ring|bell)|buzz\s+(?:me|us|back|if|when|asap|later|today|tonight|tomorrow)|call\s+(?:me|us|back|plz|pls|please|if\s+(?:you\s+)?can|when\s+(?:you\s+)?(?:can|get\s+a\s+chance|free)|asap)|(?:can|could|will)\s+you\s+(?:call|buzz|ring)|ring\s+(?:me|us|back)|tried\s+(?:calling|to\s+call))\b|^buzz[.!?]*$|^call(?:\s+(?:plz|pls|please))?[.!?]*$/i;

export function isCallSignal(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return !!s && (MISSED_CALL_RE.test(s) || CALLBACK_RE.test(s));
}

// Detect missed calls or buzz/call-back requests that have no visible outbound reply
// after them (Reverb sees SMS/text messages, not phone calls).
export function hasUnrepliedCall(snippet, messages) {
  if (Array.isArray(messages) && messages.length) {
    let lastOut = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.outbound) { lastOut = i; break; }
    }
    const trailing = messages.slice(lastOut + 1);
    if (!trailing.length) return false;
    return trailing.some(m => isCallSignal(m?.text)) || isCallSignal(snippet);
  }
  return isCallSignal(snippet);
}

// ── Progressive person dossier & archive helpers ────────────
const QUOTE_RE = /(?:\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?(?:\s*(?:\+|plus|inc|incl|ex|excl)?\s*gst|\s*all\s*up|\s*each)?|\b\d{2,5}\s*dollars?(?:\s*(?:plus|\+)\s*gst|\s*all\s*up)?\b)/i;

export function extractQuoteAmount(text) {
  const m = String(text || '').match(QUOTE_RE);
  if (!m) return null;
  return m[0].replace(/\s+/g, ' ').trim();
}

const STREET_TYPE_MAP = {
  st: 'street', street: 'street',
  rd: 'road', road: 'road',
  dr: 'drive', drive: 'drive',
  av: 'avenue', ave: 'avenue', avenue: 'avenue',
  ct: 'court', crt: 'court', court: 'court',
  pl: 'place', place: 'place',
  cr: 'crescent', cres: 'crescent', crescent: 'crescent',
  bvd: 'boulevard', blvd: 'boulevard', boulevard: 'boulevard',
  hwy: 'highway', highway: 'highway',
  ln: 'lane', lane: 'lane',
  cl: 'close', close: 'close',
  tce: 'terrace', terrace: 'terrace',
  pde: 'parade', parade: 'parade',
  cct: 'circuit', circuit: 'circuit',
  gr: 'grove', grove: 'grove',
  wy: 'way', way: 'way',
};

const ADDR_KEY_RE = /\b(\d{1,5}[a-z]?(?:\/\d{1,5})?)\s+((?:[a-z][a-z'\-]*\s+){1,4})(street|st|road|rd|drive|dr|avenue|ave|av|court|ct|crt|place|pl|crescent|cres|cr|boulevard|blvd|bvd|highway|hwy|lane|ln|close|cl|terrace|tce|parade|pde|circuit|cct|grove|gr|way|wy)\b/i;

export function normalizeAddressKey(addr) {
  const raw = String(addr || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const m = raw.match(ADDR_KEY_RE);
  if (!m) return null;
  const num = m[1].toLowerCase();
  const street = m[2].trim().replace(/\s+/g, ' ').toLowerCase();
  const type = STREET_TYPE_MAP[m[3].toLowerCase()] || m[3].toLowerCase();
  return `${num} ${street} ${type}`;
}

const GEELONG_SUBURBS = [
  'Armstrong Creek', 'Bannockburn', 'Barwon Heads', 'Batesford',
  'Bell Park', 'Bell Post Hill', 'Belmont', 'Breakwater', 'Charlemont',
  'Clifton Springs', 'Corio', 'Curlewis', 'Drysdale', 'East Geelong',
  'Fyansford', 'Geelong West', 'Grovedale', 'Hamlyn Heights',
  'Herne Hill', 'Highton', 'Indented Head', 'Inverleigh', 'Jan Juc',
  'Lara', 'Leopold', 'Lovely Banks', 'Manifold Heights', 'Marshall',
  'Moolap', 'Moriac', 'Mount Duneed', 'Newcomb', 'Newtown',
  'North Geelong', 'Norlane', 'Ocean Grove', 'Point Lonsdale', 'Portarlington',
  'Queenscliff', 'South Geelong', 'St Albans Park', 'St Leonards', 'Thomson',
  'Torquay', 'Wallington', 'Wandana Heights', 'Waurn Ponds', 'West Geelong',
  'Whittington', 'Winchelsea', 'Anglesea',
].sort((a, b) => b.length - a.length);

const GEELONG_SUBURB_CANON = new Map(GEELONG_SUBURBS.map(s => [s.toLowerCase(), s]));
const GEELONG_SUBURB_RE = new RegExp(`\\b(${GEELONG_SUBURBS.map(s => s.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');

export function extractSuburb(text) {
  const m = String(text || '').match(GEELONG_SUBURB_RE);
  if (!m) return null;
  const key = m[1].replace(/\s+/g, ' ').trim().toLowerCase();
  return GEELONG_SUBURB_CANON.get(key) || m[1].replace(/\s+/g, ' ').trim();
}

const TRADE_PART_PATTERNS = [
  /\b(?:customer|client)[- ]supplied\b/gi,
  /\b\d+\s*(?:x\s*)?(?:ceiling\s+fans?|fans?|downlights?|lights?|pendants?|smoke\s+alarms?|power\s*points?|gpos?|switches|dimmers?|data\s+points?|sensors?)\b/gi,
  /\b(?:switchboard|rcd|safety\s+switch|oven|cooktop|rangehood|exhaust\s+fan|split\s+system|isolator|hot\s+water|ev\s+charger|starlink)\b/gi,
];
const JOB_LINK_RE = /switchcraft\.cmdward\.xyz\/jobs\/(\d+)/gi;
const INVOICED_OR_PAID_RE = /\b(?:invoice\s*#?\d+|paid\s+in\s+full|remittance|payment\s+received|eft\s+transfer)\b/i;

export function extractTradeSignals(text) {
  const src = String(text || '');
  const jobIds = [];
  for (const m of src.matchAll(JOB_LINK_RE)) {
    const id = Number(m[1]);
    if (Number.isInteger(id) && id > 0 && !jobIds.includes(id)) jobIds.push(id);
  }
  const parts = [];
  const seenParts = new Set();
  for (const re of TRADE_PART_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const val = m[0].replace(/\s+/g, ' ').trim();
      const key = val.toLowerCase();
      if (val && !seenParts.has(key)) {
        seenParts.add(key);
        parts.push(val);
      }
    }
  }
  return {
    jobIds,
    parts,
    quote: extractQuoteAmount(src),
    suburb: extractSuburb(src),
    invoicedOrPaid: INVOICED_OR_PAID_RE.test(src),
  };
}

const localDateStr = v => {
  if (!v) return '';
  if (v instanceof Date && !Number.isNaN(+v)) {
    const pad = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

export function deriveDeterministicStage({ messages = [], commitments = [], events = [], jobStatus = null, today = '' } = {}) {
  const todayStr = today || localDateStr(new Date());
  const msgText = m => String(m?.text ?? m?.body ?? '');

  const validEvents = (events || [])
    .map(e => ({ ...e, _date: localDateStr(e?.date) }))
    .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e._date));

  const upcoming = validEvents
    .filter(e => e._date >= todayStr)
    .sort((a, b) => a._date.localeCompare(b._date) || String(a.time || '').localeCompare(String(b.time || '')));
  if (upcoming.length) {
    const ev = upcoming[0];
    return {
      stage: `Booked (${ev._date}${ev.time ? ' ' + ev.time : ''})`,
      nextStep: `Attend booked job on ${ev._date}${ev.time ? ' at ' + ev.time : ''}`,
    };
  }

  const past = validEvents
    .filter(e => e._date < todayStr)
    .sort((a, b) => b._date.localeCompare(a._date));
  if (past.length) {
    const ev = past[0];
    const hasInvoiceOrPaid = (messages || []).some(m => {
      const mAt = localDateStr(m?.at ?? m?.msg_at);
      if (/^\d{4}-\d{2}-\d{2}$/.test(mAt) && mAt < ev._date) return false;
      return INVOICED_OR_PAID_RE.test(msgText(m));
    }) || (jobStatus && /invoic|paid|complet/i.test(String(jobStatus)));
    if (!hasInvoiceOrPaid) {
      return {
        stage: `Completed (${ev._date}) · check invoicing`,
        nextStep: 'Confirm job completion and send invoice if not yet billed',
      };
    }
  }

  const openList = commitments || [];
  const unbooked = openList.find(c => c?.status === 'unbooked');
  if (unbooked) {
    const wd = localDateStr(unbooked.when_date);
    return {
      stage: `Agreed · needs calendar booking${wd ? ' (' + wd + ')' : ''}`,
      nextStep: 'Book the agreed day and time in the Work calendar',
    };
  }
  const needsConfirm = openList.find(c => c?.status === 'needs_confirm');
  if (needsConfirm) {
    return {
      stage: 'Time discussed · needs confirmation',
      nextStep: 'Confirm the exact day and time with the client',
    };
  }

  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i]?.outbound) continue;
    const t = msgText(msgs[i]);
    if (extractQuoteAmount(t) || /switchcraft\.cmdward\.xyz\/jobs\/\d+/i.test(t)) {
      const clientReplied = msgs.slice(i + 1).some(m => !m?.outbound);
      return clientReplied
        ? { stage: 'Quoted · client replied', nextStep: 'Reply to client and lock in a booking time' }
        : { stage: 'Quoted · awaiting client reply', nextStep: 'Wait for client response or follow up on quote' };
    }
  }

  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.outbound) continue;
    if (extractContactIntro(msgText(msgs[i])).isDetailsDrop) {
      if (!msgs.slice(i + 1).some(m => m?.outbound)) {
        return {
          stage: 'New client sent contact details',
          nextStep: 'Reply or call back to discuss the job and book a time',
        };
      }
      break;
    }
  }

  return { stage: null, nextStep: null };
}

export function canonicalPersonKey({ kind, from, phone, email, name, address } = {}, directory = {}) {
  const last9 = phoneLast9(phone) || (kind === 'sms' ? phoneLast9(from) : null) || phoneLast9(from);
  if (last9) return directory.byPhone?.[last9] || `phone:${last9}`;

  const rawEmail = email
    ? normalizeIdentifier('email', email)
    : ((kind === 'email' || kind === 'bizemail') ? normalizeIdentifier(kind, from) : '');
  if (rawEmail && rawEmail.includes('@')) return directory.byEmail?.[rawEmail] || `email:${rawEmail}`;

  const addrKey = normalizeAddressKey(address || extractAddress(from));
  if (addrKey && directory.byAddress?.[addrKey]) return directory.byAddress[addrKey];

  const rawName = String(name || from || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (rawName && directory.byName?.[rawName]) return directory.byName[rawName];
  return rawName ? `name:${rawName}` : 'unknown';
}

const PLACEHOLDER_RE = /^(none|null|n\/a|unknown|unclear|not\s+(?:mentioned|specified|provided|clear|applicable)|—|-|\?)$/i;

export function cleanDossierValue(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).replace(/\s+/g, ' ').trim();
  if (!s || PLACEHOLDER_RE.test(s)) return null;
  return s;
}

const DOSSIER_TEXT_FIELDS = [
  'work_scope',
  'quote_estimate',
  'parts_materials',
  'preferred_times',
  'access_notes',
  'current_stage',
  'open_next_step',
  'summary_notes',
];

const SELF_NAME_RE = /^(?:jesse(?:\s*k?ward(?:\s+test)?)?|switch\s*craft(?:\s+electrics)?|me|you)$/i;
const GENERIC_JOB_STAGE_RE = /^(?:pending|accepted|quoted|open|active|in[\s_-]*progress|new)$/i;
const cleanPersonName = val => {
  const s = cleanDossierValue(val);
  return s && !SELF_NAME_RE.test(s) ? s : null;
};

export function mergeDossierFields(existing = {}, incoming = {}) {
  const exName = cleanPersonName(existing.display_name);
  const inName = cleanPersonName(incoming.display_name);
  const exHasLetters = !!(exName && /[a-z]/i.test(exName));
  const inHasLetters = !!(inName && /[a-z]/i.test(inName));

  let display_name = null;
  if (exHasLetters && !inHasLetters) display_name = exName;
  else if (inHasLetters) display_name = inName;
  else display_name = inName || exName || null;

  const exAddr = cleanDossierValue(existing.address);
  const inAddr = cleanDossierValue(incoming.address);
  let address = null;
  let address_source = null;
  if (exAddr && existing.address_source === 'switch-craft' && incoming.address_source !== 'switch-craft') {
    address = exAddr;
    address_source = 'switch-craft';
  } else if (inAddr && !(exAddr && normalizeAddressKey(exAddr) && !normalizeAddressKey(inAddr) && incoming.address_source !== 'manual')) {
    address = inAddr;
    address_source = incoming.address_source || existing.address_source || 'model';
  } else if (exAddr) {
    address = exAddr;
    address_source = existing.address_source || null;
  }

  const channels = [...new Set(
    [...(existing.channels || []), ...(incoming.channels || [])]
      .filter(Boolean)
      .map(c => String(c).toLowerCase())
  )].sort();

  const job_ids = [...new Set(
    [...(existing.job_ids || []), ...(incoming.job_ids || [])]
      .map(Number)
      .filter(n => Number.isInteger(n) && n > 0)
  )].sort((a, b) => a - b);

  const merged = {
    person_key: incoming.person_key || existing.person_key || null,
    display_name,
    phone: cleanDossierValue(incoming.phone) || cleanDossierValue(existing.phone) || null,
    email: cleanDossierValue(incoming.email) || cleanDossierValue(existing.email) || null,
    address,
    address_source,
    business: cleanPersonName(incoming.business) || cleanPersonName(existing.business) || null,
    channels,
    job_ids,
  };

  for (const field of DOSSIER_TEXT_FIELDS) {
    merged[field] = cleanDossierValue(incoming[field]) || cleanDossierValue(existing[field]) || null;
  }
  const exStage = cleanDossierValue(existing.current_stage);
  const inStage = cleanDossierValue(incoming.current_stage);
  if (exStage && inStage && GENERIC_JOB_STAGE_RE.test(inStage) && !GENERIC_JOB_STAGE_RE.test(exStage)) {
    merged.current_stage = exStage;
  }
  return merged;
}

const DOSSIER_LINE_KEYS = {
  NAME: 'display_name',
  ADDRESS: 'address',
  SCOPE: 'work_scope',
  QUOTE: 'quote_estimate',
  PARTS: 'parts_materials',
  TIMES: 'preferred_times',
  ACCESS: 'access_notes',
  STAGE: 'current_stage',
  NEXT: 'open_next_step',
  SUMMARY: 'summary_notes',
};

export function parseDossierResponse(raw, existing = {}, sourceCorpus = '') {
  const incoming = {};
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])?\s*\*{0,2}([A-Z_]+)\*{0,2}\s*(?:::|:)\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (key === 'EVIDENCE') continue;
    const field = DOSSIER_LINE_KEYS[key];
    if (!field) continue;
    const val = cleanDossierValue(m[2]);
    if (!val) continue;
    incoming[field] = val;
    if (field === 'address') incoming.address_source = 'model';
  }

  const corpusStr = String(sourceCorpus || '').trim();
  if (corpusStr) {
    const corpusLow = corpusStr.toLowerCase();
    const corpusDigits = corpusLow.replace(/,/g, '');

    if (incoming.address) {
      const inKey = normalizeAddressKey(incoming.address);
      const corpKey = normalizeAddressKey(extractAddress(corpusStr));
      let addrOk = false;
      if (inKey) {
        if (corpKey && corpKey === inKey) {
          addrOk = true;
        } else {
          const [num, st] = inKey.split(/\s+/);
          const numEsc = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          addrOk = new RegExp(`\\b${numEsc}\\b`).test(corpusLow) && (!st || corpusLow.includes(st));
        }
      } else {
        const words = incoming.address.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z]/g, '')).filter(w => w.length >= 3);
        addrOk = corpusLow.includes(incoming.address.toLowerCase()) || (words.length > 0 && words.every(w => corpusLow.includes(w)));
      }
      if (!addrOk) {
        delete incoming.address;
        delete incoming.address_source;
        const detAddr = extractAddress(corpusStr);
        if (detAddr) {
          incoming.address = detAddr;
          incoming.address_source = 'chat';
        }
      }
    }

    if (incoming.quote_estimate) {
      const nums = incoming.quote_estimate.match(/\d[\d,]*/g) || [];
      if (nums.length && !nums.some(n => corpusDigits.includes(n.replace(/,/g, '')))) {
        delete incoming.quote_estimate;
        const detQuote = extractQuoteAmount(corpusStr);
        if (detQuote) incoming.quote_estimate = detQuote;
      }
    }

    if (incoming.display_name) {
      if (!cleanPersonName(incoming.display_name)) {
        delete incoming.display_name;
      } else {
        const words = incoming.display_name.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z'\-]/g, '')).filter(w => w.length >= 3);
        const exNameLow = String(existing.display_name || '').toLowerCase();
        if (words.length && !words.some(w => corpusLow.includes(w) || exNameLow.includes(w))) {
          delete incoming.display_name;
        }
      }
    }
  }

  return mergeDossierFields(existing, incoming);
}

export function formatDossierBlock(d) {
  if (!d || typeof d !== 'object') return '';
  const get = (snake, camel) => cleanDossierValue(d[snake] ?? d[camel]);
  const jobIds = Array.isArray(d.job_ids) ? d.job_ids : (Array.isArray(d.jobIds) ? d.jobIds : []);
  const parts = [
    get('display_name', 'displayName') && `Name: ${get('display_name', 'displayName')}`,
    get('phone', 'phone') && `Phone: ${get('phone', 'phone')}`,
    get('email', 'email') && `Email: ${get('email', 'email')}`,
    get('address', 'address') && `Address: ${get('address', 'address')}`,
    get('business', 'business') && `Business: ${get('business', 'business')}`,
    jobIds.length && `Jobs: ${jobIds.map(id => `#${id}`).join(', ')}`,
    get('work_scope', 'workScope') && `Scope: ${get('work_scope', 'workScope')}`,
    get('quote_estimate', 'quoteEstimate') && `Quote: ${get('quote_estimate', 'quoteEstimate')}`,
    get('parts_materials', 'partsMaterials') && `Parts: ${get('parts_materials', 'partsMaterials')}`,
    get('preferred_times', 'preferredTimes') && `Preferred times: ${get('preferred_times', 'preferredTimes')}`,
    get('access_notes', 'accessNotes') && `Access: ${get('access_notes', 'accessNotes')}`,
    get('current_stage', 'currentStage') && `Stage: ${get('current_stage', 'currentStage')}`,
    get('open_next_step', 'openNextStep') && `Next step: ${get('open_next_step', 'openNextStep')}`,
    get('summary_notes', 'summaryNotes') && `Notes: ${get('summary_notes', 'summaryNotes')}`,
  ].filter(Boolean);
  return parts.length ? `[${parts.join(' | ')}]` : '';
}
