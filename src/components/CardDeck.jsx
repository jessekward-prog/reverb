import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform, useReducedMotion } from 'framer-motion';
import ItemCard, { SHELF } from './ItemCard.jsx';

// Focus mode: one pile, one card at a time. Swipe right = done, swipe left =
// skip (back of the deck). Ignore and add-to-cal stay deliberate buttons - a
// mis-flick should never silently drop a real customer's job, so the only
// destructive gesture is the one marking work finished, and it's undoable.
//
// ponytail: the queue is local to the deck rather than derived from props, so
// the parent re-fetching (which undo does) can't reshuffle the pile you're
// halfway through. Ceiling: cards added to the category while you're in it
// appear next time you enter.

const SWIPE_X = 110;   // px past which a release commits
const SWIPE_V = 600;   // or this much flick velocity, for a short fast swipe
const BEHIND = 2;      // cards drawn under the top one, for depth

const haptic = {
  tap:     () => navigator.vibrate?.(15),
  success: () => navigator.vibrate?.([20, 40, 30]),
  soft:    () => navigator.vibrate?.(10),
};

export default function CardDeck({
  categories, tints, context, calState, initialLabel = null,
  onDone, onIgnore, onAddToCal, onLoadContext, onDraftReply, onUndo, onExit,
}) {
  const [label, setLabel] = useState(initialLabel);
  const [queue, setQueue] = useState([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [undoable, setUndoable] = useState(null);
  const [exitDir, setExitDir] = useState(0);
  const dragged = useRef(false);
  const undoTimer = useRef(null);
  const reduce = useReducedMotion();

  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 0, 240], reduce ? [0, 0, 0] : [-13, 0, 13]);
  const doneGlow = useTransform(x, [30, 140], [0, 1]);
  const skipGlow = useTransform(x, [-140, -30], [1, 0]);

  const category = categories.find(c => c.label === label) || null;
  const tintOf = i => tints[i % tints.length];
  const tint = category ? tintOf(categories.findIndex(c => c.label === label)) : SHELF.accent;

  // Snapshot the pile on entry so a parent re-fetch can't reshuffle it.
  function enter(c) {
    haptic.tap();
    setLabel(c.label);
    setQueue(c.items);
    setTotal(c.items.length);
    setExpanded(false);
  }
  function leave() {
    setLabel(null); setQueue([]); setExpanded(false); x.set(0);
    onExit?.();
  }

  // Entering straight from the grid's "focus" button.
  useEffect(() => {
    if (!initialLabel) return;
    const c = categories.find(x => x.label === initialLabel);
    if (c) enter(c);
  }, [initialLabel]);

  useEffect(() => () => clearTimeout(undoTimer.current), []);
  useEffect(() => { setExpanded(false); x.set(0); }, [queue[0]?.id]);

  const top = queue[0] || null;

  function advance(fn, dir) {
    if (!top) return;
    setExitDir(dir);
    fn?.(top);
    setQueue(q => q.slice(1));
    x.set(0);
  }

  function commitDone() {
    if (!top) return;
    haptic.success();
    const item = top;
    advance(onDone, 1);
    setUndoable(item);
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoable(null), 6000);
  }

  function commitSkip() {
    if (!top) return;
    haptic.soft();
    setExitDir(-1);
    setQueue(q => (q.length > 1 ? [...q.slice(1), q[0]] : q));
    x.set(0);
  }

  function commitIgnore() {
    if (!top) return;
    haptic.soft();
    advance(onIgnore, -1);
  }

  function undo() {
    if (!undoable) return;
    haptic.tap();
    onUndo?.(undoable);
    setQueue(q => [undoable, ...q]);
    setUndoable(null);
    clearTimeout(undoTimer.current);
  }

  function toggle() {
    if (dragged.current) { dragged.current = false; return; }
    const next = !expanded;
    setExpanded(next);
    if (next && top && (top.kind === 'sms' || top.kind === 'meta')) onLoadContext?.(top);
  }

  // ── Pile picker ───────────────────────────────────────────
  if (!category) {
    if (!categories.length) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase',
                      color: SHELF.text3 }}>pick a pile</div>
        {categories.map((c, ci) => (
          <motion.button
            key={c.label} type="button" onClick={() => enter(c)} whileTap={{ scale: 0.98 }}
            style={{
              appearance: 'none', border: `1px solid ${SHELF.border}`, borderRadius: SHELF.radius,
              background: SHELF.surface, color: SHELF.text1, fontFamily: 'inherit',
              textAlign: 'left', padding: '14px 15px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 7, minHeight: 44,
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: tintOf(ci), flex: 'none' }} />
              <div style={{ flex: 1, fontWeight: 700, color: SHELF.accent, textTransform: 'none' }}>{c.label}</div>
              <div style={{ color: SHELF.text3, fontSize: 11 }}>{String(c.items.length).padStart(2, '0')}</div>
            </div>
            {c.synopsis && (
              <div style={{ fontSize: 11.5, lineHeight: 1.55, color: SHELF.text2,
                            textTransform: 'none', textWrap: 'pretty', paddingLeft: 17 }}>
                {c.synopsis}
              </div>
            )}
          </motion.button>
        ))}
      </div>
    );
  }

  const isText = top && (top.kind === 'sms' || top.kind === 'meta');
  const cal = top ? calState[top.id] : null;
  const seat = total - queue.length + 1;
  const ghost = {
    appearance: 'none', border: `1px solid ${SHELF.border}`, borderRadius: 6,
    background: SHELF.surface, color: SHELF.text1, fontFamily: 'inherit',
    fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase',
    padding: '12px 10px', minHeight: 44, cursor: 'pointer', flex: 1,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" onClick={leave} style={{ ...ghost, flex: 'none', minHeight: 34, padding: '8px 11px' }}>
          ← piles
        </button>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: tint, flex: 'none' }} />
        <div style={{ flex: 1, fontWeight: 700, color: SHELF.accent, textTransform: 'none',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {category.label}
        </div>
        <div style={{ color: SHELF.text3, fontSize: 11, flex: 'none' }}>
          {queue.length ? `${seat} of ${total}` : `${total} of ${total}`}
        </div>
      </div>

      <div style={{ height: 2, background: SHELF.border, borderRadius: 2, position: 'relative' }}>
        <motion.div
          animate={{ width: `${total ? ((total - queue.length) / total) * 100 : 100}%` }}
          transition={{ duration: reduce ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
          style={{ position: 'absolute', inset: 0, background: tint, borderRadius: 2 }} />
      </div>

      {queue.length > 0 ? (
        // overflow hidden so a card dragged past the edge can't widen the page
        // paddingBottom gives the stacked cards' overhang somewhere to show:
        // overflow:hidden clips at the padding edge, so without it the deck
        // reads as a single card rather than a pile.
        <div style={{ position: 'relative', overflow: 'hidden', borderRadius: SHELF.radius,
                      paddingBottom: 18 }}>
          {/* Intent badges live here, NOT on the card - anchored to the space the
              card vacates, so they stay on screen instead of sliding off with it. */}
          <motion.div style={{ opacity: doneGlow, position: 'absolute', top: '50%', left: 14, zIndex: 2,
                               y: '-50%', color: SHELF.accent, fontSize: 11, letterSpacing: '.12em',
                               fontWeight: 700, border: `1px solid ${SHELF.accent}`, borderRadius: 6,
                               background: '#000', padding: '7px 10px', pointerEvents: 'none' }}>
            DONE ✓
          </motion.div>
          <motion.div style={{ opacity: skipGlow, position: 'absolute', top: '50%', right: 14, zIndex: 2,
                               y: '-50%', color: SHELF.text1, fontSize: 11, letterSpacing: '.12em',
                               fontWeight: 700, border: `1px solid ${SHELF.borderHi}`, borderRadius: 6,
                               background: '#000', padding: '7px 10px', pointerEvents: 'none' }}>
            ↻ SKIP
          </motion.div>

          {/* The next card shows through dimmed, so the space under the top card
              reads as a deck rather than an empty box. */}
          {queue.slice(1, 1 + BEHIND).map((t, i) => (
            <div key={t.id} aria-hidden style={{
              position: 'absolute', left: 0, right: 0, top: 0, bottom: 18, zIndex: 0,
              overflow: 'hidden', transformOrigin: 'top center',
              transform: `translateY(${(i + 1) * 9}px) scale(${1 - (i + 1) * 0.025})`,
              opacity: .5 - i * 0.2,
            }}>
              {i === 0 && <ItemCard t={t} tint={tint} expanded={false} entry={null} cal={null}
                                    onToggle={() => {}} style={{ height: '100%' }} />}
            </div>
          ))}

          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={top.id}
              drag={expanded ? false : 'x'}
              dragSnapToOrigin
              dragElastic={0.5}
              style={{ x, rotate, position: 'relative', zIndex: 1, touchAction: 'pan-y' }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { x: exitDir * 420, opacity: 0, transition: { duration: 0.22 } }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              onDragStart={() => { dragged.current = true; }}
              onDragEnd={(e, info) => {
                const far = info.offset.x, fast = info.velocity.x;
                if (far > SWIPE_X || fast > SWIPE_V) commitDone();
                else if (far < -SWIPE_X || fast < -SWIPE_V) commitSkip();
                else x.set(0);
                setTimeout(() => { dragged.current = false; }, 0);
              }}
            >
              <ItemCard t={top} tint={tint} expanded={expanded} entry={context[top.id]}
                        cal={cal} onToggle={toggle} bodyMax={6}
                        style={{ borderColor: SHELF.borderHi }}
                        actions={[
                          { label: expanded ? 'close' : (isText ? 'thread' : 'details'), onPress: toggle },
                          ...(top.reply ? [{ label: 'reply', onPress: () => onDraftReply?.(top) }] : []),
                          ...(isText ? [{ label: cal === 'adding' ? 'adding…' : 'add to cal',
                                          onPress: e => onAddToCal?.(top, e) }] : []),
                          { label: 'ignore', onPress: commitIgnore },
                        ]} />
            </motion.div>
          </AnimatePresence>
        </div>
      ) : (
        <div style={{ border: `1px solid ${SHELF.border}`, borderRadius: SHELF.radius,
                      background: SHELF.surface, padding: '30px 18px', textAlign: 'center',
                      display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ color: SHELF.accent, fontWeight: 700, textTransform: 'none' }}>pile cleared</div>
          <div style={{ fontSize: 11.5, color: SHELF.text2, textTransform: 'none' }}>
            {category.label} — nothing left to deal with.
          </div>
          <button type="button" onClick={leave} style={{ ...ghost, flex: 'none', alignSelf: 'center' }}>
            ← back to the piles
          </button>
        </div>
      )}

      {/* Swipe is the shortcut, not the only way in: desktop has no swipe, and
          the card can't be dragged while the thread is open. */}
      {queue.length > 0 && (
        <div style={{ display: 'flex', gap: 10,
                      paddingBottom: 'calc(env(safe-area-inset-bottom) * 0.5)' }}>
          <button type="button" onClick={commitSkip} style={ghost}>↻ skip</button>
          <button type="button" onClick={commitDone} style={{
            ...ghost, background: SHELF.accent, color: '#000', fontWeight: 700,
            border: `1px solid ${SHELF.accent}`,
          }}>done ✓</button>
        </div>
      )}

      <AnimatePresence>
        {undoable && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
                     border: `1px solid ${SHELF.borderHi}`, borderRadius: SHELF.radius,
                     background: SHELF.surface }}>
            <div style={{ flex: 1, fontSize: 11, color: SHELF.text2, textTransform: 'none' }}>marked done</div>
            <button type="button" onClick={undo} style={{
              ...ghost, flex: 'none', minHeight: 34, padding: '8px 12px', color: SHELF.accent,
            }}>undo</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
