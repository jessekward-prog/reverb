import React, { useState, useEffect } from 'react';
import PinGate from './components/PinGate.jsx';
import ChatView from './components/ChatView.jsx';
import { getStoredAuth, saveAuth, clearStoredAuth } from './api.js';

export default function App() {
  const [stage, setStage]     = useState('loading'); // 'loading' | 'pin' | 'chat'
  const [pinMode, setPinMode] = useState('enter');   // 'setup' | 'enter'
  const [auth, setAuth]       = useState({ token: null, role: null });

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

  if (stage === 'loading') return null;
  if (stage === 'pin')     return <PinGate mode={pinMode} onAuth={handleAuth} />;
  return <ChatView auth={auth} onLockout={handleLockout} />;
}
