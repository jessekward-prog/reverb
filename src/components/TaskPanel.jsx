import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { authHeaders } from '../api.js';
import { C, FS, FONT, SP } from '../lib/design.js';
import { KINDS } from '../lib/kinds.js';
import { calendarDayUrl, pickJobPhone, sendableChannel, telHref } from '../lib/actionMeta.js';
import ItemCard from './ItemCard.jsx';
import CalForm from './CalForm.jsx';
import ReplyBox from './ReplyBox.jsx';

// What you get when you open a row. The complaint this answers: a line saying
// a row reading "Reply to <name> · 4d" is not something you can act on — you had to
// leave the app, do it in Messages, come back and regenerate the list.
//
// So everything needed to finish the thing is here: the conversation behind it
// (loaded on open, not behind another press), the assistant's read on where it
// stands, and the actions that actually close it out — reply and send through
// the logged-in browser session, put it in the calendar, mark it handled. The
// list updates in place afterwards; nothing needs regenerating.

const READABLE = new Set(['sms', 'meta']);

// Local date, not toISOString: in AEDT a UTC date reads as yesterday until 11am,
// which would open the form on the wrong day every morning.
const ymdLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function TaskPanel({ t, auth, onClose, onDone, onOpenBrowser, onOpenChat }) {
  const [entry, setEntry]     = useState(null);
  const [composing, setCompose] = useState(false);
  const [busy, setBusy]       = useState(null);   // 'reading' | 'calling' | 'muting' | null
  const [note, setNote]       = useState('');
  const [cal, setCal]         = useState(null);
  const [detail, setDetail]   = useState(null);   // the expanded brief, on request
  const [calForm, setCalForm] = useState(null);   // the manual add, when there's nothing to read
  const [calUrl, setCalUrl]   = useState(null);

  const phone = pickJobPhone(t);
  const channel = sendableChannel(t.kind) || (phone ? 'sms' : null);
  const replyTo = sendableChannel(t.kind) ? t.from : (phone || t.from);
  const head = authHeaders(auth?.token);
  const jsonHead = { 'Content-Type': 'application/json', ...head };

  // The thread loads with the panel. Making it a second press was the whole
  // problem: you open a card to find out what this is, and it tells you again
  // that someone sent you a message.
  useEffect(() => {
    if (!READABLE.has(t.kind)) return;
    let live = true;
    setEntry({ loading: true, messages: [] });
    fetch(`/api/item/context?from=${encodeURIComponent(t.from)}`, { headers: head })
      .then(r => (r.ok ? r.json() : { messages: [] }))
      .then(d => live && setEntry({ loading: false, messages: d.messages || [] }))
      .catch(() => live && setEntry({ loading: false, messages: [] }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id]);

  function expand() {
    if (busy === 'reading') return;
    setBusy('reading'); setDetail({ loading: true });
    fetch('/api/item/detail', { method: 'POST', headers: jsonHead, body: JSON.stringify(t) })
      .then(r => r.json())
      .then(d => setDetail(d.detail ? { text: d.detail, grounded: d.grounded }
                                    : { error: d.error || 'the model had nothing to add' }))
      .catch(() => setDetail({ error: 'could not reach the model' }))
      .finally(() => setBusy(null));
  }

  // A date out of whatever the item already knows, so the form opens on
  // something sensible rather than an empty box.
  function seedForm(why, draft) {
    const iso = String(t.when || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || ymdLocal(new Date());
    const hhmm = String(t.when || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    setCalForm({
      seed: {
        date: iso,
        time: hhmm ? `${String(hhmm[1]).padStart(2, '0')}:${hhmm[2]}` : '09:00',
        durationMins: 60,
        title: String(t.text || '').slice(0, 120),
        location: t.address || '',
        ...(draft || {}),
      },
      why: why || '',
    });
  }

  // Reading the thread fills the form in; it never books anything. The model
  // can find the day and the time in a conversation, but how long the job will
  // take and what has to be brought are only in his head, and an event missing
  // those is what sends you back out on a second trip.
  function addToCal() {
    if (!READABLE.has(t.kind)) { seedForm('nothing to read here — fill it in'); return; }
    setCal('reading the thread');
    fetch('/api/item/tocal', { method: 'POST', headers: jsonHead,
      body: JSON.stringify({ from: t.from, text: t.text }) })
      .then(r => r.json())
      .then(d => {
        setCal(null);
        if (d.draft) seedForm('read out of the conversation — check it', d.draft);
        else seedForm(d.error || 'nothing concrete in the thread');
      })
      .catch(() => { setCal(null); seedForm('could not read the thread'); });
  }

  // The tab is opened here, inside the press, or the browser blocks it as a
  // popup - the fetch comes back too late to count as a user gesture. It is
  // a real tab rather than the bridge's shared calendar tab, which the message
  // scrapers keep pulling back to the front mid-booking.
  function submitCal(f) {
    if (!f?.date) return;
    setBusy('calling'); setCal('adding');
    const tab = window.open('', '_blank');
    fetch('/api/item/tocal', { method: 'POST', headers: jsonHead,
      body: JSON.stringify({ from: t.from, text: t.text, ...f,
                             parts: f.needsParts ? f.parts : '' }) })
      .then(r => r.json())
      .then(d => {
        if (d.error || !d.url) { try { tab?.close(); } catch {} setCal(d.error || 'no event came back'); return; }
        setCal('done'); setCalForm(null);
        if (tab) { tab.location.href = d.url; setCalUrl(null); } else setCalUrl(d.url);
      })
      .catch(() => { try { tab?.close(); } catch {} setCal('could not reach calendar'); })
      .finally(() => setBusy(null));
  }

  // Marking one promo done only clears that one promo - the next one has a
  // different id and comes straight back. This is the button that actually
  // stops them: the sender is muted, and anything mentioning an invoice,
  // receipt, payment or quote still gets through, so a shop's receipts
  // survive its marketing. Undo it in the People drawer.
  function mute() {
    setBusy('muting');
    fetch('/api/contacts/mute', { method: 'POST', headers: jsonHead,
      body: JSON.stringify({ kind: t.kind, from: t.from, name: t.displayName || t.from }) })
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setNote(d.error || 'could not mute them'); return; }
        setNote('muted — only invoices and receipts from them from now on');
        setTimeout(() => onDone?.(t, 'muted'), 700);
      })
      .catch(() => setNote('could not mute them'))
      .finally(() => setBusy(null));
  }

  const tel = telHref(phone);
  const actions = [
    t.href && { label: '🔗 open job →', strong: !channel, href: t.href },
    channel && { label: composing ? 'hide reply' : (t.kind === 'job' ? '✍ text client' : '✍ reply'), strong: !composing,
                 onPress: () => setCompose(c => !c) },
    t.kind === 'cal' && { label: '📅 open calendar →', strong: true, href: calendarDayUrl(t.when) },
    (t.kind === 'email' || t.kind === 'bizemail') && { label: '✉ open in gmail', strong: !channel, onPress: () => onOpenBrowser?.() },
    (t.kind === 'meta' || t.kind === 'instagram') && { label: `🌐 open in ${t.kind}`, strong: true, onPress: () => onOpenBrowser?.() },
    tel && { label: '📞 call', href: tel },
    { label: busy === 'reading' ? 'reading…' : (detail ? '🔍 re-read it' : '🔍 more detail'), onPress: expand },
    t.kind !== 'cal' && { label: '📅 add to calendar', onPress: addToCal },
    { label: '💬 ask about this', onPress: () => onOpenChat?.(t) },
    t.kind !== 'cal' && t.kind !== 'job' && { label: busy === 'muting' ? 'muting…' : '🔇 only invoices from them', onPress: mute },
    { label: '✓ done', onPress: () => onDone?.(t, 'done') },
    { label: 'close', onPress: () => onClose?.() },
  ].filter(Boolean);

  const k = KINDS[t.kind] || KINDS.email;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}
      style={{ margin: `${SP[2]}px 0 ${SP[3]}px` }}>
      <ItemCard t={t} tint={k.tint} expanded entry={entry} cal={cal} actions={actions}
                onToggle={() => onClose?.()} />

      {detail && (
        <div style={{ border: `1px solid ${C.border}`, borderTop: 0,
                      borderRadius: `0 0 ${C.radius}px ${C.radius}px`,
                      background: C.surface2, padding: SP[3],
                      display: 'flex', flexDirection: 'column', gap: SP[2] }}>
          <div style={{ display: 'flex', gap: SP[2], fontFamily: FONT.mono, fontSize: FS.label,
                        letterSpacing: '.08em', textTransform: 'uppercase', color: C.text3 }}>
            <span>the longer version</span>
            <span style={{ flex: 1 }} />
            {detail.grounded && <span>from the {detail.grounded}</span>}
          </div>
          <div style={{ fontFamily: FONT.sans, fontSize: FS.body, lineHeight: 1.6,
                        textWrap: 'pretty', whiteSpace: 'pre-wrap', textTransform: 'none',
                        letterSpacing: 'normal', color: detail.error ? C.danger : C.text1 }}>
            {detail.loading ? 'reading it all back…' : (detail.text || detail.error)}
          </div>
        </div>
      )}

      {calForm && (
        <CalForm seed={calForm.seed} why={calForm.why}
                 busy={busy === 'calling'}
                 error={typeof cal === 'string' && cal !== 'adding' && cal !== 'done' ? cal : null}
                 onCancel={() => { setCalForm(null); setCal(null); }}
                 onSubmit={submitCal} />
      )}

      {calUrl && (
        <div style={{ padding: `${SP[2]}px ${SP[3]}px`, fontFamily: FONT.sans, fontSize: FS.meta,
                      textTransform: 'none' }}>
          <a href={calUrl} target="_blank" rel="noreferrer" style={{ color: C.amber }}>
            open the pre-filled event in your calendar →
          </a>
        </div>
      )}

      {note && !composing && (
        <div style={{ padding: `${SP[2]}px ${SP[3]}px`, fontFamily: FONT.sans, fontSize: FS.meta,
                      textTransform: 'none', color: note.startsWith('muted') ? C.amber : C.danger }}>
          {note}
        </div>
      )}

      {composing && channel && (
        <div style={{ marginTop: 1 }}>
          <ReplyBox
            channel={channel}
            to={replyTo}
            name={t.from}
            kind={t.kind}
            text={t.text}
            snippet={t.snippet}
            brief={t.brief}
            auth={auth}
            onSent={() => onDone?.(t, 'replied')}
          />
        </div>
      )}
    </motion.div>
  );
}
