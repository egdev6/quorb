import { describe, expect, it } from 'vitest';
import { openDelayForOs, osFromUA } from './os-detect';

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAC_WEBKIT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const LINUX_X11 = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const LINUX_WAYLAND = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) wv';

describe('osFromUA', () => {
  it('reconoce las tres plataformas en las que se distribuye Quorb', () => {
    expect(osFromUA(WINDOWS)).toBe('windows');
    expect(osFromUA(MAC_SAFARI)).toBe('macos');
    expect(osFromUA(MAC_WEBKIT)).toBe('macos');
    expect(osFromUA(LINUX_X11)).toBe('linux');
    expect(osFromUA(LINUX_WAYLAND)).toBe('linux');
  });

  it('funciona igual con X11 y con Wayland en Linux: la UA no los distingue', () => {
    // Ni /Macintosh/ ni /Windows/ aparecen en ninguno de los dos: el compositor
    // no llega a la UA, por eso el backend (#128) y no el frontend decide.
    expect(osFromUA(LINUX_X11)).toBe(osFromUA(LINUX_WAYLAND));
  });

  it('prioriza Windows cuando la UA menciona ambas plataformas', () => {
    // El orden de las comprobaciones es parte del contrato: /Windows/ gana.
    expect(osFromUA('Mozilla/5.0 (Windows NT 10.0; Mac OS X 10_15_7)')).toBe('windows');
  });

  it('deja en «linux» todo lo que no es Windows ni macOS, sin adivinar', () => {
    // Android también cae aquí: es el bucket «resto». Quien necesita la
    // distinción (excluir Android) usa su propio /Linux/ && !/Android/, como
    // showDesktopCompat() en desktop-compat.ts.
    expect(osFromUA('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36')).toBe('linux');
    expect(osFromUA('Mozilla/5.0 (X11; FreeBSD amd64)')).toBe('linux');
    // Sin UA (headless, tests): nunca se asumirá Windows ni macOS.
    expect(osFromUA('')).toBe('linux');
  });
});

describe('openDelayForOs', () => {
  it('mantiene los 90 ms de Windows y macOS y los 350 ms de Linux', () => {
    expect(openDelayForOs('windows')).toBe(90);
    expect(openDelayForOs('macos')).toBe(90);
    expect(openDelayForOs('linux')).toBe(350);
  });

  it('es el mismo delay que el gate de UA que sustituye', () => {
    // Regresión sobre OPEN_DELAY: los dos call sites tenían /Windows|Macintosh|Mac OS X/.
    const legacyDelay = (ua: string) => (/Windows|Macintosh|Mac OS X/.test(ua) ? 90 : 350);
    for (const ua of [WINDOWS, MAC_SAFARI, MAC_WEBKIT, LINUX_X11, LINUX_WAYLAND, '']) {
      expect(openDelayForOs(osFromUA(ua))).toBe(legacyDelay(ua));
    }
  });
});