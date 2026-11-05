import React from 'react';
import { KINDS } from '../lib/kinds.js';

// ShelfStation's card, in Reverb. Palette is shelf-cmd's `theme-cmd` (the one
// in Jesse's screenshot): black page, #111 surface, white accent, grey body
// text - not shelf-cmd's amber default. One card component shared by the grid
// and the deck, so the two views can never drift apart.
export const SHELF = {
  surface:  '#111111',
  surface2: '#161616',
  border:   '#2b2b2b',
  borderHi: '#3d3d3d',
  accent:   '#ffffff',
  text1:    '#b0b0b0',
  text2:    '#8a8a8a',
  text3:    '#6a6a6a',
  radius:   8,
};

const daysOpen = iso => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0);

export function Bubbles({ entry, snippet }) {
  if (!entry) return null;
  if (entry.loading) return <div style={{ fontSize: 11, color: SHELF.text3 }}>reading the thread…</div>;
  if (!entry.messages.length) {
    return <div style={{ fontSize: 11.5, color: SHELF.text2, textTransform: 'none' }}>{snippet}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260,
                  overflowY: 'auto', paddingRight: 2 }}>
      {entry.messages.slice(-30).map((m, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: m.outbound ? 'flex-end' : 'flex-start' }}>
          <div style={{
            maxWidth: '82%', padding: '7px 10px', fontSize: 11.5, lineHeight: 1.45,
            textTransform: 'none', textWrap: 'pretty', wordBreak: 'break-word',
            borderRadius: m.outbound ? '9px 9px 2px 9px' : '9px 9px 9px 2px',
            border: `1px solid ${m.outbound ? SHELF.borderHi : SHELF.border}`,
            background: m.outbound ? '#1e1e1e' : SHELF.surface2,
            color: m.outbound ? SHELF.accent : SHELF.text1,
          }}>{m.text}</div>
        </div>
      ))}
    </div>
  );
}


// Everything known about a non-message item. Short, and honest about gaps:
// if the source record is thin, this shows that rather than padding it.
function Facts({ t, showDescription }) {
  const todo = (t.tasks || []).filter(x => x && x.text);
  const rows = [
    ['client', t.business ? `${t.from} (${t.business})` : t.from],
    ['status', t.status && String(t.status).replace(/_/g, ' ')],
    ['when', t.when],
    ['prefers', t.preferredDays || t.timeline],
    ['raised', t.raised ? new Date(t.raised).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : null],
    ['job', t.jobId && `#${t.jobId}`],
  ].filter(([, v]) => v);

  const link = { color: SHELF.accent, textDecoration: 'none', borderBottom: `1px solid ${SHELF.border}` };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {showDescription && t.snippet && (
        <div style={{ fontSize: 11.5, lineHeight: 1.55, color: SHELF.text1,
                      textTransform: 'none', textWrap: 'pretty', whiteSpace: 'pre-wrap' }}>
          {t.snippet}
        </div>
      )}

      {/* The checklist is what the job actually consists of. */}
      {todo.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {todo.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.45,
                                  textTransform: 'none', textWrap: 'pretty',
                                  color: x.done ? SHELF.text3 : SHELF.text1 }}>
              <span style={{ flex: 'none', color: x.done ? SHELF.text3 : SHELF.accent }}>{x.done ? '✓' : '○'}</span>
              <span style={{ textDecoration: x.done ? 'line-through' : 'none' }}>{x.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Address and number are the two things worth tapping on a phone. */}
      {(t.address || t.phone) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 11.5, textTransform: 'none' }}>
          {t.address && (
            <a href={`https://maps.google.com/?q=${encodeURIComponent(t.address)}`}
               target="_blank" rel="noopener noreferrer"
               onClick={e => e.stopPropagation()}
               style={{ ...link, padding: '6px 0', minHeight: 32 }}>{t.address}</a>
          )}
          {t.phone && (
            <a href={`tel:${String(t.phone).replace(/\s+/g, '')}`}
               onClick={e => e.stopPropagation()}
               style={{ ...link, padding: '6px 0', minHeight: 32 }}>{t.phone}</a>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: 10.5 }}>
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <div style={{ color: SHELF.text3, textTransform: 'uppercase', letterSpacing: '.08em' }}>{k}</div>
            <div style={{ color: t.overdue && k === 'when' ? '#e07070' : SHELF.text1, textTransform: 'none' }}>{v}</div>
          </React.Fragment>
        ))}
      </div>

      {/* Where the job's information came from. */}
      {(t.noteCount > 0 || t.photoCount > 0) && (
        <div style={{ borderTop: `1px solid ${SHELF.border}`, paddingTop: 8,
                      display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: SHELF.text3 }}>
            {t.noteCount || 0} note{t.noteCount === 1 ? '' : 's'}
            {t.photoCount ? ` · ${t.photoCount} photo${t.photoCount === 1 ? '' : 's'}` : ''}
          </div>
          {t.lastNote && (
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: SHELF.text2,
                          textTransform: 'none', textWrap: 'pretty' }}>
              <span style={{ color: SHELF.text3 }}>{t.lastNote.author === 'admin' ? 'you' : 'client'}: </span>
              {String(t.lastNote.message).slice(0, 240)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// actions: [{ label, onPress, strong? }] - rendered as ShelfStation's quiet
// text row along the card's foot.
export default function ItemCard({
  t, tint, expanded, entry, cal, onToggle, actions = [], style, bodyMax = 4,
}) {
  const k = KINDS[t.kind] || KINDS.email;
  const open = daysOpen(t.firstSeenAt);
  // Only show the snippet when it actually adds something: it used to repeat
  // the title almost verbatim on every job card.
  const norm = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const dup = norm(t.snippet) && (norm(t.text).includes(norm(t.snippet)) || norm(t.snippet).includes(norm(t.text)));
  const body = t.snippet && !dup ? t.snippet : null;

  return (
    <div style={{
      background: SHELF.surface, border: `1px solid ${SHELF.border}`,
      borderRadius: SHELF.radius, display: 'flex', flexDirection: 'column',
      overflow: 'hidden', ...style,
    }}>
      <div style={{ padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        {/* channel + how long it has been sitting */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9.5,
                      letterSpacing: '.1em', textTransform: 'uppercase' }}>
          <span style={{ color: SHELF.text3, border: `1px solid ${SHELF.border}`,
                         borderRadius: 4, padding: '2px 6px' }}>{k.label}</span>
          {t.status && (
            <span style={{ color: SHELF.text2, border: `1px solid ${SHELF.border}`,
                           borderRadius: 4, padding: '2px 6px' }}>{String(t.status).replace(/_/g, ' ')}</span>
          )}
          <span style={{ flex: 1 }} />
          {open >= 1 && (
            <span style={{ color: open >= 2 ? SHELF.accent : SHELF.text3,
                           fontWeight: open >= 2 ? 700 : 400 }}>open {open}d</span>
          )}
        </div>

        {/* dot + the item itself, as the card's title */}
        <div onClick={onToggle} style={{ display: 'flex', gap: 8, cursor: 'pointer' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: tint,
                         flex: 'none', marginTop: 5 }} />
          <div style={{
            flex: 1, fontSize: 13, lineHeight: 1.5, color: SHELF.accent, fontWeight: 700,
            textTransform: 'none', textWrap: 'pretty', minWidth: 0,
            ...(expanded ? {} : {
              display: '-webkit-box', WebkitLineClamp: bodyMax, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }),
          }}>{t.text}</div>
        </div>

        {/* The facts grid below supersedes this one-liner when it is showing. */}
        {!(expanded && !entry) && (
        <div style={{ fontSize: 10.5, textTransform: 'none',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: SHELF.text3 }}>{t.from}</span>
          {t.when && <span style={{ color: SHELF.text3 }}> · </span>}
          {t.when && (
            <span style={{ color: t.overdue ? '#e07070' : SHELF.text3,
                           fontWeight: t.overdue ? 700 : 400 }}>{t.when}</span>
          )}
        </div>
        )}

        {expanded
          ? (entry
              ? <Bubbles entry={entry} snippet={t.snippet} />
              // No thread to read (a job, a calendar entry). Echoing the title
              // back was useless, so show the facts the record actually has -
              // plus the description only when it says more than the title.
              : <Facts t={t} showDescription={!dup} />)
          : body && (
              <div style={{ fontSize: 11.5, lineHeight: 1.5, color: SHELF.text2,
                            textTransform: 'none', textWrap: 'pretty',
                            display: '-webkit-box', WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{body}</div>
            )}

        {cal && cal !== 'adding' && cal !== 'done' && (
          <div style={{ fontSize: 10.5, color: '#e07070', textTransform: 'none' }}>⚠ {cal}</div>
        )}
        {cal === 'done' && (
          <div style={{ fontSize: 10.5, color: SHELF.accent, textTransform: 'none' }}>
            ✓ opened in calendar — hit save there
          </div>
        )}
      </div>

      {actions.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 14px',
                      borderTop: `1px solid ${SHELF.border}`, background: SHELF.surface2 }}>
          {actions.map(a => (
            <button key={a.label} type="button" onClick={a.onPress} style={{
              appearance: 'none', border: 0, margin: 0, padding: '4px 0', background: 'none',
              fontFamily: 'inherit', fontSize: 10.5, letterSpacing: '.04em',
              textTransform: 'none', cursor: 'pointer', minHeight: 32,
              color: a.strong ? SHELF.accent : SHELF.text2,
              fontWeight: a.strong ? 700 : 400,
            }}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
