// Pure action-metadata helpers shared across server nextActions, TaskPanel, and ActionBand
// so every band card and to-do item carries concrete reply/call/book/open targets.

export const SENDABLE_CHANNELS = new Set(['sms', 'whatsapp', 'messenger']);

export function sendableChannel(kind) {
  return SENDABLE_CHANNELS.has(kind) ? kind : null;
}

export function looksLikePhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.length >= 8;
}

export function telHref(v) {
  if (!looksLikePhone(v)) return null;
  const clean = String(v || '').replace(/[^\d+]/g, '');
  return clean ? `tel:${clean}` : null;
}

export function jobUrl(baseUrl, jobId) {
  if (!baseUrl || !jobId) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}/admin/jobs/${jobId}`;
}

export function calendarDayUrl(when) {
  const iso = String(when || '').match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!iso) return 'https://calendar.google.com/calendar/u/0/r';
  const [y, m, d] = iso.split('-');
  return `https://calendar.google.com/calendar/u/0/r/day/${Number(y)}/${Number(m)}/${Number(d)}`;
}

export function pickJobPhone(t) {
  if (looksLikePhone(t?.phone)) return t.phone;
  if (looksLikePhone(t?.from)) return t.from;
  return null;
}

export function enrichReplyOwed({ w, who, displayWho, title, asked, today, known, job, extractedAddress }) {
  const phone = looksLikePhone(w.identifier)
    ? w.identifier
    : (looksLikePhone(job?.phone) ? job.phone : null);
  const place = known?.address || job?.address || extractedAddress || null;
  const sendChannel = sendableChannel(w.kind);

  return {
    title: title || displayWho || who,
    person: {
      name: displayWho || who,
      phone: phone && phone !== (displayWho || who) ? phone : null,
      address: place,
      via: w.identifier && w.identifier !== (displayWho || who) ? w.identifier : null,
    },
    phone,
    reply: sendChannel ? {
      channel: sendChannel,
      to: w.identifier,
      name: displayWho || who,
      kind: w.kind,
      text: `Reply to ${displayWho || who}`,
      snippet: asked || '',
    } : null,
    book: {
      title: `${displayWho || who}${place ? ` — ${place}` : ''}`.slice(0, 180),
      date: today,
      time: '09:00',
      location: place || '',
      kind: w.kind,
      from: w.identifier,
    },
    chat: {
      kind: w.kind,
      from: w.identifier,
      snippet: asked || '',
    },
    browserSource: w.kind,
    cta: sendChannel ? `reply on ${sendChannel}` : (w.kind === 'meta' ? 'open meta inbox' : null),
  };
}
