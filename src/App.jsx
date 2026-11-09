import React, { useState, useEffect } from 'react';
import PinGate from './components/PinGate.jsx';
import NavRail from './components/NavRail.jsx';
import VitaSwitchView from './components/VitaSwitchView.jsx';
import ChatView from './components/ChatView.jsx';
import SweepView from './components/SweepView.jsx';
import TasksView from './components/TasksView.jsx';
import WorkView from './components/WorkView.jsx';
import LifeView from './components/LifeView.jsx';
import TextsView from './components/TextsView.jsx';
import BrowserView from './components/BrowserView.jsx';
import { getStoredAuth, saveAuth, clearStoredAuth, authHeaders } from './api.js';

export default function App() {
  const [stage, setStage]     = useState('loading'); // 'loading' | 'pin' | 'chat'
  const [pinMode, setPinMode] = useState('enter');   // 'setup' | 'enter'
  const [auth, setAuth]       = useState({ token: null, role: null });
  // 'home' | 'tasks' | 'chat' | 'sweep' | 'work' | 'life' | 'texts' | 'browser'
  // home is the Vita Switch page: work, the feed and life all at once, which is
  // what you land on. The single-report tabs stay for looking at one half.
  const [view, setView]       = useState('home');
  const [draftPrompt, setDraftPrompt] = useState(null);
  const [outstanding, setOutstanding] = useState(0); // items chased 2+ days, for the rail badge

  // Keep the rail's chase badge current: refetch the to-do list's chase count
  // on auth and whenever the view changes (so it updates after a sweep).
  useEffect(() => {
    if (stage !== 'chat' || !auth.token) return;
    fetch('/api/tasks', { headers: authHeaders(auth.token) })
      .then(r => (r.ok ? r.json() : null))
      .then(d => d && setOutstanding(d.outstanding || 0))
      .catch(() => {});
  }, [stage, auth.token, view]);

  useEffect(() => {
    const { token, role } = getStoredAuth();
    if (token) {
      setAuth({ token, role });
      setStage('chat');
    } else {
      fetch('/api/pin')
        .then(r => r.json())
        .then(({ set }) => { setPinMode(set ? 'enter' : 'setup'); setStage('pin'); })
        .catch(() => { setPinMode('enter'); setStage('pin'); });
    }
  }, []);

  function handleAuth(token, role) {
    saveAuth(token, role);
    setAuth({ token, role });
    setStage('chat');
  }

  function handleLockout() {
    clearStoredAuth();
    setAuth({ token: null, role: null });
    setPinMode('enter');
    setStage('pin');
  }

  // Stages a drafted-reply prompt and switches to chat — the user reviews and
  // sends it themselves; reverb never sends messages on your behalf. Also the
  // positive signal into contact memory: acting on someone's message is
  // stronger evidence they matter than just seeing it go by.
  function stageDraft(task) {
    if (task.kind && task.from) {
      fetch('/api/contacts/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(auth?.token) },
        body: JSON.stringify({ kind: task.kind, from: task.from, action: 'reply' }),
      }).catch(() => {});
    }
    setDraftPrompt(`Draft a reply to ${task.from} (${task.kind}) about this:\n\n"${task.snippet}"`);
    setView('chat');
  }

  if (stage === 'loading') return null;
  if (stage === 'pin')     return <PinGate mode={pinMode} onAuth={handleAuth} />;

  // Every view takes the same set of tab-switch callbacks; extra ones a view
  // doesn't use are harmless. Collected here so the shell wraps once instead of
  // the nav rail being bolted onto five near-identical returns.
  const nav = {
    onOpenChat:  () => setView('chat'),
    onOpenSweep: () => setView('sweep'),
    onOpenTasks: () => setView('tasks'),
    onOpenWork:  () => setView('work'),
    onOpenLife:  () => setView('life'),
    onOpenTexts: () => setView('texts'),
    onOpenBrowser: () => setView('browser'),
  };

  let content;
  if (view === 'home')         content = <VitaSwitchView auth={auth} onLockout={handleLockout} {...nav} onDraftReply={stageDraft} />;
  else if (view === 'sweep')        content = <SweepView auth={auth} onLockout={handleLockout} {...nav} />;
  else if (view === 'tasks')   content = <TasksView auth={auth} onLockout={handleLockout} {...nav} onDraftReply={stageDraft} />;
  else if (view === 'work')    content = <WorkView auth={auth} onLockout={handleLockout} {...nav} onDraftReply={stageDraft} />;
  else if (view === 'life')    content = <LifeView auth={auth} onLockout={handleLockout} {...nav} onDraftReply={stageDraft} />;
  else if (view === 'texts')   content = <TextsView auth={auth} onLockout={handleLockout} {...nav} />;
  else if (view === 'browser') content = <BrowserView auth={auth} onLockout={handleLockout} {...nav} />;
  else content = <ChatView auth={auth} onLockout={handleLockout} {...nav}
                   draftPrompt={draftPrompt} onDraftConsumed={() => setDraftPrompt(null)} />;

  return (
    <div className="rv-app">
      <NavRail active={view} onView={setView} onLockout={handleLockout} outstanding={outstanding} />
      <div className="rv-main">{content}</div>
    </div>
  );
}
