import type { AppConfig, Locale } from './types';
import { t } from '../i18n';
import { withCanonicalLive } from './settings-dirty';
import type { AutostartApplyOutcome } from './autostart-controller';

// Coordinador del guardado mixto de Ajustes. La config se persiste por la cola
// existente y el autostart se aplica contra el sistema operativo. Las dos partes
// se intentan siempre y se reportan por separado: no hay un «guardado atómico»
// falso que oculte que una mitad falló.

/** Mensaje legible de cualquier rechazo. */
function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

export interface MixedSaveInput {
  /** ¿Hay cambios manuales de config pendientes? */
  configDirty: boolean;
  /** Config a enviar (instantánea al pulsar Guardar). */
  configSnapshot: AppConfig;
  /** ¿El borrador de autostart difiere de la base confirmada? */
  autostartDirty: boolean;
  /** Valor de autostart deseado (instantánea al pulsar Guardar). */
  autostartDesired: boolean;
}

export interface MixedSaveDeps {
  /** Guarda por la cola existente (snapshot + reconcile en Ajustes). */
  saveConfig: (snapshot: AppConfig) => Promise<AppConfig>;
  /** Aplica y confirma el autostart; ver `AutostartApplyOutcome`. */
  applyAutostart: (desired: boolean) => Promise<AutostartApplyOutcome>;
}

export type MixedConfigPart = { status: 'saved'; saved: AppConfig } | { status: 'failed'; message: string } | { status: 'skipped' };
export type AutostartFailure = Extract<AutostartApplyOutcome, { ok: false }>;
export type MixedAutostartPart = { status: 'confirmed' } | { status: 'failed'; outcome: AutostartFailure } | { status: 'skipped' };

export interface MixedSaveResult {
  config: MixedConfigPart;
  autostart: MixedAutostartPart;
}

/**
 * Relee lo que depende de la config persistida. `secret_status` enumera cuentas
 * guardadas: la key de una cuenta adicional se puede guardar antes de que la
 * cuenta exista en la config, así que hasta que no se persiste su secreto
 * scoped no aparece y el proveedor queda «Falta conectar». Sin un guardado
 * confirmado no hay nada nuevo que leer.
 */
export async function reloadSecretsAfterSave<S>(
  configPart: MixedSaveResult['config'],
  reload: () => Promise<S>,
): Promise<S | null> {
  if (configPart.status !== 'saved') return null;
  return reload();
}

export async function runMixedSave(input: MixedSaveInput, deps: MixedSaveDeps): Promise<MixedSaveResult> {
  const configPart = async (): Promise<MixedConfigPart> => {
    if (!input.configDirty) return { status: 'skipped' };
    try {
      return { status: 'saved', saved: await deps.saveConfig(input.configSnapshot) };
    } catch (e) {
      return { status: 'failed', message: errorText(e) };
    }
  };

  const autostartPart = async (): Promise<MixedAutostartPart> => {
    if (!input.autostartDirty) return { status: 'skipped' };
    try {
      const outcome = await deps.applyAutostart(input.autostartDesired);
      return outcome.ok ? { status: 'confirmed' } : { status: 'failed', outcome };
    } catch (e) {
      return { status: 'failed', outcome: { ok: false, stage: 'apply', message: errorText(e) } };
    }
  };

  // Ambas partes se intentan aunque la otra falle: sus resultados son independientes.
  const [config, autostart] = await Promise.all([configPart(), autostartPart()]);
  return { config, autostart };
}

/**
 * ¿Se puede dar por persistida la config tras un guardado mixto? Solo `false`
 * si la parte de config falló. `saved` quedó escrita y `skipped` (no había
 * cambios) deja la config tal cual estaba: en ambos casos el login por CLI
 * puede buscar la cuenta. El resultado del autostart no afecta a esta decisión.
 */
export function configPersistedAfterSave(result: MixedSaveResult): boolean {
  return result.config.status !== 'failed';
}

/**
 * Mensaje para el usuario a partir del resultado real de cada parte. Nunca
 * presenta una parte omitida como guardada y nunca da un éxito conjunto falso:
 * nombra exactamente lo que se confirmó y lo que falló, con su error.
 */
export function mixedSaveMessage(result: MixedSaveResult, locale: Locale = 'es'): string | null {
  const cfgError = result.config.status === 'failed' ? t(locale, 'settings.shell.configNotSaved', { error: result.config.message }) : null;
  const osError = result.autostart.status === 'failed' ? t(locale, 'settings.shell.autostartNotSaved', { error: result.autostart.outcome.message }) : null;
  const cfgSaved = result.config.status === 'saved';
  const osConfirmed = result.autostart.status === 'confirmed';

  if (cfgError && osError) return `${cfgError} · ${osError}`;
  if (cfgError) return osConfirmed ? `${t(locale, 'settings.shell.autostartSaved')} · ${cfgError}` : cfgError;
  if (osError) return cfgSaved ? `${t(locale, 'settings.shell.configSaved')} · ${osError}` : osError;
  if (cfgSaved || osConfirmed) return t(locale, 'settings.shell.saved');
  return null;
}

/** Coordina el snapshot manual con los valores vivos confirmados. */
export function enqueueCanonicalConfig(
  enqueue: (build: () => AppConfig) => Promise<AppConfig>,
  snapshot: AppConfig,
  latestLive: () => Partial<AppConfig>,
): Promise<AppConfig> {
  // Leer dentro de la cola: un patch anterior puede confirmar mientras esperamos.
  return enqueue(() => withCanonicalLive(snapshot, latestLive()));
}

export interface WriteQueue {
  /** Encola una escritura: espera a la anterior y devuelve su propio resultado. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Cola de escrituras de Ajustes. Unifica el guardado manual, el patch vivo y
 * cualquier relectura para que no se crucen: sin ella, un `save_config` de
 * snapshot completo podía pisar un patch atómico más nuevo (B5).
 */
export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn);
      // La cola sobrevive al rechazo; el error viaja a quien espera `run`.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
