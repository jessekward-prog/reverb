import React from 'react';
import { INK, AMBER, EDGE, HAIR, RAISED, FILM } from './CrtBackdrop.jsx';

// Desktop-only left rail, in the shelf-cmd mould: a fixed 240px column of nav
// rows beside the content, instead of the top pill the views carry on mobile.
// Hidden below 1024px by .nav-rail's `hidden lg:flex` (see style.css); the
// per-view pill is hidden ABOVE 1024px, so exactly one is visible at any width.
const ITEMS = [
  { key: 'work',  label: 'work',  hint: 'things to do' },
  { key: 'life',  label: 'life',  hint: 'personal' },
  { key: 'sweep', label: 'sweep', hint: 'pull + generate' },
  { key: 'texts', label: 'texts', hint: 'message threads' },
  { key: 'chat',  label: 'chat',  hint: 'ask reverb' },
];

function Row({ item, active, onClick, outstanding }) {
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
      {/* the aging nudge rides on the work tab — the only place items accumulate */}
      {item.key === 'work' && outstanding > 0 && (
        <span style={{
          flex: 'none', minWidth: 18, textAlign: 'center', fontSize: 10,
          color: AMBER, border: `1px solid ${AMBER}`, padding: '1px 5px', letterSpacing: 0,
        }}>{outstanding}</span>
      )}
    </button>
  );
}

export default function NavRail({ active, onView, onLockout, outstanding = 0 }) {
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
        <div style={{ color: AMBER, fontWeight: 700, letterSpacing: '.28em', fontSize: 13 }}>// REVERB</div>
        <div style={{ color: 'rgba(232,232,228,.4)', fontSize: 10, letterSpacing: '.1em' }}>assistant</div>
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', paddingTop: 6 }}>
        {ITEMS.map(it => (
          <Row key={it.key} item={it} active={active === it.key}
               outstanding={outstanding} onClick={() => onView?.(it.key)} />
        ))}
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
