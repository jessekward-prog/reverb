import React from 'react';
import { INK, AMBER, HAIR, WELL, FILM } from './CrtBackdrop.jsx';

// The rail is desktop only (hidden below 1024px), and this app is used on a
// phone more than anywhere else - so without this the custom tabs would simply
// not exist on the device he actually reads his mail on. Same tabs, same
// unread counts, as a scrolling strip under the header. Hidden at >=1024px by
// .topic-strip in style.css, where the rail takes over.
export default function TopicStrip({ topics = [], active, onView }) {
  if (!topics.length) return null;
  return (
    <div className="topic-strip" style={{
      display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'none',
      padding: '0 0 14px',
    }}>
      {topics.map(tp => {
        const on = active === `topic:${tp.slug}`;
        return (
          <button key={tp.slug} type="button" onClick={() => onView?.(`topic:${tp.slug}`)} style={{
            flex: 'none', appearance: 'none', cursor: 'pointer', display: 'flex',
            alignItems: 'center', gap: 6, border: `1px solid ${on ? AMBER : HAIR}`,
            background: on ? FILM : WELL, color: on ? AMBER : INK,
            fontFamily: 'inherit', fontSize: 10, letterSpacing: '.08em',
            textTransform: 'uppercase', padding: '7px 10px', minHeight: 32,
          }}>
            <span>{tp.label}</span>
            {tp.unread > 0 && (
              <span style={{ color: AMBER, border: `1px solid ${AMBER}`, padding: '0 4px',
                             letterSpacing: 0 }}>{tp.unread}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
