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
import { extractAddress, extractContactIntro, phoneLast9 } from '../src/lib/contacts.js';

assert.strictEqual(extractAddress('do the rest of the electrical at 12 Sample Drive next week'), '12 Sample Drive');
assert.strictEqual(extractAddress('address is 3/27 Example Street, Belmont VIC 3216'), '3/27 Example Street, Belmont VIC 3216');
assert.strictEqual(extractAddress('meet at 5 Short Rd, Lara'), '5 Short Rd, Lara');
assert.strictEqual(extractAddress('Hello, previous work at 16 Example Street East Geelong. Small job'), '16 Example Street East Geelong');
assert.strictEqual(extractAddress("Hi it's \nJane Smith\n6 Example Drive \nWaurn Ponds \n0400111222"), '6 Example Drive Waurn Ponds');
// A loose pattern would turn any of these into an address.
assert.strictEqual(extractAddress('that will be 450 dollars all up'), null);
assert.strictEqual(extractAddress('ill be there at 9am on the 14th'), null);
assert.strictEqual(extractAddress('call me on 0400 111 222'), null);

assert.deepStrictEqual(
  extractContactIntro("Hi it's \nJane Smith\n6 Example Drive \nWaurn Ponds \n0400111222\njane.smith@example.com\n👍"),
  {
    name: 'Jane Smith',
    address: '6 Example Drive Waurn Ponds',
    email: 'jane.smith@example.com',
    phone: '0400111222',
    isDetailsDrop: true,
  }
);
assert.deepStrictEqual(
  extractContactIntro('Hey its Sam Taylor from 14 High Street Belmont'),
  {
    name: 'Sam Taylor',
    address: '14 High Street Belmont',
    email: null,
    phone: null,
    isDetailsDrop: true,
  }
);
assert.strictEqual(extractContactIntro('Yes it is fine thanks').isDetailsDrop, false);

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

// ── progressive dossier & archive helpers ───────────────────
import {
  extractQuoteAmount,
  canonicalPersonKey,
  cleanDossierValue,
  mergeDossierFields,
  parseDossierResponse,
  formatDossierBlock,
} from '../src/lib/contacts.js';

assert.strictEqual(extractQuoteAmount("you'll be looking at $300 plus gst :)"), '$300 plus gst');
assert.strictEqual(extractQuoteAmount('Roughly $1,250.50 inc gst for the board'), '$1,250.50 inc gst');
assert.strictEqual(extractQuoteAmount('That comes to 450 dollars all up'), '450 dollars all up');
assert.strictEqual(extractQuoteAmount('Can you check on Thursday?'), null);

const dir = {
  byPhone: { '403253735': 'phone:403253735' },
  byName: { 'judith robinson': 'phone:403253735' },
  byEmail: { 'judith@example.com': 'phone:403253735' },
};
assert.strictEqual(canonicalPersonKey({ kind: 'sms', from: '+61 403 253 735' }, dir), 'phone:403253735');
assert.strictEqual(canonicalPersonKey({ kind: 'job', from: 'Judith Robinson', phone: '0403 253 735' }, dir), 'phone:403253735');
assert.strictEqual(canonicalPersonKey({ kind: 'email', from: 'Judith Robinson <judith@example.com>' }, dir), 'phone:403253735');
assert.strictEqual(canonicalPersonKey({ kind: 'whatsapp', from: 'Judith Robinson' }, dir), 'phone:403253735');
assert.strictEqual(canonicalPersonKey({ kind: 'email', from: 'Pat <pat@example.org>' }, dir), 'email:pat@example.org');
assert.strictEqual(canonicalPersonKey({ kind: 'whatsapp', from: 'Unknown Tradie' }, dir), 'name:unknown tradie');

assert.strictEqual(cleanDossierValue('NONE'), null);
assert.strictEqual(cleanDossierValue('Not mentioned'), null);
assert.strictEqual(cleanDossierValue('  Replace 2 ceiling fans  '), 'Replace 2 ceiling fans');

// Existing Switch Craft address and prior extracted fields survive follow-up updates with NONE/model guesses
const baseDossier = {
  person_key: 'phone:403253735',
  display_name: 'Judith Robinson',
  phone: '0403 253 735',
  address: '9 Pinecrest Drive, Highton VIC',
  address_source: 'switch-craft',
  channels: ['job'],
  job_ids: [32],
  work_scope: 'Replace 2 lights with customer-supplied ceiling fans',
  quote_estimate: '$300 plus gst',
  parts_materials: 'Customer supplies 2 ceiling fans',
};
const merged = mergeDossierFields(baseDossier, {
  display_name: '0403253735',
  address: '99 Other St',
  address_source: 'model',
  channels: ['sms'],
  job_ids: [35],
  work_scope: 'NONE',
  quote_estimate: '',
  parts_materials: 'unclear',
  preferred_times: 'Friday mornings',
  current_stage: 'Awaiting client day confirmation',
});
assert.strictEqual(merged.display_name, 'Judith Robinson');
assert.strictEqual(merged.address, '9 Pinecrest Drive, Highton VIC');
assert.strictEqual(merged.address_source, 'switch-craft');
assert.deepStrictEqual(merged.channels, ['job', 'sms']);
assert.deepStrictEqual(merged.job_ids, [32, 35]);
assert.strictEqual(merged.work_scope, 'Replace 2 lights with customer-supplied ceiling fans');
assert.strictEqual(merged.quote_estimate, '$300 plus gst');
assert.strictEqual(merged.parts_materials, 'Customer supplies 2 ceiling fans');
assert.strictEqual(merged.preferred_times, 'Friday mornings');

// Prefer real lettered name when existing display_name was only digits
const named = mergeDossierFields({ person_key: 'phone:400111222', display_name: '0400 111 222' }, { display_name: 'Mark Brown' });
assert.strictEqual(named.display_name, 'Mark Brown');

const parsed = parseDossierResponse(`
- NAME :: Mark Brown
- ADDRESS :: 14 Sample Rd, Lara VIC
- SCOPE :: Upgrade switchboard and test RCDs
- QUOTE :: $850 plus gst
- PARTS :: NONE
- TIMES :: After 3pm weekdays
- ACCESS :: Key in letterbox
- STAGE :: quoted
- NEXT :: Follow up Thursday
- SUMMARY :: Recurring rental client needing switchboard upgrade.
`, { person_key: 'phone:400111222', parts_materials: '6-pole RCBOs' });
assert.strictEqual(parsed.address, '14 Sample Rd, Lara VIC');
assert.strictEqual(parsed.address_source, 'model');
assert.strictEqual(parsed.parts_materials, '6-pole RCBOs');
assert.strictEqual(parsed.access_notes, 'Key in letterbox');
assert.strictEqual(parsed.open_next_step, 'Follow up Thursday');

const block = formatDossierBlock(parsed);
assert.ok(block.includes('Name: Mark Brown') && block.includes('Quote: $850 plus gst') && block.includes('Parts: 6-pole RCBOs'));
assert.strictEqual(formatDossierBlock({}), '');
console.log('dossier helpers: all assertions passed');

// ── Tier 1 address key, suburb, trade signals, stage & gating ──
import {
  normalizeAddressKey,
  extractSuburb,
  extractTradeSignals,
  deriveDeterministicStage,
} from '../src/lib/contacts.js';

assert.strictEqual(normalizeAddressKey('16 Sample St, East Geelong VIC 3219'), '16 sample street');
assert.strictEqual(normalizeAddressKey('6 burgundy dr Waurn Ponds'), '6 burgundy drive');
assert.strictEqual(normalizeAddressKey('just in Highton'), null);

const addrDir = {
  byPhone: { '400111222': 'phone:400111222' },
  byAddress: { '6 sample drive': 'phone:400111222' },
};
assert.strictEqual(
  canonicalPersonKey({ kind: 'email', from: 'Jane Smith', address: '6 Sample Dr Waurn Ponds' }, addrDir),
  'phone:400111222'
);

assert.strictEqual(extractSuburb('Job is in East Geelong next week'), 'East Geelong');
assert.strictEqual(extractSuburb('Over in Waurn Ponds near the shops'), 'Waurn Ponds');
assert.strictEqual(extractSuburb('No location mentioned'), null);

const sig = extractTradeSignals('Customer supplied 2 ceiling fans and a switchboard upgrade https://switchcraft.cmdward.xyz/jobs/32 for $300 plus gst in Highton');
assert.deepStrictEqual(sig.jobIds, [32]);
assert.strictEqual(sig.quote, '$300 plus gst');
assert.strictEqual(sig.suburb, 'Highton');
assert.ok(sig.parts.some(p => /customer supplied/i.test(p)));
assert.ok(sig.parts.some(p => /2 ceiling fans/i.test(p)));
assert.ok(sig.parts.some(p => /switchboard/i.test(p)));
assert.strictEqual(sig.invoicedOrPaid, false);

// Deterministic stage machine priority checks
assert.strictEqual(
  deriveDeterministicStage({
    today: '2026-11-16',
    events: [{ date: '2026-11-20', time: '09:00', text: 'Ceiling fans' }],
    commitments: [{ status: 'unbooked', when_date: '2026-11-18' }],
  }).stage,
  'Booked (2026-11-20 09:00)'
);
assert.strictEqual(
  deriveDeterministicStage({
    today: '2026-11-16',
    events: [{ date: '2026-11-12', time: '10:00', text: 'Powerpoints' }],
    messages: [{ outbound: true, text: 'All done today, thanks', at: '2026-11-12T12:00' }],
  }).stage,
  'Completed (2026-11-12) · check invoicing'
);
assert.strictEqual(
  deriveDeterministicStage({
    today: '2026-11-16',
    commitments: [{ status: 'unbooked', when_date: '2026-11-19' }],
  }).stage,
  'Agreed · needs calendar booking (2026-11-19)'
);
assert.strictEqual(
  deriveDeterministicStage({
    today: '2026-11-16',
    messages: [
      { outbound: false, text: 'Can you quote 2 fans?' },
      { outbound: true, text: "You'll be looking at $300 plus gst :)" },
    ],
  }).stage,
  'Quoted · awaiting client reply'
);
assert.strictEqual(
  deriveDeterministicStage({
    today: '2026-11-16',
    messages: [
      { outbound: false, text: "Hi it's Jane Smith\n6 Sample Drive Waurn Ponds\n0400111222" },
    ],
  }).stage,
  'New client sent contact details'
);

// Grounding gate rejects hallucinated name/quote/address and falls back to corpus facts
const gated = parseDossierResponse(`
EVIDENCE :: Hi it's Jane Smith at 6 Sample Drive Waurn Ponds, $300 plus gst
NAME :: Invented Person
ADDRESS :: 99 Hallucinated Road, Fakeville
QUOTE :: $999
SCOPE :: Replace 2 ceiling fans
`, { person_key: 'phone:400111222' }, "them: Hi it's Jane Smith at 6 Sample Drive Waurn Ponds\nme: Looking at $300 plus gst");
assert.strictEqual(gated.display_name, null);
assert.strictEqual(gated.address, '6 Sample Drive Waurn Ponds');
assert.strictEqual(gated.quote_estimate, '$300 plus gst');
assert.strictEqual(gated.work_scope, 'Replace 2 ceiling fans');

// Street address is not overwritten by a bare suburb
const keptStreet = mergeDossierFields(
  { person_key: 'phone:400111222', address: '6 Sample Drive Waurn Ponds', address_source: 'chat' },
  { address: 'Waurn Ponds', address_source: 'chat' }
);
assert.strictEqual(keptStreet.address, '6 Sample Drive Waurn Ponds');

// Reject self names and bare "Geelong"
assert.strictEqual(extractSuburb('Licensed electrician in Geelong'), null);
assert.strictEqual(extractSuburb('Work in East Geelong next week'), 'East Geelong');
const noSelf = parseDossierResponse(`
NAME :: Jesse
SCOPE :: Order confirmation
`, { person_key: 'email:orders@example.com' }, 'Hi Jesse, your order shipped');
assert.strictEqual(noSelf.display_name, null);

console.log('tier1 & gating: all assertions passed');
