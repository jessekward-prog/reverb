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
