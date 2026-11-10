// Self-check for the commitments ledger — run with: node scripts/commitments.test.js
// Phrasing here is taken from real threads, including the lines that must NOT
// resolve to a date (an address, a greeting, a past reference).
import assert from 'assert';
import {
  resolveWhen, commitmentId, groundedInThread, parseExtraction,
  reconcileStatus, projectCommitments,
} from '../src/lib/commitments.js';

// Thursday 5 Nov 2026, local.
const REF = new Date(2026, 10, 5, 9, 0, 0);

// ── resolveWhen: the cases that must work ───────────────────
assert.strictEqual(resolveWhen('Thursday', REF).date, '2026-11-05');
assert.strictEqual(resolveWhen('thurs', REF).date, '2026-11-05');
assert.strictEqual(resolveWhen('Friday', REF).date, '2026-11-06');
assert.strictEqual(resolveWhen('today', REF).date, '2026-11-05');
assert.strictEqual(resolveWhen('tomorrow', REF).date, '2026-11-06');
assert.strictEqual(resolveWhen('next thursday', REF).date, '2026-11-12'); // today is Thu -> following week

const withTime = resolveWhen('Thursday at 9am', REF);
assert.strictEqual(withTime.date, '2026-11-05');
assert.strictEqual(withTime.time, '09:00');
assert.strictEqual(resolveWhen('friday 2:30pm', REF).time, '14:30');

// ── resolveWhen: the false positives that must stay unresolved ──
// A street number is not a time ("the rest of the electrical at 12 Sample Drive").
assert.strictEqual(resolveWhen('at 12 Sample Drive', REF).date, null);
assert.strictEqual(resolveWhen('at 12 Sample Drive', REF).time, null);
// A greeting is not a time.
assert.strictEqual(resolveWhen('Good morning', REF).date, null);
// Informal timing has no day in it — must not invent one.
assert.strictEqual(resolveWhen('around lunch', REF).date, null);
// A time with no day is not bookable on its own.
assert.strictEqual(resolveWhen('9am if that suits', REF).date, null);
assert.strictEqual(resolveWhen('9am if that suits', REF).time, '09:00');
// Vague windows are known-unknown, not a guess.
assert.strictEqual(resolveWhen('next week', REF).reason, 'vague');
assert.strictEqual(resolveWhen('another day', REF).reason, 'vague');
// "Monday 2nd" is a PAST reference; weekday says the 9th, so the two conflict.
assert.strictEqual(resolveWhen('Monday 2nd', REF).date, null);
assert.strictEqual(resolveWhen('Monday 2nd', REF).reason, 'day-of-month conflict');

// ── grounding guard ─────────────────────────────────────────
const thread = {
  name: '0400 111 222',
  messages: [
    { outbound: false, text: "The parts turned up, give me a call when you get a chance and we can lock in a date." },
    { outbound: true,  text: 'Busy start to the week sorry! Can we book this in for Thursday?' },
    { outbound: false, text: 'No worries, Thursday works 👌' },
    { outbound: true,  text: "I'll be aiming for around lunch if that suits." },
  ],
};
assert.ok(groundedInThread(thread, 'Can we book this in for Thursday?', 'Thursday'));
assert.ok(!groundedInThread(thread, 'See you at 8am on the 14th', 'the 14th')); // invented
assert.ok(!groundedInThread(thread, 'short', 'Thursday'));                      // too short to trust

assert.strictEqual(commitmentId('0400 111 222', 'Can we book this in for Thursday?'),
                   commitmentId('0400 111 222', 'can we  book this in for thursday? '));

// ── parseExtraction ─────────────────────────────────────────
const raw = [
  '0400 111 222 :: ceiling fan installation :: Thursday :: Can we book this in for Thursday?',
  'Nobody :: made up job :: Friday :: This line is not in any thread at all',   // ungrounded -> dropped
  '0400 111 222 :: fan install again :: Thursday :: Can we book this in for Thursday?', // dupe id -> dropped
  'not a commitment line without separators',
].join('\n');
const parsed = parseExtraction(raw, [thread], REF);
assert.strictEqual(parsed.length, 1);

// The model copies the heading back with its dashes, because that's how it's
// shown to it ("— 0400 111 222 —"). Seen live against gemma-4-12b-qat.
const dashed = parseExtraction(
  '— 0400 111 222 — :: ceiling fans :: Thursday :: No worries, Thursday works 👌', [thread], REF);
assert.strictEqual(dashed.length, 1);
assert.strictEqual(dashed[0].who, '0400 111 222');
assert.strictEqual(dashed[0].date, '2026-11-05');
assert.strictEqual(parsed[0].date, '2026-11-05');
assert.strictEqual(parsed[0].who, '0400 111 222');
assert.strictEqual(parsed[0].vague, false);

// ── reconcileStatus: calendar is truth ──────────────────────
const c = { who: '0400 111 222', what: 'ceiling fan installation', date: '2026-11-05' };
assert.strictEqual(reconcileStatus(c, []), 'unbooked');
assert.strictEqual(reconcileStatus({ ...c, date: null }, []), 'needs_confirm');
// An unrelated event that day: something is on, we cannot claim it is this job.
assert.strictEqual(reconcileStatus(c, [{ date: '2026-11-05', text: 'Dentist' }]), 'needs_confirm');
// Matched by a shared word...
assert.strictEqual(reconcileStatus(c, [{ date: '2026-11-05', text: 'Ceiling fans - Jo' }]), 'booked');
// ...or by the contact's number appearing in the event.
assert.strictEqual(reconcileStatus(c, [{ date: '2026-11-05', text: 'Install', location: 'call 0400 111 222' }]), 'booked');
// A booking on a different day does not count.
assert.strictEqual(reconcileStatus(c, [{ date: '2026-11-06', text: 'Ceiling fans' }]), 'unbooked');

// ── projection: cancelled work supersedes itself ────────────
const proj = projectCommitments(['keep-me', 'talked-away'], [{ id: 'keep-me' }, { id: 'brand-new' }]);
assert.deepStrictEqual(proj.supersede, ['talked-away']);
assert.strictEqual(proj.upserts.length, 2);

console.log('commitments.test.js: all assertions passed');

// ── ymd: a pg DATE is a Date at LOCAL midnight ──────────────
// toISOString() would shift it back a day east of UTC. Verified against a real
// Postgres: 2026-11-05 came back as "2026-11-04" in AEDT.
import { ymd } from '../src/lib/commitments.js';
assert.strictEqual(ymd(new Date(2026, 10, 5, 0, 0, 0)), '2026-11-05');
assert.strictEqual(ymd(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01');
assert.strictEqual(ymd(null), '');

// The model sometimes puts the speaker label in WHO instead of the heading
// ("me :: fix the lights :: next week :: <quote>"), which made every row
// unmatchable. The quote is verbatim, so it identifies the thread on its own.
const speakerLabelled = parseExtraction(
  'me :: ceiling fans :: Thursday :: Can we book this in for Thursday?', [thread], REF);
assert.strictEqual(speakerLabelled.length, 1);
assert.strictEqual(speakerLabelled[0].who, '0400 111 222');
assert.strictEqual(speakerLabelled[0].date, '2026-11-05');

// ── field order is not stable between runs ──────────────────
// The same prompt has produced all of these. Fields are identified by what
// they are (quote = verbatim in a thread, timing = resolves to a date), not
// by position, so every shape has to land on the same commitment.
const shapes = [
  '0400 111 222 :: ceiling fans :: Thursday :: Can we book this in for Thursday?',
  'me :: ceiling fans :: Thursday :: Can we book this in for Thursday?',
  'me: Can we book this in for Thursday? :: ceiling fans :: Thursday',
  '0. 0400 111 222 :: ceiling fans :: Thursday :: Can we book this in for Thursday?',
];
for (const line of shapes) {
  const got = parseExtraction(line, [thread], REF);
  assert.strictEqual(got.length, 1, `shape failed to parse: ${line}`);
  assert.strictEqual(got[0].date, '2026-11-05');
  assert.strictEqual(got[0].who, '0400 111 222');
  assert.strictEqual(got[0].what, 'ceiling fans', `WHO leaked into what: ${line}`);
}
// Still refuses a quote that appears in no thread, whatever the order.
assert.strictEqual(parseExtraction('me :: made up :: Friday :: not in any thread', [thread], REF).length, 0);

// ── dated messages: last week's "Thursday" is not this week's ──
// Real failure, 2026-11-11: an old "Thursday works" was re-read as the coming
// Thursday, while the actual new booking ("tomorrow is out, but Wednesday")
// never surfaced. Wednesday 11 Nov, morning.
const WED = new Date(2026, 10, 11, 7, 40);
const fans = {
  name: '0400 333 444',
  messages: [
    { outbound: true,  at: '2026-11-03T09:10', text: 'Busy start to the week sorry! Lets book this in for Thursday?' },
    { outbound: false, at: '2026-11-03T09:30', text: 'All good! Thursday works 👌' },
    { outbound: true,  at: '2026-11-05T11:56', text: 'Heading out to you shortly' },
    { outbound: false, at: '2026-11-09T10:17', text: "Let me know what day you're thinking for the install so I can clear the rooms." },
    { outbound: true,  at: '2026-11-09T16:39', text: 'No worries, tomorrow is out, but I think Wednesday should be good to go! Maybe 9am if that suits.' },
    { outbound: false, at: '2026-11-09T16:43', text: 'Hi, Yep Wednesday is good.' },
  ],
};
// A different thread that happens to contain the word "installation".
const other = {
  name: 'Sample Outdoor Co',
  messages: [{ outbound: false, at: '2026-11-09T08:00', text: 'Roof installation is done, thanks for the fan bracket.' }],
};
const both = [other, fans];

assert.strictEqual(resolveWhen('tomorrow is out, but I think Wednesday', new Date(2026, 10, 9, 16, 39)).date, '2026-11-11');

const wed = parseExtraction('0400 333 444 :: installation :: Wednesday :: Hi, Yep Wednesday is good.', both, WED);
assert.strictEqual(wed.length, 1);
assert.strictEqual(wed[0].who, '0400 333 444', 'a short WHAT must not pull the job into another thread');
assert.strictEqual(wed[0].date, '2026-11-11', 'Wednesday as said on Monday 9th');
assert.strictEqual(wed[0].what, 'installation');

// The model copied the date stamp it was shown; still grounded.
assert.strictEqual(parseExtraction('0400 333 444 :: fans :: Wednesday :: [Mon 9 Nov] them: Hi, Yep Wednesday is good.', both, WED)[0]?.date, '2026-11-11');

// Last week's Thursday is in the past, not tomorrow - dropped.
assert.strictEqual(parseExtraction('0400 333 444 :: fans :: Thursday :: All good! Thursday works 👌', both, WED).length, 0);

// No WHEN field: the day comes from the quote itself.
const fromQuote = parseExtraction('0400 333 444 :: install ::  :: No worries, tomorrow is out, but I think Wednesday should be good to go! Maybe 9am if that suits.', both, WED);
assert.strictEqual(fromQuote[0]?.date, '2026-11-11');
assert.strictEqual(fromQuote[0]?.time, '09:00');

console.log('commitments.test.js: dated-message assertions passed');

// Day from WHEN, time from the quote.
const split = parseExtraction('0400 333 444 :: install :: Hi, Yep Wednesday is good. :: No worries, tomorrow is out, but I think Wednesday should be good to go! Maybe 9am if that suits.', both, WED);
assert.strictEqual(split[0]?.date, '2026-11-11');
assert.strictEqual(split[0]?.time, '09:00');
console.log('commitments.test.js: time-from-quote passed');
