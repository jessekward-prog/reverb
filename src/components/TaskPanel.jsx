import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { authHeaders } from '../api.js';
import { C, FS, FONT, SP } from '../lib/design.js';
import { KINDS } from '../lib/kinds.js';
import ItemCard from './ItemCard.jsx';

// What you get when you open a row. The complaint this answers: a line saying
// "Reply to Daniel Smith · 4d" is not something you can act on — you had to
// leave the app, do it in Messages, come back and regenerate the list.
//
// So everything needed to finish the thing is here: the conversation behind it
// (loaded on open, not behind another press), the assistant's read on where it
// stands, and the actions that actually close it out — reply and send through
// the logged-in browser session, put it in the calendar, mark it handled. The
// list updates in place afterwards; nothing needs regenerating.

// Which channels we can type into. Email isn't one of them — Gmail's composer
// is a different animal, so those items send you to the live tab instead of
// pretending there's a reply box.
const SENDABLE = { sms: 'sms', whatsapp: 'whatsapp', messenger: 'messenger' };
const READABLE = new Set(['sms', 'meta']);

// Local date, not toISOString: in AEDT a UTC date reads as yesterday until 11am,
// which would open the form on the wrong day every morning.
const ymdLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// textTransform: none is load-bearing, not decoration - this panel also renders
// inside the report tabs, whose root sets uppercase for the terminal chrome,
// and text-transform is inherited. Without it you type a client's address and
// the field shouts it back at you.
const field = {
  background: C.bg, color: C.text1, border: `1px solid ${C.border}`, borderRadius: 6,
  padding: '10px 11px', fontFamily: FONT.sans, fontSize: FS.body, minHeight: 42,
  outline: 'none', width: '100%', boxSizing: 'border-box', textTransform: 'none',
  letterSpacing: 'normal',
};

export default function TaskPanel({ t, auth, onClose, onDone, onOpenBrowser, onOpenChat }) {
  const [entry, setEntry]     = useState(null);
  const [composing, setCompose] = useState(false);
  const [draft, setDraft]     = useState('');
  const [busy, setBusy]       = useState(null);   // 'drafting' | 'sending' | null
  const [note, setNote]       = useState('');
  const [cal, setCal]         = useState(null);
  const [detail, setDetail]   = useState(null);   // the expanded brief, on request
  const [calForm, setCalForm] = useState(null);   // the manual add, when there's nothing to read
  const [calUrl, setCalUrl]   = useState(null);
  const boxRef = useRef(null);

  const channel = SENDABLE[t.kind] || null;
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

  // The panel is tall, so the box you are meant to type in is usually below
  // the fold when it appears. Bring it to you.
  const openComposer = useCallback(() => {
    setCompose(true);
    setTimeout(() => {
      boxRef.current?.focus();
      boxRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  }, []);

  function suggest() {
    setBusy('drafting'); setNote('');
    fetch('/api/item/draft', { method: 'POST', headers: jsonHead,
      body: JSON.stringify({ from: t.from, text: t.text, snippet: t.snippet, brief: t.brief, kind: t.kind }) })
      .then(r => r.json())
      .then(d => {
        if (d.draft) { setDraft(d.draft); setTimeout(() => boxRef.current?.focus(), 40); }
        else setNote(d.error || 'the model had nothing to say — write it yourself');
      })
      .catch(() => setNote('could not reach the model'))
      .finally(() => setBusy(null));
  }

  // The only path to an actual message, and it is this button. The model can
  // fill the box; it can never press this.
  function send() {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy('sending'); setNote('');
    fetch('/api/text/send', { method: 'POST', headers: jsonHead,
      body: JSON.stringify({ to: t.from, name: t.from, message, channel }) })
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setNote(d.error || 'it did not go through — the thread may not be open'); return; }
        fetch('/api/contacts/signal', { method: 'POST', headers: jsonHead,
          body: JSON.stringify({ kind: t.kind, from: t.from, action: 'reply' }) }).catch(() => {});
        setNote(`sent on ${d.via}`);
        setTimeout(() => onDone?.(t, 'replied'), 700);
      })
      .catch(() => setNote('could not reach the sender'))
      .finally(() => setBusy(null));
  }

  // A card is a summary by construction. When it isn't enough, this reads the
  // whole thread (or the whole job record) back and writes the longer version,
  // so the answer to "what is this actually about" is one press away instead of
  // a trip out of the app.
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
  function seedForm(why) {
    const iso = String(t.when || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || ymdLocal(new Date());
    const hhmm = String(t.when || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    setCalForm({
      date: iso,
      time: hhmm ? `${String(hhmm[1]).padStart(2, '0')}:${hhmm[2]}` : '09:00',
      durationMins: 60,
      title: String(t.text || '').slice(0, 120),
      location: t.address || '',
      why: why || '',
    });
  }

  // Try to read the booking out of the conversation; when there is no
  // conversation to read - a job raised off a phone call, nine times out of
  // ten - don't just report that, open the form and let it be typed in.
  function addToCal() {
    if (!READABLE.has(t.kind)) { seedForm('no conversation behind this one'); return; }
    setCal('adding');
    fetch('/api/item/tocal', { method: 'POST', headers: jsonHead,
      body: JSON.stringify({ from: t.from, text: t.text }) })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setCal(null); seedForm(d.error); return; }
        setCal('done'); setCalUrl(d.navigated ? null : d.url); onOpenBrowser?.();
      })
      .catch(() => setCal('could not reach calendar'));
  }

  function submitCal() {
    if (!calForm?.date) return;
    setBusy('calling'); setCal('adding');
    fetch('/api/item/tocal', { method: 'POST', headers: jsonHead,
      body: JSON.stringify({ from: t.from, text: t.text, ...calForm }) })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setCal(d.error); return; }
        setCal('done'); setCalForm(null); setCalUrl(d.navigated ? null : d.url); onOpenBrowser?.();
      })
      .catch(() => setCal('could not reach calendar'))
      .finally(() => setBusy(null));
  }

  const actions = [
    channel && { label: composing ? 'hide reply' : '✍ reply', strong: !composing,
                 onPress: () => (composing ? setCompose(false) : openComposer()) },
    { label: busy === 'reading' ? 'reading…' : (detail ? '🔍 re-read it' : '🔍 more detail'), onPress: expand },
    (t.kind === 'email' || t.kind === 'bizemail') && { label: '✉ open in gmail', onPress: () => onOpenBrowser?.() },
    t.kind !== 'cal' && { label: '📅 add to calendar', onPress: addToCal },
    { label: '💬 ask about this', onPress: () => onOpenChat?.(t) },
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
        <div style={{ border: `1px solid ${C.borderHi}`, borderTop: 0,
                      borderRadius: `0 0 ${C.radius}px ${C.radius}px`,
                      background: C.surface, padding: SP[3], display: 'flex',
                      flexDirection: 'column', gap: SP[2] }}>
          <div style={{ fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
                        textTransform: 'uppercase', color: C.text3 }}>
            add it by hand{calForm.why ? ` — ${calForm.why}` : ''}
          </div>

          <input value={calForm.title} onChange={e => setCalForm(f => ({ ...f, title: e.target.value }))}
                 placeholder="what the event is" style={field} />

          <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
            <input type="date" value={calForm.date}
                   onChange={e => setCalForm(f => ({ ...f, date: e.target.value }))}
                   style={{ ...field, flex: '1 1 150px' }} />
            <input type="time" value={calForm.time}
                   onChange={e => setCalForm(f => ({ ...f, time: e.target.value }))}
                   style={{ ...field, flex: '1 1 110px' }} />
            <select value={calForm.durationMins}
                    onChange={e => setCalForm(f => ({ ...f, durationMins: Number(e.target.value) }))}
                    style={{ ...field, flex: '1 1 110px' }}>
              {[30, 60, 90, 120, 180, 240, 480].map(m => (
                <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hr${m > 60 ? 's' : ''}`}</option>
              ))}
            </select>
          </div>

          <input value={calForm.location} onChange={e => setCalForm(f => ({ ...f, location: e.target.value }))}
                 placeholder="address (optional)" style={field} />

          <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
            <button type="button" onClick={() => setCalForm(null)} style={{
              appearance: 'none', cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.label,
              letterSpacing: '.08em', textTransform: 'uppercase', borderRadius: 6,
              padding: '9px 12px', minHeight: 40, border: `1px solid ${C.border}`,
              background: 'transparent', color: C.text3,
            }}>cancel</button>
            <span style={{ flex: 1 }} />
            <motion.button type="button" onClick={submitCal} whileTap={{ scale: .98 }}
              disabled={!calForm.date || busy === 'calling'} style={{
                appearance: 'none', cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.ui,
                letterSpacing: '.08em', textTransform: 'uppercase', borderRadius: 6,
                padding: '9px 16px', minHeight: 44, border: `1px solid ${C.amber}`,
                fontWeight: 700, background: C.amber, color: '#140d02',
              }}>{busy === 'calling' ? 'opening…' : 'put it in the calendar →'}</motion.button>
          </div>
        </div>
      )}

      {calUrl && (
        <div style={{ padding: `${SP[2]}px ${SP[3]}px`, fontFamily: FONT.sans, fontSize: FS.meta,
                      textTransform: 'none' }}>
          <a href={calUrl} target="_blank" rel="noreferrer" style={{ color: C.amber }}>
            the calendar tab didn't take it — open the event here
          </a>
        </div>
      )}

      {composing && (
        <div style={{ border: `1px solid ${C.amber}`, borderTop: 0,
                      borderRadius: `0 0 ${C.radius}px ${C.radius}px`,
                      background: C.surface, padding: SP[3], display: 'flex',
                      flexDirection: 'column', gap: SP[2] }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[2],
                        fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
                        textTransform: 'uppercase', color: C.text3 }}>
            <span>replying on {channel}</span>
            <span style={{ flex: 1 }} />
            <span>{draft.trim().length} chars</span>
          </div>

          <textarea
            ref={boxRef} value={draft} onChange={e => setDraft(e.target.value)}
            rows={4} placeholder={`write to ${t.from}…`}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              background: C.bg, color: C.text1, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: SP[3], fontFamily: FONT.sans, fontSize: FS.body,
              lineHeight: 1.5, outline: 'none', textTransform: 'none', letterSpacing: 'normal',
            }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
            <button type="button" onClick={suggest} disabled={busy === 'drafting'} style={{
              appearance: 'none', cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.label,
              letterSpacing: '.08em', textTransform: 'uppercase', borderRadius: 6,
              padding: '9px 12px', minHeight: 40, border: `1px solid ${C.border}`,
              background: 'transparent', color: C.text2,
            }}>{busy === 'drafting' ? 'writing…' : 'draft one for me'}</button>

            <span style={{ flex: 1 }} />

            <motion.button type="button" onClick={send} whileTap={{ scale: .98 }}
              disabled={!draft.trim() || busy === 'sending'} style={{
                appearance: 'none', cursor: draft.trim() ? 'pointer' : 'not-allowed',
                fontFamily: FONT.mono, fontSize: FS.ui, letterSpacing: '.08em',
                textTransform: 'uppercase', borderRadius: 6, padding: '9px 16px', minHeight: 44,
                border: `1px solid ${C.amber}`, fontWeight: 700,
                background: draft.trim() ? C.amber : 'transparent',
                color: draft.trim() ? '#140d02' : C.text3,
              }}>{busy === 'sending' ? 'sending…' : `send on ${channel} →`}</motion.button>
          </div>

          {note && (
            <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, textTransform: 'none',
                          color: note.startsWith('sent') ? C.amber : C.danger }}>{note}</div>
          )}
        </div>
      )}
    </motion.div>
  );
}
