import { describe, expect, it } from 'vitest';
import { keyringErrorHint } from './keyring-message';

describe('keyringErrorHint', () => {
  it('detecta errores de libsecret y devuelve un mensaje accionable', () => {
    const hint = keyringErrorHint('libsecret error: could not connect to Secret Service');
    expect(hint).toContain('GNOME Keyring');
    expect(hint).toContain('libsecret-1-0');
  });

  it('detecta errores de D-Bus / SecretService / keyring sin importar mayúsculas', () => {
    expect(keyringErrorHint('D-Bus session not available')).toMatch(/Secret Service/);
    expect(keyringErrorHint('SecretService not available on session bus')).toMatch(/libsecret/);
    expect(keyringErrorHint('failed to access platform keyring')).toMatch(/KWallet|libsecret-1-0/);
    expect(keyringErrorHint('gnome-keyring not running')).toMatch(/GNOME Keyring/);
    expect(keyringErrorHint('KWallet not available on this session')).toMatch(/KWallet/);
  });

  it('acepta un `Error` (no solo string)', () => {
    const hint = keyringErrorHint(new Error('libsecret not initialized'));
    expect(hint).toContain('GNOME Keyring');
  });

  it('acepta "keyring error|not|failed" como indicador de fallo', () => {
    expect(keyringErrorHint('keyring error: cannot store credential')).toMatch(/Secret Service/);
    expect(keyringErrorHint('keyring not initialized')).toMatch(/Secret Service/);
    expect(keyringErrorHint('keyring failed: backend unreachable')).toMatch(/Secret Service/);
  });

  it('ignora "keyring" desnudo en contextos no-fallo (no es keyring error/not/failed)', () => {
    // El patrón `keyring\s+(?:error|not|failed)` requiere la barra seguida de uno
    // de esos marcadores. "settings", "config", "openai keyring ..." no matchean
    // porque el contexto benigno no acompaña la barra de un fallo.
    expect(keyringErrorHint('keyring settings are fine')).toBeNull();
    expect(keyringErrorHint('openai keyring config updated')).toBeNull();
    // (D-Bus en cualquier mención dispara el hint: el owner lo incluyó en la
    //  lista de anclas de fallo de backend. El falso positivo aceptable aquí
    //  es que un log tipo "D-Bus daemon started OK" muestre el hint del llavero;
    //  la heurística de error del frontend es preventiva, no diagnóstica.)
  });

  it('devuelve null para errores que no son del llavero', () => {
    expect(keyringErrorHint('invalid api key')).toBeNull();
    expect(keyringErrorHint(new Error('network timeout'))).toBeNull();
    expect(keyringErrorHint(null)).toBeNull();
    expect(keyringErrorHint(undefined)).toBeNull();
  });
});
