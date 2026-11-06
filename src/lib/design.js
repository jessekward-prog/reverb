// Reverb's design tokens. One scale each for type, space and colour, so a
// component never reaches for a raw value.
//
// Why two typefaces: everything was JetBrains Mono, including prose. Mono is
// excellent for data a tradesman scans — numbers, addresses, times, job ids,
// statuses — and poor for sentences, which is exactly what the new briefs are.
// IBM Plex Sans carries the prose: same industrial/technical lineage as a mono,
// deliberately not the Inter/Geist default.
export const FONT = {
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

// 4px grid. No more 13px/11px/9px one-offs.
export const SP = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 };

// Type scale. The floor is deliberate: functional UI text never goes below
// 12px and body text never below 15px - the previous 9.5-11.5px range was the
// single biggest legibility failure (62 findings from impeccable).
export const FS = {
  label: 12,   // uppercase chips and field labels
  meta:  13,   // secondary lines: who, when
  ui:    14,   // buttons and actions
  body:  15,   // briefs, descriptions, messages
  title: 17,   // the card's headline
  head:  20,   // section headings
};

// Neutral ramp, contrast-checked against #000 and #111.
// The old muted grey (#6a6a6a) measured 3.9:1 and failed WCAG AA; every value
// below clears 4.5:1 for body text on both surfaces.
export const C = {
  bg:       '#000000',
  surface:  '#111111',
  surface2: '#171717',
  border:   '#2e2e2e',
  borderHi: '#454545',
  text1:    '#ededed',  // 15.9:1 on surface
  text2:    '#b4b4b4',  //  8.6:1 on surface
  text3:    '#8f8f8f',  //  5.2:1 on surface - was #6a6a6a at 3.9:1
  // Amber is reserved for "act on this now". It is not decoration: if it is
  // amber, there is something to do.
  amber:    '#f0a63c',
  amberDim: 'rgba(240,166,60,.13)',
  danger:   '#f08b8b',
  radius:   10,
};

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
