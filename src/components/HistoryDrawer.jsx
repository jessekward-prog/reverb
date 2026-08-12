import React, { useState, useEffect } from 'react';
import { authHeaders } from '../api.js';

export default function HistoryDrawer({ open, auth, currentId, onSwitch, onNewChat, onClose }) {
  const [list, setList] = useState([]);

  useEffect(() => {
    if (open) load();
  }, [open]);

  async function load() {
    try {
      const res = await fetch('/api/conversations', { headers: authHeaders(auth.token) });
      if (res.ok) setList(await res.json());
    } catch {}
  }

  async function deleteConv(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: authHeaders(auth.token) }).catch(() => {});
    if (id === currentId) onNewChat();
    load();
  }

  return (
    <div className={`drawer-overlay${open ? ' open' : ''}`} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="drawer-panel">
        <div className="drawer-head">
          <h2>Chats</h2>
          <button className="icon-btn" onClick={onClose}>&#10005;</button>
        </div>

        <button className="new-chat-btn" onClick={() => { onNewChat(); onClose(); }}>
          + New Chat
        </button>

        <div className="conv-list">
          {list.length === 0 && <p className="conv-empty">No chats yet</p>}
          {list.map(conv => (
            <div
              key={conv.id}
              className={`conv-item${conv.id === currentId ? ' active' : ''}`}
              onClick={() => { onSwitch(conv.id); onClose(); }}
            >
              <span className="conv-title">{conv.title || 'New chat'}</span>
              {auth.role === 'owner' && (
                <button className="conv-delete" onClick={e => deleteConv(conv.id, e)}>✕</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
