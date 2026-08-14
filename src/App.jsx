import React, { useState, useEffect } from 'react';
import PinGate from './components/PinGate.jsx';
import ChatView from './components/ChatView.jsx';
import SweepView from './components/SweepView.jsx';
import WorkView from './components/WorkView.jsx';
import TextsView from './components/TextsView.jsx';
import { getStoredAuth, saveAuth, clearStoredAuth } from './api.js';

export default function App() {
  const [stage, setStage]     = useState('loading'); // 'loading' | 'pin' | 'chat'
  const [pinMode, setPinMode] = useState('enter');   // 'setup' | 'enter'
  const [auth, setAuth]       = useState({ token: null, role: null });
  const [view, setView]       = useState('chat');    // 'chat' | 'sweep' | 'work' | 'texts'
  const [draftPrompt, setDraftPrompt] = useState(null);

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
  // sends it themselves; reverb never sends messages on your behalf.
  function stageDraft(task) {
    setDraftPrompt(`Draft a reply to ${task.from} (${task.kind}) about this:\n\n"${task.snippet}"`);
    setView('chat');
  }

  if (stage === 'loading') return null;
  if (stage === 'pin')     return <PinGate mode={pinMode} onAuth={handleAuth} />;
  if (view === 'sweep') {
    return <SweepView
      auth={auth}
      onLockout={handleLockout}
      onOpenChat={() => setView('chat')}
      onOpenWork={() => setView('work')}
      onOpenTexts={() => setView('texts')}
      onDraftReply={stageDraft}
    />;
  }
  if (view === 'work') {
    return <WorkView
      auth={auth}
      onLockout={handleLockout}
      onOpenChat={() => setView('chat')}
      onOpenSweep={() => setView('sweep')}
      onOpenTexts={() => setView('texts')}
      onDraftReply={stageDraft}
    />;
  }
  if (view === 'texts') {
    return <TextsView
      auth={auth}
      onLockout={handleLockout}
      onOpenChat={() => setView('chat')}
      onOpenSweep={() => setView('sweep')}
      onOpenWork={() => setView('work')}
    />;
  }
  return <ChatView
    auth={auth}
    onLockout={handleLockout}
    onOpenSweep={() => setView('sweep')}
    onOpenWork={() => setView('work')}
    onOpenTexts={() => setView('texts')}
    draftPrompt={draftPrompt}
    onDraftConsumed={() => setDraftPrompt(null)}
  />;
}
