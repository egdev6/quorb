// Selector puro del locale por ventana y helper de guardado del selector de
// Idioma (T2b-U2 R5/R8). El hook en sí es un envoltorio fino: los efectos se
// prueban por sus partes puras, como el resto de la suite (sin DOM falso).
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../lib/types';
import { isDirty } from '../lib/settings-dirty';
import { changeLocale, localeFrom, withLocale } from './use-locale';

// Fixture parcial como en settings-dirty.test.ts: solo importan los campos tocados.
const config = (over: Record<string, unknown> = {}): AppConfig =>
  ({ refreshMinutes: 5, orbSize: 48, accentColor: '#ff0036', alerts: { enabled: true }, ...over }) as unknown as AppConfig;

describe('localeFrom', () => {
  it('returns the configured locale', () => {
    expect(localeFrom(config({ locale: 'en' }))).toBe('en');
    expect(localeFrom(config({ locale: 'es' }))).toBe('es');
  });

  it('defaults to es before the first load', () => {
    expect(localeFrom(undefined)).toBe('es');
    expect(localeFrom(null)).toBe('es');
  });

  it('defaults to es for a config payload without locale', () => {
    expect(localeFrom(config({ locale: undefined }))).toBe('es');
  });
});

describe('changeLocale', () => {
  // Ajustes guarda el idioma al momento, pero también tiene un borrador. Si el
  // borrador no adopta el idioma, aparece «cambios sin guardar» y «Guardar
  // cambios» lo devuelve al anterior.
  it('updates the draft and saves the merged latest config', async () => {
    let draft: AppConfig | null = config({ locale: 'es', refreshMinutes: 9 });
    let backend = config({ locale: 'es', refreshMinutes: 7 });
    let baseline = backend;
    await changeLocale('en', {
      setDraft: (update) => { draft = update(draft); },
      getConfig: async () => backend,
      enqueueSave: async (build) => { backend = await build(); baseline = backend; return backend; },
    });
    expect(backend.locale).toBe('en');
    expect(backend.refreshMinutes).toBe(7); // la base es el backend, no el borrador
    expect(draft?.locale).toBe('en');
    expect(draft?.refreshMinutes).toBe(9); // la edición pendiente se conserva
    // Sin otras ediciones, el borrador no queda «sucio» solo por el idioma.
    const clean = config({ locale: 'en', refreshMinutes: 7 });
    expect(isDirty(baseline, { ...clean })).toBe(false);
    expect(isDirty(baseline, withLocale(config({ locale: 'es', refreshMinutes: 7 }), 'es'))).toBe(true);
  });

  it('leaves a missing draft untouched', async () => {
    let draft: AppConfig | null = null;
    await changeLocale('en', {
      setDraft: (update) => { draft = update(draft); },
      getConfig: async () => config({ locale: 'es' }),
      enqueueSave: async (build) => build(),
    });
    expect(draft).toBeNull();
  });

  // Si el guardado falla, el backend manda: el borrador vuelve al locale que
  // realmente persistió (el anterior) para que el selector y «Guardar cambios»
  // no muestren o apliquen un idioma que nunca se guardó, y el error sube para
  // que Ajustes lo muestre (P2 de #163).
  it('reverts the draft to the backend locale and rethrows when the save fails', async () => {
    let draft: AppConfig | null = config({ locale: 'es', refreshMinutes: 9 });
    const backend = config({ locale: 'es', refreshMinutes: 7 });
    await expect(changeLocale('en', {
      setDraft: (update) => { draft = update(draft); },
      getConfig: async () => backend,
      enqueueSave: async () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
    expect(backend.locale).toBe('es');
    expect(draft?.locale).toBe('es'); // reconciliado con el backend, no «en»
    expect(draft?.refreshMinutes).toBe(9); // el resto del borrador se conserva
  });

  it('rethrows the save error even when the reconcile read also fails', async () => {
    let draft: AppConfig | null = config({ locale: 'es' });
    const getConfig = async (): Promise<AppConfig> => {
      throw new Error('unreadable');
    };
    await expect(changeLocale('en', {
      setDraft: (update) => { draft = update(draft); },
      getConfig,
      enqueueSave: async () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full'); // el error original, no el de la relectura
    expect(draft?.locale).toBe('en'); // sin relectura no hay reconciliación
  });
});

describe('withLocale', () => {
  it('builds the config to save with the new locale and preserves the rest', () => {
    const current = config({ locale: 'es', opacity: 0.8, providerOrder: ['claude'] });
    const next = withLocale(current, 'en');
    expect(next.locale).toBe('en');
    expect(next).toEqual({ ...current, locale: 'en' });
  });

  it('accepts switching back to es', () => {
    const current = config({ locale: 'en' });
    expect(withLocale(current, 'es').locale).toBe('es');
  });

  it('does not mutate the original config', () => {
    const current = config({ locale: 'es' });
    withLocale(current, 'en');
    expect(current.locale).toBe('es');
  });
});
