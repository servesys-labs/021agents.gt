import { useEffect, useRef } from "react";
import { useStore } from "@xyflow/react";

/**
 * CanvasGlow — HTML5 canvas dot grid with interactive glow.
 *
 * Draws a dense dot grid that tracks React Flow's viewport transform.
 * Dots near the mouse cursor change color (warm amber) and grow larger.
 * The glow fades out smoothly after ~2 seconds of mouse inactivity.
 */

const DOT_GAP = 10;
const DOT_RADIUS = 0.8;
const GLOW_RADIUS = 180;
const BASE_COLOR: [number, number, number] = [120, 113, 108];
const GLOW_COLOR: [number, number, number] = [255, 170, 30];
const BASE_ALPHA = 0.35;
const GLOW_ALPHA = 0.85;
const GLOW_DOT_SCALE = 2.0;
const FADE_DELAY = 1500;
const FADE_DURATION = 800;
const MAX_DOTS = 60000;

export function CanvasGlow({ visible }: { visible: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -9999, y: -9999 });
  const rafRef = useRef<number>(0);
  const lastMoveRef = useRef<number>(0);
  const glowRef = useRef<number>(0);
  const runningRef = useRef(true);
  const txRef = useRef<[number, number, number]>([0, 0, 1]);

  const transform = useStore((s) => s.transform);
  txRef.current = transform as [number, number, number];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    runningRef.current = true;

    const onMouseMove = (e: MouseEvent) => {
      const rect = parent.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      lastMoveRef.current = performance.now();
      glowRef.current = 1;
    };

    const onMouseLeave = () => {
      mouseRef.current = { x: -9999, y: -9999 };
      glowRef.current = 0;
    };

    parent.addEventListener("mousemove", onMouseMove);
    parent.addEventListener("mouseleave", onMouseLeave);

    const ctx = canvas.getContext("2d")!;

    const draw = () => {
      if (!runningRef.current) return;

      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (!visible) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Fade logic
      const now = performance.now();
      const elapsed = now - lastMoveRef.current;
      if (elapsed > FADE_DELAY) {
        const fadeProgress = Math.min((elapsed - FADE_DELAY) / FADE_DURATION, 1);
        glowRef.current = Math.max(0, 1 - fadeProgress);
      }

      const intensity = glowRef.current;
      const [tx, ty, zoom] = txRef.current;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;
      const glowR2 = GLOW_RADIUS * GLOW_RADIUS;

      // Visible range in flow coordinates
      const flowLeft = -tx / zoom;
      const flowTop = -ty / zoom;
      const flowRight = (w - tx) / zoom;
      const flowBottom = (h - ty) / zoom;

      // Adaptive gap for performance
      let gap = DOT_GAP;
      const cols = (flowRight - flowLeft) / gap;
      const rows = (flowBottom - flowTop) / gap;
      if (cols * rows > MAX_DOTS) {
        gap = gap * Math.ceil(Math.sqrt((cols * rows) / MAX_DOTS));
      }

      const startX = Math.floor(flowLeft / gap) * gap;
      const startY = Math.floor(flowTop / gap) * gap;
      const endX = Math.ceil(flowRight / gap) * gap;
      const endY = Math.ceil(flowBottom / gap) * gap;

      const dotR = Math.max(DOT_RADIUS * zoom, 0.4);

      for (let fy = startY; fy <= endY; fy += gap) {
        for (let fx = startX; fx <= endX; fx += gap) {
          const sx = fx * zoom + tx;
          const sy = fy * zoom + ty;

          let r: number, g: number, b: number, a: number, radius: number;

          if (intensity > 0) {
            const dx = sx - mx;
            const dy = sy - my;
            const dist2 = dx * dx + dy * dy;

            if (dist2 < glowR2) {
              const t = 1 - Math.sqrt(dist2) / GLOW_RADIUS;
              const ease = t * t * intensity;
              r = BASE_COLOR[0] + (GLOW_COLOR[0] - BASE_COLOR[0]) * ease;
              g = BASE_COLOR[1] + (GLOW_COLOR[1] - BASE_COLOR[1]) * ease;
              b = BASE_COLOR[2] + (GLOW_COLOR[2] - BASE_COLOR[2]) * ease;
              a = BASE_ALPHA + (GLOW_ALPHA - BASE_ALPHA) * ease;
              radius = dotR * (1 + (GLOW_DOT_SCALE - 1) * ease);
            } else {
              r = BASE_COLOR[0]; g = BASE_COLOR[1]; b = BASE_COLOR[2];
              a = BASE_ALPHA; radius = dotR;
            }
          } else {
            r = BASE_COLOR[0]; g = BASE_COLOR[1]; b = BASE_COLOR[2];
            a = BASE_ALPHA; radius = dotR;
          }

          ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
      parent.removeEventListener("mousemove", onMouseMove);
      parent.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [visible]);

  return (
    <canvas
      ref={canvasRef}
      className="canvas-dot-grid"
    />
  );
}
