import type { ReactNode } from 'react';

export interface Ring {
  percent: number | null;
  label: string;
}

/** Colores fijos por anillo (de fuera a dentro) para poder leer la leyenda. */
export const RING_COLORS = ['var(--ring-1)', 'var(--ring-2)', 'var(--ring-3)'];

/**
 * Anillos concéntricos estilo «activity rings»: el exterior es la ventana
 * más corta (sesión de 5 h), los interiores las semanales.
 */
export function RingGauge({
  rings,
  size,
  stroke,
  gap = 3,
  muted = false,
  children,
}: {
  rings: Ring[];
  size: number;
  stroke: number;
  gap?: number;
  muted?: boolean;
  children?: ReactNode;
}) {
  const c = size / 2;
  // Siempre al menos un anillo (vacío) para que el círculo se vea.
  const list = rings.length ? rings.slice(0, 3) : [{ percent: null, label: '' }];

  return (
    <div className="ring" data-muted={muted || undefined} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {list.map((r, i) => {
          const radius = c - stroke / 2 - i * (stroke + gap);
          const pct = r.percent == null ? 0 : Math.max(0, Math.min(100, r.percent));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional list with a fixed order that is never reordered or filtered; the index is its identity.
            <g key={i} transform={`rotate(-90 ${c} ${c})`}>
              <circle className="ring__track" cx={c} cy={c} r={radius} strokeWidth={stroke} />
              {pct > 0 && (
                <circle
                  className="ring__value"
                  data-hot={pct >= 90 || undefined}
                  cx={c}
                  cy={c}
                  r={radius}
                  strokeWidth={stroke}
                  pathLength={100}
                  strokeDasharray={`${pct} 100`}
                  style={{ stroke: RING_COLORS[i], color: RING_COLORS[i] }}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="ring__center" style={{ inset: list.length * (stroke + gap) + 2 }}>
        {children}
      </div>
    </div>
  );
}
