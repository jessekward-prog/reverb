import { AMBER } from '../components/CrtBackdrop.jsx';

// Shared across Sweep/Work/Life — the channel badge on every card so an item
// can always be traced back to where it actually lives (insta/messenger/text/etc).
export const KINDS = {
  sms:       { label: 'sms',        tint: AMBER },
  email:     { label: 'email',      tint: '#9fb0a8' },
  cal:       { label: 'calendar',   tint: '#8fa8c4' },
  call:      { label: 'missed',     tint: '#c47c7c' },
  bizemail:  { label: 'biz email',  tint: '#7f9f9f' },
  whatsapp:  { label: 'whatsapp',   tint: '#7fbf8f' },
  messenger: { label: 'messenger',  tint: '#8f9fc4' },
  instagram: { label: 'instagram',  tint: '#c48fb0' },
  job:       { label: 'job',        tint: '#c4a35f' },
};

export const SOURCES = [
  { key: 'sms',       label: 'get_recent_texts' },
  { key: 'email',     label: 'get_recent_emails' },
  { key: 'cal',       label: 'get_upcoming_events' },
  { key: 'call',      label: 'call log', unavailable: true },
  { key: 'bizemail',  label: 'get_recent_business_emails' },
  { key: 'whatsapp',  label: 'get_recent_notifications (whatsapp)' },
  { key: 'messenger', label: 'get_recent_notifications (messenger)' },
  { key: 'instagram', label: 'get_recent_notifications (instagram)' },
  { key: 'job',       label: 'get_switchcraft_jobs' },
];
