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
// sentence into an address.
const STREET = 'st|street|rd|road|ave|avenue|dr|drive|ct|court|cres|crescent|pde|parade|pl|place|way|lane|ln|tce|terrace|blvd|hwy|highway';
const ADDRESS_RE = new RegExp(
  `\\b\\d{1,5}[a-z]?(?:\\/\\d{1,5})?\\s+(?:[a-z][a-z'\\-]*\\s+){1,4}(?:${STREET})\\b` +
  // A suburb only counts after a comma: without that, "12 Sample Drive next
  // week" swallowed "next week" as the suburb.
  `(?:,\\s*[a-z][a-z'\\-]*(?:\\s+[a-z][a-z'\\-]*){0,2})?` +
  `(?:,?\\s+(?:vic|nsw|qld|sa|wa|tas|nt|act))?(?:,?\\s+\\d{4})?`, 'i');

export function extractAddress(text) {
  const m = String(text || '').match(ADDRESS_RE);
  if (!m) return null;
  const hit = m[0].replace(/\s+/g, ' ').trim().replace(/[.,;]$/, '');
  return hit.length >= 10 && hit.length <= 120 ? hit : null;
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
