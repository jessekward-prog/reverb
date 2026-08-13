import React, { useEffect, useRef, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';

const CSS = BACKDROP_CSS + `
@keyframes rv-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes rv-popin { from{transform:scale(.2);opacity:0} to{transform:scale(1);opacity:1} }
@keyframes rv-rise  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
@keyframes rv-sweepline { 0%{transform:translateY(-40px)} 100%{transform:translateY(560px)} }
.sweep-scroll::-webkit-scrollbar { width:0 }
`;

const KINDS = {
  sms:   { label: 'sms',      tint: AMBER },
  email: { label: 'email',    tint: '#9fb0a8' },
  cal:   { label: 'calendar', tint: '#8fa8c4' },
  call:  { label: 'missed',   tint: '#c47c7c' },
};

const BUCKETS = [
  { label: 'needs a reply', tint: AMBER },
  { label: 'this week',     tint: INK },
  { label: 'no date',       tint: '#9fb0a8' },
];

/* `call log` has no backing tool in src/lib/tools.js — deliberately shown as
 * a known gap rather than hidden or faked. Remove this row if/when a call-log
 * source exists to wire up. */
const SOURCES = [
  { key: 'sms',   label: 'get_recent_texts' },
  { key: 'email', label: 'get_recent_emails' },
  { key: 'cal',   label: 'get_upcoming_events' },
  { key: 'call',  label: 'call log', unavailable: true },
];

/* Amber EQ. Each bar runs its own independent timer — a single shared interval
 * makes the whole row swing in unison, and staggered CSS delays make a travelling
 * wave. Neither reads as random. Goes frantic while scanning. */
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

export default function SweepView({ auth, onLockout, onOpenChat, onDraftReply }) {
  const [phase, setPhase] = useState('idle');       // 'idle' | 'scanning' | 'results'
  const [step, setStep] = useState(0);              // which SOURCES row is resolved
  const [tasks, setTasks] = useState([]);
  const [counts, setCounts] = useState({});
  const [scanned, setScanned] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [lastSwept, setLastSwept] = useState(null);
  const [toast, setToast] = useState('');
  const [clock, setClock] = useState('');
  const pushRipple = useRef(() => {});
  const toastTimer = useRef(null);

  useEffect(() => {
    setPhase('idle');
    const p = n => String(n).padStart(2, '0');
    const t = setInterval(() => {
      const d = new Date();
      setClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    }, 1000);
    return () => { clearInterval(t); clearTimeout(toastTimer.current); };
  }, []);

  function say(text) {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  }

  async function runSweep() {
    if (phase === 'scanning') return;
    pushRipple.current(1.5);
    setPhase('scanning');
    setStep(0);
    setExpandedId(null);

    const pacer = setInterval(() => {
      setStep(s => Math.min(s + 1, SOURCES.length));
      pushRipple.current(1.2);
    }, 620);

    try {
      const res = await fetch('/api/sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      });
      if (res.status === 401) { onLockout?.(); return; }
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();

      // let the scan rows finish resolving before flipping to results
      const settle = Math.max(0, SOURCES.length * 620 - 200);
      setTimeout(() => {
        setTasks(data.tasks || []);
        setCounts(data.counts || {});
        setScanned(data.scanned || 0);
        setPhase('results');
        setLastSwept('just now');
        const n = (data.tasks || []).length;
        say(n ? `${n} actions pulled from ${data.scanned} items` : 'nothing needs you right now');
      }, settle);
    } catch {
      setTimeout(() => {
        setPhase(tasks.length ? 'results' : 'idle');
        say('sweep failed — tap to retry');
      }, 400);
    } finally {
      setTimeout(() => clearInterval(pacer), SOURCES.length * 620);
    }
  }

  function toggleDone(id, e) {
    e?.stopPropagation();
    const task = tasks.find(t => t.id === id);
    const nextDone = !task?.done;
    setTasks(prev => prev.map(t => t.id === id ? { ...t, done: nextDone } : t));
    fetch(`/api/sweep/${id}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ done: nextDone }),
    }).catch(() => {});
  }

  const scanning = phase === 'scanning';
  const open = tasks.filter(t => !t.done).length;
  const replies = tasks.filter(t => !t.done && t.reply).length;

  const groups = BUCKETS.map((b, bi) => ({
    ...b,
    tasks: tasks.filter(t => t.bucket === bi),
  })).filter(g => g.tasks.length);

  const label = { opacity: .45 };
  const navBtn = (active) => ({
    appearance: 'none', border: 0, margin: 0, background: active ? 'rgba(232,232,228,.14)' : '#060606',
    color: INK, fontFamily: 'inherit', fontSize: 11, letterSpacing: '.06em',
    textTransform: 'uppercase', padding: '7px 10px', cursor: 'pointer',
  });

  return (
    <div style={{
      position: 'relative', width: 390, height: 844, overflow: 'hidden', margin: '0 auto',
      background: '#060606', color: INK,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', userSelect: 'none',
    }}>
      <style>{CSS}</style>
      <DitherField pushRef={pushRipple} />
      <CrtLayers />

      {/* content sits above the CRT stack so text stays crisp — no text-shadow fringe here */}
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column',
                    height: '100%', boxSizing: 'border-box' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                      gap: 12, padding: '20px 20px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontWeight: 700 }}>// sweep</div>
            <div style={label}>{scanning ? 'reading your channels…' : lastSwept ? `last sweep ${lastSwept}` : 'no sweep yet'}</div>
          </div>
          <div style={{ display: 'flex', gap: 1, background: 'rgba(232,232,228,.18)',
                        border: '1px solid rgba(232,232,228,.18)' }}>
            <button type="button" style={navBtn(false)} onClick={() => onOpenChat?.()}>chat</button>
            <button type="button" style={navBtn(true)}>sweep</button>
          </div>
        </div>

        <Waveform busy={scanning} />

        <div style={{ margin: '16px 20px 0', position: 'relative', overflow: 'hidden' }}>
          <button type="button" onClick={runSweep} style={{
            appearance: 'none', width: '100%', margin: 0, border: '1px solid rgba(217,147,47,.55)',
            background: 'rgba(217,147,47,.09)', color: INK, fontFamily: 'inherit',
            fontSize: 13, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase',
            padding: '19px 16px', cursor: 'pointer', transition: 'background .14s',
          }}>{scanning ? 'sweeping…' : 'sweep everything'}</button>
          {scanning && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 2, background: AMBER,
                          boxShadow: '0 0 12px 2px rgba(217,147,47,.5)',
                          animation: 'rv-sweepline 1.1s linear infinite' }} />
          )}
        </div>

        <div className="sweep-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 20px 26px',
                                               marginTop: 18, scrollbarWidth: 'none' }}>

          {scanning && (
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
              <div>no sweep yet</div>
              <div style={{ fontSize: 10 }}>pull your texts, mail and calendar into one list</div>
            </div>
          )}

          {phase === 'results' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                            paddingBottom: 12, borderBottom: '1px solid rgba(232,232,228,.14)' }}>
                <div style={{ opacity: .8 }}>
                  {open === 0 ? 'all clear' : `${open} actions · ${replies} need a reply`}
                </div>
                <div style={{ opacity: .4 }}>{scanned} items</div>
              </div>

              {groups.map(g => (
                <div key={g.label} style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div style={{ fontWeight: 700, color: g.tint }}>{g.label}</div>
                    <div style={{ flex: 1, height: 1, background: 'rgba(232,232,228,.14)' }} />
                    <div style={{ opacity: .4 }}>
                      {String(g.tasks.filter(t => !t.done).length).padStart(2, '0')}
                    </div>
                  </div>

                  {g.tasks.map((t, i) => {
                    const k = KINDS[t.kind] || KINDS.email;
                    const expanded = expandedId === t.id;
                    const actions = [
                      { label: t.done ? 'reopen' : 'done', onPress: e => toggleDone(t.id, e) },
                      { label: 'snooze 1d', onPress: () => say('snoozed — back tomorrow 08:00') },
                      t.reply
                        ? { label: 'draft reply', onPress: () => onDraftReply?.(t) }
                        : { label: 'open source', onPress: () => say(`opening ${k.label} thread`) },
                    ];
                    return (
                      <div key={t.id} style={{
                        border: '1px solid rgba(232,232,228,.16)', background: 'rgba(6,6,6,.72)',
                        animation: 'rv-rise .26s ease-out both', animationDelay: `${(i * 0.05).toFixed(2)}s`,
                        opacity: t.done ? .4 : 1,
                      }}>
                        <div onClick={() => setExpandedId(expanded ? null : t.id)}
                             style={{ display: 'flex', gap: 11, padding: '12px 12px 11px', cursor: 'pointer' }}>
                          <div onClick={e => toggleDone(t.id, e)} style={{
                            width: 16, height: 16, flex: 'none', marginTop: 1,
                            border: '1px solid rgba(232,232,228,.5)', display: 'flex',
                            alignItems: 'center', justifyContent: 'center',
                            background: t.done ? INK : 'transparent',
                          }}>
                            {t.done && <div style={{ width: 8, height: 8, background: '#060606',
                                                     animation: 'rv-popin .16s ease-out' }} />}
                          </div>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, lineHeight: 1.45, letterSpacing: '.02em',
                                          textTransform: 'none', textWrap: 'pretty',
                                          textDecoration: t.done ? 'line-through' : 'none' }}>{t.text}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, opacity: .5, fontSize: 10 }}>
                              <div style={{ color: k.tint }}>{k.label}</div>
                              <div>·</div>
                              <div style={{ textTransform: 'none', overflow: 'hidden',
                                            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.from}</div>
                              <div>·</div>
                              <div style={{ flex: 'none' }}>{t.when}</div>
                            </div>
                          </div>
                          <div style={{ flex: 'none', opacity: .35, fontSize: 14, lineHeight: 1 }}>
                            {expanded ? '−' : '+'}
                          </div>
                        </div>

                        {expanded && (
                          <div style={{ borderTop: '1px solid rgba(232,232,228,.12)', padding: 12,
                                        display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div style={{ fontSize: 11.5, lineHeight: 1.6, letterSpacing: '.01em',
                                          textTransform: 'none', opacity: .62, textWrap: 'pretty',
                                          borderLeft: '2px solid rgba(217,147,47,.5)', paddingLeft: 10 }}>
                              {t.snippet}
                            </div>
                            <div style={{ display: 'flex', gap: 1, background: 'rgba(232,232,228,.16)',
                                          border: '1px solid rgba(232,232,228,.16)' }}>
                              {actions.map(a => (
                                <button key={a.label} type="button" onClick={a.onPress} style={{
                                  appearance: 'none', flex: 1, border: 0, margin: 0, background: '#060606',
                                  color: INK, fontFamily: 'inherit', fontSize: 10, letterSpacing: '.08em',
                                  textTransform: 'uppercase', padding: '10px 4px', cursor: 'pointer',
                                }}>{a.label}</button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid rgba(232,232,228,.14)',
                            display: 'flex', justifyContent: 'space-between', opacity: .3 }}>
                <div>**nothing left your device</div>
                <div>{clock}</div>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'absolute', left: 20, right: 20, bottom: 24, zIndex: 9,
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
