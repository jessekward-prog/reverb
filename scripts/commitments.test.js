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
