import type { AppConfig } from './types';

// Seguimiento de cambios sin guardar de Ajustes. `baseline` es la última config
// confirmada por el backend; `draft` es lo que ve el formulario. Los campos vivos
// (tamaño/color) se persisten partiendo de la base, no del borrador.

/** Igualdad estructural profunda para valores de config serializables a JSON. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, (b as unknown[])[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

/**
 * Campos que se aplican al momento con el autosave vivo (tamaño, color y los
 * controles de personalización inmediata #97: opacidad, círculos pequeños,
 * borde, posición, auto-ocultar y siempre encima). No cuentan como cambios
 * manuales sin guardar: el botón «Guardar cambios» solo refleja lo que espera
 * confirmación explícita, ni mientras su autosave está en vuelo ni si falló
 * (la recuperación del fallo es un reintento del propio campo vivo).
 */
const LIVE_FIELDS = ['orbSize', 'accentColor', 'opacity', 'compact', 'showResets', 'dockEdge', 'dockOffset', 'autoHide', 'alwaysOnTop'] as const;

/** Copia de la config sin los campos vivos, para comparar solo lo manual. */
function withoutLiveFields(cfg: AppConfig): Omit<AppConfig, (typeof LIVE_FIELDS)[number]> {
  const rest: Record<string, unknown> = { ...cfg };
  for (const key of LIVE_FIELDS) delete rest[key];
  return rest as Omit<AppConfig, (typeof LIVE_FIELDS)[number]>;
}

/**
 * ¿Hay cambios manuales sin guardar? Sin base (aún cargando) no se considera
 * sucio. Los campos vivos (autosave de personalización) se ignoran porque se
 * persisten solos: no deben activar «Guardar cambios» ni siquiera mientras su
 * autosave está en vuelo y la base canónica todavía no los refleja.
 */
export function isDirty(baseline: AppConfig | null, draft: AppConfig | null): boolean {
  if (!baseline || !draft) return false;
  return !deepEqual(withoutLiveFields(baseline), withoutLiveFields(draft));
}

/**
 * Suciedad combinada de Ajustes: cambios manuales de config (los campos vivos
 * no cuentan) o un borrador de autostart distinto de la base confirmada por el
 * sistema. Mientras la base de autostart es desconocida no se considera sucio.
 */
export function isSettingsDirty(
  cfgBaseline: AppConfig | null,
  cfgDraft: AppConfig | null,
  autostartConfirmed: boolean | null,
  autostartDraft: boolean | null,
): boolean {
  if (isDirty(cfgBaseline, cfgDraft)) return true;
  return autostartConfirmed !== null && autostartDraft !== null && autostartDraft !== autostartConfirmed;
}

/**
 * Config a persistir en un guardado inmediato: base persistida + solo el campo
 * vivo. Así un cambio vivo no pisa escrituras previas ni ensucia otros campos.
 */
export function liveSaveConfig(baseline: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return { ...baseline, ...patch };
}

/**
 * Snapshot para un guardado manual: conserva intacto el borrador manual, pero
 * sobreescribe los campos vivos con su canónico confirmado. Así un `save_config`
 * de snapshot completo no puede pisar un autosave vivo más reciente (B5).
 */
export function withCanonicalLive(snapshot: AppConfig, live: Partial<AppConfig>): AppConfig {
  return { ...snapshot, ...live };
}

/** Reconcilia una respuesta viva con el formulario actual. */
export function reconcileLive(current: AppConfig, patch: Partial<AppConfig>, confirmed: AppConfig): AppConfig {
  const next = { ...current };
  for (const key of LIVE_FIELDS) {
    // Una respuesta antigua no sustituye una edición posterior del mismo campo.
    if (key in patch && Object.is(current[key], patch[key])) next[key] = confirmed[key] as never;
  }
  return next;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reconcilia el guardado con ediciones hechas mientras estaba en vuelo:
 * `base` = lo enviado, `saved` = canónico del backend, `latest` = borrador actual.
 * Los campos no tocados adoptan lo canónico; los tocados conservan la edición,
 * evitando que `setCfg(saved)` descarte cambios posteriores al clic.
 */
export function reconcileSaved<T>(base: T, saved: T, latest: T): T {
  if (deepEqual(latest, base)) return saved;
  if (deepEqual(saved, base)) return latest;
  if (isRecord(base) && isRecord(saved) && isRecord(latest)) {
    const out: Record<string, unknown> = { ...saved };
    for (const key of Object.keys(latest)) {
      out[key] = reconcileSaved(base[key], saved[key], latest[key]);
    }
    return out as T;
  }
  return latest;
}
