import React, { useEffect, useRef, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';

const CONTENT_MAX = 700; // matches Chat/Sweep/Work so the nav pill lands in the same spot

const CSS = BACKDROP_CSS + `
@keyframes rv-rise { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
.texts-scroll::-webkit-scrollbar { width:0 }
`;

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function timeOnly(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function TextsView({ auth, onLockout, onOpenChat, onOpenSweep, onOpenWork, onOpenLife }) {
  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready'
  const [threads, setThreads] = useState([]);
  const [openPhone, setOpenPhone] = useState(null);
  const pushRipple = useRef(() => {});

  useEffect(() => {
    fetch('/api/texts', { headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(data => { setThreads(data.threads || []); setPhase('ready'); })
      .catch(() => setPhase('ready'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalMessages = threads.reduce((sum, t) => sum + t.messages.length, 0);

  const navBtn = (active) => ({
    appearance: 'none', border: 0, margin: 0, background: active ? 'rgba(232,232,228,.14)' : '#060606',
    color: INK, fontFamily: 'inherit', fontSize: 11, letterSpacing: '.06em',
    textTransform: 'uppercase', padding: '7px 10px', cursor: 'pointer',
  });
  const label = { opacity: .45 };

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
            <div style={{ fontWeight: 700 }}>// texts</div>
            <div style={label}>
              {phase === 'loading' ? 'loading…' : `${threads.length} threads · ${totalMessages} msgs · last 5 days`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 1, background: 'rgba(232,232,228,.18)',
                        border: '1px solid rgba(232,232,228,.18)' }}>
            <button type="button" style={navBtn(false)} onClick={() => onOpenChat?.()}>chat</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenSweep?.()}>sweep</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenWork?.()}>work</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenLife?.()}>life</button>
            <button type="button" style={navBtn(true)}>texts</button>
          </div>
        </div>

        <div className="texts-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 20px 26px',
                                                marginTop: 20, scrollbarWidth: 'none' }}>

          {phase === 'ready' && threads.length === 0 && (
            <div style={{ paddingTop: 40, textAlign: 'center', opacity: .4, lineHeight: 1.8 }}>
              <div>no texts captured yet</div>
              <div style={{ fontSize: 10 }}>real SMS via MacroDroid — nothing's come in since setup</div>
            </div>
          )}

          {threads.map((t, i) => {
            const last = t.messages[t.messages.length - 1];
            const open = openPhone === t.phone;
            return (
              <div key={t.phone} style={{
                marginBottom: 8, border: '1px solid rgba(232,232,228,.16)', background: 'rgba(6,6,6,.72)',
                animation: 'rv-rise .22s ease-out both', animationDelay: `${(i * 0.03).toFixed(2)}s`,
              }}>
                <div onClick={() => setOpenPhone(open ? null : t.phone)}
                     style={{ display: 'flex', gap: 11, padding: '13px 12px', cursor: 'pointer' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontWeight: 700, textTransform: 'none' }}>{t.phone}</div>
                      <div style={{ opacity: .4, flex: 'none' }}>{timeAgo(t.lastAt)}</div>
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.4, textTransform: 'none', opacity: .7,
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {last.body}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flex: 'none' }}>
                    <div style={{ opacity: .35, fontSize: 14, lineHeight: 1 }}>{open ? '−' : '+'}</div>
                    {t.messages.length > 1 && <div style={{ opacity: .35 }}>{t.messages.length}</div>}
                  </div>
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid rgba(232,232,228,.12)', padding: '12px',
                                display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 360, overflowY: 'auto' }}>
                    {t.messages.map(m => (
                      <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <div style={{ opacity: .35, flex: 'none', fontSize: 10 }}>{timeOnly(m.occurred_at)}</div>
                        <div style={{ fontSize: 12, lineHeight: 1.5, textTransform: 'none', textWrap: 'pretty', opacity: .85 }}>
                          {m.body}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
