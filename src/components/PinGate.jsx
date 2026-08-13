/* Reverb pin screen — drop-in replacement for src/components/PinGate.jsx
 * Keeps the existing contract: <PinGate mode="setup"|"enter" onAuth={(token, role) => …} />
 * Styling is inline on purpose so it needs nothing from style.css.
 * Requires: public/skull.png (copy from handoff/skull.png)
 *
 * Layout: the dither field + CRT layers are full-bleed across the whole
 * viewport (that's what makes this feel like a real screen, not a shrunk
 * mockup, on desktop); the actual keypad UI sits in a comfortable centered
 * column on top so it doesn't stretch into an absurd wide keypad on a big
 * monitor. Same split used in ChatView and SweepView.
 */
import React, { useEffect, useRef, useState } from 'react';
import { djb2 } from '../api.js';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER } from './CrtBackdrop.jsx';

const CONTENT_MAX = 480;

const CSS = BACKDROP_CSS + `
@keyframes rv-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes rv-popin { from{transform:scale(.2);opacity:0} to{transform:scale(1);opacity:1} }
@keyframes rv-shk   { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-7px)} 40%{transform:translateX(6px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(2px)} }
`;

/* ── amber EQ: each bar on its own random timer ────────────────────────── */
function Waveform() {
  const [levels, setLevels] = useState(() => Array.from({ length: 26 }, () => 0.25));
  useEffect(() => {
    const next = Array.from({ length: 26 }, () => performance.now() + Math.random() * 1400);
    const id = setInterval(() => {
      const now = performance.now();
      let changed = false;
      const out = [];
      setLevels(prev => {
        const v = prev.slice();
        for (let i = 0; i < v.length; i++) {
          if (now >= next[i]) {
            v[i] = 0.14 + Math.pow(Math.random(), 1.7) * 0.86;
            next[i] = now + 380 + Math.random() * 900;
            changed = true;
          }
        }
        return changed ? v : prev;
      });
      void out;
    }, 90);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 26, marginTop: 18 }}>
      {levels.map((h, i) => (
        <div key={i} style={{
          width: 3, height: 24, transformOrigin: 'bottom', background: AMBER, opacity: .6,
          transition: 'transform .5s ease-in-out', transform: `scaleY(${h})`,
        }} />
      ))}
    </div>
  );
}

export default function PinGate({ mode: initialMode = 'enter', onAuth }) {
  const [mode, setMode] = useState(initialMode); // 'setup' | 'confirm' | 'enter'
  const [setupPin, setSetupPin] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [granted, setGranted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [clock, setClock] = useState('');
  const pushRipple = useRef(() => {});

  useEffect(() => {
    const p = n => String(n).padStart(2, '0');
    const t = setInterval(() => {
      const d = new Date();
      setClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  function reject() {
    setError(true);
    setPin('');
    setAttempts(a => a + 1);
    setTimeout(() => setError(false), 700);
  }

  function accept(token, role) {
    pushRipple.current(1.5);
    setGranted(true);
    setTimeout(() => onAuth?.(token, role), 900);
  }

  // Matches server.js: both routes take { hash } (djb2 of the pin) and return { ok, token, role }.
  async function submit(code) {
    // first-run setup is two-step: capture, then confirm
    if (mode === 'setup') {
      setSetupPin(code);
      setPin('');
      setMode('confirm');
      return;
    }
    if (mode === 'confirm' && code !== setupPin) {
      setSetupPin(null);
      setMode('setup');
      reject();
      return;
    }

    setBusy(true);
    try {
      const path = mode === 'confirm' ? '/api/pin/set' : '/api/pin/verify';
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: djb2(code) }),
      });
      const data = await res.json();
      if (data.ok) accept(data.token, data.role);
      else if (data.locked) { setLocked(true); setPin(''); }
      else reject();
    } catch {
      reject();
    } finally {
      setBusy(false);
    }
  }

  function press(label) {
    if (granted || busy || locked) return;
    pushRipple.current(1.5);
    if (label === 'del') { setPin(p => p.slice(0, -1)); setError(false); return; }
    if (label === 'clr') { setPin(''); setError(false); return; }
    const nextPin = (pin + label).slice(0, 4);
    setPin(nextPin);
    setError(false);
    if (nextPin.length === 4) setTimeout(() => submit(nextPin), 260);
  }

  // physical keyboard
  useEffect(() => {
    const onKey = e => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Escape') press('clr');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const label = { fontWeight: 400, opacity: .45 };
  const prompts = { setup: '> choose access code', confirm: '> confirm access code', enter: '> enter access code' };
  const idle = { setup: 'set a new code', confirm: 're-enter to confirm', enter: 'awaiting input' };
  const status = granted ? 'channel open'
    : locked ? '!! too many attempts — locked 5 min'
    : error ? (mode === 'setup' ? '!! codes do not match' : '!! invalid code — retry')
    : pin.length ? `buffering ${pin.length}/4`
    : idle[mode];

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100dvh', overflow: 'hidden',
      background: '#060606', color: INK,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', userSelect: 'none',
    }}>
      <style>{CSS}</style>
      <DitherField pushRef={pushRipple} />
      <CrtLayers />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 120,
                    background: `linear-gradient(${INK}, transparent)`, opacity: .05, pointerEvents: 'none', zIndex: 1 }} />

      <div style={{
        position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', height: '100%',
        maxWidth: CONTENT_MAX, margin: '0 auto',
        padding: '22px 20px 26px', boxSizing: 'border-box',
        textShadow: '.5px 0 rgba(255,60,90,.1), -.5px 0 rgba(60,200,255,.09)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontWeight: 700 }}>// reverb_assistant</div>
            <div style={label}>auth protocol v2.6</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'right' }}>
            <div style={label}>no signal</div>
            <div style={label}>local only</div>
          </div>
        </div>

        <Waveform />

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={label}>{prompts[mode]}</div>
            <div style={label}>att {String(attempts).padStart(2, '0')}/03</div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} style={{
                flex: 1, height: 64, border: '1px solid rgba(232,232,228,.28)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(6,6,6,.6)',
              }}>
                {pin.length > i && (
                  <div style={{ width: 12, height: 12, background: INK, animation: 'rv-popin .18s ease-out' }} />
                )}
                {pin.length === i && !granted && (
                  <div style={{ width: 12, height: 1, background: INK, animation: 'rv-blink 1s step-end infinite' }} />
                )}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 16 }}>
            <div style={{ opacity: .8 }}>{status}</div>
            <div style={{ opacity: .35 }}>{error ? 'err_0x1f' : '4 digits'}</div>
          </div>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1, marginTop: 26,
          background: 'rgba(232,232,228,.18)', border: '1px solid rgba(232,232,228,.18)',
        }}>
          {['1','2','3','4','5','6','7','8','9','clr','0','del'].map(k => (
            <button key={k} type="button" onClick={() => press(k)} style={{
              appearance: 'none', border: 0, margin: 0, background: '#060606', color: INK,
              fontFamily: 'inherit', fontSize: 22, letterSpacing: '.04em', height: 74,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              transition: 'background .12s, color .12s',
            }}>{k}</button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, opacity: .3 }}>
          <div>**do not share this code</div>
          <div>{clock}</div>
        </div>
      </div>

      {error && (
        <div style={{ position: 'absolute', inset: 0, border: `2px solid ${INK}`,
                      animation: 'rv-shk .4s ease-out', pointerEvents: 'none', zIndex: 8 }} />
      )}
      {granted && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 9, background: '#060606',
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      justifyContent: 'center', gap: 14, animation: 'rv-popin .25s ease-out' }}>
          <div style={{ width: 64, height: 64, border: '1px solid rgba(232,232,228,.4)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 22, height: 22, background: INK }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>access granted</div>
          <div style={{ opacity: .4 }}>initializing reverb_assistant…</div>
        </div>
      )}
    </div>
  );
}
