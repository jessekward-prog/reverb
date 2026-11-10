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
// Longest-first so "thurs" wins over "thu" and never half-matches.
const DAY_WORDS = [
  ['sunday', 0], ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4], ['friday', 5], ['saturday', 6],
  ['thurs', 4], ['tues', 2], ['weds', 3], ['thur', 4], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6], ['sun', 0],
];

const VAGUE = /\b(next week|next month|week after|sometime|some time|later|soon|another day|in a few|tbc|tba|asap)\b/;

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// A Postgres DATE comes back as a JS Date at LOCAL midnight, so toISOString()
// shifts it a day backwards anywhere east of UTC — verified against a real
// Postgres: 2026-11-05 read back as "2026-11-04" in AEDT (UTC+11). Every date
// in the ledger would have displayed a day early. Format from the local parts.
export const ymd = d => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d || '').slice(0, 10));

// Resolve the day (and only an explicit clock time) from the short verbatim
// span the model copied out of the thread. Returns date null when unsure.
export function resolveWhen(whenText, ref = new Date()) {
  const raw = norm(whenText);
  if (!raw) return { date: null, time: null, reason: 'empty' };

  // Pull an explicit clock time first, and strip it, so its digits can't be
  // mistaken for a day of the month below ("9am" must not look like the 9th).
  let time = null;
  const t = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (t) {
    let h = Number(t[1]) % 12;
    if (t[3] === 'pm') h += 12;
    time = `${String(h).padStart(2, '0')}:${t[2] || '00'}`;
  }
  const noTime = raw.replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/g, ' ');

  // Vague windows are a real answer: we know there is a commitment, not when.
  if (VAGUE.test(noTime)) return { date: null, time, reason: 'vague' };

  // A named day beats a relative word: "tomorrow is out, but Wednesday should
  // be good" agrees to Wednesday.
  let date = null;
  const hit = DAY_WORDS.find(([w]) => new RegExp(`\\b${w}\\b`).test(noTime));
  if (hit) {
    const [, target] = hit;
    let offset = (target - ref.getDay() + 7) % 7;       // 0 = today
    if (/\bnext\b/.test(noTime) && offset === 0) offset = 7;
    date = iso(addDays(ref, offset));
  } else if (/\b(today|tonight|this arvo|this afternoon|this morning)\b/.test(noTime)) {
    date = iso(ref);
  } else if (/\btomorrow\b/.test(noTime)) {
    date = iso(addDays(ref, 1));
  }
  if (!date) return { date: null, time, reason: 'unrecognised' };

  // Disagreement guard. If the span also names a day of the month and it does
  // not match what the weekday resolved to, the two readings conflict — most
  // often a PAST reference like "Monday 2nd". Refuse rather than pick one.
  const dom = noTime.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (dom) {
    const n = Number(dom[1]);
    if (n >= 1 && n <= 31 && n !== Number(date.slice(8, 10))) {
      return { date: null, time, reason: 'day-of-month conflict' };
    }
  }
  return { date, time, reason: 'ok' };
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
      const r = resolveWhen(f, sent);
      if (r.date || r.reason === 'vague' || r.reason === 'day-of-month conflict') {
        whenText = f === quote ? '' : f; when = r; break;
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
