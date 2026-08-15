import React, { useEffect, useRef, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';
import { KINDS } from '../lib/kinds.js';

const CONTENT_MAX = 700; // matches Chat/Sweep so the nav pill lands in the same spot

const CSS = BACKDROP_CSS + `
@keyframes rv-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes rv-rise  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
.report-scroll::-webkit-scrollbar { width:0 }
`;

// Rotate through a small palette for category headers since labels are
// LLM-chosen and open-ended, not a fixed set.
const TINTS = [AMBER, '#8fa8c4', '#7fbf8f', '#c48fb0', '#9fb0a8', '#c4a35f'];

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
        width: 'min(360px, 92vw)', height: '100%', background: '#0b0b0a',
        borderLeft: '1px solid rgba(232,232,228,.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '18px 16px', borderBottom: '1px solid rgba(232,232,228,.14)' }}>
          <div style={{ fontWeight: 700 }}>// people</div>
          <button type="button" onClick={onClose} style={{ appearance: 'none', border: 0, background: 'none',
                                                            color: INK, fontFamily: 'inherit', fontSize: 14, cursor: 'pointer' }}>&#10005;</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && <div style={{ padding: 16, opacity: .4 }}>loading…</div>}
          {!loading && !contacts.length && <div style={{ padding: 16, opacity: .4, textTransform: 'none' }}>nobody tracked yet — run a scan</div>}
          {contacts.map(c => (
            <div key={c.id} style={{ padding: '11px 16px', borderBottom: '1px solid rgba(232,232,228,.08)' }}>
              <div style={{ fontSize: 12, textTransform: 'none', overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap' }}>{c.display_name || c.identifier}</div>
              <div style={{ fontSize: 9.5, opacity: .4, marginTop: 2 }}>
                {c.kind} · seen {c.seen_count} · replied {c.replied_count} · dismissed {c.dismissed_count}
              </div>
              <div style={{ display: 'flex', gap: 1, marginTop: 8, background: 'rgba(232,232,228,.14)',
                            border: '1px solid rgba(232,232,228,.14)' }}>
                {TIER_OPTIONS.map(opt => (
                  <button key={opt.label} type="button" onClick={() => setTier(c.id, opt.value)} style={{
                    appearance: 'none', flex: 1, border: 0, margin: 0, cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: 9.5, letterSpacing: '.06em', padding: '7px 4px',
                    background: c.tier === opt.value ? 'rgba(217,147,47,.22)' : '#060606',
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

// Shared by WorkView and LifeView — both are read-only digests of a
// persisted report (work_summary / life_summary), regenerated only from
// Sweep's Pull Data -> Generate Report flow, not from a button in here.
export default function ReportView({
  auth, onLockout, active, title, apiPath, emptyHint,
  onOpenChat, onOpenSweep, onOpenWork, onOpenLife, onOpenTexts, onDraftReply,
}) {
  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready'
  const [summary, setSummary] = useState('');
  const [categories, setCategories] = useState([]);
  const [scannedAt, setScannedAt] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [toast, setToast] = useState('');
  const [peopleOpen, setPeopleOpen] = useState(false);
  const toastTimer = useRef(null);

  function say(text) {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  }

  useEffect(() => {
    setPhase('loading');
    fetch(apiPath, { headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(data => {
        setSummary(data.summary || '');
        setCategories(data.categories || []);
        setScannedAt(data.scannedAt || null);
        setPhase('ready');
      })
      .catch(() => setPhase('ready'));
    return () => clearTimeout(toastTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiPath]);

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

  const total = categories.reduce((sum, c) => sum + c.items.length, 0);

  const navBtn = (isActive) => ({
    appearance: 'none', border: 0, margin: 0, background: isActive ? 'rgba(232,232,228,.14)' : '#060606',
    color: INK, fontFamily: 'inherit', fontSize: 11, letterSpacing: '.06em',
    textTransform: 'uppercase', padding: '7px 10px', cursor: 'pointer',
  });
  const label = { opacity: .45 };

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100dvh', overflow: 'hidden',
      background: '#060606', color: INK,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', userSelect: 'none',
    }}>
      <style>{CSS}</style>
      <DitherField pushRef={useRef(() => {})} />
      <CrtLayers />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column',
                    height: '100%', maxWidth: CONTENT_MAX, margin: '0 auto', boxSizing: 'border-box' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                      gap: 12, padding: '20px 20px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontWeight: 700 }}>{title}</div>
            <div style={label}>{scannedAt ? `last generated ${timeAgo(scannedAt)}` : 'no report yet'}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ display: 'flex', gap: 1, background: 'rgba(232,232,228,.18)',
                          border: '1px solid rgba(232,232,228,.18)' }}>
              <button type="button" style={navBtn(false)} onClick={() => onOpenChat?.()}>chat</button>
              <button type="button" style={navBtn(false)} onClick={() => onOpenSweep?.()}>sweep</button>
              <button type="button" style={navBtn(active === 'work')} onClick={() => onOpenWork?.()}>work</button>
              <button type="button" style={navBtn(active === 'life')} onClick={() => onOpenLife?.()}>life</button>
              <button type="button" style={navBtn(false)} onClick={() => onOpenTexts?.()}>texts</button>
            </div>
            <button type="button" onClick={() => setPeopleOpen(true)} style={{ ...navBtn(false), opacity: .6 }}>people</button>
          </div>
        </div>

        <div style={{ margin: '20px 20px 0' }}>
          <button type="button" onClick={() => onOpenSweep?.()} style={{
            appearance: 'none', width: '100%', margin: 0, border: '1px solid rgba(232,232,228,.18)',
            background: 'rgba(232,232,228,.05)', color: INK, fontFamily: 'inherit',
            fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase',
            padding: '11px 16px', cursor: 'pointer', opacity: .7,
          }}>{scannedAt ? 'pull fresh data on sweep →' : 'go pull data on sweep →'}</button>
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

          {summary && (
            <div style={{ marginBottom: 22, padding: '14px 14px', border: '1px solid rgba(232,232,228,.16)',
                          background: 'rgba(232,232,228,.05)', fontSize: 12, lineHeight: 1.65,
                          letterSpacing: '.01em', textTransform: 'none', textWrap: 'pretty', opacity: .88 }}>
              {summary}
            </div>
          )}

          {scannedAt && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                          paddingBottom: 12, borderBottom: '1px solid rgba(232,232,228,.14)' }}>
              <div style={{ opacity: .8 }}>{total === 0 ? 'nothing outstanding' : `${total} things to do`}</div>
            </div>
          )}

          {categories.map((c, ci) => {
            const tint = TINTS[ci % TINTS.length];
            return (
              <div key={c.label} style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <div style={{ fontWeight: 700, color: tint, textTransform: 'none' }}>{c.label}</div>
                  <div style={{ flex: 1, height: 1, background: 'rgba(232,232,228,.14)' }} />
                  <div style={{ opacity: .4 }}>{String(c.items.length).padStart(2, '0')}</div>
                </div>

                {c.items.map((t, i) => {
                  const k = KINDS[t.kind] || KINDS.email;
                  const expanded = expandedId === t.id;
                  const actions = [
                    ...(t.reply ? [{ label: 'draft reply', onPress: () => onDraftReply?.(t) }] : []),
                    { label: 'done', onPress: e => dismiss(t.id, t, e) },
                  ];
                  return (
                    <div key={t.id} style={{
                      border: '1px solid rgba(232,232,228,.16)', background: 'rgba(6,6,6,.72)',
                      animation: 'rv-rise .26s ease-out both', animationDelay: `${(i * 0.05).toFixed(2)}s`,
                    }}>
                      <div onClick={() => setExpandedId(expanded ? null : t.id)}
                           style={{ display: 'flex', gap: 11, padding: '12px 12px 11px', cursor: 'pointer' }}>
                        <div onClick={e => dismiss(t.id, t, e)} style={{
                          width: 16, height: 16, flex: 'none', marginTop: 1,
                          border: '1px solid rgba(232,232,228,.5)',
                        }} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, lineHeight: 1.45, letterSpacing: '.02em',
                                        textTransform: 'none', textWrap: 'pretty' }}>{t.text}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, opacity: .5, fontSize: 10 }}>
                            {t.tier === 'vip' && (
                              <div style={{ flex: 'none', color: AMBER, opacity: 1, fontWeight: 700 }}>VIP</div>
                            )}
                            <div style={{ color: k.tint }}>{k.label}</div>
                            <div>·</div>
                            <div style={{ textTransform: 'none', overflow: 'hidden',
                                          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.from}</div>
                            {t.when && (<><div>·</div><div style={{ flex: 'none' }}>{t.when}</div></>)}
                          </div>
                        </div>
                        <div style={{ flex: 'none', opacity: .35, fontSize: 14, lineHeight: 1 }}>
                          {expanded ? '−' : '+'}
                        </div>
                      </div>

                      {expanded && (
                        <div style={{ borderTop: '1px solid rgba(232,232,228,.12)', padding: 12,
                                      display: 'flex', flexDirection: 'column', gap: 12 }}>
                          <div style={{ fontSize: 11.5, lineHeight: 1.6, letterSpacing: '.01em',
                                        textTransform: 'none', opacity: .62, textWrap: 'pretty',
                                        borderLeft: `2px solid ${tint}`, paddingLeft: 10 }}>
                            {t.snippet}
                          </div>
                          <div style={{ display: 'flex', gap: 1, background: 'rgba(232,232,228,.16)',
                                        border: '1px solid rgba(232,232,228,.16)' }}>
                            {actions.map(a => (
                              <button key={a.label} type="button" onClick={a.onPress} style={{
                                appearance: 'none', flex: 1, border: 0, margin: 0, background: '#060606',
                                color: INK, fontFamily: 'inherit', fontSize: 10, letterSpacing: '.08em',
                                textTransform: 'uppercase', padding: '10px 4px', cursor: 'pointer',
                              }}>{a.label}</button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 24, zIndex: 9,
                      width: `calc(100% - 40px)`, maxWidth: CONTENT_MAX - 40,
                      border: '1px solid rgba(217,147,47,.5)', background: '#0b0b0a',
                      padding: '13px 14px', display: 'flex', alignItems: 'center', gap: 10,
                      animation: 'rv-rise .2s ease-out' }}>
          <div style={{ width: 8, height: 8, flex: 'none', background: AMBER }} />
          <div style={{ flex: 1, opacity: .85 }}>{toast}</div>
          <div style={{ opacity: .4, animation: 'rv-blink 1s step-end infinite' }}>_</div>
        </div>
      )}

      <PeopleDrawer open={peopleOpen} auth={auth} onClose={() => setPeopleOpen(false)} />
    </div>
  );
}
