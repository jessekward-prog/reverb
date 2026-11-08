import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { C, FS, FONT, SP } from '../lib/design.js';
import { KINDS } from '../lib/kinds.js';
import ActionBand from './ActionBand.jsx';

// Vita Switch: work on the left, life on the right, and the feed down the
// middle so nothing is hidden behind a tab. The side panes are the full list
// for each half of the day; the centre is what actually wants doing, drawn
// from both and tagged so you can always see which world a row belongs to.
//
// On a phone three columns is a lie, so it collapses to one and the segmented
// control picks which pane you are looking at.

const daysOpen = iso => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0);

// "today" means something you'd act on today: overdue, due today, or said today.
const TODAYISH = /^(today|now|just now|\d+\s*(m|min|h|hr)|overdue)/i;
function scopeOf(t) {
  if (t.overdue) return 'today';
  const w = String(t.when || '').toLowerCase();
  if (TODAYISH.test(w)) return 'today';
  if (/tomorrow|mon|tue|wed|thu|fri|sat|sun/i.test(w)) return 'week';
  return 'later';
}

function Tag({ bucket }) {
  const work = bucket === 'work';
  return (
    <span style={{
      fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em', textTransform: 'uppercase',
      color: work ? C.amber : '#8fa8c4', border: `1px solid ${work ? C.amber : '#8fa8c4'}`,
      borderRadius: 4, padding: '1px 5px', flex: 'none', opacity: .85,
    }}>{work ? 'work' : 'life'}</span>
  );
}

// One line in a pane. Deliberately not the full card: these columns are for
// scanning, and the card view is a click away.
function Row({ t, showTag, onOpen }) {
  const k = KINDS[t.kind] || KINDS.email;
  const open = daysOpen(t.firstSeenAt);
  return (
    <motion.button
      type="button" onClick={() => onOpen?.(t)} whileTap={{ scale: 0.99 }}
      style={{
        appearance: 'none', width: '100%', textAlign: 'left', cursor: 'pointer',
        background: 'none', border: 0, borderBottom: `1px solid ${C.border}`,
        padding: `${SP[3]}px ${SP[1]}px`, display: 'flex', flexDirection: 'column', gap: SP[1],
        fontFamily: 'inherit', minHeight: 44,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none',
                       background: t.overdue ? C.danger : k.tint }} />
        <span style={{ flex: 1, fontFamily: FONT.sans, fontSize: FS.body, lineHeight: 1.4,
                       color: C.text1, textTransform: 'none',
                       display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                       overflow: 'hidden' }}>{t.text}</span>
        {showTag && <Tag bucket={t.bucket} />}
      </div>
      <div style={{ display: 'flex', gap: SP[2], fontFamily: FONT.mono, fontSize: FS.label,
                    color: C.text3, textTransform: 'none', paddingLeft: 14 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.from}</span>
        {t.when && <span style={{ flex: 'none', color: t.overdue ? C.danger : C.text3 }}>· {t.when}</span>}
        {open >= 2 && <span style={{ flex: 'none', color: C.amber }}>· {open}d</span>}
      </div>
    </motion.button>
  );
}

function Pane({ title, accent, items, filters, filter, setFilter, showTag, onOpen, empty }) {
  return (
    <section style={{
      border: `1px solid ${C.border}`, borderRadius: C.radius, background: C.surface,
      display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
    }}>
      <header style={{ padding: `${SP[3]}px ${SP[3]}px ${SP[2]}px`, borderBottom: `1px solid ${C.border}`,
                       display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: accent, flex: 'none' }} />
          <h2 style={{ margin: 0, fontFamily: FONT.sans, fontSize: FS.head, fontWeight: 600,
                       color: accent, textTransform: 'none', letterSpacing: 0 }}>{title}</h2>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: FONT.mono, fontSize: FS.label, color: C.text3 }}>{items.length}</span>
        </div>
        {filters.length > 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[1] }}>
            {filters.map(f => (
              <button key={f} type="button" onClick={() => setFilter(f)} style={{
                appearance: 'none', cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.label,
                letterSpacing: '.06em', textTransform: 'lowercase', borderRadius: 4,
                padding: '4px 7px', minHeight: 28,
                border: `1px solid ${filter === f ? accent : C.border}`,
                background: filter === f ? C.amberDim : 'transparent',
                color: filter === f ? accent : C.text3,
              }}>{f}</button>
            ))}
          </div>
        )}
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: `0 ${SP[3]}px ${SP[3]}px`, scrollbarWidth: 'none' }}>
        {items.length === 0
          ? <div style={{ padding: `${SP[5]}px 0`, textAlign: 'center', fontFamily: FONT.sans,
                          fontSize: FS.body, color: C.text3 }}>{empty}</div>
          : items.map(t => <Row key={t.id} t={t} showTag={showTag} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

const SCOPES = ['today', 'week', 'all'];

export default function TriPane({ categories = [], actions = [], scannedAt, onOpen }) {
  const [scope, setScope] = useState('all');
  const [workFilter, setWorkFilter] = useState('all');
  const [lifeFilter, setLifeFilter] = useState('all');
  const [pane, setPane] = useState('feed'); // phone only

  const all = useMemo(
    () => categories.flatMap(c => (c.items || []).map(t => ({ ...t, category: c.label }))),
    [categories]);

  const inScope = useMemo(() => {
    if (scope === 'all') return all;
    if (scope === 'today') return all.filter(t => scopeOf(t) === 'today');
    return all.filter(t => scopeOf(t) !== 'later');
  }, [all, scope]);

  const work = inScope.filter(t => t.bucket === 'work');
  const life = inScope.filter(t => t.bucket !== 'work');

  const catsOf = rows => ['all', ...[...new Set(rows.map(t => t.category))].filter(Boolean)];
  const byFilter = (rows, f) => (f === 'all' ? rows : rows.filter(t => t.category === f));

  // The middle is ranked, not grouped: overdue first, then oldest-waiting.
  const feed = useMemo(() => [...inScope].sort((a, b) =>
    (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0) || daysOpen(b.firstSeenAt) - daysOpen(a.firstSeenAt)
  ), [inScope]);

  const panes = {
    work: <Pane title="switch" accent={C.amber} items={byFilter(work, workFilter)}
                filters={catsOf(work)} filter={workFilter} setFilter={setWorkFilter}
                onOpen={onOpen} empty="work is clear" />,
    feed: (
      <section style={{ border: `1px solid ${C.borderHi}`, borderRadius: C.radius, background: C.surface,
                        display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <header style={{ padding: `${SP[3]}px`, borderBottom: `1px solid ${C.border}`,
                         display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <h2 style={{ margin: 0, fontFamily: FONT.sans, fontSize: FS.head, fontWeight: 600,
                       color: C.text1, textTransform: 'none', letterSpacing: 0 }}>to do</h2>
          <span style={{ flex: 1 }} />
          {SCOPES.map(sc => (
            <button key={sc} type="button" onClick={() => setScope(sc)} style={{
              appearance: 'none', cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.label,
              letterSpacing: '.08em', textTransform: 'uppercase', borderRadius: 4,
              padding: '5px 8px', minHeight: 30,
              border: `1px solid ${scope === sc ? C.text1 : C.border}`,
              background: scope === sc ? C.surface2 : 'transparent',
              color: scope === sc ? C.text1 : C.text3,
            }}>{sc}</button>
          ))}
        </header>
        <div style={{ flex: 1, overflowY: 'auto', padding: `${SP[3]}px`, scrollbarWidth: 'none' }}>
          <ActionBand actions={actions} />
          {feed.length === 0
            ? <div style={{ padding: `${SP[6]}px 0`, textAlign: 'center', fontFamily: FONT.sans,
                            fontSize: FS.body, color: C.text3 }}>nothing in this window</div>
            : feed.map(t => <Row key={t.id} t={t} showTag onOpen={onOpen} />)}
        </div>
      </section>
    ),
    life: <Pane title="vita" accent="#8fa8c4" items={byFilter(life, lifeFilter)}
                filters={catsOf(life)} filter={lifeFilter} setFilter={setLifeFilter}
                onOpen={onOpen} empty="nothing personal waiting" />,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], minHeight: 0, flex: 1 }}>
      {/* phone: one pane at a time */}
      <div className="vs-switcher" style={{ display: 'none', gap: 1 }}>
        {['work', 'feed', 'life'].map(p => (
          <button key={p} type="button" onClick={() => setPane(p)} style={{
            appearance: 'none', flex: 1, cursor: 'pointer', fontFamily: FONT.mono, fontSize: FS.ui,
            letterSpacing: '.08em', textTransform: 'uppercase', padding: '10px 6px', minHeight: 44,
            border: `1px solid ${pane === p ? C.text1 : C.border}`,
            background: pane === p ? C.surface2 : C.surface,
            color: pane === p ? C.text1 : C.text3,
          }}>{p === 'work' ? 'switch' : p === 'life' ? 'vita' : 'to do'}</button>
        ))}
      </div>

      <div className="vs-grid" data-active={pane} style={{ display: 'grid', gap: SP[3], minHeight: 0, flex: 1 }}>
        <div className="vs-col vs-work">{panes.work}</div>
        <div className="vs-col vs-feed">{panes.feed}</div>
        <div className="vs-col vs-life">{panes.life}</div>
      </div>

      {scannedAt && (
        <div style={{ fontFamily: FONT.mono, fontSize: FS.label, color: C.text3, textAlign: 'right' }}>
          updated {new Date(scannedAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}
        </div>
      )}
      <style>{`
        .vs-grid { grid-template-columns: minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr); }
        .vs-col { display: flex; flex-direction: column; min-height: 0; }
        .vs-col > section { flex: 1; min-height: 0; }
        /* Three columns is a lie on a phone: show one, chosen by the switcher. */
        @media (max-width: 1000px) {
          .vs-switcher { display: flex !important; }
          .vs-grid { grid-template-columns: minmax(0,1fr); }
          .vs-col { display: none; }
          .vs-grid[data-active="work"] .vs-work,
          .vs-grid[data-active="feed"] .vs-feed,
          .vs-grid[data-active="life"] .vs-life { display: flex; }
        }
      `}</style>
    </div>
  );
}
