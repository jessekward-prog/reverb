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

const DOSSIER_EDIT_FIELDS = [
  ['displayName',    'Name'],
  ['phone',          'Phone'],
  ['email',          'Email'],
  ['address',        'Address'],
  ['business',       'Business'],
  ['workScope',      'Work scope'],
  ['quoteEstimate',  'Quote / estimate'],
  ['partsMaterials', 'Parts / materials'],
  ['preferredTimes', 'Preferred times'],
  ['accessNotes',    'Access / site notes'],
  ['currentStage',   'Stage'],
  ['openNextStep',   'Open next step'],
  ['summaryNotes',   'Summary notes', true],
];

const DRAWER_INPUT_STYLE = {
  appearance: 'none', border: `1px solid ${C.borderHi}`, background: C.bg,
  color: C.text1, fontFamily: FONT.sans, fontSize: FS.body, padding: '8px 10px',
  width: '100%', boxSizing: 'border-box', outline: 'none', minHeight: 38,
};

function DossierEditor({ contact, auth, onSaved, onCancel }) {
  const d = contact.dossier || {};
  const [form, setForm] = useState(() => ({
    displayName:    d.displayName || contact.display_name || '',
    phone:          d.phone || '',
    email:          d.email || '',
    address:        d.address || contact.address || '',
    business:       d.business || '',
    workScope:      d.workScope || '',
    quoteEstimate:  d.quoteEstimate || '',
    partsMaterials: d.partsMaterials || '',
    preferredTimes: d.preferredTimes || '',
    accessNotes:    d.accessNotes || '',
    currentStage:   d.currentStage || '',
    openNextStep:   d.openNextStep || '',
    summaryNotes:   d.summaryNotes || '',
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save(e) {
    e.preventDefault();
    if (!contact.personKey || saving) return;
    setSaving(true);
    setErr('');
    try {
      const res = await fetch('/api/dossiers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
        body: JSON.stringify({ personKey: contact.personKey, ...form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.dossier) {
        setErr(data.error || 'save failed');
        return;
      }
      onSaved(contact.personKey, data.dossier);
    } catch {
      setErr('network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} style={{
      marginTop: SP[2], padding: SP[2], border: `1px solid ${C.borderHi}`,
      background: C.surface2, display: 'flex', flexDirection: 'column', gap: SP[2],
    }}>
      {DOSSIER_EDIT_FIELDS.map(([key, label, multi]) => (
        <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontFamily: FONT.mono, fontSize: FS.label, color: C.text3, textTransform: 'uppercase' }}>{label}</span>
          {multi ? (
            <textarea
              rows={3}
              value={form[key]}
              onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
              style={{ ...DRAWER_INPUT_STYLE, resize: 'vertical' }}
            />
          ) : (
            <input
              value={form[key]}
              onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
              style={DRAWER_INPUT_STYLE}
            />
          )}
        </label>
      ))}
      {err && <div style={{ fontFamily: FONT.mono, fontSize: FS.label, color: '#e07070' }}>{err}</div>}
      <div style={{ display: 'flex', gap: SP[2] }}>
        <button type="submit" disabled={saving} style={{
          appearance: 'none', flex: 1, border: `1px solid ${C.amber}`, background: C.amberDim,
          color: C.amber, fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
          textTransform: 'uppercase', minHeight: 38, cursor: 'pointer',
        }}>{saving ? 'saving…' : 'save dossier'}</button>
        <button type="button" onClick={onCancel} style={{
          appearance: 'none', border: `1px solid ${C.border}`, background: 'none',
          color: C.text2, fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.08em',
          textTransform: 'uppercase', minHeight: 38, padding: '0 12px', cursor: 'pointer',
        }}>cancel</button>
      </div>
    </form>
  );
}

// Manual override list + progressive client dossier viewer/editor.
export function PeopleDrawer({ open, auth, onLockout, onClose }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [editingKey, setEditingKey] = useState(null);

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
    if (id == null) return;
    setContacts(prev => prev.map(c => (c.id === id ? { ...c, tier } : c)));
    fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
      body: JSON.stringify({ tier }),
    }).catch(() => {});
  }

  function handleDossierSaved(personKey, dossier) {
    setContacts(prev => prev.map(c => (c.personKey === personKey ? {
      ...c,
      display_name: dossier.displayName || c.display_name,
      address: dossier.address || c.address,
      dossier,
    } : c)));
    setEditingKey(null);
  }

  const needle = query.trim().toLowerCase();
  const visible = needle ? contacts.filter(c => {
    const d = c.dossier || {};
    const hay = [
      c.display_name, c.identifier, c.personKey, c.address,
      d.displayName, d.phone, d.email, d.address, d.business,
      d.workScope, d.quoteEstimate, d.partsMaterials, d.summaryNotes,
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(needle);
  }) : contacts;

  return (
    <DrawerShell open={open} title="// people & dossiers" onClose={onClose}>
      <div style={{ padding: `${SP[2]}px ${SP[4]}px`, borderBottom: `1px solid ${C.border}` }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search name, phone, address, job, quote…"
          style={{ ...DRAWER_INPUT_STYLE, fontSize: 15 }}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: SP[4], fontFamily: FONT.mono, fontSize: FS.label, color: C.text3 }}>loading…</div>
        )}
        {!loading && !visible.length && (
          <div style={{ padding: SP[4], fontFamily: FONT.sans, fontSize: FS.body, color: C.text3 }}>
            {contacts.length ? 'No matching contacts or dossiers.' : 'Nobody tracked yet — run refresh all data.'}
          </div>
        )}
        {visible.map(c => {
          const d = c.dossier || {};
          const key = c.personKey || `${c.kind}:${c.id || c.identifier}`;
          const isEditing = editingKey && editingKey === c.personKey;
          const summaryBits = [
            d.phone,
            d.address || c.address,
            d.workScope && `scope: ${d.workScope}`,
            d.quoteEstimate && `quote: ${d.quoteEstimate}`,
            d.partsMaterials && `parts: ${d.partsMaterials}`,
            d.currentStage && `stage: ${d.currentStage}`,
          ].filter(Boolean);

          return (
            <div key={key} style={{ padding: `${SP[3]}px ${SP[4]}px`, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                <div style={{
                  flex: 1, fontFamily: FONT.sans, fontSize: FS.body, color: C.text1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{d.displayName || c.display_name || c.identifier}</div>
                {c.personKey && (
                  <button
                    type="button"
                    onClick={() => setEditingKey(isEditing ? null : c.personKey)}
                    style={{
                      appearance: 'none', border: `1px solid ${isEditing ? C.amber : C.border}`,
                      background: isEditing ? C.amberDim : 'none',
                      color: isEditing ? C.amber : C.text2,
                      fontFamily: FONT.mono, fontSize: FS.label, letterSpacing: '.06em',
                      textTransform: 'uppercase', padding: '4px 8px', minHeight: 30, cursor: 'pointer',
                    }}
                  >{isEditing ? 'close' : 'dossier'}</button>
                )}
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: FS.label, color: C.text3, marginTop: 3 }}>
                {(d.channels?.length ? d.channels.join('+') : c.kind)} · {c.itemCount || 0} items · {c.messageCount || 0} msgs · seen {c.seen_count} · replied {c.replied_count}
              </div>
              {summaryBits.length > 0 && (
                <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, color: C.text2, marginTop: 5, lineHeight: 1.45, wordBreak: 'break-word' }}>
                  {summaryBits.join(' · ')}
                </div>
              )}
              {d.summaryNotes && (
                <div style={{ fontFamily: FONT.sans, fontSize: FS.meta, color: C.text1, marginTop: 4, lineHeight: 1.45 }}>
                  {d.summaryNotes}
                </div>
              )}
              {isEditing && (
                <DossierEditor
                  contact={c}
                  auth={auth}
                  onSaved={handleDossierSaved}
                  onCancel={() => setEditingKey(null)}
                />
              )}
              {c.id != null && (
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
              )}
            </div>
          );
        })}
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
