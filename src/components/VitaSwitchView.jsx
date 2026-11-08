import React, { useCallback, useEffect, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';
import { C, FS, FONT, SP } from '../lib/design.js';
import TriPane from './TriPane.jsx';

// The whole day on one page. Nothing to press to make it current: it loads,
// then refreshes itself quietly, because being asked to regenerate a list is
// the app making its problem the user's.
const REFRESH_MS = 5 * 60 * 1000;

export default function VitaSwitchView({ auth, onLockout, nav }) {
  const [data, setData] = useState({ categories: [], actions: [], scannedAt: null });
  const [phase, setPhase] = useState('loading');

  const load = useCallback((quiet = false) => {
    if (!quiet) setPhase('loading');
    return fetch('/api/tasks', { headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(d => {
        setData({ categories: d.categories || [], actions: d.actions || [], scannedAt: d.scannedAt || null });
        setPhase('ready');
      })
      .catch(() => setPhase('ready'));
  }, [auth, onLockout]);

  useEffect(() => { load(); }, [load]);

  // Quiet background refresh, and again whenever the app is brought forward.
  useEffect(() => {
    const t = setInterval(() => load(true), REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
                  background: C.bg, color: C.text1, overflow: 'hidden' }}>
      <style>{BACKDROP_CSS}</style>
      <DitherField />
      <CrtLayers />

      <header style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center',
                       gap: SP[3], padding: `max(${SP[4]}px, env(safe-area-inset-top)) ${SP[4]}px ${SP[3]}px` }}>
        <div style={{ fontFamily: FONT.mono, fontSize: FS.ui, letterSpacing: '.14em',
                      textTransform: 'uppercase', color: C.text1 }}>
          <span style={{ color: C.amber }}>vita</span> switch
        </div>
        <span style={{ flex: 1 }} />
        {nav}
      </header>

      <main style={{ position: 'relative', zIndex: 2, flex: 1, minHeight: 0,
                     padding: `0 ${SP[4]}px calc(${SP[4]}px + env(safe-area-inset-bottom) * .5)`,
                     display: 'flex' }}>
        {phase === 'loading'
          ? <div style={{ margin: 'auto', fontFamily: FONT.sans, fontSize: FS.body, color: C.text3 }}>reading everything…</div>
          : <TriPane categories={data.categories} actions={data.actions} scannedAt={data.scannedAt} />}
      </main>
    </div>
  );
}
