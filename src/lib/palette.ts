// Gama de colores de anillos y barras: eliges un color base (el del anillo
// exterior / primera barra) y los otros dos se derivan de él automáticamente.

export const DEFAULT_ACCENT = '#ff0036';

/** Sugerencias rápidas en Ajustes (además del selector RGB libre). */
export const ACCENT_PRESETS = ['#ff0036', '#ff7a00', '#ffd400', '#22c55e', '#00c2ff', '#3b82f6', '#8b5cf6', '#ff3fb4'];

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

export function toHex([r, g, b]: Rgb): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.round(Math.min(255, Math.max(0, v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Mezcla con blanco: t = 0 → color, t = 1 → blanco. */
function tint(c: Rgb, t: number): Rgb {
  return c.map((v) => v + (255 - v) * t) as Rgb;
}

/**
 * Devuelve los tres colores [anillo 1, anillo 2, anillo 3].
 * - El 1 es el elegido, aclarado lo justo si es tan oscuro que no se vería sobre negro.
 * - El 2 es casi blanco con un toque del color (contraste máximo con el 1).
 * - El 3 es un tono intermedio.
 * Con el rojo por defecto sale la combinación original: rojo, blanco y rosa.
 */
export function derivePalette(hex: string): [string, string, string] {
  const rgb = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
  const [h, s, l] = rgbToHsl(rgb);
  const base = l < 0.42 ? hslToRgb(h, s, 0.42) : l > 0.8 ? hslToRgb(h, s, 0.8) : rgb;
  return [toHex(base), toHex(tint(base, 0.92)), toHex(tint(base, 0.52))];
}

export function normalizeHex(hex: string | null | undefined): string {
  const rgb = hex ? parseHex(hex) : null;
  return rgb ? toHex(rgb) : DEFAULT_ACCENT;
}
