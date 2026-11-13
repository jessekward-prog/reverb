import React, { useEffect, useState } from 'react';
import { DitherField, CrtLayers, BACKDROP_CSS, INK, AMBER,
         EDGE, RULE, HAIR, WELL, PANEL, ROW } from './CrtBackdrop.jsx';
import { authHeaders } from '../api.js';

// A topic tab: kinder, daycare, Peyton's school, receipts - whatever he has
// told the app never to let slip. Two halves, and the order matters.
//
// The top half is the written update: what has happened lately, what has a
// date on it, what is waiting on him. It is rewritten only when something new
// files, so opening the tab twice in an hour does not burn a model call and
// does not quietly reword yesterday's answer.
//
// The bottom half is the dated record underneath it - every matching message,
// grouped by the day it arrived, kept forever. The reports age out with the
// inbox; this does not, which is the whole point of a tab you can scroll back
// through in March to find what the kinder said in February.
const CONTENT_MAX = 700;
const CSS = BACKDROP_CSS + `
@keyframes rv-rise { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
.topic-scroll::-webkit-scrollbar { width:0 }
`;

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function dayLabel(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  const head = `${DAY[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
  return diff < 7 ? `${head} · ${diff}d ago` : head;
}
const ago = iso => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function TopicView({ slug, auth, onLockout, onOpenHome, onOpenBrowser, onOpenChat, onTopicsChanged }) {
  const [phase, setPhase] = useState('loading');
  const [topic, setTopic] = useState(null);
  const [editing, setEdit] = useState(null);
  const [busy, setBusy]   = useState(null);
  const head = { 'Content-Type': 'application/json', ...authHeaders(auth?.token) };

  function load(markRead) {
    fetch(`/api/topics/${slug}`, { headers: authHeaders(auth?.token) })
      .then(r => { if (r.status === 401) { onLockout?.(); throw new Error('401'); } return r.json(); })
      .then(d => {
        setTopic(d); setPhase('ready');
        // Opening the tab IS reading it; the badge in the rail clears here.
        if (markRead && d.unread) {
          fetch(`/api/topics/${slug}`, { method: 'POST', headers: head, body: JSON.stringify({ read: true }) })
            .then(() => onTopicsChanged?.()).catch(() => {});
        }
      })
      .catch(() => setPhase('ready'));
  }
  useEffect(() => { setPhase('loading'); load(true); /* eslint-disable-next-line */ }, [slug]);

  function saveWords() {
    setBusy('saving');
    fetch(`/api/topics/${slug}`, { method: 'POST', headers: head,
      body: JSON.stringify({ patterns: editing, rewrite: true }) })
      .then(r => r.json())
      .then(() => { setEdit(null); load(false); onTopicsChanged?.(); })
      .finally(() => setBusy(null));
  }
  function rewrite() {
    setBusy('writing');
    fetch(`/api/topics/${slug}`, { method: 'POST', headers: head, body: JSON.stringify({ rewrite: true }) })
      .then(r => r.json()).then(d => setTopic(t => ({ ...t, ...d })))
      .finally(() => setBusy(null));
  }
  function remove() {
    if (busy) return;
    if (!window.confirm(`Delete the "${topic?.label}" tab and everything filed under it?`)) return;
    setBusy('deleting');
    fetch(`/api/topics/${slug}`, { method: 'DELETE', headers: head })
      .then(() => { onTopicsChanged?.(); onOpenHome?.(); })
      .finally(() => setBusy(null));
  }

  const navBtn = active => ({
    appearance: 'none', border: 0, margin: 0, background: active ? RULE : WELL,
    color: INK, fontFamily: 'inherit', fontSize: 11, letterSpacing: '.06em',
    textTransform: 'uppercase', padding: '7px 10px', cursor: 'pointer',
  });
  const prose = { textTransform: 'none', letterSpacing: 'normal',
                  fontFamily: "ui-sans-serif, system-ui, sans-serif" };

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100dvh', overflow: 'hidden',
      background: WELL, color: INK,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    }}>
      <style>{CSS}</style>
      <DitherField /><CrtLayers />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column',
                    height: '100%', maxWidth: CONTENT_MAX, margin: '0 auto', boxSizing: 'border-box' }}>
        <div className="rv-head">
          <div className="rv-head-title">
            <div style={{ fontWeight: 700 }}>// {topic?.label || slug}</div>
            <div style={{ opacity: .45 }}>
              {phase === 'loading' ? 'loading…'
                : `${(topic?.days || []).reduce((n, d) => n + d.entries.length, 0)} filed`
                  + `${topic?.summary_at ? ` · update ${ago(topic.summary_at)}` : ''}`}
            </div>
          </div>
          <div className="rv-head-nav" style={{ background: EDGE, border: `1px solid ${EDGE}` }}>
            <button type="button" style={navBtn(false)} onClick={() => onOpenHome?.()}>vita switch</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenBrowser?.()}>browser</button>
            <button type="button" style={navBtn(false)} onClick={() => onOpenChat?.()}>chat</button>
            <button type="button" style={navBtn(true)}>this tab</button>
          </div>
        </div>

        <div className="topic-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 20px 26px',
                                               marginTop: 20, scrollbarWidth: 'none' }}>

          {/* The written update. */}
          {topic?.summary ? (
            <div style={{ marginBottom: 20, padding: '15px 17px', border: `1px solid ${HAIR}`,
                          background: PANEL, animation: 'rv-rise .22s ease-out both' }}>
              <div style={{ opacity: .45, marginBottom: 9 }}>where this stands</div>
              <div style={{ ...prose, fontSize: 13, lineHeight: 1.7, textWrap: 'pretty',
                            whiteSpace: 'pre-wrap' }}>{topic.summary}</div>
            </div>
          ) : phase === 'ready' && (
            <div style={{ marginBottom: 20, padding: '15px 17px', border: `1px solid ${HAIR}`,
                          background: PANEL, opacity: .55, lineHeight: 1.7 }}>
              nothing has come in under these words yet. the update appears the
              first time something matches.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
            <button type="button" onClick={rewrite} disabled={!!busy} style={navBtn(false)}>
              {busy === 'writing' ? 'writing…' : 'rewrite the update'}
            </button>
            <button type="button" onClick={() => setEdit(topic?.patterns || '')} style={navBtn(false)}>
              keywords
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={remove} disabled={!!busy}
                    style={{ ...navBtn(false), color: 'rgba(255,120,110,.8)' }}>delete tab</button>
          </div>

          {editing !== null && (
            <div style={{ marginBottom: 20, padding: '15px 17px', border: `1px solid ${AMBER}`,
                          background: PANEL, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ opacity: .5 }}>catch anything containing — comma separated</div>
              <input value={editing} onChange={e => setEdit(e.target.value)}
                     placeholder="kinder, daycare, peyton, school"
                     style={{ ...prose, background: WELL, color: INK, border: `1px solid ${HAIR}`,
                              padding: '10px 11px', fontSize: 13, outline: 'none', width: '100%',
                              boxSizing: 'border-box' }} />
              <div style={{ ...prose, fontSize: 12, opacity: .5, lineHeight: 1.6 }}>
                Plain words, matched against the sender, the subject and the message —
                no model decides what counts. Anything that matches is always shown,
                even from a muted sender.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setEdit(null)} style={navBtn(false)}>cancel</button>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={saveWords} disabled={busy === 'saving' || !editing.trim()}
                        style={{ ...navBtn(true), background: AMBER, color: '#140d02', fontWeight: 700 }}>
                  {busy === 'saving' ? 'refiling…' : 'save and refile →'}
                </button>
              </div>
            </div>
          )}

          {/* The dated record. */}
          {(topic?.days || []).map((d, di) => (
            <div key={d.date} style={{ marginBottom: 16, animation: 'rv-rise .22s ease-out both',
                                       animationDelay: `${Math.min(di, 6) * 0.03}s` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
                <span style={{ width: 6, height: 6, background: AMBER }} />
                <span style={{ color: AMBER }}>{dayLabel(d.date)}</span>
                <span style={{ opacity: .35 }}>{d.entries.length}</span>
              </div>
              <div style={{ background: PANEL, border: `1px solid ${HAIR}` }}>
                {d.entries.map((e, i) => (
                  <div key={e.id} style={{ padding: ROW,
                                           borderBottom: i === d.entries.length - 1 ? 0 : `1px solid ${HAIR}` }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
                      <span style={{ opacity: .4 }}>{e.kind}</span>
                      <span style={{ ...prose, fontWeight: 700, flex: 1, minWidth: 0,
                                     overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.from_label || 'unknown'}
                      </span>
                      {!e.read_at && <span style={{ color: AMBER, flex: 'none' }}>new</span>}
                    </div>
                    {e.subject && (
                      <div style={{ ...prose, fontSize: 13, fontWeight: 600, lineHeight: 1.4,
                                    marginBottom: 4 }}>{e.subject}</div>
                    )}
                    <div style={{ ...prose, fontSize: 12.5, lineHeight: 1.6, opacity: .72,
                                  textWrap: 'pretty' }}>{e.snippet}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
