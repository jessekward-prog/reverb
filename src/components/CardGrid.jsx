import React from 'react';
import { motion } from 'framer-motion';
import ItemCard, { SHELF } from './ItemCard.jsx';
import TaskPanel from './TaskPanel.jsx';
import { C, FS, FONT } from '../lib/design.js';

// ShelfStation's card grid: everything visible at once, each card carrying its
// own actions. The default way to look at a report; the deck is the focus mode
// for working one pile down. Category grouping is kept (the synopsis is written
// per category and is the agent's read on the pile), with the legend dot that
// ShelfStation uses to tie a card back to its group.
//
// Opening a card hands it to TaskPanel - the same action surface the Vita
// Switch page uses. The old expanded card could only show you the thread and
// then send you elsewhere to act on it, and its add-to-cal dead-ended in an
// error whenever there was no conversation to read. One panel, so the two
// surfaces can't offer different things.
export default function CardGrid({
  categories, tints, auth, expandedId,
  onToggle, onDone, onIgnore, onOpenBrowser, onOpenChat, onFocus,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      {categories.map((c, ci) => {
        const tint = tints[ci % tints.length];
        return (
          <div key={`${c.label}-${ci}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: tint, flex: 'none' }} />
              <div style={{ fontWeight: 600, fontSize: FS.head, fontFamily: FONT.sans, color: SHELF.accent, textTransform: 'none', letterSpacing: '0' }}>{c.label}</div>
              <div style={{ color: SHELF.text3, fontSize: FS.meta }}>
                {c.items.length} {c.items.length === 1 ? 'card' : 'cards'}
              </div>
              <div style={{ flex: 1 }} />
              {/* Straight into the deck for just this pile - the grid is for
                  seeing everything, the deck for getting through it. */}
              <motion.button type="button" whileTap={{ scale: 0.96 }} onClick={() => onFocus?.(c, ci)}
                style={{
                  appearance: 'none', border: `1px solid ${SHELF.border}`, borderRadius: 6,
                  background: SHELF.surface, color: SHELF.text1, fontFamily: 'inherit',
                  fontSize: FS.label, letterSpacing: '.1em', textTransform: 'uppercase',
                  padding: '7px 11px', minHeight: 32, cursor: 'pointer',
                }}>focus →</motion.button>
            </div>

            {c.synopsis && (
              <div style={{ fontSize: FS.body, fontFamily: FONT.sans, lineHeight: 1.6, color: SHELF.text2,
                            textTransform: 'none', textWrap: 'pretty', paddingLeft: 17 }}>
                {c.synopsis}
              </div>
            )}

            <div style={{ display: 'grid', gap: 12,
                          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
              {c.items.map(t => (
                expandedId === t.id ? (
                  <div key={t.id} style={{ gridColumn: '1 / -1' }}>
                    <TaskPanel
                      t={t} auth={auth}
                      onClose={() => onToggle?.(t)}
                      onDone={item => onDone?.(item)}
                      onOpenBrowser={onOpenBrowser}
                      onOpenChat={onOpenChat} />
                  </div>
                ) : (
                  <ItemCard
                    key={t.id} t={t} tint={tint} expanded={false} entry={null} cal={null}
                    onToggle={() => onToggle?.(t)}
                    actions={[
                      { label: t.reply ? 'open · reply' : 'open', onPress: () => onToggle?.(t), strong: true },
                      { label: 'ignore', onPress: e => onIgnore?.(t, e) },
                      { label: 'done ✓', onPress: e => onDone?.(t, e) },
                    ]}
                  />
                )
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
