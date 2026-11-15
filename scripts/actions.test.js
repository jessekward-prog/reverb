// Self-check for actionMeta helpers used by ActionBand, TaskPanel, and nextActions.
// Run with: node scripts/actions.test.js
import assert from 'assert';
import {
  sendableChannel,
  looksLikePhone,
  telHref,
  jobUrl,
  calendarDayUrl,
  pickJobPhone,
  enrichReplyOwed,
} from '../src/lib/actionMeta.js';

assert.strictEqual(sendableChannel('sms'), 'sms');
assert.strictEqual(sendableChannel('whatsapp'), 'whatsapp');
assert.strictEqual(sendableChannel('messenger'), 'messenger');
assert.strictEqual(sendableChannel('meta'), null);
assert.strictEqual(sendableChannel('email'), null);
assert.strictEqual(sendableChannel('job'), null);
assert.strictEqual(sendableChannel('cal'), null);

assert.strictEqual(looksLikePhone('0408 463 948'), true);
assert.strictEqual(looksLikePhone('+61 408 463 948'), true);
assert.strictEqual(looksLikePhone('Allan Heyne'), false);
assert.strictEqual(telHref('0408 463 948'), 'tel:0408463948');
assert.strictEqual(telHref('+61 408 463 948'), 'tel:+61408463948');
assert.strictEqual(telHref('Allan Heyne'), null);

assert.strictEqual(jobUrl('https://switch.example.com/', 123), 'https://switch.example.com/admin/jobs/123');
assert.strictEqual(jobUrl('', 123), null);
assert.strictEqual(jobUrl('https://switch.example.com', null), null);

assert.strictEqual(calendarDayUrl('2026-11-18 09:00'), 'https://calendar.google.com/calendar/u/0/r/day/2026/11/18');
assert.strictEqual(calendarDayUrl('no date'), 'https://calendar.google.com/calendar/u/0/r');

assert.strictEqual(pickJobPhone({ kind: 'job', from: 'Jane Doe', phone: '0411 222 333' }), '0411 222 333');
assert.strictEqual(pickJobPhone({ kind: 'sms', from: '0408 463 948' }), '0408 463 948');
assert.strictEqual(pickJobPhone({ kind: 'job', from: 'Jane Doe' }), null);

// Screenshot case: unsaved SMS client with an address inside their text
const smsOwed = enrichReplyOwed({
  w: { identifier: '0408 463 948', kind: 'sms' },
  who: '0408 463 948',
  displayWho: '0408 463 948',
  title: '0408 463 948',
  asked: 'Hello, you have done some work for us previously at 16 Helen Street East Geelong. We are wanting to get a couple more small jobs done',
  today: '2026-11-15',
  known: null,
  job: null,
  extractedAddress: '16 Helen Street East Geelong',
});
assert.deepStrictEqual(smsOwed.reply, {
  channel: 'sms',
  to: '0408 463 948',
  name: '0408 463 948',
  kind: 'sms',
  text: 'Reply to 0408 463 948',
  snippet: 'Hello, you have done some work for us previously at 16 Helen Street East Geelong. We are wanting to get a couple more small jobs done',
});
assert.strictEqual(smsOwed.phone, '0408 463 948');
assert.strictEqual(smsOwed.person.phone, null); // don't duplicate the title visually
assert.strictEqual(smsOwed.person.address, '16 Helen Street East Geelong');
assert.strictEqual(smsOwed.book.location, '16 Helen Street East Geelong');
assert.strictEqual(smsOwed.book.from, '0408 463 948');
assert.strictEqual(smsOwed.cta, 'reply on sms');
assert.strictEqual(smsOwed.browserSource, 'sms');
assert.strictEqual(smsOwed.chat.from, '0408 463 948');

// Resolved known contact on SMS preserves both name and raw identifier
const knownOwed = enrichReplyOwed({
  w: { identifier: '0408 463 948', kind: 'sms' },
  who: '0408 463 948',
  displayWho: 'Helen Client',
  title: 'Helen Client',
  asked: 'Can you come Tuesday?',
  today: '2026-11-15',
  known: { display_name: 'Helen Client', address: '16 Helen Street East Geelong' },
  job: null,
  extractedAddress: null,
});
assert.strictEqual(knownOwed.person.phone, '0408 463 948');
assert.strictEqual(knownOwed.person.via, '0408 463 948');
assert.strictEqual(knownOwed.reply.to, '0408 463 948');

// Meta message falls back to browser inbox CTA while still keeping book + chat
const metaOwed = enrichReplyOwed({
  w: { identifier: 'Local Cafe', kind: 'meta' },
  who: 'Local Cafe',
  displayWho: 'Local Cafe',
  title: 'Local Cafe',
  asked: 'Looking for a quote on exit lights',
  today: '2026-11-15',
  known: null,
  job: null,
  extractedAddress: null,
});
assert.strictEqual(metaOwed.reply, null);
assert.strictEqual(metaOwed.cta, 'open meta inbox');
assert.strictEqual(metaOwed.browserSource, 'meta');
assert.ok(metaOwed.book);
assert.ok(metaOwed.chat);

console.log('actions metadata checks: ok');
