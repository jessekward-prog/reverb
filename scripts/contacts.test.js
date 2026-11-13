// Self-check for contacts.js's importance rules — run with: node scripts/contacts.test.js
import assert from 'assert';
import { normalizeIdentifier, deriveTier, hasMoneyFlag, matchRules } from '../src/lib/contacts.js';

assert.strictEqual(normalizeIdentifier('email', 'Jaan Smith <jaan@example.com>'), 'jaan@example.com');
assert.strictEqual(normalizeIdentifier('email', 'jaan@example.com'), 'jaan@example.com');
assert.strictEqual(normalizeIdentifier('sms', '+61 400 111 222'), '+61400111222');
assert.strictEqual(normalizeIdentifier('whatsapp', 'Mum'), 'mum');

assert.strictEqual(deriveTier(null), 'normal');
assert.strictEqual(deriveTier({ tier: 'vip', seen_count: 0, replied_count: 0, dismissed_count: 0 }), 'vip');
assert.strictEqual(deriveTier({ tier: null, seen_count: 1, replied_count: 2, dismissed_count: 0 }), 'vip'); // 1 + 2*5 = 11 >= 8
assert.strictEqual(deriveTier({ tier: null, seen_count: 1, replied_count: 0, dismissed_count: 3 }), 'muted'); // 1 - 6 = -5 <= -4
assert.strictEqual(deriveTier({ tier: null, seen_count: 3, replied_count: 0, dismissed_count: 0 }), 'normal');

assert.ok(hasMoneyFlag('Your invoice #123 is now overdue'));
assert.ok(!hasMoneyFlag('Hey, want to grab lunch?'));

const rules = [{ pattern: 'KOGAN', action: 'ignore' }, { pattern: 'invoice', action: 'priority' }];
assert.strictEqual(matchRules('KOGAN: last chance to score', rules), 'ignore');
assert.strictEqual(matchRules('kogan lowercase still matches', rules), 'ignore');   // case-insensitive both ways
assert.strictEqual(matchRules('Your invoice is ready', rules), 'priority');
assert.strictEqual(matchRules('Hey, want to grab lunch?', rules), null);
assert.strictEqual(matchRules('', rules), null);
// ignore beats priority when both match the same item
assert.strictEqual(matchRules('KOGAN invoice', rules), 'ignore');
// a blank pattern must never match — it would ignore every item and silence the assistant
assert.strictEqual(matchRules('anything at all', [{ pattern: '', action: 'ignore' }]), null);
assert.strictEqual(matchRules('anything at all', [{ pattern: '   ', action: 'ignore' }]), null);
assert.strictEqual(matchRules('anything at all', []), null);

console.log('contacts.test.js: all assertions passed');

// ── address extraction ──────────────────────────────────────
// Feeds the calendar's location field and the saved contact address.
// Synthetic addresses only: this repo is public.
import { extractAddress, phoneLast9 } from '../src/lib/contacts.js';

assert.strictEqual(extractAddress('do the rest of the electrical at 12 Sample Drive next week'), '12 Sample Drive');
assert.strictEqual(extractAddress('address is 3/27 Example Street, Belmont VIC 3216'), '3/27 Example Street, Belmont VIC 3216');
assert.strictEqual(extractAddress('meet at 5 Short Rd, Lara'), '5 Short Rd, Lara');
// A loose pattern would turn any of these into an address.
assert.strictEqual(extractAddress('that will be 450 dollars all up'), null);
assert.strictEqual(extractAddress('ill be there at 9am on the 14th'), null);
assert.strictEqual(extractAddress('call me on 0400 111 222'), null);

// Matched on the last 9 digits, so any AU formatting resolves to one contact.
assert.strictEqual(phoneLast9('+61 400 111 222'), phoneLast9('0400 111 222'));
assert.strictEqual(phoneLast9('321'), null);

// ── callback / missed-call flagging ─────────────────────────
import { isCallSignal, hasUnrepliedCall } from '../src/lib/contacts.js';

assert.ok(isCallSignal('Buzz if can'));
assert.ok(isCallSignal('Buzz'));
assert.ok(isCallSignal('Give us a buzz when you get a chance'));
assert.ok(isCallSignal('Call plz'));
assert.ok(isCallSignal('61400111222 called. No Voicemail message was left. For more information on this feature, free call 147 from your mobile phone.'));
assert.ok(!isCallSignal('The buzzer on the gate is stuck'));
assert.ok(!isCallSignal('Yes Tuesday next week is good for us'));
assert.ok(!isCallSignal('Call it 450 all up'));

const callThread = [
  { text: '61400111222 called. No Voicemail message was left. For more information on this feature, free call 147 from your mobile phone.', outbound: false },
  { text: 'Call plz', outbound: false },
  { text: 'All good', outbound: true },
  { text: 'Buzz if can', outbound: false },
];
assert.ok(hasUnrepliedCall('Buzz if can', callThread));
assert.ok(!hasUnrepliedCall('Sounds good', [...callThread, { text: 'Called you back', outbound: true }]));
assert.ok(hasUnrepliedCall('Any luck?', [
  { text: '61400111222 called. No Voicemail message was left. For more information on this feature, free call 147 from your mobile phone.', outbound: false },
  { text: 'Any luck?', outbound: false },
]));
