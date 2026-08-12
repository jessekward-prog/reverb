import React, { useState, useEffect } from 'react';
import { authHeaders } from '../api.js';

const DEFAULT_SYSTEM = 'You are Reverb, a personal assistant with access to the user\'s texts, calendar, and email. You have three tools: get_recent_texts, get_upcoming_events, and get_recent_emails. Use them whenever the user asks about messages, their schedule, or their inbox — never guess at this information. Answer everything else from your own knowledge.';

export default function SettingsDrawer({ open, auth, currentId, systemPrompt, onSystemChange, onDeleteChat, onClose }) {
  const [draft, setDraft] = useState(systemPrompt);

  useEffect(() => { if (open) setDraft(systemPrompt); }, [open, systemPrompt]);

  async function handleDeleteChat() {
    if (!confirm('Delete this chat?')) return;
    if (currentId) {
      await fetch(`/api/conversations/${currentId}`, { method: 'DELETE', headers: authHeaders(auth.token) }).catch(() => {});
    }
    onDeleteChat();
    onClose();
  }

  return (
    <div className={`drawer-overlay${open ? ' open' : ''}`} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="drawer-panel">
        <div className="drawer-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>&#10005;</button>
        </div>

        <label className="drawer-label">System prompt</label>
        <textarea
          className="drawer-textarea"
          rows={5}
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />

        <div className="drawer-actions">
          <button className="btn-primary" onClick={() => { onSystemChange(draft.trim() || DEFAULT_SYSTEM); onClose(); }}>
            Save
          </button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>

        <hr className="drawer-divider" />
        <button className="btn-danger" onClick={handleDeleteChat}>Delete this chat</button>
      </div>
    </div>
  );
}
