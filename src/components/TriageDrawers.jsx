import React, { useEffect, useState } from 'react';
import { authHeaders } from '../api.js';
import { C, FS, FONT, SP } from '../lib/design.js';

const TIER_OPTIONS = [
  { value: null,     label: 'auto' },
  { value: 'vip',    label: 'vip' },
  { value: 'normal', label: 'normal' },
  { value: 'muted',  label: 'muted' },
];

function DrawerShell({ open, title, onClose, children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0,0,0,.65)',
      display: 'flex', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(380px, 92vw)', height: '100%', background: C.surface,
        borderLeft: `1px solid ${C.borderHi}`, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: `${SP[3]}px ${SP[4]}px`, borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{
            fontFamily: FONT.mono, fontSize: FS.ui, fontWeight: 700,
            letterSpacing: '.1em', textTransform: 'uppercase', color: C.text1,
          }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{
            appearance: 'none', border: 0, background: 'none', color: C.text2,
            fontFamily: FONT.mono, fontSize: FS.title, cursor: 'pointer',
            minWidth: 44, minHeight: 44, display: 'grid', placeItems: 'center',
          }}>&#10005;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Manual override list for Reverb's contact memory — auto (derived from
// seen/reply/dismiss counts) vs a pinned vip/normal/muted.
export function PeopleDrawer({ open, auth, onLockout, onClose }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch('/api/contacts', { headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(rows => setContacts(Array.isArray(rows) ? rows : []))
      .catch(() => setContacts([]))
      .finally(() => setLoading(false));
  }, [open, auth, onLockout]);

  function setTier(id, tier) {
    setContacts(prev => prev.map(c => (c.id === id ? { ...c, tier } : c)));
    fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ tier }),
    }).catch(() => {});
  }

  return (
    <DrawerShell open={open} title="// people" onClose={onClose}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: SP[4], fontFamily: FONT.mono, fontSize: FS.label, color: C.text3 }}>loading…</div>
        )}
        {!loading && !contacts.length && (
          <div style={{ padding: SP[4], fontFamily: FONT.sans, fontSize: FS.body, color: C.text3 }}>
            Nobody tracked yet — run refresh all data.
          </div>
        )}
        {contacts.map(c => (
          <div key={c.id} style={{ padding: `${SP[3]}px ${SP[4]}px`, borderBottom: `1px solid ${C.border}` }}>
            <div style={{
              fontFamily: FONT.sans, fontSize: FS.body, color: C.text1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{c.display_name || c.identifier}</div>
            <div style={{ fontFamily: FONT.mono, fontSize: FS.label, color: C.text3, marginTop: 3 }}>
              {c.kind} · seen {c.seen_count} · replied {c.replied_count} · dismissed {c.dismissed_count}
            </div>
            <div style={{ display: 'flex', gap: 1, marginTop: SP[2], background: C.border, border: `1px solid ${C.border}` }}>
              {TIER_OPTIONS.map(opt => {
                const active = c.tier === opt.value;
                return (
                  <button key={opt.label} type="button" onClick={() => setTier(c.id, opt.value)} style={{
                    appearance: 'none', flex: 1, border: 0, margin: 0, cursor: 'pointer',
                    fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.06em',
                    textTransform: 'uppercase', minHeight: 36, padding: `${SP[1]}px`,
                    background: active ? C.amberDim : C.bg,
                    color: active ? C.amber : C.text2,
                  }}>{opt.label}</button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </DrawerShell>
  );
}

// Plain substring patterns matched in code (server.js matchRules) during
// report assembly: priority floats matching items up, ignore drops them.
export function RulesDrawer({ open, auth, onLockout, onClose }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState('priority');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch('/api/rules', { headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(rows => setRules(Array.isArray(rows) ? rows : []))
      .catch(() => setRules([]))
      .finally(() => setLoading(false));
  }, [open, auth, onLockout]);

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
    } catch { /* leave input as-is */ }
  }

  function removeRule(id) {
    setRules(prev => prev.filter(r => r.id !== id));
    fetch(`/api/rules/${id}`, { method: 'DELETE', headers: authHeaders(auth?.token) }).catch(() => {});
  }

  return (
    <DrawerShell open={open} title="// rules" onClose={onClose}>
      <form onSubmit={addRule} style={{
        padding: SP[4], display: 'flex', flexDirection: 'column', gap: SP[2],
        borderBottom: `1px solid ${C.border}`,
      }}>
        <input
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          placeholder="e.g. domain.com.au, or a name/address"
          style={{
            appearance: 'none', border: `1px solid ${C.borderHi}`, background: C.bg,
            color: C.text1, fontFamily: FONT.sans, fontSize: 16, padding: '10px 12px',
            width: '100%', boxSizing: 'border-box', outline: 'none', minHeight: 44,
          }}
        />
        <div style={{ display: 'flex', gap: 1, background: C.border, border: `1px solid ${C.border}` }}>
          {['priority', 'ignore'].map(a => {
            const active = action === a;
            return (
              <button key={a} type="button" onClick={() => setAction(a)} style={{
                appearance: 'none', flex: 1, border: 0, margin: 0, cursor: 'pointer',
                fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.06em',
                textTransform: 'uppercase', minHeight: 38,
                background: active ? C.amberDim : C.bg,
                color: active ? C.amber : C.text2,
              }}>{a}</button>
            );
          })}
        </div>
        <button type="submit" disabled={!pattern.trim()} style={{
          appearance: 'none', border: `1px solid ${pattern.trim() ? C.amber : C.border}`,
          background: pattern.trim() ? C.amberDim : 'transparent',
          color: pattern.trim() ? C.amber : C.text3, fontFamily: FONT.mono,
          fontSize: FS.label, letterSpacing: '.08em', textTransform: 'uppercase',
          minHeight: 44, cursor: pattern.trim() ? 'pointer' : 'default',
        }}>add rule</button>
      </form>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: SP[4], fontFamily: FONT.mono, fontSize: FS.label, color: C.text3 }}>loading…</div>
        )}
        {!loading && !rules.length && (
          <div style={{ padding: SP[4], fontFamily: FONT.sans, fontSize: FS.body, color: C.text3 }}>No rules yet.</div>
        )}
        {rules.map(r => (
          <div key={r.id} style={{
            display: 'flex', alignItems: 'center', gap: SP[2],
            padding: `${SP[3]}px ${SP[4]}px`, borderBottom: `1px solid ${C.border}`,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: FONT.sans, fontSize: FS.body, color: C.text1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.pattern}</div>
              <div style={{
                fontFamily: FONT.mono, fontSize: FS.label, marginTop: 2,
                color: r.action === 'priority' ? C.amber : C.text3,
              }}>{r.action}</div>
            </div>
            <button type="button" onClick={() => removeRule(r.id)} aria-label="Remove rule" style={{
              appearance: 'none', border: 0, background: 'none', color: C.text3,
              fontFamily: FONT.mono, fontSize: FS.ui, cursor: 'pointer', flex: 'none',
              minWidth: 44, minHeight: 44, display: 'grid', placeItems: 'center',
            }}>&#10005;</button>
          </div>
        ))}
      </div>
    </DrawerShell>
  );
}
