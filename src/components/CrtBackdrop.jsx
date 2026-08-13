/* Shared bitmap/CRT backdrop for Reverb screens.
 * Extracted from the pin screen so SweepView and PinGate can share one implementation.
 * Requires public/skull.png
 *
 * <DitherField pushRef={ref} />  ref.current(amp) fires a ripple
 * <CrtLayers />                  scanlines + phosphor + vignette, sits at z-index 1
 */
import React, { useEffect, useRef, useCallback } from 'react';

export const INK = '#e8e8e4';
export const AMBER = '#d9932f';
const SKULL_DARK = '#41473f';
const SKULL_LIGHT = '#5a625c';
const W = 390, H = 844;
const BAYER = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];

export const BACKDROP_CSS = `
@keyframes rv-scan  { 0%{transform:translateY(0)} 100%{transform:translateY(${H}px)} }
@keyframes rv-flick { 0%,100%{opacity:.05} 50%{opacity:.07} }
@keyframes rv-drift { from{transform:translateY(0)} to{transform:translateY(3px)} }
`;

export function DitherField({ pushRef, centerY = 300, ambientMs = 5000, opacity = 0.5 }) {
  const canvasRef = useRef(null);
  const ripples = useRef([]);
  const skull = useRef(null);
  const cx = W / 2;

  const push = useCallback((amp = 1.1) => {
    ripples.current.push({ t0: performance.now(), x: cx, y: centerY, amp });
  }, [cx, centerY]);

  useEffect(() => { if (pushRef) pushRef.current = push; }, [push, pushRef]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const w = 190, h = Math.round(190 * img.height / img.width);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c2 = cv.getContext('2d');
      c2.drawImage(img, 0, 0, w, h);
      const d = c2.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        lum[i] = (d[i*4]*.3 + d[i*4+1]*.59 + d[i*4+2]*.11) / 255 * (d[i*4+3] / 255);
      }
      skull.current = { lum, W: w, H: h, x0: cx - w / 2, y0: centerY - h / 2 };
    };
    img.src = '/skull.png';

    push(1.1);
    const amb = setInterval(() => push(1.1), ambientMs);

    let raf, ctx = null;
    const draw = (now) => {
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(draw); return; }
      if (c.width !== W) { c.width = W; c.height = H; ctx = c.getContext('2d'); }
      ctx.clearRect(0, 0, W, H);
      ripples.current = ripples.current.filter(r => now - r.t0 < 5200);

      const step = 5;
      const jitter = Math.sin(now / 260) * 1.5;
      const sk = skull.current;
      for (let y = 2; y < H; y += step) {
        const skew = Math.sin(y / 90 + now / 900) * jitter;
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
            const R = 190 + t * 150;
            const d = Math.hypot(x + skew - r.x, y - r.y);
            const g = Math.exp(-Math.pow((d - R) / 20, 2));
            v += r.amp * g * Math.exp(-t * 0.45);
          }
          const bx = ((x / step) | 0) & 3, by = ((y / step) | 0) & 3;
          const thr = BAYER[by * 4 + bx] / 16;
          if (v <= (hit ? thr * 0.55 + 0.02 : thr * 1.15 + 0.06)) continue;
          ctx.fillStyle = hit && v < 0.8
            ? (hit > 0.5 ? SKULL_LIGHT : SKULL_DARK)
            : (v > 0.7 ? SKULL_LIGHT : SKULL_DARK);
          ctx.fillRect(x, y, 3, 3);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); clearInterval(amb); };
  }, [push, ambientMs, centerY, cx]);

  return (
    <canvas ref={canvasRef} style={{
      position: 'absolute', inset: 0, width: W, height: H, opacity,
      imageRendering: 'pixelated', filter: 'blur(.3px)',
    }} />
  );
}

/* Background-only CRT. Keep this at zIndex 1 with content above it at zIndex 2 —
 * that is what keeps text crisp while the backdrop stays tube-like. */
export function CrtLayers() {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: -H, height: H * 2 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: H, height: 2, background: INK,
                      opacity: .14, animation: 'rv-scan 7s linear infinite' }} />
      </div>
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
