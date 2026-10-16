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
  });

  it('acepta un `Error` (no solo string)', () => {
    const hint = keyringErrorHint(new Error('libsecret not initialized'));
    expect(hint).toContain('GNOME Keyring');
  });

  it('devuelve null para errores que no son del llavero', () => {
    expect(keyringErrorHint('invalid api key')).toBeNull();
    expect(keyringErrorHint(new Error('network timeout'))).toBeNull();
    expect(keyringErrorHint(null)).toBeNull();
    expect(keyringErrorHint(undefined)).toBeNull();
  });
});
