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
    expect(keyringErrorHint('keyring settings are fine')).toBeNull();
    expect(keyringErrorHint('openai keyring config updated')).toBeNull();
    expect(keyringErrorHint('D-Bus daemon started OK, keyring idle')).toBeNull();
  });

  it('devuelve null para errores que no son del llavero', () => {
    expect(keyringErrorHint('invalid api key')).toBeNull();
    expect(keyringErrorHint(new Error('network timeout'))).toBeNull();
    expect(keyringErrorHint(null)).toBeNull();
    expect(keyringErrorHint(undefined)).toBeNull();
  });
});
