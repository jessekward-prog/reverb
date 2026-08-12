const TOKEN_KEY = 'reverb_token';
const ROLE_KEY  = 'reverb_role';

export function getStoredAuth() {
  return {
    token: sessionStorage.getItem(TOKEN_KEY),
    role:  sessionStorage.getItem(ROLE_KEY),
  };
}

export function saveAuth(token, role) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(ROLE_KEY, role);
}

export function clearStoredAuth() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ROLE_KEY);
}

export function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function djb2(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

import { marked } from 'marked';

marked.use({ gfm: true, breaks: true });

export function renderText(text) {
  let html = marked.parse(text);
  // Open all links in a new tab
  html = html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
  return html;
}
