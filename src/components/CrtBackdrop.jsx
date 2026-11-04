/* Shared bitmap/CRT backdrop for Reverb screens.
 * Extracted from the pin screen so SweepView and PinGate can share one implementation.
 * Requires public/skull.png
 *
 * <DitherField pushRef={ref} />  ref.current(amp) fires a ripple. Fills its
 *   parent (position:absolute; inset:0 on the canvas) and measures that
 *   parent via ResizeObserver — no fixed design size. All spatial constants
 *   (dither pitch, skull size, ripple radius) scale off measured width so
 *   the same relative look holds at phone width or a full desktop window;
 *   timing constants (animation speed, decay) don't scale — a 5s ripple
 *   should still take 5s on a bigger screen, not slow down.
 * <CrtLayers />  scanlines + phosphor + vignette, sits at z-index 1, purely
 *   CSS-percentage based so it needs no measurement at all.
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';

export const INK = '#e8e8e4';
export const AMBER = '#d9932f';

/* ── Surfaces & density ──────────────────────────────────────────────────
   One set of values for every panel, row and rule in the app. These are
   lifted from the People/Rules drawers, which were already the flattest,
   tightest surfaces in Reverb; the report and sweep lists were boxier and
   looser, so they read as a different app. Palette, glow and type are
   deliberately NOT here - they stay exactly as they were.

   Three border weights, used consistently:
     EDGE  a panel or a control group's outer edge
     RULE  a divider between sections inside a panel
     HAIR  the separator between rows of one list - nearly invisible on
           purpose, because a list of 20 rows draws 20 of them.
   ──────────────────────────────────────────────────────────────────────── */
export const EDGE = 'rgba(232,232,228,.18)';
export const RULE = 'rgba(232,232,228,.14)';
export const HAIR = 'rgba(232,232,228,.08)';

export const WELL   = '#060606';            // the base the backdrop shows through
export const RAISED = '#0b0b0a';            // drawers, toasts - sits above the well
export const FILM    = 'rgba(232,232,228,.05)'; // a fill that reads as tinted glass

/* Row padding is the density unit. Everything that is a list row uses ROW,
   so Work, Life, Texts and the drawers scan at the same rhythm. */
export const ROW = '11px 16px';
export const PANEL = 'rgba(6,6,6,.72)';     // list wells - opaque enough to read over the dither
// Black skull and pulses: every dot is pure black, so the whole form reads black
// with no grey highlights. Shape still comes from which dots are drawn (the
// luminance threshold below), not from two shades, so flattening the colours
// doesn't lose the skull — it just makes all of it black.
const SKULL_DARK = '#000000';
const SKULL_LIGHT = '#000000';
const REF_W = 390; // design reference: the width the original pixel constants were tuned at
const BAYER = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];

export const BACKDROP_CSS = `
/* ── View header ─────────────────────────────────────────────────────────
   Title on the left, the five-tab nav on the right. At 390px the nav alone
   is ~350px wide, which squeezed the title into a four-line wrap, so below
   560px the nav drops to its own full-width row and the buttons share the
   width evenly - bigger tap targets as a side effect.
   ──────────────────────────────────────────────────────────────────────── */
.rv-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:20px 20px 0; }
.rv-head-title { display:flex; flex-direction:column; gap:3px; min-width:0; }
.rv-head-title > :last-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rv-head-side { display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex:none; }
.rv-head-nav { display:flex; gap:1px; }
.rv-head-sub { display:flex; gap:10px; justify-content:flex-end; }
@media (max-width:560px) {
  .rv-head { flex-direction:column; gap:10px; }
  .rv-head-side { align-items:stretch; width:100%; }
  .rv-head-nav { width:100%; }
  .rv-head-nav > button { flex:1; text-align:center; }
}

@keyframes rv-scan  { 0%{top:-2%} 100%{top:102%} }
@keyframes rv-flick { 0%,100%{opacity:.05} 50%{opacity:.07} }
@keyframes rv-drift { from{transform:translateY(0)} to{transform:translateY(3px)} }
`;

function useMeasure(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function DitherField({ pushRef, centerYFrac = 0.31, ambientMs = 5000, opacity = 0.9 }) {
  const canvasRef = useRef(null);
  const ripples = useRef([]);
  const skull = useRef(null);
  const { w: W, h: H } = useMeasure(canvasRef);

  const push = useCallback((amp = 1.1) => {
    if (!W || !H) return;
    ripples.current.push({ t0: performance.now(), x: W / 2, y: H * centerYFrac, amp });
  }, [W, H, centerYFrac]);

  useEffect(() => { if (pushRef) pushRef.current = push; }, [push, pushRef]);

  // Re-sample the skull whenever the measured size changes, so it stays
  // proportional to the canvas instead of a fixed pixel size.
  useEffect(() => {
    if (!W || !H) return;
    const img = new Image();
    img.onload = () => {
      const scale = W / REF_W;
      const w = Math.round(150 * scale), h = Math.round(w * img.height / img.width);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c2 = cv.getContext('2d');
      c2.drawImage(img, 0, 0, w, h);
      const d = c2.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        lum[i] = (d[i*4]*.3 + d[i*4+1]*.59 + d[i*4+2]*.11) / 255 * (d[i*4+3] / 255);
      }
      const cy = H * centerYFrac;
      skull.current = { lum, W: w, H: h, x0: W / 2 - w / 2, y0: cy - h / 2 };
    };
    img.src = '/skull.png';
  }, [W, H, centerYFrac]);

  useEffect(() => {
    if (!W || !H) return;
    push(1.1);
    const amb = setInterval(() => push(1.1), ambientMs);
    return () => clearInterval(amb);
  }, [W, H, push, ambientMs]);

  useEffect(() => {
    if (!W || !H) return;
    const S = W / REF_W; // spatial scale factor — everything pixel-sized below rides on this
    const step = Math.max(3, Math.round(5 * S));
    const dot = Math.max(2, Math.round(3 * S));
    const c = canvasRef.current;
    if (!c) return;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    let raf;
    const draw = (now) => {
      ctx.clearRect(0, 0, W, H);
      ripples.current = ripples.current.filter(r => now - r.t0 < 5200);

      const jitter = Math.sin(now / 260) * 1.5 * S;
      const sk = skull.current;
      for (let y = 2; y < H; y += step) {
        const skew = Math.sin(y / (90 * S) + now / 900) * jitter;
        for (let x = 2; x < W; x += step) {
          let v = 0, hit = 0;
          if (sk) {
            const sx = (x - sk.x0) | 0, sy = (y - sk.y0) | 0;
            if (sx >= 0 && sy >= 0 && sx < sk.W && sy < sk.H) {
              const l = sk.lum[sy * sk.W + sx];
              if (l > 0.22) { hit = l; v += 0.24 + l * 0.2; }
            }
          }
          for (const r of ripples.current) {
            const t = (now - r.t0) / 1000;
            const R = (150 + t * 120) * S;
            const d = Math.hypot(x + skew - r.x, y - r.y);
            const g = Math.exp(-Math.pow((d - R) / (20 * S), 2));
            v += r.amp * g * Math.exp(-t * 0.45);
          }
          const bx = ((x / step) | 0) & 3, by = ((y / step) | 0) & 3;
          const thr = BAYER[by * 4 + bx] / 16;
          if (v <= (hit ? thr * 0.55 + 0.02 : thr * 1.15 + 0.06)) continue;
          ctx.fillStyle = hit && v < 0.8
            ? (hit > 0.5 ? SKULL_LIGHT : SKULL_DARK)
            : (v > 0.7 ? SKULL_LIGHT : SKULL_DARK);
          ctx.fillRect(x, y, dot, dot);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [W, H]);

  return (
    <canvas ref={canvasRef} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%', opacity,
      imageRendering: 'pixelated', filter: 'blur(.3px)',
    }} />
  );
}

/* Background-only CRT. Keep this at zIndex 1 with content above it at zIndex 2 —
 * that is what keeps text crisp while the backdrop stays tube-like. Purely
 * percentage/CSS driven, no measurement needed — scales to any container. */
export function CrtLayers() {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: INK,
                    opacity: .14, animation: 'rv-scan 7s linear infinite' }} />
      {/* drift must equal exactly one 3px stripe period or the pattern snaps each loop */}
      <div style={{ position: 'absolute', inset: 0, willChange: 'transform',
                    background: 'repeating-linear-gradient(180deg,rgba(0,0,0,.42) 0px,rgba(0,0,0,.42) 1px,transparent 1px,transparent 3px)',
                    animation: 'rv-drift 5s linear infinite' }} />
      <div style={{ position: 'absolute', inset: 0, background: '#c9f3d8', mixBlendMode: 'overlay',
                    animation: 'rv-flick 6s ease-in-out infinite' }} />
      <div style={{ position: 'absolute', inset: -40, boxShadow: 'inset 0 0 90px 40px rgba(0,0,0,.85)' }} />
    </div>
  );
}
