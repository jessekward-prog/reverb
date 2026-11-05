import React from 'react';
import { motion } from 'framer-motion';
import ItemCard, { SHELF } from './ItemCard.jsx';

// ShelfStation's card grid: everything visible at once, each card carrying its
// own actions. The default way to look at a report; the deck is the focus mode
// for working one pile down. Category grouping is kept (the synopsis is written
// per category and is the agent's read on the pile), with the legend dot that
// ShelfStation uses to tie a card back to its group.
export default function CardGrid({
  categories, tints, context, calState, expandedId,
  onToggle, onDone, onIgnore, onAddToCal, onDraftReply, onFocus,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      {categories.map((c, ci) => {
        const tint = tints[ci % tints.length];
        return (
          <div key={c.label} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: tint, flex: 'none' }} />
              <div style={{ fontWeight: 700, color: SHELF.accent, textTransform: 'none' }}>{c.label}</div>
              <div style={{ color: SHELF.text3, fontSize: 11 }}>
                {c.items.length} {c.items.length === 1 ? 'card' : 'cards'}
              </div>
              <div style={{ flex: 1 }} />
              {/* Straight into the deck for just this pile - the grid is for
                  seeing everything, the deck for getting through it. */}
              <motion.button type="button" whileTap={{ scale: 0.96 }} onClick={() => onFocus?.(c)}
                style={{
                  appearance: 'none', border: `1px solid ${SHELF.border}`, borderRadius: 6,
                  background: SHELF.surface, color: SHELF.text1, fontFamily: 'inherit',
                  fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase',
                  padding: '7px 11px', minHeight: 32, cursor: 'pointer',
                }}>focus →</motion.button>
            </div>

            {c.synopsis && (
              <div style={{ fontSize: 11.5, lineHeight: 1.55, color: SHELF.text2,
                            textTransform: 'none', textWrap: 'pretty', paddingLeft: 17 }}>
                {c.synopsis}
              </div>
            )}

            <div style={{ display: 'grid', gap: 12,
                          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {c.items.map(t => {
                const isText = t.kind === 'sms' || t.kind === 'meta';
                const expanded = expandedId === t.id;
                return (
                  <ItemCard
                    key={t.id} t={t} tint={tint} expanded={expanded}
                    entry={context[t.id]} cal={calState[t.id]}
                    onToggle={() => onToggle?.(t)}
                    style={expanded ? { gridColumn: '1 / -1', borderColor: SHELF.borderHi } : undefined}
                    actions={[
                      { label: expanded ? 'close' : (isText ? 'thread' : 'details'), onPress: () => onToggle?.(t) },
                      ...(t.reply ? [{ label: 'reply', onPress: () => onDraftReply?.(t) }] : []),
                      ...(isText ? [{ label: calState[t.id] === 'adding' ? 'adding…' : 'add to cal',
                                      onPress: e => onAddToCal?.(t, e) }] : []),
                      { label: 'ignore', onPress: e => onIgnore?.(t, e) },
                      { label: 'done ✓', onPress: e => onDone?.(t, e), strong: true },
                    ]}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
