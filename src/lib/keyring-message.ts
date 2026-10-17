// Detecta errores del llavero del sistema (Secret Service / libsecret) y los
// traduce a un mensaje accionable. La idea: cuando el backend falla con
// "libsecret", "D-Bus" o "SecretService", el frontend no debe mostrar el
// error crudo al usuario (es técnico y filtra contexto del sistema), sino un
// "qué hacer" corto.

const KEYRING_PATTERNS =
  /libsecret|secret\s*service|D-?Bus|gnome[- ]?keyring|kwallet|platform\s+keyring|(?:^|\s)keyring\s+(?:error|not|failed)/i;

/** Devuelve un mensaje accionable si `raw` parece un error del llavero; o `null`. */
export function keyringErrorHint(raw: unknown): string | null {
  if (raw == null) return null;
  const msg = typeof raw === 'string' ? raw : String(raw);
  if (!KEYRING_PATTERNS.test(msg)) return null;
  return 'No hay llavero del sistema (Secret Service / libsecret) en esta sesión. Abre GNOME Keyring o KWallet, o instala libsecret-1-0 con un daemon de llavero, y vuelve a intentarlo.';
}
