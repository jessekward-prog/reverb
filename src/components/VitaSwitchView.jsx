import React, { useCallback, useEffect, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';
import { C, FS, FONT, SP } from '../lib/design.js';
import TriPane from './TriPane.jsx';
import TopicStrip from './TopicStrip.jsx';

// The whole day on one page. Nothing to press to make it current: it loads,
// then refreshes itself quietly, because being asked to regenerate a list is
// the app making its problem the user's.
const REFRESH_MS = 5 * 60 * 1000;

const PILL = [
  ['chat', 'chat'], ['sweep', 'sweep'], ['texts', 'texts'], ['browser', 'browser'],
];

export default function VitaSwitchView({ auth, onLockout, onOpenChat, onOpenSweep,
                                         onOpenTexts, onOpenBrowser, onDraftReply,
                                         topics, onView }) {
  const go = { chat: onOpenChat, sweep: onOpenSweep, texts: onOpenTexts, browser: onOpenBrowser };
  const [data, setData] = useState({ categories: [], actions: [], scannedAt: null });
  const [phase, setPhase] = useState('loading');
  const [sweep, setSweep] = useState(null);   // {step} while a full pass runs, then {note}

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

  // "Refresh all data": re-read every source, look for times newly agreed, and
  // check the calendar for what has since been booked. It is minutes of work,
  // so the server runs it detached and this polls the step it is on - the
  // alternative is a button that looks broken for three minutes.
  const refreshAll = useCallback(() => {
    setSweep({ step: 'starting' });
    const poll = () => fetch('/api/refresh-all', { headers: authHeaders(auth?.token) })
      .then(r => r.json())
      .then(d => {
        if (d.running) { setSweep({ step: d.step || 'working' }); setTimeout(poll, 2000); return; }
        const r = d.result || {};
        const bits = [];
        if (r.booked) bits.push(`${r.booked} already in your calendar`);
        if (r.found) bits.push(`${r.found} agreed time${r.found === 1 ? '' : 's'} found`);
        if (r.superseded) bits.push(`${r.superseded} no longer agreed`);
        if (r.unsure) bits.push(`${r.unsure} to check by eye`);
        setSweep({ note: d.error ? `refresh failed: ${d.error}`
                                 : bits.length ? bits.join(' · ') : 'everything re-read — nothing changed' });
        load(true);
        setTimeout(() => setSweep(null), 9000);
      })
      .catch(() => { setSweep({ note: 'could not refresh' }); setTimeout(() => setSweep(null), 5000); });

    fetch('/api/refresh-all', { method: 'POST', headers: authHeaders(auth?.token) })
      .then(r => r.json())
      .then(d => { setSweep({ step: d.busy ? 'already running' : (d.step || 'starting') }); setTimeout(poll, 1500); })
      .catch(() => setSweep({ note: 'could not start a refresh' }));
  }, [auth, load]);

  // Acting on something takes it off the list here and now. Waiting for the
  // next scheduled rebuild to notice you replied is how the old flow sent you
  // back to a regenerate button.
  const finish = useCallback((t) => {
    setData(d => ({
      ...d,
      categories: d.categories
        .map(c => ({ ...c, items: (c.items || []).filter(i => i.id !== t.id) }))
        .filter(c => c.items.length),
    }));
    fetch(`/api/tasks/${t.id}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ done: true, kind: t.kind, from: t.from }),
    }).catch(() => {});
  }, [auth]);

  // Quiet background refresh, and again whenever the app is brought forward.
  useEffect(() => {
    const t = setInterval(() => load(true), REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100dvh', display: 'flex', flexDirection: 'column',
                  background: C.bg, color: C.text1, overflow: 'hidden' }}>
      <style>{BACKDROP_CSS}</style>
      <DitherField />
      <CrtLayers />

      <header style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center',
                       gap: SP[3], flexWrap: 'wrap', padding: `max(${SP[4]}px, env(safe-area-inset-top)) ${SP[4]}px ${SP[3]}px` }}>
        <div style={{ fontFamily: FONT.mono, fontSize: FS.ui, letterSpacing: '.14em',
                      textTransform: 'uppercase', color: C.text1, whiteSpace: 'nowrap' }}>
          <span style={{ color: C.amber }}>vita</span> switch
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={refreshAll} disabled={!!sweep?.step}
          style={{ appearance: 'none', cursor: sweep?.step ? 'default' : 'pointer',
                   fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.1em',
                   textTransform: 'uppercase', padding: '7px 10px', minHeight: 32,
                   border: `1px solid ${sweep?.step ? C.amber : C.border}`,
                   background: 'transparent', color: sweep?.step ? C.amber : C.text2,
                   whiteSpace: 'nowrap' }}>
          {sweep?.step ? `⟳ ${sweep.step}` : '⟳ refresh all data'}
        </button>
        {/* The rail covers this at desktop width; under 1024px it's hidden, so
            the other tabs need a way out of here. */}
        <nav className="rv-head-nav" style={{ display: 'flex', gap: 1 }}>
          {PILL.map(([key, label]) => (
            <button key={key} type="button" onClick={() => go[key]?.()} style={{
              appearance: 'none', cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.label,
              letterSpacing: '.1em', textTransform: 'uppercase', padding: '7px 9px', minHeight: 32,
              border: `1px solid ${C.border}`, background: 'transparent', color: C.text3,
            }}>{label}</button>
          ))}
        </nav>
      </header>

      {sweep?.note && (
        <div style={{ position: 'relative', zIndex: 2, padding: `0 ${SP[4]}px ${SP[2]}px`,
                      fontFamily: FONT.sans, fontSize: FS.meta, color: C.text2 }}>
          {sweep.note}
        </div>
      )}

      {/* Phone only - at desktop width the rail carries these. */}
      <div style={{ position: 'relative', zIndex: 2, padding: `0 ${SP[4]}px` }}>
        <TopicStrip topics={topics} onView={onView} />
      </div>

      <main style={{ position: 'relative', zIndex: 2, flex: 1, minHeight: 0,
                     padding: `0 ${SP[4]}px calc(${SP[4]}px + env(safe-area-inset-bottom) * .5)`,
                     display: 'flex' }}>
        {phase === 'loading'
          ? <div style={{ margin: 'auto', fontFamily: FONT.sans, fontSize: FS.body, color: C.text3 }}>reading everything…</div>
          : <TriPane categories={data.categories} actions={data.actions} scannedAt={data.scannedAt}
                     auth={auth} onDone={finish} onOpenBrowser={onOpenBrowser}
                     onOpenChat={onDraftReply} />}
      </main>
    </div>
  );
}
