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
  { key: 'messages',  label: 'messages' },
  { key: 'whatsapp',  label: 'whatsapp' },
  { key: 'messenger', label: 'messenger' },
  { key: 'email',    label: 'email' },
  { key: 'bizemail', label: 'sce email' },
  { key: 'calendar', label: 'calendar' },
  { key: 'meta',     label: 'fb business' },
];

export default function BrowserView({ auth, onLockout, ...nav }) {
  const [source, setSource] = useState('messages');
  const [status, setStatus] = useState('connecting');
  const [fit, setFit]       = useState(true);   // fit-to-width, or the tab at its own size
  const [vp, setVp]         = useState({ w: 0, h: 0 });
  const [gotFrame, setGot]  = useState(false);
  const imgRef = useRef(null);
  const frameRef = useRef(null);         // the <img> showing the current frame
  const vpRef = useRef({ w: 0, h: 0 });  // the tab's CSS viewport, for input mapping
  const onLockoutRef = useRef(onLockout);
  onLockoutRef.current = onLockout;
  const genRef = useRef(0);
  const pollNowRef = useRef(() => {});

  // Poll frames per active source. Every effect owns an AbortController and generation
  // token so rapid tab switches never leave older in-flight loops fighting over frameRef.
  useEffect(() => {
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    let timer;
    let disposed = false;
    let inFlight = null;
    let rerun = false;

    setStatus('connecting');
    setGot(false);
    vpRef.current = { w: 0, h: 0 };
    if (frameRef.current) {
      if (frameRef.current.src?.startsWith('blob:')) URL.revokeObjectURL(frameRef.current.src);
      frameRef.current.removeAttribute('src');
    }

    const fetchFrame = async () => {
      if (disposed || genRef.current !== gen) return;
      try {
        const r = await fetch(`/api/browser/frame?source=${source}`, {
          headers: authHeaders(auth?.token),
          signal: ctrl.signal,
        });
        if (disposed || genRef.current !== gen) return;
        if (r.status === 401) { onLockoutRef.current?.(); return; }
        if (!r.ok) { setStatus('waiting for the tab…'); return; }
        const rawVp = (r.headers.get('x-viewport') || '0x0').split('x').map(Number);
        const nextVp = { w: rawVp[0] || 0, h: rawVp[1] || 0 };
        vpRef.current = nextVp;
        setVp(prev => (prev.w === nextVp.w && prev.h === nextVp.h ? prev : nextVp));
        const blob = await r.blob();
        if (disposed || genRef.current !== gen) return;
        const url = URL.createObjectURL(blob);
        const img = frameRef.current;
        if (!img) { URL.revokeObjectURL(url); return; }
        const old = img.src;
        img.onload = () => { if (old && old.startsWith('blob:')) URL.revokeObjectURL(old); };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
        setGot(true);
        setStatus('live');
      } catch (e) {
        if (e?.name === 'AbortError' || disposed || genRef.current !== gen) return;
        setStatus('offline');
      }
    };

    const tick = (fromInput = false) => {
      if (disposed || genRef.current !== gen) return;
      if (inFlight) {
        if (fromInput) rerun = true;
        return;
      }
      clearTimeout(timer);
      rerun = false;
      inFlight = fetchFrame().finally(() => {
        inFlight = null;
        if (disposed || genRef.current !== gen) return;
        timer = setTimeout(() => tick(false), rerun ? 0 : 900);
      });
    };

    pollNowRef.current = () => tick(true);
    tick(false);

    return () => {
      disposed = true;
      genRef.current++;
      clearTimeout(timer);
      ctrl.abort();
      if (frameRef.current?.src?.startsWith('blob:')) {
        URL.revokeObjectURL(frameRef.current.src);
        frameRef.current.removeAttribute('src');
      }
    };
  }, [source, auth?.token]);

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
    }).then(() => pollNowRef.current?.()).catch(() => {});
  }, [source, auth?.token]);

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
              <button type="button" style={tabBtn(false)} onClick={() => nav.onOpenHome?.()}>vita switch</button>
              <button type="button" style={tabBtn(true)}>browser</button>
              <button type="button" style={tabBtn(false)} onClick={() => nav.onOpenChat?.()}>chat</button>
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
          {/* A desktop tab squeezed into a phone width is unreadable. Actual
              size and pan is the only way to read it there; fit is the only way
              to see where you are. Both, rather than a compromise between. */}
          <button type="button" style={{ ...tabBtn(!fit), marginLeft: 'auto' }}
                  onClick={() => setFit(v => !v)}>{fit ? 'actual size' : 'fit width'}</button>
        </div>

        {/* the live frame — focusable so it takes keyboard, clickable for the tab */}
        <div
          tabIndex={0}
          onKeyDown={onKey}
          style={{
            margin: '14px 20px 20px', flex: 1, minHeight: 0, border: `1px solid ${HAIR}`,
            background: '#000', position: 'relative', outline: 'none',
            overflow: fit ? 'hidden' : 'auto', WebkitOverflowScrolling: 'touch',
            display: 'flex', alignItems: 'flex-start', justifyContent: fit ? 'center' : 'flex-start',
          }}
        >
          <img
            ref={frameRef}
            alt={`${source} live`}
            onClick={onClick}
            onWheel={onWheel}
            draggable={false}
            style={{ width: fit ? '100%' : (vp.w ? `${vp.w}px` : '100%'), maxWidth: fit ? '100%' : 'none',
                     height: 'auto', display: gotFrame ? 'block' : 'none', cursor: 'crosshair', userSelect: 'none',
                     imageRendering: 'auto', flex: 'none' }}
          />
          {status !== 'live' && !gotFrame && (
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
