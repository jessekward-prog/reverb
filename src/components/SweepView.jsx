import React, { useEffect, useRef, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';
import { SOURCES } from '../lib/kinds.js';

const CONTENT_MAX = 700; // must match .app-shell's max-width in style.css (chat) —
// chat and sweep are a toggle pair, so their headers need to land at the
// same screen position or the nav buttons visibly jump when switching

const CSS = BACKDROP_CSS + `
@keyframes rv-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes rv-rise  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
@keyframes rv-sweepline { 0%{transform:translateY(-40px)} 100%{transform:translateY(560px)} }
.sweep-scroll::-webkit-scrollbar { width:0 }
`;

/* Amber EQ. Each bar runs its own independent timer — a single shared interval
 * makes the whole row swing in unison, and staggered CSS delays make a travelling
 * wave. Neither reads as random. Goes frantic while busy. */
function Waveform({ busy }) {
  const [levels, setLevels] = useState(() => Array.from({ length: 26 }, () => 0.25));
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    const next = Array.from({ length: 26 }, () => performance.now() + Math.random() * 1400);
    const id = setInterval(() => {
      const now = performance.now();
      const fast = busyRef.current;
      setLevels(prev => {
        let changed = false;
        const v = prev.slice();
        for (let i = 0; i < v.length; i++) {
          if (now >= next[i]) {
            v[i] = 0.14 + Math.pow(Math.random(), fast ? 1.05 : 1.7) * 0.86;
            next[i] = now + (fast ? 90 : 380) + Math.random() * (fast ? 220 : 900);
            changed = true;
          }
        }
        return changed ? v : prev;
      });
    }, 90);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 26, margin: '18px 20px 0' }}>
      {levels.map((h, i) => (
        <div key={i} style={{ width: 3, height: 24, transformOrigin: 'bottom', background: AMBER,
                              opacity: .6, transition: 'transform .5s ease-in-out', transform: `scaleY(${h})` }} />
      ))}
    </div>
  );
}

// Sweep is a two-step console now, not its own results list: "Pull Data"
// gathers all 9 sources (no LLM yet, so it's fast and free), then "Generate
// Report" runs that same pull through the model twice — once for Work
// (business), once for Life (personal) — and both tabs pick up the result.
export default function SweepView({ auth, onLockout, onOpenChat, onOpenWork, onOpenLife, onOpenTexts }) {
  const [phase, setPhase] = useState('idle'); // 'idle' | 'pulling' | 'pulled' | 'generating' | 'done' | 'error'
  const [step, setStep] = useState(0);
  const [counts, setCounts] = useState({});
  const [scanned, setScanned] = useState(0);
  const [pulledAt, setPulledAt] = useState(null);
  const [result, setResult] = useState(null); // { work: {categories}, life: {categories} }
  const [toast, setToast] = useState('');
  const pushRipple = useRef(() => {});
  const toastTimer = useRef(null);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function say(text) {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  }

  async function runPull() {
    if (phase === 'pulling' || phase === 'generating') return;
    pushRipple.current(1.5);
    setPhase('pulling');
    setStep(0);
    setResult(null);

    const pacer = setInterval(() => {
      setStep(s => Math.min(s + 1, SOURCES.length));
      pushRipple.current(1.2);
    }, 620);

    try {
      const res = await fetch('/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      });
      if (res.status === 401) { onLockout?.(); return; }
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();

      const settle = Math.max(0, SOURCES.length * 620 - 200);
      setTimeout(() => {
        setCounts(data.counts || {});
        setScanned(data.scanned || 0);
        setPulledAt(data.pulledAt || new Date().toISOString());
        setPhase('pulled');
        say(`pulled ${data.scanned} items — ready to generate`);
      }, settle);
    } catch {
      setTimeout(() => { setPhase('error'); say('pull failed — tap to retry'); }, 400);
    } finally {
      setTimeout(() => clearInterval(pacer), SOURCES.length * 620);
    }
  }

  async function runGenerate() {
    if (phase === 'generating') return;
    pushRipple.current(1.5);
    setPhase('generating');
    try {
      const res = await fetch('/api/report/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      });
      if (res.status === 401) { onLockout?.(); return; }
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      setResult(data);
      setPhase('done');
      const workN = (data.work?.categories || []).reduce((n, c) => n + c.items.length, 0);
      const lifeN = (data.life?.categories || []).reduce((n, c) => n + c.items.length, 0);
      say(`${workN} things on work, ${lifeN} on life`);
    } catch {
      setPhase('pulled');
      say('generate failed — tap to retry');
    }
  }

  const busy = phase === 'pulling' || phase === 'generating';

  const navBtn = (active) => ({
    appearance: 'none', border: 0, margin: 0, background: active ? 'rgba(232,232,228,.14)' : '#060606',
    color: INK, fontFamily: 'inherit', fontSize: 11, letterSpacing: '.06em',
    textTransform: 'uppercase', padding: '7px 10px', cursor: 'pointer',
  });
  const label = { opacity: .45 };
  const primaryBtn = (disabled) => ({
    appearance: 'none', width: '100%', margin: 0, border: '1px solid rgba(217,147,47,.55)',
    background: 'rgba(217,147,47,.09)', color: INK, fontFamily: 'inherit',
    fontSize: 13, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase',
    padding: '19px 16px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .4 : 1,
    transition: 'background .14s',
  });
  const statusLine = () => {
    if (phase === 'pulling')    return 'reading your channels…';
    if (phase === 'generating') return 'writing your reports…';
    if (phase === 'pulled')     return `pulled ${scanned} items — ready to generate`;
    if (phase === 'done')       return 'reports ready — check work & life';
    if (phase === 'error')      return 'something went wrong';
    return 'no data pulled yet';
  };

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

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column',
                    height: '100%', maxWidth: CONTENT_MAX, margin: '0 auto', boxSizing: 'border-box' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                      gap: 12, padding: '20px 20px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontWeight: 700 }}>// sweep</div>
            <div style={label}>{statusLine()}</div>
          </div>
          <div style={{ display: 'flex', gap: 1, background: 'rgba(232,232,228,.18)',
                        border: '1px solid rgba(232,232,228,.18)' }}>
            <button type="button" style={navBtn(false)} onClick={() => onOpenChat?.()}>chat</button>
            <button type="button" style={navBtn(true)}>sweep</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenWork?.()}>work</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenLife?.()}>life</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenTexts?.()}>texts</button>
          </div>
        </div>

        <Waveform busy={busy} />

        <div style={{ margin: '16px 20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative', overflow: 'hidden' }}>
            <button type="button" onClick={runPull} disabled={busy} style={primaryBtn(busy)}>
              {phase === 'pulling' ? 'pulling…' : pulledAt ? 'pull data again' : 'pull data'}
            </button>
            {phase === 'pulling' && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 2, background: AMBER,
                            boxShadow: '0 0 12px 2px rgba(217,147,47,.5)',
                            animation: 'rv-sweepline 1.1s linear infinite' }} />
            )}
          </div>

          {(phase === 'pulled' || phase === 'generating' || phase === 'done') && (
            <div style={{ position: 'relative', overflow: 'hidden' }}>
              <button type="button" onClick={runGenerate} disabled={phase === 'generating'}
                      style={primaryBtn(phase === 'generating')}>
                {phase === 'generating' ? 'generating…' : 'generate report'}
              </button>
              {phase === 'generating' && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 2, background: AMBER,
                              boxShadow: '0 0 12px 2px rgba(217,147,47,.5)',
                              animation: 'rv-sweepline 1.1s linear infinite' }} />
              )}
            </div>
          )}
        </div>

        <div className="sweep-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 20px 26px',
                                               marginTop: 18, scrollbarWidth: 'none' }}>

          {phase === 'pulling' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1,
                          background: 'rgba(232,232,228,.14)', border: '1px solid rgba(232,232,228,.14)' }}>
              {SOURCES.map((src, i) => {
                const done = step > i, active = step === i;
                return (
                  <div key={src.key} style={{ display: 'flex', alignItems: 'center', gap: 10,
                                              background: '#060606', padding: 12 }}>
                    <div style={{ width: 9, height: 9, flex: 'none',
                                  background: done ? (src.unavailable ? '#c47c7c' : AMBER) : 'rgba(232,232,228,.22)' }} />
                    <div style={{ flex: 1, opacity: done ? .85 : active ? .6 : .3 }}>{src.label}</div>
                    <div style={{ opacity: .5, letterSpacing: '.04em' }}>
                      {done ? (src.unavailable ? 'not connected' : (counts[src.key] || '—'))
                            : active ? 'reading…' : 'queued'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {phase === 'idle' && (
            <div style={{ paddingTop: 40, textAlign: 'center', opacity: .4, lineHeight: 1.8 }}>
              <div>no data pulled yet</div>
              <div style={{ fontSize: 10 }}>pull every channel, then generate work &amp; life reports</div>
            </div>
          )}

          {phase === 'error' && (
            <div style={{ paddingTop: 40, textAlign: 'center', opacity: .4, lineHeight: 1.8 }}>
              <div>couldn't reach the server</div>
              <div style={{ fontSize: 10 }}>tap pull data to retry</div>
            </div>
          )}

          {(phase === 'pulled' || phase === 'generating') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1,
                          background: 'rgba(232,232,228,.14)', border: '1px solid rgba(232,232,228,.14)' }}>
              {SOURCES.map(src => (
                <div key={src.key} style={{ display: 'flex', alignItems: 'center', gap: 10,
                                            background: '#060606', padding: 12 }}>
                  <div style={{ width: 9, height: 9, flex: 'none', background: src.unavailable ? '#c47c7c' : AMBER }} />
                  <div style={{ flex: 1, opacity: .85 }}>{src.label}</div>
                  <div style={{ opacity: .5, letterSpacing: '.04em' }}>
                    {src.unavailable ? 'not connected' : (counts[src.key] || '—')}
                  </div>
                </div>
              ))}
            </div>
          )}

          {phase === 'done' && result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
              {['work', 'life'].map(k => {
                const n = (result[k]?.categories || []).reduce((sum, c) => sum + c.items.length, 0);
                return (
                  <button key={k} type="button"
                          onClick={() => (k === 'work' ? onOpenWork?.() : onOpenLife?.())}
                          style={{
                            appearance: 'none', width: '100%', textAlign: 'left', cursor: 'pointer',
                            border: '1px solid rgba(232,232,228,.16)', background: 'rgba(6,6,6,.72)',
                            color: INK, fontFamily: 'inherit', padding: 14,
                            animation: 'rv-rise .26s ease-out both',
                          }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <div style={{ fontWeight: 700, color: AMBER }}>{k}</div>
                      <div style={{ opacity: .5 }}>{n === 0 ? 'all clear →' : `${n} things →`}</div>
                    </div>
                    {result[k]?.summary && (
                      <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.6, letterSpacing: '.01em',
                                    textTransform: 'none', opacity: .62, textWrap: 'pretty' }}>
                        {result[k].summary}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 24, zIndex: 9,
                      width: `calc(100% - 40px)`, maxWidth: CONTENT_MAX - 40,
                      border: '1px solid rgba(217,147,47,.5)', background: '#0b0b0a',
                      padding: '13px 14px', display: 'flex', alignItems: 'center', gap: 10,
                      animation: 'rv-rise .2s ease-out' }}>
          <div style={{ width: 8, height: 8, flex: 'none', background: AMBER }} />
          <div style={{ flex: 1, opacity: .85 }}>{toast}</div>
          <div style={{ opacity: .4, animation: 'rv-blink 1s step-end infinite' }}>_</div>
        </div>
      )}
    </div>
  );
}
