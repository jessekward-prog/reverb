import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import './style.css';

// autoUpdate activates a new build immediately (skipWaiting+clientsClaim in
// vite.config.js), but the browser only checks for a new service worker on
// its own schedule — for a chat app people leave open, that's not often
// enough. Poll explicitly: on every tab focus, and hourly as a fallback.
registerSW({
  immediate: true,
  onRegisteredSW(url, registration) {
    if (!registration) return;
    registration.update();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) registration.update();
    });
    setInterval(() => registration.update(), 60 * 60 * 1000);
  },
});

createRoot(document.getElementById('root')).render(<App />);
