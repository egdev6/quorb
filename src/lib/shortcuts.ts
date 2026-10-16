// Convierte una pulsación en el formato de atajos globales de Tauri («Ctrl+Alt+U»).

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const map: Record<string, string> = {
    Space: 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
    Minus: 'Minus',
    Equal: 'Equal',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
    Backquote: 'Backquote',
  };
  return map[code] ?? null;
}

/**
 * Devuelve la combinación («Ctrl+Alt+U») o null si aún no es válida:
 * hace falta una tecla normal y, salvo F1–F24, al menos Ctrl, Alt o Win.
 */
export function comboFromEvent(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = keyName(e.code);
  if (!key) return null;
  const isFn = /^F\d+$/.test(key);
  if (!isFn && !e.ctrlKey && !e.altKey && !e.metaKey) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  return [...mods, key].join('+');
}

/** ¿Estamos en macOS? Para la visualización de atajos con símbolos del sistema. */
export function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || '');
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' };

/**
 * Para mostrarlo bonito: «Ctrl + Alt + U», «Win» en vez de «Super».
 * En macOS usa los símbolos del sistema y sin separadores: «⌃⌥U», «⌘⇧R».
 * El valor guardado no cambia: es solo la capa de visualización.
 */
export function prettyCombo(combo: string, mac: boolean = isMacLike()): string {
  if (mac) {
    return combo
      .split('+')
      .map((k) => MAC_SYMBOLS[k] ?? k)
      .join('');
  }
  return combo
    .split('+')
    .map((k) => (k === 'Super' ? 'Win' : k))
    .join(' + ');
}
