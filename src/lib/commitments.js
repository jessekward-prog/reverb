// Commitments ledger: structured, cited, re-derivable memory of work agreed in
// messages, reconciled against the calendar.
//
// Why not an LLM-resolved date, and why not a general NL date parser:
//  - The model confabulates dates (and gemma is weak at strict JSON anyway).
//  - A greedy parser invents them from ordinary text: "electrical at 12 Sample
//    Drive" parses as 12 o'clock, "Good morning." parses as a time, and a past
//    "Monday 2nd" gets pushed into next week.
// So the model only decides WHETHER a commitment exists and quotes the thread
// verbatim; the day is resolved here, deterministically, from the short WHEN
// span it copied. Anything this does not recognise resolves to null and becomes
// needs_confirm — asked, never asserted.
//
// ponytail: deliberately a whitelist (today/tomorrow/weekday), not a date
// parser. Ceiling: it does not understand "the 14th", "next month" or
// "fortnight" — those land in needs_confirm rather than being guessed wrong.
// Upgrade path is chrono-node constrained to the WHEN span, with the
// day-of-month cross-check below kept as a guard.

import { createHash } from 'node:crypto';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Every spelling seen or plausible in a text, typos included. Matched
// longest-first, never inside a word or after an apostrophe ("c'mon").
const DAY_WORDS = [
  ['sunday', 0], ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4], ['friday', 5], ['saturday', 6],
  ['wednsday', 3], ['wedensday', 3], ['wendsday', 3], ['wensday', 3], ['wedsday', 3], ['wednesay', 3],
  ['thurday', 4], ['thursay', 4], ['thrusday', 4], ['tuesay', 2], ['teusday', 2], ['tuseday', 2],
  ['firday', 5], ['saterday', 6], ['satuday', 6], ['monady', 1],
  ['thurs', 4], ['tues', 2], ['weds', 3], ['thur', 4], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6], ['sun', 0],
].sort((a, b) => b[0].length - a[0].length);
// Too often an ordinary word ("c'mon", "sat down", "the sun") to trust when
// reading a whole message rather than a short WHEN span.
const LOOSE = new Set(['mon', 'sat', 'sun']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const VAGUE = /\b(next week|next weeks|next month|week after|weeks? time|\d+ weeks|a week|fortnight|couple of (days|weeks)|few days|end of (the )?week|weekend|sometime|some time|later|soon|another day|in a few|tbc|tba|asap|any ?time|whenever)\b/;
const ALTERNATIVE = /\b(or|otherwise|either)\b/;
// A day that is ruled out, not agreed: "can't do Thursday", "any day except
// Thursday", "tomorrow is out", "Friday's no good".
const NEG_BEFORE = /\b(can'?t|cannot|can not|not|except|besides|other than|busy|booked)\s+(?:(?:do|make|on|the|this|that|be|until|till)\s+)*$/;
const NEG_AFTER = /^\s*(?:is|'s)?\s*(?:out|no good|not good|bad|booked|full|busy|off|a no|no go|doesn'?t|does not|won'?t|will not|isn'?t|is not|not)\b/;

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monWeek = d => (d.getDay() + 6) % 7;                 // Monday = 0, as weeks are said here
const dayOnly = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// A Postgres DATE comes back as a JS Date at LOCAL midnight, so toISOString()
// shifts it a day backwards anywhere east of UTC — verified against a real
// Postgres: 2026-11-05 read back as "2026-11-04" in AEDT (UTC+11). Every date
// in the ledger would have displayed a day early. Format from the local parts.
export const ymd = d => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d || '').slice(0, 10));

// Hours a tradie works: a bare "2" or "2ish" is the afternoon, not 2am.
const workHour = h => (h >= 1 && h <= 6 ? h + 12 : h);
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${m || '00'}`;

function pullTime(text) {
  let time = null;
  const take = (re, fn) => {
    text = text.replace(re, (...m) => { if (!time) time = fn(m); return ' '; });
  };
  take(/(?<![\d$.\/])(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/g, m => {   // 9am, 1.30pm, 05:20pm
    let h = Number(m[1]) % 12; if (m[3] === 'pm') h += 12; return hhmm(h, m[2]);
  });
  take(/\b(midday|noon)\b/g, () => '12:00');
  take(/(?<![\d$.\/])(\d{1,2})[:.](\d{2})(?!\d|\.\d|\/)/g, m => hhmm(workHour(Number(m[1])), m[2]));  // 12.30, 8:30
  take(/(?<![\d$.\/])(\d{1,2})\s*(?:-?ish|o'?clock)\b/g, m => hhmm(workHour(Number(m[1]))));      // 11 ish, 9 o'clock
  return { time, rest: text };
}

// Every candidate day a span could mean. Several candidates is not a guess
// to be made - it comes back as 'ambiguous' and is asked, never asserted.
//
// ponytail: still a whitelist, not a date parser. Anything not listed here
// ("the following week", "a week from Monday") lands in needs_confirm.
export function resolveWhen(whenText, ref = new Date(), { strict = false } = {}) {
  const raw = norm(whenText).replace(/[‘’]/g, "'");
  if (!raw) return { date: null, time: null, reason: 'empty' };
  const today = dayOnly(ref);
  const { time, rest } = pullTime(raw);
  let text = rest;

  // Explicit calendar dates: 20/10/2026, 20th October, Oct 20.
  const explicit = new Set();
  const nearestYear = (d, m, y) => {
    if (y) return new Date(y < 100 ? 2000 + y : y, m, d);
    let x = new Date(today.getFullYear(), m, d);
    if (x < addDays(today, -60)) x = new Date(today.getFullYear() + 1, m, d);   // "3 Jan" said in December
    return x;
  };
  const addExplicit = x => { if (!isNaN(x)) explicit.add(iso(x)); return ' '; };
  text = text.replace(/(?<![\d$.])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d\/])/g,
    (_, d, m, y) => (Number(m) >= 1 && Number(m) <= 12 ? addExplicit(nearestYear(+d, m - 1, y && +y)) : _));
  text = text.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\b(?: (\\d{4}))?`, 'g'),
    (_, d, mo, y) => addExplicit(nearestYear(+d, MONTHS.indexOf(mo.slice(0, 3)), y && +y)));
  text = text.replace(new RegExp(`\\b${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'),
    (_, mo, d) => addExplicit(nearestYear(+d, MONTHS.indexOf(mo.slice(0, 3)))));
  // A bare ordinal ("the 3rd") pins the day of the month; a bare number does
  // not - "12 Oberon Drive" is an address.
  const ord = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  const dom = ord ? Number(ord[1]) : null;

  // Day mentions, each with its candidate dates. A negated one is dropped.
  const mentions = [];
  const negated = (at, len) => NEG_BEFORE.test(text.slice(Math.max(0, at - 30), at)) || NEG_AFTER.test(text.slice(at + len, at + len + 25));
  let weekRelative = false;

  const relWords = [
    [/\bday after (?:tomorrow|tmrw|tmr|tomoz)\b/g, 2],
    [/\b(?:tomorrow|tomorow|tommorow|tommorrow|tmrw|tmr|tomoz|2moro|2morrow)\b/g, 1],
    [/\b(?:today|tonight|tonite|2day|this arvo|this afternoon|this morning|this evening)\b/g, 0],
    [/\byesterday\b/g, -1],
  ];
  for (const [re, n] of relWords) {
    text = text.replace(re, (m, at) => {
      if (!negated(at, m.length)) mentions.push({ kind: 'rel', dates: [iso(addDays(today, n))] });
      return ' '.repeat(m.length);   // keep offsets, and "tomorrow" inside "day after tomorrow" is spent
    });
  }

  const dayRe = new RegExp(`(?<![\\w'])(${DAY_WORDS.map(([w]) => w).join('|')})(?!\\w)`, 'g');
  for (const m of text.matchAll(dayRe)) {
    const word = m[1], at = m.index;
    if (strict && LOOSE.has(word)) continue;
    if (negated(at, word.length)) continue;
    const t = DAY_WORDS.find(([w]) => w === word)[1];
    const before = text.slice(Math.max(0, at - 20), at);
    const after = text.slice(at + word.length, at + word.length + 20);
    const mondayThis = addDays(today, -monWeek(today));
    const inWeek = k => [iso(addDays(mondayThis, 7 * k + (t + 6) % 7))];
    const off = (t - today.getDay() + 7) % 7;
    let dates;
    if (/^\s*,?\s*next week\b/.test(after) || /\bnext week\s*,?\s*$/.test(before)) dates = inWeek(1);
    else if (/^\s*,?\s*last week\b/.test(after) || /\blast week\s*,?\s*$/.test(before)) dates = inWeek(-1);
    else if (/^\s*,?\s*this week\b/.test(after)) dates = inWeek(0);
    else if (/^\s*week\b/.test(after)) { weekRelative = true; continue; }          // "Tuesday week"
    else if (/\blast\s+$/.test(before)) dates = [iso(addDays(today, -(((today.getDay() - t + 7) % 7) || 7)))];
    else if (/\bnext\s+$/.test(before)) {
      // "next Thursday" said on a Monday is this Thursday to some, next week's to others.
      dates = off === 0 ? [iso(addDays(today, 7))]
        : (t + 6) % 7 > monWeek(today) ? [iso(addDays(today, off)), iso(addDays(today, off + 7))]
        : [iso(addDays(today, off))];
    } else dates = [iso(addDays(today, off))];
    mentions.push({ kind: 'day', dates });
  }

  const domOf = d => Number(d.slice(8, 10));
  const done = (date, reason = 'ok') => ({ date, time, reason });
  const days = mentions.filter(m => m.kind === 'day');

  if (explicit.size) {
    if (explicit.size > 1) return done(null, 'ambiguous');
    const [only] = explicit;
    // A weekday named alongside must be that date's weekday.
    const wd = new Date(only + 'T00:00').getDay();
    if (days.length && !days.some(m => m.dates.some(d => new Date(d + 'T00:00').getDay() === wd))) return done(null, 'day-of-month conflict');
    return done(only);
  }

  if (dom) {
    // Most often a PAST reference like "Monday 2nd": refuse rather than pick.
    if (mentions.length) {
      const hits = [...new Set(mentions.flatMap(m => m.dates).filter(d => domOf(d) === dom))];
      return hits.length === 1 ? done(hits[0]) : done(null, hits.length ? 'ambiguous' : 'day-of-month conflict');
    }
    let x = new Date(today.getFullYear(), today.getMonth(), dom);
    if (x < today) x = new Date(today.getFullYear(), today.getMonth() + 1, dom);
    return x.getDate() === dom ? done(iso(x)) : done(null, 'unrecognised');
  }

  if (days.some(m => m.dates.length > 1)) return done(null, 'ambiguous');
  const dayDates = [...new Set(days.flatMap(m => m.dates))];
  const relDates = [...new Set(mentions.filter(m => m.kind === 'rel').flatMap(m => m.dates))];
  const all = [...new Set([...dayDates, ...relDates])];
  const offered = ALTERNATIVE.test(text) && (all.length > 1 || VAGUE.test(text));

  if (dayDates.length > 1 || relDates.length > 1 && !dayDates.length) return done(null, 'ambiguous');
  if (offered) return done(null, 'ambiguous');                     // "Thurs or Friday?"
  // A named day beats a relative word: "tomorrow is my wife's birthday, I'll
  // have to do Thursday" agrees to Thursday.
  if (dayDates.length) return done(dayDates[0]);
  if (relDates.length) return done(relDates[0]);
  if (weekRelative || VAGUE.test(text)) return done(null, 'vague');
  return done(null, 'unrecognised');
}

// Stable per thread + quoted line, so re-extraction updates the same row
// instead of duplicating (same idiom as workItemId).
export function commitmentId(threadName, quote) {
  return createHash('sha1').update(`${norm(threadName)}|${norm(quote)}`).digest('hex').slice(0, 12);
}

// Anti-confabulation guard: both the quoted line and the WHEN span must appear
// verbatim in the thread the model attributed them to. A row that fails this is
// invention, so it is dropped rather than stored with a caveat.
export function groundedInThread(thread, quote, whenText) {
  const hay = norm((thread.messages || []).map(m => m.text).join(' \u0001 '));
  const q = norm(quote);
  if (!q || q.length < 8 || !hay.includes(q)) return false;
  const w = norm(whenText);
  return !w || hay.includes(w);
}

// A bridge message's `at` is local wall-clock "YYYY-MM-DDTHH:MM".
const atDate = at => {
  const m = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
};

// One message as the model reads it: dated, so last week's "Thursday works"
// is not mistaken for this week's.
export function msgLine(m) {
  const d = atDate(m.at);
  const stamp = d ? `[${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}] ` : '';
  return `${stamp}${m.outbound ? 'me' : 'them'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}`;
}

// Parse the model's line output. Line-based, not JSON, because gemma is
// unreliable at strict JSON (see Agentic-LM-Pipeline-Pattern).
//   WHO :: WHAT :: WHEN :: QUOTE
export function parseExtraction(raw, threads, ref = new Date()) {
  const out = [];
  const seen = new Set();

  for (const line of String(raw || '').split('\n')) {
    if (!line.includes('::')) continue;

    // Field ORDER is not stable between runs. The same prompt has produced
    // "WHO :: WHAT :: WHEN :: QUOTE", "me :: what :: when :: quote" and
    // "me: quote :: what :: when". So fields are identified by what they ARE,
    // using the guards we already trust: the quote is the one that appears
    // verbatim in a thread, the timing is the one that resolves to a date.
    const fields = line.split('::')
      .map(f => f.trim()
                 .replace(/^\d+\s*[.)]\s*/, '')          // leading index
                 .replace(/^\[[^\]]*\]\s*/, '')           // date stamp from msgLine
                 .replace(/^(me|them|you|it)\s*:\s*/i, '') // speaker label
                 .replace(/^[—–-]+\s*|\s*[—–-]+$/g, '')
                 .replace(/^["“']|["”']$/g, '')
                 .trim())
      .filter(Boolean);
    if (fields.length < 2) continue;

    // 1. the thread: named by WHO when the model copied the heading. Without
    //    this, a short WHAT like "installation" matched whichever thread
    //    happened to contain that word first, and a job landed on a stranger.
    const named = threads.find(t => fields.some(f => norm(f) === norm(t.name)));
    const pool = named ? [named] : threads;

    // 2. the quote: the LONGEST field grounded verbatim in that thread - a
    //    short WHAT can be verbatim too, and must not win over the real line.
    let thread = null, quote = null, qi = -1;
    fields.forEach((f, i) => {
      if (quote && f.length <= quote.length) return;
      const hit = pool.find(t => groundedInThread(t, f, ''));
      if (hit) { thread = hit; quote = f; qi = i; }
    });
    if (!thread) continue;   // nothing verbatim -> invention, drop it

    // Weekdays resolve from when the quoted message was SENT, not from now.
    const q = norm(quote);
    const sent = atDate((thread.messages || []).find(m => norm(m.text).includes(q))?.at) || ref;

    // 3. the timing: whichever remaining field actually reads as one, else
    //    the quote itself ("Let's do Thursday this week! ... 9am").
    const rest = fields.filter((_, i) => i !== qi);
    let whenText = '', when = { date: null, time: null, reason: 'empty' };
    for (const f of [...rest.filter(f => f.length <= 40), quote]) {   // >40: a sentence, not a date
      const r = resolveWhen(f, sent, { strict: f === quote });
      if (r.date || ['vague', 'ambiguous', 'day-of-month conflict'].includes(r.reason)) {
        whenText = f === quote ? '' : f; when = r; break;
      }
    }
    // "Yep Wednesday is good" agrees to a time said in another message
    // ("Wednesday... Maybe 9am"). Take the latest time the thread pins to
    // that same day, the quote first.
    if (when.date && !when.time) {
      const said = [{ text: quote, at: null }, ...(thread.messages || []).slice().reverse()];
      for (const m of said) {
        const r = resolveWhen(m.text, atDate(m.at) || sent, { strict: true });
        if (r.time && (r.date === when.date || (m.at === null && !r.date))) { when.time = r.time; break; }
      }
    }
    // Its day has been and gone: nothing left to put in the calendar.
    if (when.date && when.date < iso(ref)) continue;

    // 4. what is left, longest first, is the description of the work
    // Drop the timing and any field that is just the thread's own name, so a
    // present WHO is not mistaken for the description of the work.
    const what = rest
      .filter(f => f !== whenText && norm(f) !== norm(thread.name))
      .sort((a, b) => b.length - a.length)[0] || quote.slice(0, 80);

    const id = commitmentId(thread.name, quote);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, who: thread.name, what, whenText, quote,
      date: when.date, time: when.time, vague: !when.date, reason: when.reason,
      threadName: thread.name,
    });
  }
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'need', 'needs', 'install', 'job', 'jobs', 'work', 'come', 'book', 'booked', 'about', 'their', 'them', 'they', 'have', 'from', 'will']);
const tokens = s => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w));
const digits = s => String(s || '').replace(/\D/g, '');

// The calendar is truth; the ledger only reports the gap. Never let the model
// decide "booked".
//   booked        - an event that day clearly refers to this commitment
//   needs_confirm - no date, or something else is on that day and we cannot tell
//   unbooked      - that day is empty, so it genuinely is not in the calendar
export function reconcileStatus(c, events = []) {
  if (!c.date) return 'needs_confirm';
  const sameDay = events.filter(e => e.date === c.date);
  if (!sameDay.length) return 'unbooked';

  const want = new Set(tokens(`${c.who} ${c.what}`));
  const whoDigits = digits(c.who);
  for (const e of sameDay) {
    const hay = `${e.text || ''} ${e.location || ''}`;
    if (whoDigits.length >= 9 && digits(hay).includes(whoDigits.slice(-9))) return 'booked';
    if (tokens(hay).some(w => want.has(w))) return 'booked';
  }
  return 'needs_confirm';
}

// The ledger is a projection of the threads, not an accumulator. Anything open
// that is no longer extracted has been talked away in the thread ("Another day
// it is!") and is superseded — so a cancelled job drops itself instead of
// becoming a phantom, and nothing is ever silently deleted.
export function projectCommitments(existingIds, extracted) {
  const live = new Set(extracted.map(c => c.id));
  return { upserts: extracted, supersede: existingIds.filter(id => !live.has(id)) };
}

export const WEEKDAY_NAMES = DAYS;
