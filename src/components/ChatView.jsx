import React, { useState, useEffect, useRef, useCallback } from 'react';
import HistoryDrawer from './HistoryDrawer.jsx';
import SettingsDrawer from './SettingsDrawer.jsx';
import { DitherField, CrtLayers, BACKDROP_CSS } from './CrtBackdrop.jsx';
import { authHeaders, renderText } from '../api.js';
import { playThinkingBeep, playDoneBeep } from '../audio.js';

const DEFAULT_SYSTEM = 'You are Reverb, a personal assistant with access to the user\'s texts, calendar, personal and business email, WhatsApp/Messenger/Instagram notifications, and Switch Craft Electrics jobs. You have six tools: get_recent_texts, get_upcoming_events, get_recent_emails, get_recent_business_emails, get_recent_notifications, and get_switchcraft_jobs. Use them whenever the user asks about messages, their schedule, their inbox, or open jobs — never guess at this information. Answer everything else from your own knowledge.';

const PREFER_MODEL   = 'gemma-4-e4b';
const URL_RE          = /https?:\/\/[^\s<>"']+/i;
const linkPreviewCache = new Map();

function dayKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dateLabelFor(iso) {
  const d = iso ? new Date(iso) : new Date();
  const today = new Date();
  const yest  = new Date(); yest.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return 'today';
  if (dayKey(iso) === dayKey(yest.toISOString())) return 'yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* Scans a message for a URL and renders a preview card underneath it —
 * ported from bit-prompt's attachLinkPreview, adapted to fetch via React
 * state instead of imperative DOM appendChild. */
function LinkPreview({ content, token }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const match = content.match(URL_RE);
    if (!match) { setData(null); return; }
    const url = match[0];
    const cached = linkPreviewCache.get(url);
    if (cached) { setData(cached); return; }
    let cancelled = false;
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { headers: authHeaders(token) })
      .then(r => r.json())
      .then(d => {
        if (cancelled || d.error || (!d.title && !d.image)) return;
        linkPreviewCache.set(url, d);
        setData(d);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [content, token]);

  if (!data) return null;
  return (
    <a className="link-preview" href={data.url} target="_blank" rel="noopener noreferrer">
      {data.image && <img src={data.image} alt="" onError={e => e.target.remove()} />}
      <div className="link-preview-text">
        {data.domain && <div className="link-preview-domain">{data.domain}</div>}
        {data.title && <div className="link-preview-title">{data.title}</div>}
        {data.description && <div className="link-preview-desc">{data.description}</div>}
      </div>
    </a>
  );
}


export default function ChatView({ auth, onLockout, onOpenSweep, onOpenWork, onOpenTexts, draftPrompt, onDraftConsumed }) {
  const [messages, setMessages]       = useState([]);
  const [pending, setPending]         = useState(null); // {status, text} | {retry, fn} | null
  const [convId, setConvId]           = useState(null);
  const [convTitle, setConvTitle]     = useState('');
  const [models, setModels]           = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [systemPrompt, setSystemPrompt]   = useState(() => localStorage.getItem('lm_system') || DEFAULT_SYSTEM);
  const [inputText, setInputText]     = useState('');
  const [sendDisabled, setSendDisabled] = useState(false);
  const [showHistory, setShowHistory]       = useState(false);
  const [showSettings, setShowSettings]     = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pwaPrompt, setPwaPrompt]           = useState(null);
  const [showScrollBtn, setShowScrollBtn]   = useState(false);
  const [lightboxSrc, setLightboxSrc]       = useState(null);

  const isStreamingRef  = useRef(false);
  const receivedRef     = useRef('');
  const displayedLenRef = useRef(0);
  const revealTimerRef  = useRef(null);
  const streamDoneRef   = useRef(false);
  const messagesEndRef  = useRef(null);
  const messagesAreaRef = useRef(null);
  const autoScrollRef   = useRef(true);
  const inputRef        = useRef(null);
  const deferredInstall = useRef(null);
  const modelPickerRef  = useRef(null);
  const pushRipple      = useRef(() => {});

  // ── Init ────────────────────────────────────────────────
  useEffect(() => {
    loadModels();

    const handler = e => { e.preventDefault(); deferredInstall.current = e; setPwaPrompt(true); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      clearInterval(revealTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (autoScrollRef.current) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pending]);

  // Pre-fills the input from a Sweep "draft reply" — never auto-sends, the
  // user still reviews and hits send themselves.
  useEffect(() => {
    if (!draftPrompt) return;
    setInputText(draftPrompt);
    inputRef.current?.focus();
    onDraftConsumed?.();
  }, [draftPrompt, onDraftConsumed]);

  useEffect(() => {
    if (!showModelPicker) return;
    const handler = e => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target))
        setShowModelPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelPicker]);

  // ── Models ───────────────────────────────────────────────
  async function loadModels() {
    try {
      const res = await fetch('/api/models', { headers: authHeaders(auth.token) });
      const data = await res.json();
      const ids = data.data.map(m => m.id);
      setModels(ids);
      const pref = ids.find(id => id.toLowerCase().includes(PREFER_MODEL)) || ids[0] || '';
      setSelectedModel(pref);
    } catch {
      setModels([]);
    }
  }

  // ── Conversation management ──────────────────────────────
  async function loadLatestConversation() {
    try {
      const res = await fetch('/api/conversations', { headers: authHeaders(auth.token) });
      if (!res.ok) return;
      const list = await res.json();
      if (list.length) await switchConversation(list[0].id, list[0].title);
    } catch {}
  }

  async function switchConversation(id, title) {
    setConvId(id);
    setConvTitle(title || '');
    setMessages([]);
    try {
      const res = await fetch(`/api/conversations/${id}/messages`, { headers: authHeaders(auth.token) });
      if (!res.ok) return;
      const saved = await res.json();
      setMessages(saved.map((m, i) => ({ ...m, id: i })));
    } catch {}
  }

  function startNewChat() {
    setConvId(null);
    setConvTitle('');
    setMessages([]);
  }

  // ── Persistence ──────────────────────────────────────────
  const convIdRef = useRef(convId);
  useEffect(() => { convIdRef.current = convId; }, [convId]);

  async function persistMessage(msg) {
    let id = convIdRef.current;
    if (!id) {
      try {
        const res = await fetch('/api/conversations', { method: 'POST', headers: authHeaders(auth.token) });
        const conv = await res.json();
        id = conv.id;
        convIdRef.current = id;
        setConvId(id);
      } catch { return; }
    }
    fetch(`/api/conversations/${id}/messages`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(auth.token) },
      body:    JSON.stringify(msg),
    }).catch(() => {});
  }

  // ── Send ─────────────────────────────────────────────────
  async function send(userText, priorMessages) {
    if (isStreamingRef.current || !userText.trim()) return;
    isStreamingRef.current = true;
    setSendDisabled(true);
    receivedRef.current = '';
    displayedLenRef.current = 0;
    streamDoneRef.current = false;
    clearInterval(revealTimerRef.current);

    const userMsg = { id: Date.now(), role: 'user', content: userText, created_at: new Date().toISOString() };
    const nextMessages = [...priorMessages, userMsg];
    setMessages(nextMessages);
    setPending({ status: null, text: '' });
    playThinkingBeep();

    const showRetry = () => {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
      setPending({
        retry: true,
        fn: () => {
          setPending(null);
          isStreamingRef.current = false;
          setSendDisabled(false);
          setMessages(priorMessages); // remove the failed user msg
          send(userText, priorMessages);
        },
      });
    };

    const finalize = () => {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
      playDoneBeep();
      const finalText = receivedRef.current;
      if (!finalText.trim()) { showRetry(); return; }

      const aiMsg = { id: Date.now() + 1, role: 'assistant', content: finalText, created_at: new Date().toISOString() };
      setMessages(prev => [...prev, aiMsg]);
      setPending(null);

      persistMessage({ role: 'user', content: userText });
      persistMessage({ role: 'assistant', content: finalText, model: selectedModel });

      // Poll for AI-generated title ~3s after response — server generates
      // it async so it won't be ready when persistMessage returns.
      setTimeout(async () => {
        const id = convIdRef.current;
        if (!id) return;
        try {
          const r = await fetch('/api/conversations', { headers: authHeaders(auth.token) });
          if (!r.ok) return;
          const list = await r.json();
          const conv = list.find(c => c.id === id);
          if (conv?.title && conv.title !== 'New chat') setConvTitle(conv.title);
        } catch {}
      }, 3000);

      isStreamingRef.current = false;
      setSendDisabled(false);
      inputRef.current?.focus();
    };

    // Smooth reveal ticker: decouples displayed text from network chunk
    // size so it always advances in small, even steps instead of jumping.
    revealTimerRef.current = setInterval(() => {
      const full = receivedRef.current;
      const gap  = full.length - displayedLenRef.current;
      if (gap > 0) {
        const step = Math.max(1, Math.ceil(gap / 3));
        displayedLenRef.current = Math.min(full.length, displayedLenRef.current + step);
        setPending(prev => (prev && !prev.retry)
          ? { ...prev, text: full.slice(0, displayedLenRef.current), status: null }
          : prev);
      } else if (streamDoneRef.current) {
        finalize();
      }
    }, 22);

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(auth.token) },
        body: JSON.stringify({
          model:    selectedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            ...nextMessages.map(m => ({ role: m.role, content: m.content })),
          ],
          stream: true,
        }),
      });

      if (res.status === 401) {
        clearInterval(revealTimerRef.current);
        revealTimerRef.current = null;
        onLockout();
        return;
      }
      if (!res.ok) throw new Error(`Server ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop(); // keep any incomplete trailing line
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') break;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.type === 'status') {
              setPending(prev => (prev && !prev.retry) ? { ...prev, status: parsed.message } : prev);
              continue;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) receivedRef.current += delta;
          } catch {}
        }
      }

      streamDoneRef.current = true;

    } catch {
      showRetry();
      return;
    }
  }

  function handleSubmit(e) {
    e?.preventDefault();
    const text = inputText.trim();
    if (!text || sendDisabled) return;
    setInputText('');
    autoScrollRef.current = true;
    pushRipple.current(1.4);
    send(text, messages);
  }

  // ── Render ───────────────────────────────────────────────
  const navBtn = (active) => ({
    appearance: 'none', border: 0, margin: 0, background: active ? 'rgba(232,232,228,.14)' : '#060606',
    color: '#e8e8e4', fontFamily: 'inherit', fontSize: 11, letterSpacing: '.06em',
    textTransform: 'uppercase', padding: '7px 10px', cursor: 'pointer',
  });

  return (
    <div className="app-backdrop">
    <style>{BACKDROP_CSS}</style>
    <DitherField pushRef={pushRipple} />
    <CrtLayers />
    <div className="app-shell">
      {/* Header — same title-left / toggle-right pattern as Sweep */}
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 12, padding: '20px 20px 14px', position: 'static', minHeight: 0,
        background: 'none', border: 'none',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>// reverb</div>
          <div style={{ opacity: .45, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
            {convTitle || 'new conversation'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div className="model-picker-wrap" ref={modelPickerRef}>
            <button
              className="icon-header-btn"
              title={selectedModel || 'Select model'}
              onClick={() => setShowModelPicker(p => !p)}
            >&#8853;</button>
            {showModelPicker && (
              <div className="model-picker">
                {models.length === 0
                  ? <span className="model-option">No models found</span>
                  : models.map(id => (
                    <button
                      key={id}
                      className={`model-option${id === selectedModel ? ' active' : ''}`}
                      onClick={() => { setSelectedModel(id); setShowModelPicker(false); }}
                    >{id}</button>
                  ))
                }
              </div>
            )}
          </div>
          <button className="icon-header-btn" title="Chats" onClick={() => setShowHistory(true)}>&#9776;</button>
          <button className="icon-header-btn" title="Settings" onClick={() => setShowSettings(true)}>&#9881;</button>
          {/* Toggle last, flush against the right edge — same position Sweep's
              pill sits at, since it has nothing after it either. */}
          <div style={{ display: 'flex', gap: 1, background: 'rgba(232,232,228,.18)',
                        border: '1px solid rgba(232,232,228,.18)' }}>
            <button type="button" style={navBtn(true)}>chat</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenSweep?.()}>sweep</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenWork?.()}>work</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenTexts?.()}>texts</button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div
        className="messages-area"
        ref={messagesAreaRef}
        onScroll={() => {
          const el = messagesAreaRef.current;
          if (!el) return;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          autoScrollRef.current = nearBottom;
          setShowScrollBtn(!nearBottom);
        }}
        onClick={e => {
          if (e.target.tagName === 'IMG' && e.target.closest('.msg-body')) setLightboxSrc(e.target.src);
        }}
      >
        {messages.length === 0 && !pending && (
          <div className="welcome"><p>How can I help?</p></div>
        )}

        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          const showDateSep = !prev || dayKey(prev.created_at) !== dayKey(msg.created_at);
          return (
            <React.Fragment key={msg.id}>
              {showDateSep && <div className="date-sep">{dateLabelFor(msg.created_at)}</div>}
              <div className={`msg ${msg.role}`}>
                <div className="msg-role">{msg.role === 'user' ? 'You' : 'Reverb'}</div>
                <div
                  className="msg-body"
                  dangerouslySetInnerHTML={{ __html: renderText(msg.content) }}
                />
                <LinkPreview content={msg.content} token={auth.token} />
                {msg.created_at && <div className="msg-time">{timeLabel(msg.created_at)}</div>}
              </div>
            </React.Fragment>
          );
        })}

        {pending && (
          <div className="msg ai">
            <div className="msg-role">Reverb</div>
            {pending.retry ? (
              <div className="msg-body">
                <button className="retry-btn" onClick={pending.fn}>↺ Retry</button>
              </div>
            ) : (
              <div className={`msg-body${pending.text ? '' : ' cursor'}`}>
                {pending.status && !pending.text
                  ? <span className="status-text">{pending.status}</span>
                  : pending.text
                    ? <span dangerouslySetInnerHTML={{ __html: renderText(pending.text) }} />
                    : null
                }
                {pending.text && <span className="cursor-inline">▋</span>}
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />

        {showScrollBtn && (
          <button
            type="button"
            className="scroll-btn"
            title="Scroll to latest"
            onClick={() => {
              autoScrollRef.current = true;
              setShowScrollBtn(false);
              messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
          >&#8595;</button>
        )}
      </div>

      {lightboxSrc && (
        <div className="lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="" />
        </div>
      )}

      {/* Input */}
      <form className="input-form" onSubmit={handleSubmit}>
        <div className="input-card">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="Ask me anything…"
            rows={1}
            value={inputText}
            autoComplete="off"
            spellCheck="false"
            onChange={e => {
              setInputText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
            }}
          />
          <button type="submit" className="send-btn" disabled={sendDisabled} title="Send">&#x23CE;</button>
        </div>
      </form>

      {/* Drawers */}
      <HistoryDrawer
        open={showHistory}
        auth={auth}
        currentId={convId}
        onSwitch={(id) => { switchConversation(id); }}
        onNewChat={startNewChat}
        onClose={() => setShowHistory(false)}
      />
      <SettingsDrawer
        open={showSettings}
        auth={auth}
        currentId={convId}
        systemPrompt={systemPrompt}
        onSystemChange={(s) => { setSystemPrompt(s); localStorage.setItem('lm_system', s); }}
        onDeleteChat={startNewChat}
        onClose={() => setShowSettings(false)}
      />

      {/* PWA prompt */}
      {pwaPrompt && (
        <div className="pwa-prompt">
          <span className="pwa-text">Install Reverb to home screen</span>
          <button className="pwa-install" onClick={async () => {
            if (!deferredInstall.current) return;
            deferredInstall.current.prompt();
            await deferredInstall.current.userChoice;
            deferredInstall.current = null;
            setPwaPrompt(false);
          }}>Install</button>
          <button className="pwa-dismiss" onClick={() => setPwaPrompt(false)}>✕</button>
        </div>
      )}
    </div>
    </div>
  );
}
