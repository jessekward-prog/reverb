import React, { useState } from 'react';
import { INK, AMBER, EDGE, HAIR, RAISED, FILM, WELL } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';

// Desktop-only left rail, in the shelf-cmd mould: a fixed 240px column of nav
// rows beside the content, instead of the top pill the views carry on mobile.
// Hidden below 1024px by .nav-rail's `hidden lg:flex` (see style.css); the
// per-view pill is hidden ABOVE 1024px, so exactly one is visible at any width.
const ITEMS = [
  { key: 'home',  label: 'vita switch', hint: 'everything at once' },
  { key: 'tasks', label: 'to-do', hint: 'the list' },
  { key: 'work',  label: 'work',  hint: 'business report' },
  { key: 'life',  label: 'life',  hint: 'personal report' },
  { key: 'sweep', label: 'sweep', hint: 'pull + generate' },
  { key: 'texts', label: 'texts', hint: 'message threads' },
  { key: 'browser', label: 'browser', hint: 'live logged-in tabs' },
  { key: 'chat',  label: 'chat',  hint: 'ask vita or switch' },
];

function Row({ item, active, onClick, outstanding, unread }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none', textAlign: 'left', cursor: 'pointer', width: '100%',
        display: 'flex', alignItems: 'center', gap: 10,
        border: 0, borderLeft: `2px solid ${active ? AMBER : 'transparent'}`,
        background: active ? FILM : 'transparent',
        color: active ? INK : 'rgba(232,232,228,.6)',
        fontFamily: 'inherit', fontSize: 12, letterSpacing: '.08em',
        textTransform: 'uppercase', padding: '11px 16px',
        transition: 'background .12s, color .12s',
      }}
    >
      <span style={{ color: active ? AMBER : 'rgba(232,232,228,.3)', width: 8 }}>{active ? '▸' : ''}</span>
      <span style={{ flex: 1 }}>{item.label}</span>
      {/* the chase nudge rides on the championed to-do tab — the one list that
          pushes you to clear what's been sitting */}
      {((item.key === 'home' || item.key === 'tasks') && outstanding > 0) || unread > 0 ? (
        <span style={{
          flex: 'none', minWidth: 18, textAlign: 'center', fontSize: 10,
          color: AMBER, border: `1px solid ${AMBER}`, padding: '1px 5px', letterSpacing: 0,
        }}>{unread > 0 ? unread : outstanding}</span>
      ) : null}
    </button>
  );
}

// The user's own tabs live under the fixed ones: subjects that must never be
// missed and belong to neither report - kinder, daycare, Peyton's school,
// receipts. Each carries its own unread count, because the point of a tab is
// to be able to glance at the rail and see that something new came in.
export default function NavRail({ active, onView, onLockout, outstanding = 0,
                                  topics = [], auth, onTopicsChanged }) {
  const [adding, setAdding] = useState(null);   // { label, patterns } | null
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);

  function create() {
    if (!adding?.label?.trim() || !adding?.patterns?.trim() || busy) return;
    setBusy(true); setErr(null);
    fetch('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify(adding),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setErr(d.error); return; }
        setAdding(null); onTopicsChanged?.(); onView?.(`topic:${d.slug}`);
      })
      .catch(() => setErr('could not create it'))
      .finally(() => setBusy(false));
  }

  const input = {
    width: '100%', boxSizing: 'border-box', background: WELL, color: INK,
    border: `1px solid ${HAIR}`, padding: '8px 9px', fontSize: 12, outline: 'none',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif', textTransform: 'none',
    letterSpacing: 'normal',
  };

  return (
    <aside className="nav-rail" style={{
      width: 240, flex: 'none', height: '100dvh', position: 'sticky', top: 0,
      background: RAISED, borderRight: `1px solid ${EDGE}`,
      flexDirection: 'column', overflow: 'hidden', zIndex: 5,
    }}>
      <div style={{
        padding: '20px 16px 16px', borderBottom: `1px solid ${HAIR}`,
        display: 'flex', flexDirection: 'column', gap: 3,
      }}>
        <div style={{ color: AMBER, fontWeight: 700, letterSpacing: '.28em', fontSize: 13 }}>// VITA SWITCH</div>
        <div style={{ color: 'rgba(232,232,228,.4)', fontSize: 10, letterSpacing: '.1em' }}>work + life</div>
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', paddingTop: 6 }}>
        {ITEMS.map(it => (
          <Row key={it.key} item={it} active={active === it.key}
               outstanding={outstanding} onClick={() => onView?.(it.key)} />
        ))}

        <div style={{ borderTop: `1px solid ${HAIR}`, margin: '10px 0 4px',
                      padding: '10px 16px 4px', color: 'rgba(232,232,228,.3)',
                      fontSize: 10, letterSpacing: '.14em' }}>my tabs</div>

        {topics.map(tp => (
          <Row key={tp.slug} item={{ key: `topic:${tp.slug}`, label: tp.label }}
               active={active === `topic:${tp.slug}`} unread={tp.unread}
               onClick={() => onView?.(`topic:${tp.slug}`)} />
        ))}

        {adding ? (
          <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <input autoFocus value={adding.label} placeholder="tab name — e.g. kinder"
                   onChange={e => setAdding(a => ({ ...a, label: e.target.value }))} style={input} />
            <input value={adding.patterns} placeholder="words to catch, comma separated"
                   onChange={e => setAdding(a => ({ ...a, patterns: e.target.value }))}
                   onKeyDown={e => e.key === 'Enter' && create()} style={input} />
            {err && <div style={{ color: 'rgba(255,120,110,.9)', fontSize: 10, textTransform: 'none',
                                  letterSpacing: 'normal' }}>{err}</div>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => { setAdding(null); setErr(null); }} style={{
                appearance: 'none', cursor: 'pointer', border: `1px solid ${HAIR}`, background: 'transparent',
                color: 'rgba(232,232,228,.5)', fontFamily: 'inherit', fontSize: 10,
                letterSpacing: '.08em', textTransform: 'uppercase', padding: '7px 9px',
              }}>cancel</button>
              <button type="button" onClick={create} disabled={busy} style={{
                flex: 1, appearance: 'none', cursor: 'pointer', border: `1px solid ${AMBER}`,
                background: AMBER, color: '#140d02', fontFamily: 'inherit', fontSize: 10,
                fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', padding: '7px 9px',
              }}>{busy ? 'filing…' : 'create'}</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding({ label: '', patterns: '' })} style={{
            appearance: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', border: 0,
            borderLeft: '2px solid transparent', background: 'transparent',
            color: 'rgba(232,232,228,.4)', fontFamily: 'inherit', fontSize: 12,
            letterSpacing: '.08em', textTransform: 'uppercase', padding: '11px 16px',
          }}>+ new tab</button>
        )}
      </nav>

      <button type="button" onClick={() => onLockout?.()} style={{
        appearance: 'none', cursor: 'pointer', border: 0, borderTop: `1px solid ${HAIR}`,
        background: 'transparent', color: 'rgba(232,232,228,.5)', fontFamily: 'inherit',
        fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase',
        padding: '14px 16px', textAlign: 'left',
      }}>↶ lock</button>
    </aside>
  );
}
