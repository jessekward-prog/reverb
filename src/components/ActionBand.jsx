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
  book:         'not booked',
  invoice:      'invoice or mark ongoing',
  'next-visit': 'book the next visit',
};

export default function ActionBand({ actions = [], auth, onOpenBrowser }) {
  const reduce = useReducedMotion();
  const [booking, setBooking] = useState(null);   // the action id being booked
  const [busy, setBusy]       = useState(null);
  const [err, setErr]         = useState(null);
  const [link, setLink]       = useState(null);   // {id, url} when the tab refused it
  if (!actions.length) return null;

  // The band used to hand you a bare Google link that assumed two hours and no
  // parts. It opens the same form the cards use instead, so how long it takes
  // and what has to be brought are answered before the event exists.
  function book(a, f) {
    setBusy(a.id); setErr(null);
    fetch('/api/item/tocal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ from: a.book.from, text: a.title, ...f,
                             parts: f.needsParts ? f.parts : '' }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setErr(d.error); return; }
        setBooking(null);
        if (d.navigated) onOpenBrowser?.(); else setLink({ id: a.id, url: d.url });
      })
      .catch(() => setErr('could not reach the calendar'))
      .finally(() => setBusy(null));
  }

  return (
    <div style={{ marginBottom: SP[5], display: 'flex', flexDirection: 'column', gap: SP[2] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2],
                    fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.1em',
                    textTransform: 'uppercase', color: C.amber }}>
        <span style={{ width: 7, height: 7, background: C.amber, borderRadius: 2 }} />
        do these first
        <span style={{ color: C.text3 }}>{actions.length}</span>
      </div>

      <AnimatePresence initial={false}>
        {actions.map((a, i) => (
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

            <div style={{ fontFamily: FONT.sans, fontSize: FS.title, fontWeight: 600,
                          color: C.text1, lineHeight: 1.35, textTransform: 'none' }}>
              {a.title}
            </div>

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
            {a.work && (
              <div style={{ fontFamily: FONT.sans, fontSize: FS.body, lineHeight: 1.55,
                            color: C.text1, textTransform: 'none', textWrap: 'pretty' }}>
                {a.work}
              </div>
            )}
            {a.where && (
              <div style={{ fontFamily: FONT.mono, fontSize: FS.meta, color: C.text3,
                            textTransform: 'none', letterSpacing: 'normal' }}>
                {a.where}
              </div>
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
                the calendar tab didn't take it — open the event here
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
