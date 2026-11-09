import React, { useEffect, useRef, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER,
         EDGE, RULE, HAIR, WELL, RAISED, FILM, ROW, PANEL } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';
import CardDeck from './CardDeck.jsx';
import CardGrid from './CardGrid.jsx';
import ActionBand from './ActionBand.jsx';

const CONTENT_MAX = 700; // matches Chat/Sweep so the nav pill lands in the same spot

const CSS = BACKDROP_CSS + `
@keyframes rv-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes rv-rise  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
.report-scroll::-webkit-scrollbar { width:0 }
/* Reduced motion means gentler, not zero: keep the fade that explains an item
   arriving, drop the movement. */
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .2s !important; }
  @keyframes rv-rise { from { opacity:0 } to { opacity:1 } }
}
`;

// Rotate through a small palette for category headers since labels are
// LLM-chosen and open-ended, not a fixed set.
const TINTS = [AMBER, '#8fa8c4', '#7fbf8f', '#c48fb0', '#9fb0a8', '#c4a35f'];

// Whole days an item has been surfaced without being actioned. Null under a day,
// so a fresh item carries no badge; at/over two days it's the chase threshold.
const CHASE_DAYS = 2;
function daysOpen(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function timeAgo(iso) {
  if (!iso) return null;
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const TIER_OPTIONS = [
  { value: null,     label: 'auto' },
  { value: 'vip',    label: 'vip' },
  { value: 'normal', label: 'normal' },
  { value: 'muted',  label: 'muted' },
];

// Manual override list for Reverb's contact memory — auto (derived from
// seen/reply/dismiss counts) vs a pinned vip/normal/muted. Shared between
// Work and Life since it's contact-level, not report-level.
function PeopleDrawer({ open, auth, onClose }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch('/api/contacts', { headers: authHeaders(auth?.token) })
      .then(r => r.json())
      .then(rows => setContacts(Array.isArray(rows) ? rows : []))
      .catch(() => setContacts([]))
      .finally(() => setLoading(false));
  }, [open, auth]);

  function setTier(id, tier) {
    setContacts(prev => prev.map(c => c.id === id ? { ...c, tier } : c));
    fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ tier }),
    }).catch(() => {});
  }

  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0,0,0,.6)',
                                     display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(360px, 92vw)', height: '100%', background: RAISED,
        borderLeft: `1px solid ${EDGE}`, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '18px 16px', borderBottom: `1px solid ${RULE}` }}>
          <div style={{ fontWeight: 700 }}>// people</div>
          <button type="button" onClick={onClose} style={{ appearance: 'none', border: 0, background: 'none',
                                                            color: INK, fontFamily: 'inherit', fontSize: 14, cursor: 'pointer' }}>&#10005;</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && <div style={{ padding: 16, opacity: .4 }}>loading…</div>}
          {!loading && !contacts.length && <div style={{ padding: 16, opacity: .4, textTransform: 'none' }}>nobody tracked yet — run a scan</div>}
          {contacts.map(c => (
            <div key={c.id} style={{ padding: ROW, borderBottom: `1px solid ${HAIR}` }}>
              <div style={{ fontSize: 12, textTransform: 'none', overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap' }}>{c.display_name || c.identifier}</div>
              <div style={{ fontSize: 9.5, opacity: .4, marginTop: 2 }}>
                {c.kind} · seen {c.seen_count} · replied {c.replied_count} · dismissed {c.dismissed_count}
              </div>
              <div style={{ display: 'flex', gap: 1, marginTop: 8, background: RULE,
                            border: `1px solid ${RULE}` }}>
                {TIER_OPTIONS.map(opt => (
                  <button key={opt.label} type="button" onClick={() => setTier(c.id, opt.value)} style={{
                    appearance: 'none', flex: 1, border: 0, margin: 0, cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: 9.5, letterSpacing: '.06em', padding: '7px 4px',
                    background: c.tier === opt.value ? 'rgba(217,147,47,.22)' : WELL,
                    color: c.tier === opt.value ? AMBER : INK,
                  }}>{opt.label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// "emails from these guys must be a priority" / "ignore emails from this
// address" — plain patterns, matched by substring in server.js's matchRules
// when the report is assembled (annotateGrounded), the same point muted
// contacts get dropped and VIPs flagged. No LLM involved in matching, so a
// rule always sticks: priority floats the item up the to-do list, ignore drops
// it entirely.
function RulesDrawer({ open, auth, onClose }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState('priority');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch('/api/rules', { headers: authHeaders(auth?.token) })
      .then(r => r.json())
      .then(rows => setRules(Array.isArray(rows) ? rows : []))
      .catch(() => setRules([]))
      .finally(() => setLoading(false));
  }, [open, auth]);

  async function addRule(e) {
    e.preventDefault();
    const p = pattern.trim();
    if (!p) return;
    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
        body: JSON.stringify({ pattern: p, action }),
      });
      if (!res.ok) return;
      const row = await res.json();
      setRules(prev => [row, ...prev]);
      setPattern('');
    } catch { /* leave the input as-is, nothing was saved */ }
  }

  function removeRule(id) {
    setRules(prev => prev.filter(r => r.id !== id));
    fetch(`/api/rules/${id}`, { method: 'DELETE', headers: authHeaders(auth?.token) }).catch(() => {});
  }

  if (!open) return null;
  const inputStyle = {
    appearance: 'none', border: `1px solid ${EDGE}`, background: WELL,
    color: INK, fontFamily: 'inherit', fontSize: 12, textTransform: 'none',
    padding: '9px 10px', width: '100%', boxSizing: 'border-box',
  };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0,0,0,.6)',
                                     display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(360px, 92vw)', height: '100%', background: RAISED,
        borderLeft: `1px solid ${EDGE}`, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '18px 16px', borderBottom: `1px solid ${RULE}` }}>
          <div style={{ fontWeight: 700 }}>// rules</div>
          <button type="button" onClick={onClose} style={{ appearance: 'none', border: 0, background: 'none',
                                                            color: INK, fontFamily: 'inherit', fontSize: 14, cursor: 'pointer' }}>&#10005;</button>
        </div>

        <form onSubmit={addRule} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
                                          borderBottom: `1px solid ${RULE}` }}>
          <input value={pattern} onChange={e => setPattern(e.target.value)} style={inputStyle}
                 placeholder="e.g. awm.com.au, or a name/address" />
          <div style={{ display: 'flex', gap: 1, background: RULE, border: `1px solid ${RULE}` }}>
            {['priority', 'ignore'].map(a => (
              <button key={a} type="button" onClick={() => setAction(a)} style={{
                appearance: 'none', flex: 1, border: 0, margin: 0, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', padding: '9px 4px',
                background: action === a ? 'rgba(217,147,47,.22)' : WELL,
                color: action === a ? AMBER : INK,
              }}>{a}</button>
            ))}
          </div>
          <button type="submit" disabled={!pattern.trim()} style={{
            appearance: 'none', border: '1px solid rgba(217,147,47,.55)', background: 'rgba(217,147,47,.09)',
            color: INK, fontFamily: 'inherit', fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase',
            padding: '11px', cursor: pattern.trim() ? 'pointer' : 'default', opacity: pattern.trim() ? 1 : .4,
          }}>add rule</button>
        </form>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && <div style={{ padding: 16, opacity: .4 }}>loading…</div>}
          {!loading && !rules.length && <div style={{ padding: 16, opacity: .4, textTransform: 'none' }}>no rules yet</div>}
          {rules.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
                                     padding: ROW, borderBottom: `1px solid ${HAIR}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, textTransform: 'none', overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap' }}>{r.pattern}</div>
                <div style={{ fontSize: 9.5, opacity: .4, marginTop: 2, color: r.action === 'priority' ? AMBER : undefined }}>
                  {r.action}
                </div>
              </div>
              <button type="button" onClick={() => removeRule(r.id)} style={{
                appearance: 'none', border: 0, background: 'none', color: INK, opacity: .5,
                fontFamily: 'inherit', fontSize: 13, cursor: 'pointer', flex: 'none', padding: 4,
              }}>&#10005;</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Shared by WorkView and LifeView — both are read-only digests of a
// persisted report (work_summary / life_summary), regenerated only from
// Sweep's Pull Data -> Generate Report flow, not from a button in here.
export default function ReportView({
  auth, onLockout, active, title, apiPath, emptyHint,
  onOpenChat, onOpenSweep, onOpenTasks, onOpenWork, onOpenLife, onOpenTexts, onOpenBrowser, onDraftReply,
}) {
  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready'
  const [summary, setSummary] = useState('');
  const [categories, setCategories] = useState([]);
  const [actions, setActions] = useState([]);
  const [scannedAt, setScannedAt] = useState(null);
  const [outstanding, setOutstanding] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [toast, setToast] = useState('');
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Deck is the normal way to work through a pile one card at a time; the list
  // stays for scanning everything at once. Remembered so it isn't re-picked
  // every visit.
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('reverb.reportMode') || 'grid'; } catch { return 'grid'; }
  });
  const [focusIndex, setFocusIndex] = useState(null);
  function pickMode(m) {
    setMode(m);
    try { localStorage.setItem('reverb.reportMode', m); } catch { /* private mode */ }
  }
  const toastTimer = useRef(null);

  function say(text) {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  }

  function load() {
    setPhase('loading');
    return fetch(apiPath, { headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(data => {
        setSummary(data.summary || '');
        setCategories(data.categories || []);
        setActions(Array.isArray(data.actions) ? data.actions : []);
        setScannedAt(data.scannedAt || null);
        setOutstanding(data.outstanding || 0);
        setPhase('ready');
      })
      .catch(() => setPhase('ready'));
  }

  // Re-run the report over the current live items, in place — no trip to Sweep.
  // This is what applies a changed method (new rules, the per-category synopsis)
  // to the existing list: /api/report/generate re-collects and re-groups, then
  // we reload whatever this tab shows (/api/tasks, /api/work, /api/life).
  function regenerate() {
    if (regenerating) return;
    setRegenerating(true);
    say('regenerating — reading everything again…');
    fetch('/api/report/generate', { method: 'POST', headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(() => load())
      .then(() => say('report regenerated'))
      .catch(() => say('regenerate failed — try again'))
      .finally(() => setRegenerating(false));
  }

  useEffect(() => {
    load();
    return () => clearTimeout(toastTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiPath]);

  // task given -> "done" (handled): also nudges the sender's contact memory.
  // task null -> "ignore this one": drops just this notification, no contact
  // signal and no standing rule, so the conversation stays active and a later,
  // different message from them still shows. Both hide the item by its content
  // hash, so this exact notification won't come back.
  function dismiss(id, task, e) {
    e?.stopPropagation();
    setCategories(prev => prev
      .map(c => ({ ...c, items: c.items.filter(t => t.id !== id) }))
      .filter(c => c.items.length));
    if (expandedId === id) setExpandedId(null);
    fetch(`${apiPath}/${id}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ done: true, kind: task?.kind, from: task?.from }),
    }).catch(() => {});
  }
  const ignore = (id, e) => dismiss(id, null, e);

  // Undo a "done" from the deck: the endpoint already un-dismisses on
  // done:false, so this just reverses it and re-reads. (The sender's contact
  // counter keeps the dismiss nudge — it's a soft signal, not worth a second
  // endpoint to unwind.)
  function undoDone(t) {
    fetch(`${apiPath}/${t.id}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ done: false }),
    }).then(() => load()).catch(() => {});
  }

  const total = categories.reduce((sum, c) => sum + c.items.length, 0);

  const navBtn = (isActive) => ({
    appearance: 'none', border: 0, margin: 0, background: isActive ? RULE : WELL,
    color: INK, fontFamily: 'inherit', fontSize: 11, letterSpacing: '.06em',
    textTransform: 'uppercase', padding: '7px 10px', cursor: 'pointer',
  });
  const label = { opacity: .45 };

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100dvh', overflow: 'hidden',
      background: WELL, color: INK,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', userSelect: 'none',
    }}>
      <style>{CSS}</style>
      <DitherField pushRef={useRef(() => {})} />
      <CrtLayers />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column',
                    height: '100%', maxWidth: CONTENT_MAX, margin: '0 auto', boxSizing: 'border-box' }}>

        <div className="rv-head">
          <div className="rv-head-title">
            <div style={{ fontWeight: 700 }}>{title}</div>
            <div style={label}>{scannedAt ? `last generated ${timeAgo(scannedAt)}` : 'no report yet'}</div>
          </div>
          <div className="rv-head-side">
            <div className="rv-head-nav" style={{ background: EDGE, border: `1px solid ${EDGE}` }}>
              <button type="button" style={navBtn(active === 'tasks')} onClick={() => onOpenTasks?.()}>to-do</button>
              <button type="button" style={navBtn(false)} onClick={() => onOpenChat?.()}>chat</button>
              <button type="button" style={navBtn(false)} onClick={() => onOpenSweep?.()}>sweep</button>
              <button type="button" style={navBtn(active === 'work')} onClick={() => onOpenWork?.()}>work</button>
              <button type="button" style={navBtn(active === 'life')} onClick={() => onOpenLife?.()}>life</button>
              <button type="button" style={navBtn(false)} onClick={() => onOpenTexts?.()}>texts</button>
            </div>
            <div className="rv-head-sub">
              <button type="button" onClick={() => setPeopleOpen(true)} style={{ ...navBtn(false), opacity: .6 }}>people</button>
              <button type="button" onClick={() => setRulesOpen(true)} style={{ ...navBtn(false), opacity: .6 }}>rules</button>
            </div>
          </div>
        </div>

        <div style={{ margin: '20px 20px 0', display: 'flex', gap: 1, background: EDGE, border: `1px solid ${EDGE}` }}>
          {/* Regenerate re-reads the live items and re-runs them through the
              current method (rules + synopsis) in place — the one-tap way to
              apply a change to the list you're already looking at. The Sweep
              link is the heavier path (also refreshes the pulled counts). */}
          <button type="button" onClick={regenerate} disabled={regenerating} style={{
            appearance: 'none', flex: 1, margin: 0, border: 0,
            background: regenerating ? FILM : 'rgba(217,147,47,.09)', color: INK, fontFamily: 'inherit',
            fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase',
            padding: '11px 16px', cursor: regenerating ? 'default' : 'pointer',
          }}>{regenerating ? 'regenerating…' : 'regenerate now ↻'}</button>
          <button type="button" onClick={() => onOpenSweep?.()} style={{
            appearance: 'none', flex: 1, margin: 0, border: 0,
            background: PANEL, color: INK, fontFamily: 'inherit',
            fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase',
            padding: '11px 16px', cursor: 'pointer', opacity: .7,
          }}>{scannedAt ? 'fresh pull on sweep →' : 'go pull data on sweep →'}</button>
        </div>

        <div className="report-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 20px 26px',
                                               marginTop: 18, scrollbarWidth: 'none' }}>

          {phase === 'loading' && (
            <div style={{ paddingTop: 40, textAlign: 'center', opacity: .4 }}>loading…</div>
          )}

          {phase !== 'loading' && !scannedAt && (
            <div style={{ paddingTop: 40, textAlign: 'center', opacity: .4, lineHeight: 1.8 }}>
              <div>no report yet</div>
              <div style={{ fontSize: 10 }}>{emptyHint}</div>
            </div>
          )}

          {/* Above everything: the things that should not wait. */}
          <ActionBand actions={actions} />

          {summary && (
            <div style={{ marginBottom: 18, padding: '13px 16px', border: `1px solid ${HAIR}`,
                          background: PANEL, fontSize: 12, lineHeight: 1.65,
                          letterSpacing: '.01em', textTransform: 'none', textWrap: 'pretty', opacity: .88 }}>
              {summary}
            </div>
          )}

          {/* The chase: items that have been surfaced 2+ days running and still
              aren't done. This is the "push me to finish it" — it only appears
              when something is actually being left, and names the count. */}
          {outstanding > 0 && (
            <div style={{
              marginBottom: 18, padding: '11px 14px', border: `1px solid ${AMBER}`,
              background: 'rgba(217,147,47,.09)', display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 11.5, letterSpacing: '.02em', textTransform: 'none',
            }}>
              <div style={{ width: 7, height: 7, flex: 'none', background: AMBER }} />
              <div style={{ flex: 1 }}>
                <span style={{ color: AMBER, fontWeight: 700 }}>{outstanding}</span>
                {' '}{outstanding === 1 ? 'thing has' : 'things have'} been sitting 2+ days — clear these before they slip.
              </div>
            </div>
          )}

          {scannedAt && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          paddingBottom: 11, borderBottom: `1px solid ${RULE}` }}>
              <div style={{ opacity: .8 }}>{total === 0 ? 'nothing outstanding' : `${total} things to do`}</div>
              {total > 0 && (
                <div style={{ display: 'flex', gap: 1, background: EDGE, border: `1px solid ${EDGE}`, flex: 'none' }}>
                  {['grid', 'deck'].map(m => (
                    <button key={m} type="button" onClick={() => pickMode(m)} style={{
                      appearance: 'none', border: 0, margin: 0, cursor: 'pointer', fontFamily: 'inherit',
                      background: mode === m ? 'rgba(217,147,47,.13)' : WELL,
                      color: mode === m ? AMBER : INK, opacity: mode === m ? 1 : .55,
                      fontWeight: mode === m ? 700 : 400,
                      fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', padding: '7px 11px',
                    }}>{m}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {mode === 'deck' && categories.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <CardDeck
                categories={categories}
                tints={TINTS}
                auth={auth}
                onDone={t => dismiss(t.id, t)}
                onIgnore={t => dismiss(t.id, null)}
                onOpenBrowser={onOpenBrowser}
                onOpenChat={t => onDraftReply?.(t)}
                onUndo={t => undoDone(t)}
                initialIndex={focusIndex}
                onExit={() => setFocusIndex(null)}
              />
            </div>
          )}

          {mode === 'grid' && categories.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <CardGrid
                categories={categories}
                tints={TINTS}
                auth={auth}
                expandedId={expandedId}
                onToggle={t => setExpandedId(id => (id === t.id ? null : t.id))}
                onDone={(t, e) => dismiss(t.id, t, e)}
                onIgnore={(t, e) => dismiss(t.id, null, e)}
                onOpenBrowser={onOpenBrowser}
                onOpenChat={t => onDraftReply?.(t)}
                onFocus={(c, ci) => { setFocusIndex(ci); pickMode('deck'); }}
              />
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 24, zIndex: 9,
                      width: `calc(100% - 40px)`, maxWidth: CONTENT_MAX - 40,
                      border: '1px solid rgba(217,147,47,.5)', background: RAISED,
                      padding: '13px 14px', display: 'flex', alignItems: 'center', gap: 10,
                      animation: 'rv-rise .2s ease-out' }}>
          <div style={{ width: 8, height: 8, flex: 'none', background: AMBER }} />
          <div style={{ flex: 1, opacity: .85 }}>{toast}</div>
          <div style={{ opacity: .4, animation: 'rv-blink 1s step-end infinite' }}>_</div>
        </div>
      )}

      <PeopleDrawer open={peopleOpen} auth={auth} onClose={() => setPeopleOpen(false)} />
      <RulesDrawer open={rulesOpen} auth={auth} onClose={() => setRulesOpen(false)} />
    </div>
  );
}
