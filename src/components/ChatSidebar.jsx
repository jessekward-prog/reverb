import React, { useEffect, useState, useCallback } from 'react';
import { authHeaders } from '../api.js';
import { INK, AMBER, HAIR, RAISED, FILM } from './CrtBackdrop.jsx';

// The visible conversation list — tiny-chat's model, promoted out of the drawer.
// Desktop only (`.chat-convs` is hidden below 1024 in style.css); mobile keeps
// the hamburger drawer. `version` is bumped by ChatView after a send or new
// chat so the list and its auto-titles refresh without a manual reload.
export default function ChatSidebar({ auth, currentId, onSwitch, onNewChat, version }) {
  const [list, setList] = useState([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/conversations', { headers: authHeaders(auth?.token) });
      if (r.ok) setList(await r.json());
    } catch {}
  }, [auth]);

  useEffect(() => { load(); }, [load, currentId, version]);

  async function del(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: authHeaders(auth?.token) }).catch(() => {});
    if (id === currentId) onNewChat?.();
    load();
  }

  return (
    <aside className="chat-convs" style={{
      width: 230, flex: 'none', height: '100dvh', background: RAISED,
      borderRight: `1px solid ${HAIR}`, flexDirection: 'column', overflow: 'hidden', zIndex: 4,
    }}>
      <div style={{ padding: '18px 14px 12px' }}>
        <button type="button" onClick={() => onNewChat?.()} style={{
          appearance: 'none', width: '100%', cursor: 'pointer', fontFamily: 'inherit',
          border: `1px solid ${AMBER}`, background: 'rgba(217,147,47,.1)', color: AMBER,
          fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', padding: '9px',
        }}>+ new chat</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {list.length === 0 && (
          <div style={{ padding: '8px 16px', opacity: .35, fontSize: 11, letterSpacing: '.04em' }}>no chats yet</div>
        )}
        {list.map(c => {
          const active = c.id === currentId;
          return (
            <div key={c.id} onClick={() => onSwitch?.(c.id)} style={{
              display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              padding: '10px 14px', borderLeft: `2px solid ${active ? AMBER : 'transparent'}`,
              background: active ? FILM : 'transparent',
            }}>
              <span style={{
                flex: 1, minWidth: 0, fontSize: 12, color: active ? INK : 'rgba(232,232,228,.65)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{c.title || 'new chat'}</span>
              {auth?.role === 'owner' && (
                <button type="button" onClick={e => del(c.id, e)} style={{
                  appearance: 'none', border: 0, background: 'none', cursor: 'pointer',
                  color: 'rgba(232,232,228,.35)', fontSize: 12, flex: 'none', padding: 2,
                }}>✕</button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
