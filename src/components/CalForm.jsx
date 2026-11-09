import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { C, FS, FONT, SP } from '../lib/design.js';

// The one booking form, shared by the card panel and the pressure band.
//
// It exists because "add to calendar" used to be a link straight to a
// two-hour Google event: you found out on site that the job needed three
// hours and a part you hadn't ordered. So the two things you can only answer
// yourself are asked here, before anything opens - how long it will take, and
// whether it needs parts. Parts has no default on purpose: there is an
// unanswered state and the button stays dead until you answer it, because a
// pre-ticked "no" is the same as never having asked.
//
// textTransform: none throughout is load-bearing - this renders inside the
// report tabs, whose root sets uppercase for the terminal chrome.
const field = {
  background: C.bg, color: C.text1, border: `1px solid ${C.border}`, borderRadius: 6,
  padding: '10px 11px', fontFamily: FONT.sans, fontSize: FS.body, minHeight: 42,
  outline: 'none', width: '100%', boxSizing: 'border-box', textTransform: 'none',
  letterSpacing: 'normal',
};
const label = {
  fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
  textTransform: 'uppercase', color: C.text3,
};
const chip = on => ({
  appearance: 'none', cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.label,
  letterSpacing: '.08em', textTransform: 'uppercase', borderRadius: 6,
  padding: '9px 12px', minHeight: 40,
  border: `1px solid ${on ? C.amber : C.border}`,
  background: on ? C.amberDim : 'transparent', color: on ? C.amber : C.text2,
});

const DURATIONS = [30, 60, 90, 120, 180, 240, 480];
const hhmm = m => (m < 60 ? `${m} min`
  : `${Math.floor(m / 60)} hr${m >= 120 ? 's' : ''}${m % 60 ? ` ${m % 60}` : ''}`);

export default function CalForm({ seed, why, busy, error, onCancel, onSubmit }) {
  const [f, set] = useState({
    title: '', date: '', time: '09:00', durationMins: 60, location: '',
    needsParts: null, parts: '', ...seed,
  });
  const up = patch => set(prev => ({ ...prev, ...patch }));
  const ready = !!f.date && f.needsParts !== null && !(f.needsParts && !f.parts.trim());

  return (
    <div style={{ border: `1px solid ${C.borderHi}`, borderTop: 0,
                  borderRadius: `0 0 ${C.radius}px ${C.radius}px`,
                  background: C.surface, padding: SP[3], display: 'flex',
                  flexDirection: 'column', gap: SP[3] }}>
      <div style={label}>before it goes in{why ? ` — ${why}` : ''}</div>

      <input value={f.title} onChange={e => up({ title: e.target.value })}
             placeholder="what the job is" style={field} />

      <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
        <input type="date" value={f.date} onChange={e => up({ date: e.target.value })}
               style={{ ...field, flex: '1 1 150px' }} />
        <input type="time" value={f.time} onChange={e => up({ time: e.target.value })}
               style={{ ...field, flex: '1 1 110px' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        <div style={label}>how long will it take?</div>
        <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
          {DURATIONS.map(m => (
            <button key={m} type="button" onClick={() => up({ durationMins: m })}
                    style={chip(f.durationMins === m)}>{hhmm(m)}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        <div style={label}>does it need parts?</div>
        <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
          <button type="button" onClick={() => up({ needsParts: false, parts: '' })}
                  style={chip(f.needsParts === false)}>no, i have everything</button>
          <button type="button" onClick={() => up({ needsParts: true })}
                  style={chip(f.needsParts === true)}>yes — list them</button>
        </div>
        {f.needsParts && (
          <input value={f.parts} autoFocus onChange={e => up({ parts: e.target.value })}
                 placeholder="what to pick up or order" style={field} />
        )}
      </div>

      <input value={f.location} onChange={e => up({ location: e.target.value })}
             placeholder="address (optional)" style={field} />

      {error && (
        <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, textTransform: 'none',
                      letterSpacing: 'normal', color: C.danger }}>{error}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
        <button type="button" onClick={onCancel} style={{ ...chip(false), color: C.text3 }}>cancel</button>
        <span style={{ flex: 1 }} />
        <motion.button type="button" whileTap={{ scale: .98 }} disabled={!ready || busy}
          onClick={() => ready && !busy && onSubmit(f)}
          title={f.needsParts === null ? 'answer the parts question first' : undefined}
          style={{
            appearance: 'none', cursor: ready && !busy ? 'pointer' : 'not-allowed',
            fontFamily: FONT.mono, fontSize: FS.ui, letterSpacing: '.08em',
            textTransform: 'uppercase', borderRadius: 6, padding: '9px 16px', minHeight: 44,
            border: `1px solid ${ready ? C.amber : C.border}`, fontWeight: 700,
            background: ready ? C.amber : 'transparent', color: ready ? '#140d02' : C.text3,
          }}>{busy ? 'opening…' : 'put it in the calendar →'}</motion.button>
      </div>
    </div>
  );
}
