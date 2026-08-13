/* Reverb pin screen — drop-in replacement for src/components/PinGate.jsx
 * Keeps the existing contract: <PinGate mode="setup"|"enter" onAuth={(token, role) => …} />
 * Styling is inline on purpose so it needs nothing from style.css.
 * Requires: public/skull.png (copy from handoff/skull.png)
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { djb2 } from '../api.js';
import { Stage } from './CrtBackdrop.jsx';

const INK = '#e8e8e4';
const AMBER = '#d9932f';
const SKULL_DARK = '#41473f';
const SKULL_LIGHT = '#5a625c';
const W = 390, H = 844;
const CX = 195, CY = 265;              // ripple + skull center
const BAYER = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];

const CSS = `
@keyframes rv-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes rv-scan  { 0%{transform:translateY(0)} 100%{transform:translateY(${H}px)} }
@keyframes rv-popin { from{transform:scale(.2);opacity:0} to{transform:scale(1);opacity:1} }
@keyframes rv-shk   { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-7px)} 40%{transform:translateX(6px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(2px)} }
@keyframes rv-flick { 0%,100%{opacity:.05} 50%{opacity:.07} }
@keyframes rv-drift { from{transform:translateY(0)} to{transform:translateY(3px)} }
`;

/* ── dithered ripple field ─────────────────────────────────────────────── */
function DitherField({ pushRef }) {
  const canvasRef = useRef(null);
  const ripples = useRef([]);
  const skull = useRef(null);

  const push = useCallback((amp) => {
    ripples.current.push({ t0: performance.now(), x: CX, y: CY, amp });
  }, []);
  useEffect(() => { pushRef.current = push; }, [push, pushRef]);

  useEffect(() => {
    // sample the skull PNG down to a luminance grid
    const img = new Image();
    img.onload = () => {
      const w = 190, h = Math.round(190 * img.height / img.width);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c2 = cv.getContext('2d');
      c2.drawImage(img, 0, 0, w, h);
      const d = c2.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        lum[i] = (d[i*4]*.3 + d[i*4+1]*.59 + d[i*4+2]*.11) / 255 * (d[i*4+3] / 255);
      }
      skull.current = { lum, W: w, H: h, x0: CX - w / 2, y0: CY - h / 2 };
    };
    img.src = '/skull.png';

    push(1.1);
    const amb = setInterval(() => push(1.1), 5000);

    let raf;
    let ctx = null;
    const draw = (now) => {
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(draw); return; }
      if (c.width !== W) { c.width = W; c.height = H; ctx = c.getContext('2d'); }
      ctx.clearRect(0, 0, W, H);
      ripples.current = ripples.current.filter(r => now - r.t0 < 5200);

      const step = 5;
      const jitter = Math.sin(now / 260) * 1.5;   // slight horizontal tape wobble
      const sk = skull.current;
      for (let y = 2; y < H; y += step) {
        const skew = Math.sin(y / 90 + now / 900) * jitter;
        for (let x = 2; x < W; x += step) {
          let v = 0, hit = 0;
          if (sk) {
            const sx = (x - sk.x0) | 0, sy = (y - sk.y0) | 0;
            if (sx >= 0 && sy >= 0 && sx < sk.W && sy < sk.H) {
              const l = sk.lum[sy * sk.W + sx];
              if (l > 0.22) { hit = l; v += 0.24 + l * 0.2; }
            }
          }
          for (const r of ripples.current) {
            const t = (now - r.t0) / 1000;
            const R = 190 + t * 150;                       // starts wider than the skull
            const d = Math.hypot(x + skew - r.x, y - r.y);
            const g = Math.exp(-Math.pow((d - R) / 20, 2)); // thin band
            v += r.amp * g * Math.exp(-t * 0.45);
          }
          const bx = ((x / step) | 0) & 3, by = ((y / step) | 0) & 3;
          const thr = BAYER[by * 4 + bx] / 16;
          // skull pixels get a low threshold; ripple pixels a high one (sparser)
          if (v <= (hit ? thr * 0.55 + 0.02 : thr * 1.15 + 0.06)) continue;
          ctx.fillStyle = hit && v < 0.8
            ? (hit > 0.5 ? SKULL_LIGHT : SKULL_DARK)
            : (v > 0.7 ? SKULL_LIGHT : SKULL_DARK);
          ctx.fillRect(x, y, 3, 3);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); clearInterval(amb); };
  }, [push]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: W, height: H, opacity: .5,
               imageRendering: 'pixelated', filter: 'blur(.3px)' }}
    />
  );
}

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
    <Stage>
    <div style={{
      position: 'relative', width: W, height: H, overflow: 'hidden',
      background: '#060606', color: INK,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', userSelect: 'none',
    }}>
      <style>{CSS}</style>
      <DitherField pushRef={pushRipple} />

      {/* CRT dressing */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 120,
                    background: `linear-gradient(${INK}, transparent)`, opacity: .05, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: -H, height: H * 2, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: H, height: 2, background: INK,
                      opacity: .14, animation: 'rv-scan 7s linear infinite' }} />
      </div>
      <div style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none', willChange: 'transform',
                    background: 'repeating-linear-gradient(180deg,rgba(0,0,0,.42) 0px,rgba(0,0,0,.42) 1px,transparent 1px,transparent 3px)',
                    animation: 'rv-drift 5s linear infinite' }} />
      <div style={{ position: 'absolute', inset: 0, zIndex: 6, pointerEvents: 'none', background: '#c9f3d8',
                    mixBlendMode: 'overlay', animation: 'rv-flick 6s ease-in-out infinite' }} />
      <div style={{ position: 'absolute', inset: -40, zIndex: 7, pointerEvents: 'none',
                    boxShadow: 'inset 0 0 90px 40px rgba(0,0,0,.85)' }} />

      <div style={{
        position: 'relative', display: 'flex', flexDirection: 'column', height: '100%',
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
    </Stage>
  );
}
