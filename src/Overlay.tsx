import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api } from './lib/api';
import { derivePalette } from './lib/palette';
import { confettiVelocity, CORNER_HORIZONTAL_GAIN } from './lib/confetti-motion';

// Ventana a pantalla completa, transparente y que deja pasar los clics.
// Rust la coloca sobre el monitor de la tira, la muestra y emite «play-effect».

interface Payload {
  kind: 'confetti' | 'glow' | 'custom';
  moment: 'exceeded' | 'reset';
  mediaPath: string | null;
  mediaSize: 'small' | 'medium' | 'full';
  mediaSound: boolean;
  accent: string;
}

/** Imágenes animadas: no avisan de cuándo acaban, así que se muestran un tiempo fijo. */
const IMAGE_EXT = /\.(gif|webp|png|apng)$/i;
const IMAGE_MS = 4500;

const MAX_MS = 20_000;

export function Overlay() {
  const [fx, setFx] = useState<(Payload & { id: number }) | null>(null);

  useEffect(() => {
    const un = listen<Payload>('play-effect', (e) => {
      if (e.payload.kind === 'custom' && !e.payload.mediaPath) {
        api.overlayDone().catch(() => {});
        return;
      }
      setFx({ ...e.payload, id: Date.now() });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Red de seguridad: nunca dejamos la capa visible más de 20 s.
  useEffect(() => {
    if (!fx) return;
    const t = window.setTimeout(() => finish(), MAX_MS);
    return () => window.clearTimeout(t);
  }, [fx?.id]);

  const finish = () => {
    setFx(null);
    api.overlayDone().catch(() => {});
  };

  if (!fx) return null;
  if (fx.kind === 'confetti') return <Confetti key={fx.id} accent={fx.accent} onDone={finish} />;
  if (fx.kind === 'glow') return <DangerGlow key={fx.id} onDone={finish} />;
  return <CustomFx key={fx.id} path={fx.mediaPath ?? ''} size={fx.mediaSize} sound={fx.mediaSound} onDone={finish} />;
}

// ───────────────────────── confeti ─────────────────────────

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  shape: 'rect' | 'circle';
}

function Confetti({ accent, onDone }: { accent: string; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const colors = [...derivePalette(accent), '#ffffff', '#ffd400'];
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const pieces: Piece[] = [];
    const burst = (x: number, y: number, angle: number, n: number, horizontalGain = 1) => {
      for (let i = 0; i < n; i++) {
        const a = angle + rnd(-0.45, 0.45);
        const speed = rnd(9, 19);
        pieces.push({
          x,
          y,
          ...confettiVelocity(a, speed, horizontalGain),
          rot: rnd(0, Math.PI * 2),
          vr: rnd(-0.3, 0.3),
          w: rnd(6, 12),
          h: rnd(8, 16),
          color: colors[(Math.random() * colors.length) | 0],
          shape: Math.random() < 0.25 ? 'circle' : 'rect',
        });
      }
    };
    // Dos cañones en las esquinas inferiores + lluvia desde arriba
    burst(0, H, -Math.PI / 3, 120, CORNER_HORIZONTAL_GAIN);
    burst(W, H, (-2 * Math.PI) / 3, 120, CORNER_HORIZONTAL_GAIN);
    for (let i = 0; i < 90; i++) burst(rnd(0, W), -20, Math.PI / 2, 1);

    const start = performance.now();
    const DURATION = 4200;
    let raf = 0;
    const tick = (t: number) => {
      const age = t - start;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = age > DURATION - 800 ? Math.max(0, (DURATION - age) / 800) : 1;
      for (const p of pieces) {
        p.vy += 0.32; // gravedad
        p.vx *= 0.99;
        p.vy *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // «aleteo»: escala vertical con el giro
          ctx.fillRect(-p.w / 2, (-p.h / 2) * Math.cos(p.rot * 2), p.w, p.h * Math.cos(p.rot * 2));
        }
        ctx.restore();
      }
      if (age < DURATION) raf = requestAnimationFrame(tick);
      else onDone();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="fx-canvas" />;
}

// ───────────────────────── glow de peligro ─────────────────────────

function DangerGlow({ onDone }: { onDone: () => void }) {
  return <div className="fx-glow" onAnimationEnd={onDone} />;
}

// ───────────────────────── efecto propio: vídeo con alfa o imagen animada ─────────────────────────

function CustomFx({ path, size, sound, onDone }: { path: string; size: Payload['mediaSize']; sound: boolean; onDone: () => void }) {
  const src = convertFileSrc(path);
  const isImage = IMAGE_EXT.test(path);

  useEffect(() => {
    if (!isImage) return;
    const t = window.setTimeout(onDone, IMAGE_MS);
    return () => window.clearTimeout(t);
  }, [isImage]);

  return (
    <div className="fx-media" data-size={size}>
      {isImage ? (
        <img src={src} alt="" onError={onDone} />
      ) : (
        <video src={src} autoPlay muted={!sound} playsInline onEnded={onDone} onError={onDone} />
      )}
    </div>
  );
}
