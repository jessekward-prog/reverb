// Self-check for contacts.js's importance rules — run with: node scripts/contacts.test.js
import assert from 'assert';
import { normalizeIdentifier, deriveTier, hasMoneyFlag } from '../src/lib/contacts.js';

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

console.log('contacts.test.js: all assertions passed');
