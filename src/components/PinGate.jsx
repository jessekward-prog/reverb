import React, { useState, useEffect } from 'react';
import { djb2 } from '../api.js';

const KEYS = ['1','2','3','4','5','6','7','8','9','⌫','0',''];

export default function PinGate({ mode: initialMode, onAuth }) {
  const [mode, setMode]       = useState(initialMode);
  const [digits, setDigits]   = useState([]);
  const [error, setError]     = useState('');
  const [setupPin, setSetupPin] = useState(null);

  const titles = { setup: 'Set a PIN', confirm: 'Confirm PIN', enter: 'Enter PIN' };

  useEffect(() => {
    function onKey(e) {
      if (e.key >= '0' && e.key <= '9') pressDigit(e.key);
      if (e.key === 'Backspace') delDigit();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function pressDigit(d) {
    if (digits.length >= 4) return;
    const next = [...digits, d];
    setDigits(next);
    setError('');
    if (next.length === 4) submit(next);
  }

  function delDigit() {
    setDigits(prev => prev.slice(0, -1));
  }

  async function submit(pin) {
    const hash = djb2(pin.join(''));

    if (mode === 'setup') {
      setSetupPin(pin.join(''));
      setDigits([]);
      setMode('confirm');
      return;
    }

    if (mode === 'confirm') {
      if (pin.join('') !== setupPin) {
        setError('PINs do not match');
        setDigits([]);
        setSetupPin(null);
        setMode('setup');
        return;
      }
      const res  = await fetch('/api/pin/set', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ hash }),
      });
      const data = await res.json();
      if (data.ok) onAuth(data.token, data.role);
      return;
    }

    if (mode === 'enter') {
      const res  = await fetch('/api/pin/verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ hash }),
      });
      const data = await res.json();
      if (data.ok) {
        onAuth(data.token, data.role);
      } else {
        setError('Incorrect PIN');
        setDigits([]);
      }
    }
  }

  return (
    <div className="pin-gate">
      <div className="pin-inner">
        <img src="/banner.png" className="pin-logo" alt="Reverb" />
        <p className="pin-title">{titles[mode]}</p>

        <div className="pin-dots">
          {[0,1,2,3].map(i => (
            <span key={i} className={`pin-dot${i < digits.length ? ' filled' : ''}`} />
          ))}
        </div>

        <div className="pin-pad">
          {KEYS.map((k, i) => {
            if (k === '') return <div key={i} />;
            if (k === '⌫') return (
              <button key={i} className="pin-key pin-key--del" onClick={delDigit}>⌫</button>
            );
            return (
              <button key={i} className="pin-key" onClick={() => pressDigit(k)}>{k}</button>
            );
          })}
        </div>

        <p className="pin-error">{error}</p>
      </div>
    </div>
  );
}
