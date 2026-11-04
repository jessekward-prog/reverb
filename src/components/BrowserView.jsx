import React, { useEffect, useRef, useState, useCallback } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER,
         EDGE, HAIR, WELL, RAISED, PANEL } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';

const CONTENT_MAX = 1100;
const CSS = BACKDROP_CSS + `.bv-scroll::-webkit-scrollbar{width:0}`;

// The logged-in sessions the bridge holds open, shown as a live (frame-polled)
// view you can click and type into. Labels are the UI's; the server maps them to
// the bridge's source keys.
const SOURCES = [
  { key: 'messages', label: 'messages' },
  { key: 'email',    label: 'email' },
  { key: 'bizemail', label: 'sce email' },
  { key: 'calendar', label: 'calendar' },
  { key: 'meta',     label: 'fb business' },
];

export default function BrowserView({ auth, onLockout, ...nav }) {
  const [source, setSource] = useState('messages');
  const [status, setStatus] = useState('connecting');
  const imgRef = useRef(null);
  const frameRef = useRef(null);         // the <img> showing the current frame
  const vpRef = useRef({ w: 0, h: 0 });  // the tab's CSS viewport, for input mapping
  const alive = useRef(true);

  // Poll frames. Each frame is a JPEG blob; we swap the <img> src to it and read
  // the tab's CSS viewport from the X-Viewport header so clicks map correctly.
  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/browser/frame?source=${source}`, { headers: authHeaders(auth?.token) });
      if (r.status === 401) { onLockout?.(); return; }
      if (!r.ok) { setStatus('waiting for the tab…'); return; }
      const vp = (r.headers.get('x-viewport') || '0x0').split('x').map(Number);
      vpRef.current = { w: vp[0] || 0, h: vp[1] || 0 };
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (frameRef.current) {
        const old = frameRef.current.src;
        frameRef.current.onload = () => old && URL.revokeObjectURL(old);
        frameRef.current.src = url;
      }
      setStatus('live');
    } catch { setStatus('offline'); }
  }, [source, auth, onLockout]);

  useEffect(() => {
    alive.current = true;
    setStatus('connecting');
    let timer;
    const loop = async () => { if (!alive.current) return; await poll(); timer = setTimeout(loop, 900); };
    loop();
    return () => { alive.current = false; clearTimeout(timer); };
  }, [poll]);

  // Map a pointer event on the scaled <img> back to the tab's CSS coordinates.
  const toTab = (e) => {
    const img = frameRef.current;
    const { w, h } = vpRef.current;
    if (!img || !w) return null;
    const rect = img.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * w;
    const y = (e.clientY - rect.top) / rect.height * h;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const send = useCallback((payload) => {
    fetch('/api/browser/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ source, ...payload }),
    }).then(() => poll()).catch(() => {});
  }, [source, auth, poll]);

  const onClick = (e) => { const p = toTab(e); if (p) send({ kind: 'click', ...p }); };
  const onWheel = (e) => { const p = toTab(e); if (p) send({ kind: 'wheel', ...p, dy: e.deltaY }); };
  const onKey = (e) => {
    // special keys as key events, everything printable as inserted text
    if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault(); send({ kind: 'key', key: e.key });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); send({ kind: 'text', text: e.key });
    }
  };

  const tabBtn = (active) => ({
    appearance: 'none', border: 0, margin: 0, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', padding: '8px 12px',
    background: active ? 'rgba(217,147,47,.16)' : WELL, color: active ? AMBER : INK,
  });

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100dvh', overflow: 'hidden',
      background: WELL, color: INK, fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    }}>
      <style>{CSS}</style>
      <DitherField pushRef={useRef(() => {})} />
      <CrtLayers />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column',
                    height: '100%', maxWidth: CONTENT_MAX, margin: '0 auto', boxSizing: 'border-box' }}>
        <div className="rv-head">
          <div className="rv-head-title">
            <div style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>// browser</div>
            <div style={{ opacity: .45, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>
              {source} · {status}
            </div>
          </div>
          <div className="rv-head-side">
            <div className="rv-head-nav" style={{ background: EDGE, border: `1px solid ${EDGE}` }}>
              <button type="button" style={tabBtn(false)} onClick={() => nav.onOpenChat?.()}>chat</button>
              <button type="button" style={tabBtn(false)} onClick={() => nav.onOpenWork?.()}>work</button>
            </div>
          </div>
        </div>

        {/* source tabs */}
        <div style={{ display: 'flex', gap: 1, margin: '14px 20px 0', background: EDGE,
                      border: `1px solid ${EDGE}`, flexWrap: 'wrap' }}>
          {SOURCES.map(s => (
            <button key={s.key} type="button" style={tabBtn(source === s.key)}
                    onClick={() => setSource(s.key)}>{s.label}</button>
          ))}
        </div>

        {/* the live frame — focusable so it takes keyboard, clickable for the tab */}
        <div
          tabIndex={0}
          onKeyDown={onKey}
          style={{
            margin: '14px 20px 20px', flex: 1, minHeight: 0, border: `1px solid ${HAIR}`,
            background: '#000', overflow: 'hidden', position: 'relative', outline: 'none',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          }}
        >
          <img
            ref={frameRef}
            alt={`${source} live`}
            onClick={onClick}
            onWheel={onWheel}
            draggable={false}
            style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair', userSelect: 'none' }}
          />
          {status !== 'live' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                          justifyContent: 'center', background: RAISED, opacity: .9,
                          fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', color: AMBER }}>
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
