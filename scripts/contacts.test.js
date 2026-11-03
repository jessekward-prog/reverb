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
