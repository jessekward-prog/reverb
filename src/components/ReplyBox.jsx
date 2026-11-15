import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { authHeaders } from '../api.js';
import { C, FS, FONT, SP } from '../lib/design.js';

// Shared inline reply composer for both TaskPanel and ActionBand. Keeps drafting
// (POST /api/item/draft), explicit user-clicked sending (POST /api/text/send),
// and contact signal recording in one place.
export default function ReplyBox({
  channel,
  to,
  name,
  kind,
  text,
  snippet,
  brief,
  auth,
  autoFocus = true,
  onSent,
  onCancel,
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy]   = useState(null);   // 'drafting' | 'sending' | null
  const [note, setNote]   = useState('');
  const boxRef = useRef(null);

  const jsonHead = { 'Content-Type': 'application/json', ...authHeaders(auth?.token) };
  const display = name || to || 'them';

  useEffect(() => {
    if (!autoFocus) return;
    const id = setTimeout(() => {
      boxRef.current?.focus();
      boxRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }, 60);
    return () => clearTimeout(id);
  }, [autoFocus]);

  function suggest() {
    if (busy) return;
    setBusy('drafting'); setNote('');
    fetch('/api/item/draft', {
      method: 'POST',
      headers: jsonHead,
      body: JSON.stringify({ from: to || name, text, snippet, brief, kind: kind || channel }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.draft) {
          setDraft(d.draft);
          setTimeout(() => boxRef.current?.focus(), 40);
        } else {
          setNote(d.error || 'the model had nothing to say — write it yourself');
        }
      })
      .catch(() => setNote('could not reach the model'))
      .finally(() => setBusy(null));
  }

  function send() {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy('sending'); setNote('');
    fetch('/api/text/send', {
      method: 'POST',
      headers: jsonHead,
      body: JSON.stringify({ to: to || name, name: name || to, message, channel }),
    })
      .then(r => r.json())
      .then(d => {
        if (!d.ok) {
          setNote(d.error || 'it did not go through — the thread may not be open');
          return;
        }
        fetch('/api/contacts/signal', {
          method: 'POST',
          headers: jsonHead,
          body: JSON.stringify({ kind: kind || channel, from: name || to, action: 'reply' }),
        }).catch(() => {});
        setNote(`sent on ${d.via}`);
        setTimeout(() => onSent?.(d), 600);
      })
      .catch(() => setNote('could not reach the sender'))
      .finally(() => setBusy(null));
  }

  return (
    <div style={{
      border: `1px solid ${C.amber}`,
      borderRadius: C.radius,
      background: C.surface,
      padding: SP[3],
      display: 'flex',
      flexDirection: 'column',
      gap: SP[2],
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: SP[2],
        flexWrap: 'wrap',
        fontFamily: FONT.mono,
        fontSize: FS.label,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: C.text3,
      }}>
        <span>replying to {display} on {channel}</span>
        <span style={{ flex: 1 }} />
        <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{draft.trim().length} chars</span>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              appearance: 'none',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: C.text3,
              fontFamily: FONT.mono,
              fontSize: FS.label,
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              padding: '2px 4px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >cancel</button>
        )}
      </div>

      <textarea
        ref={boxRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        rows={4}
        placeholder={`write to ${display}…`}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          background: C.bg,
          color: C.text1,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: SP[3],
          fontFamily: FONT.sans,
          fontSize: FS.body,
          lineHeight: 1.5,
          outline: 'none',
          textTransform: 'none',
          letterSpacing: 'normal',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={suggest}
          disabled={busy === 'drafting'}
          style={{
            appearance: 'none',
            cursor: 'pointer',
            fontFamily: FONT.mono,
            fontSize: FS.label,
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            borderRadius: 6,
            padding: '9px 12px',
            minHeight: 40,
            border: `1px solid ${C.border}`,
            background: 'transparent',
            color: C.text2,
          }}
        >{busy === 'drafting' ? 'writing…' : 'draft one for me'}</button>

        <span style={{ flex: 1 }} />

        <motion.button
          type="button"
          onClick={send}
          whileTap={{ scale: .98 }}
          disabled={!draft.trim() || busy === 'sending'}
          style={{
            appearance: 'none',
            cursor: draft.trim() ? 'pointer' : 'not-allowed',
            fontFamily: FONT.mono,
            fontSize: FS.ui,
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            borderRadius: 6,
            padding: '9px 16px',
            minHeight: 44,
            border: `1px solid ${C.amber}`,
            fontWeight: 700,
            background: draft.trim() ? C.amber : 'transparent',
            color: draft.trim() ? '#140d02' : C.text3,
          }}
        >{busy === 'sending' ? 'sending…' : `send on ${channel} →`}</motion.button>
      </div>

      {note && (
        <div style={{
          fontFamily: FONT.sans,
          fontSize: FS.meta,
          textTransform: 'none',
          color: note.startsWith('sent') ? C.amber : C.danger,
        }}>{note}</div>
      )}
    </div>
  );
}
