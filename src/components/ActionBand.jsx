import React, { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { authHeaders } from '../api.js';
import { C, FS, FONT, SP, EASE_OUT } from '../lib/design.js';
import CalForm from './CalForm.jsx';

// The pressure band. Amber in this app means "act on this now" — it is not
// decoration, and this is the only surface that earns it.
//
// Every row is a state transition the data already shows, computed in code:
// something agreed but not in the calendar, a job whose day has passed, a job
// left open with nothing booked next. No model decides what goes here, so it
// can't nag about something that was never said.
const LABEL = {
  book:            'not booked',
  invoice:         'invoice or mark ongoing',
  'next-visit':    'book the next visit',
  'waiting-on-you':'they are waiting on you',
  'quote-owed':    'estimate never sent',
  'reply-owed':    'they are waiting on a reply',
};

export default function ActionBand({ actions = [], auth, onCleared }) {
  const reduce = useReducedMotion();
  const [booking, setBooking] = useState(null);   // the action id being booked
  const [busy, setBusy]       = useState(null);
  const [err, setErr]         = useState(null);
  const [link, setLink]       = useState(null);   // {id, url} when the tab refused it
  const [cleared, setCleared] = useState([]);     // ids clearing, so they animate out
  const [undo, setUndo]       = useState(null);   // the last row cleared by hand
  const [checking, setCheck]  = useState(false);
  const [note, setNote]       = useState(null);
  // The refresh hands back the re-derived band, so it updates in place rather
  // than reloading the whole report and flashing a spinner over everything.
  const [live, setLive]       = useState(null);
  const rows = (live ?? actions).filter(a => !cleared.includes(a.id));
  if (!rows.length && !note) return null;

  // Check, do not trust. Every row here is derived from something that can be
  // re-read - the calendar for a booking, the job feed for a client waiting -
  // so this re-reads them and lets whatever is genuinely done fall away on the
  // evidence. Only a definite calendar match clears a booking.
  function recheck() {
    setCheck(true); setNote(null);
    fetch('/api/actions/refresh', { method: 'POST', headers: authHeaders(auth?.token) })
      .then(r => r.json())
      .then(d => {
        const bits = [];
        if (d.booked) bits.push(`${d.booked} now in your calendar`);
        if (d.cleared?.length) bits.push(`${d.cleared.length} cleared`);
        if (d.unsure) bits.push(`${d.unsure} had something else on that day — left here to check`);
        setNote(bits.length ? bits.join(' · ') : 'checked — nothing has changed yet');
        if (Array.isArray(d.actions)) { setLive(d.actions); setCleared([]); setUndo(null); }
        onCleared?.();
      })
      .catch(() => setNote('could not check'))
      .finally(() => setCheck(false));
  }

  // The band was a wall you could not get through: every row permanent, no way
  // to say "handled". Clearing sends the fingerprint back with the id, so the
  // row returns the moment anything about it changes.
  function clear(a) {
    setCleared(c => [...c, a.id]);
    fetch('/api/actions/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ id: a.id, fact: a.fact ?? '', done: true }),
    })
      .then(() => { setUndo(a); onCleared?.(a); })
      .catch(() => setCleared(c => c.filter(x => x !== a.id)));
  }

  // A mis-tap must not cost him a job. Clearing is reversible for as long as
  // the band is on screen.
  function undoClear() {
    const a = undo;
    if (!a) return;
    setUndo(null);
    setCleared(c => c.filter(x => x !== a.id));
    fetch('/api/actions/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ id: a.id, done: false }),
    }).then(() => onCleared?.()).catch(() => {});
  }

  // The band used to hand you a bare Google link that assumed two hours and no
  // parts. It opens the same form the cards use instead, so how long it takes
  // and what has to be brought are answered before the event exists.
  //
  // The tab has to be opened here, inside the press, or the browser blocks it
  // as a popup - the fetch that fills it in comes back too late to count as a
  // user gesture. It starts blank and gets the url a moment later.
  function book(a, f) {
    setBusy(a.id); setErr(null);
    const tab = window.open('', '_blank');
    fetch('/api/item/tocal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ from: a.book.from, text: a.title, ...f,
                             parts: f.needsParts ? f.parts : '' }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error || !d.url) { try { tab?.close(); } catch {} setErr(d.error || 'no event came back'); return; }
        setBooking(null);
        if (tab) tab.location.href = d.url; else setLink({ id: a.id, url: d.url });
      })
      .catch(() => { try { tab?.close(); } catch {} setErr('could not reach the calendar'); })
      .finally(() => setBusy(null));
  }

  return (
    <div style={{ marginBottom: SP[5], display: 'flex', flexDirection: 'column', gap: SP[2] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2],
                    fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.1em',
                    textTransform: 'uppercase', color: C.amber }}>
        <span style={{ width: 7, height: 7, background: C.amber, borderRadius: 2 }} />
        do these first
        <span style={{ color: C.text3 }}>{rows.length}</span>
        <button type="button" onClick={recheck} disabled={checking}
          style={{ marginLeft: 'auto', appearance: 'none', background: 'none',
                   border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer',
                   fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
                   textTransform: 'uppercase', color: C.text2, padding: '6px 10px',
                   minHeight: 32 }}>
          {checking ? 'checking…' : '⟳ check what\u2019s done'}
        </button>
      </div>

      {note && (
        <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, color: C.text2,
                      textTransform: 'none', letterSpacing: 'normal' }}>{note}</div>
      )}

      {undo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2],
                      fontFamily: FONT.sans, fontSize: FS.meta, color: C.text2,
                      textTransform: 'none', letterSpacing: 'normal' }}>
          cleared “{undo.title}”
          <button type="button" onClick={undoClear}
            style={{ appearance: 'none', background: 'none', border: 'none', padding: 0,
                     cursor: 'pointer', color: C.amber, fontFamily: FONT.mono,
                     fontSize: FS.meta, textDecoration: 'underline' }}>undo</button>
        </div>
      )}

      <AnimatePresence initial={false}>
        {rows.map((a, i) => (
          <motion.div
            key={a.id}
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, delay: reduce ? 0 : i * 0.04, ease: [0.23, 1, 0.32, 1] }}
            style={{
              border: `1px solid ${C.amber}`, borderRadius: C.radius,
              background: C.amberDim, padding: `${SP[3]}px ${SP[3]}px`,
              display: 'flex', flexDirection: 'column', gap: SP[1],
            }}
          >
            <div style={{ fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
                          textTransform: 'uppercase', color: C.amber }}>
              {LABEL[a.kind] || a.kind}
            </div>

            {/* A commitment row is a contact card: who, how to reach them,
                where, then the job. Leading with the extracted phrase gave a
                row headed with a copied phrase and a bare number, which
                answers neither
                "who is this" nor "what am I turning up to do". */}
            <div style={{ fontFamily: FONT.sans, fontSize: FS.title, fontWeight: 600,
                          color: C.text1, lineHeight: 1.35, textTransform: 'none' }}>
              {a.title}
            </div>

            {a.person && (a.person.phone || a.person.address || a.person.via) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 1 }}>
                {a.person.phone && (
                  <div style={{ fontFamily: FONT.mono, fontSize: FS.ui, color: C.amber,
                                textTransform: 'none', letterSpacing: '.02em' }}>
                    {a.person.phone}
                  </div>
                )}
                {a.person.address && (
                  <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, color: C.text2,
                                textTransform: 'none', letterSpacing: 'normal' }}>{a.person.address}</div>
                )}
                {a.person.via && (
                  <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, color: C.text3,
                                textTransform: 'none', letterSpacing: 'normal' }}>
                    texting as “{a.person.via}”
                  </div>
                )}
              </div>
            )}

            {a.person && a.work && (
              <div style={{ marginTop: SP[1], paddingTop: SP[2], borderTop: `1px solid ${C.border}`,
                            display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
                              textTransform: 'uppercase', color: C.text3 }}>
                  {a.kind === 'reply-owed' ? 'what they said' : 'the job'}
                </div>
                <div style={{ fontFamily: FONT.sans, fontSize: FS.body, lineHeight: 1.55,
                              color: C.text1, textTransform: 'none', textWrap: 'pretty' }}>
                  {a.work}
                </div>
              </div>
            )}

            <div style={{ fontFamily: FONT.sans, fontSize: FS.body, lineHeight: 1.6,
                          color: C.text2, textTransform: 'none', textWrap: 'pretty' }}>
              {a.detail}
            </div>

            {/* The line they actually said, so the nag is always traceable. */}
            {a.quote && (
              <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, lineHeight: 1.5,
                            color: C.text3, textTransform: 'none', fontStyle: 'italic',
                            borderLeft: `2px solid ${C.border}`, paddingLeft: SP[2], marginTop: SP[1] }}>
                “{a.quote}”
              </div>
            )}

            {/* What the work actually is, straight off the job record - the
                row is useless for preparing if it only names the client. */}
            {a.work && !a.person && (
              <div style={{ fontFamily: FONT.sans, fontSize: FS.body, lineHeight: 1.55,
                            color: C.text1, textTransform: 'none', textWrap: 'pretty' }}>
                {a.work}
              </div>
            )}
            {a.where && !a.person && (
              <div style={{ fontFamily: FONT.mono, fontSize: FS.meta, color: C.text3,
                            textTransform: 'none', letterSpacing: 'normal' }}>
                {a.where}
              </div>
            )}

            {/* Every row can be cleared, next to whatever it suggests doing. */}
            {a.kind !== 'source-down' && booking !== a.id && (
              <button type="button" onClick={() => clear(a)}
                style={{
                  alignSelf: 'flex-start', marginTop: SP[1], appearance: 'none',
                  cursor: 'pointer', background: 'none', border: 'none', padding: `${SP[1]}px 0`,
                  fontFamily: FONT.mono, fontSize: FS.meta, letterSpacing: '.06em',
                  textTransform: 'uppercase', color: C.text3, minHeight: 32,
                }}>✓ handled — i did this myself</button>
            )}

            {a.book && booking !== a.id && (
              <motion.button type="button" whileTap={{ scale: .98 }}
                onClick={() => { setBooking(a.id); setErr(null); setLink(null); }}
                style={{
                  alignSelf: 'flex-start', marginTop: SP[1], appearance: 'none', cursor: 'pointer',
                  fontFamily: FONT.mono, fontSize: FS.ui, letterSpacing: '.04em',
                  color: C.bg, background: C.amber, fontWeight: 700, border: 'none',
                  padding: `${SP[2]}px ${SP[3]}px`, borderRadius: 6, minHeight: 40,
                }}>{a.kind === 'book' ? (a.cta || 'add to calendar') : 'book a day for it'} →</motion.button>
            )}

            {a.book && booking === a.id && (
              <div style={{ marginTop: SP[2] }}>
                <CalForm seed={a.book} why="how long, and does it need parts?"
                         busy={busy === a.id} error={err}
                         onCancel={() => { setBooking(null); setErr(null); }}
                         onSubmit={f => book(a, f)} />
              </div>
            )}

            {link?.id === a.id && (
              <a href={link.url} target="_blank" rel="noreferrer"
                 style={{ fontFamily: FONT.sans, fontSize: FS.meta, color: C.amber,
                          textTransform: 'none' }}>
                open the pre-filled event in your calendar →
              </a>
            )}

            {a.href && a.cta && a.kind !== 'book' && (
              <a href={a.href} target="_blank" rel="noopener noreferrer"
                 style={{
                   alignSelf: 'flex-start', marginTop: SP[1], textDecoration: 'none',
                   fontFamily: FONT.mono, fontSize: FS.ui, letterSpacing: '.04em',
                   color: C.bg, background: C.amber, fontWeight: 700,
                   padding: `${SP[2]}px ${SP[3]}px`, borderRadius: 6, minHeight: 40,
                   display: 'inline-flex', alignItems: 'center',
                   transition: `transform 160ms ${EASE_OUT}`,
                 }}>
                {a.cta} →
              </a>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
