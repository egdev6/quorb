// Contrato de los catálogos i18n (T2b-U2): paridad de claves y placeholders
// comprobada en ejecución sobre los árboles (independiente de los tipos),
// `t()` con interpolación y orden de fallback, `intlLocale` y claves punteadas.
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { es, type Messages } from './es';
import { formatMessage, intlLocale, t, translate, type MessageKey } from './index';

type Tree = { [key: string]: string | Tree };

const isTree = (v: string | Tree): v is Tree => typeof v === 'object';

/** Hojas del catálogo con su clave punteada. */
const leavesOf = (tree: Tree, prefix: string[] = []): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) =>
    // El par va envuelto en otra lista: `flatMap` aplanaría el par suelto.
    isTree(v) ? leavesOf(v, [...prefix, k]) : [[[...prefix, k].join('.'), v] as [string, string]],
  );

const valueAt = (tree: Tree, key: string): string | undefined => {
  let node: string | Tree = tree;
  for (const part of key.split('.')) {
    if (typeof node === 'string') return undefined;
    node = node[part];
    if (node === undefined) return undefined;
  }
  return typeof node === 'string' ? node : undefined;
};

const esTree = es as unknown as Tree;
const enTree = en as unknown as Tree;
const esLeaves = leavesOf(esTree);
const enLeaves = leavesOf(enTree);

const placeholders = (value: string): string[] => (value.match(/\{(\w+)\}/g) ?? []).sort();

describe('catalog parity (runtime, independent of types)', () => {
  it('has leaves in the es catalog', () => {
    expect(esLeaves.length).toBeGreaterThan(0);
  });

  it('every es key exists in en as a non-empty string', () => {
    for (const [key, value] of esLeaves) {
      expect(value.length, `es › ${key} vacío`).toBeGreaterThan(0);
      const enValue = valueAt(enTree, key);
      expect(enValue, `falta ${key} en en`).toBeDefined();
      expect(enValue as string, `${key} vacío en en`).not.toBe('');
    }
  });

  it('every en key exists in es (no extra keys)', () => {
    for (const [key] of enLeaves) {
      expect(valueAt(esTree, key), `clave de más en en: ${key}`).toBeDefined();
    }
  });

  it('placeholder sets are identical in es and en for every key', () => {
    for (const [key, value] of esLeaves) {
      expect(placeholders(value), `placeholders de ${key}`).toEqual(placeholders(valueAt(enTree, key) as string));
    }
  });
});

describe('t()', () => {
  it('returns the es value for es and the en value for en', () => {
    expect(t('es', 'settings.nav.look')).toBe('Apariencia');
    expect(t('en', 'settings.nav.providers')).toBe('Providers');
    expect(t('es', 'settings.pages.updates.desc')).toBe('Versión instalada, actualizaciones automáticas y el proyecto.');
    expect(t('es', 'details.range7d')).toBe('7 días');
    expect(t('en', 'widget.settings')).toBe('Settings');
  });

  it('accepts every migrated dotted key at compile time', () => {
    const keys: MessageKey[] = [
      'settings.title',
      'settings.nav.providers',
      'settings.pages.look.desc',
      'settings.language.hint',
      'widget.dragHint',
      'widget.updatingTo',
      'details.paceBurnsOut',
      'details.scaleTo',
    ];
    expect(keys).toHaveLength(8);
  });

  it('only valid dotted keys compile', () => {
    // @ts-expect-error una clave que no existe en el catálogo no compila
    expect(t('es', 'settings.nav.nope')).toBe('settings.nav.nope');
  });

  it('interpolates {placeholders} and leaves unknown ones verbatim', () => {
    expect(formatMessage('Hola {name}, quedan {count}', { name: 'X', count: 3 })).toBe('Hola X, quedan 3');
    expect(formatMessage('Hola {name}')).toBe('Hola {name}');
    expect(formatMessage('Hola {missing}', { other: 1 })).toBe('Hola {missing}');
  });

  it('falls back to es when an en value is missing (simulated with a cast)', () => {
    const brokenEn = { ...en, settings: { ...en.settings, nav: { ...en.settings.nav, look: '' } } } as Messages;
    expect(translate(es, brokenEn, 'en', 'settings.nav.look')).toBe('Apariencia');
    expect(translate(es, brokenEn, 'es', 'settings.nav.look')).toBe('Apariencia');
  });

  it('falls back to the key itself and never throws or returns undefined', () => {
    const brokenEn = { ...en } as Messages;
    expect(translate(es, brokenEn, 'en', 'settings.no.such.key')).toBe('settings.no.such.key');
    expect(t('es', 'settings.no.such.key' as MessageKey)).toBe('settings.no.such.key');
  });
});

describe('intlLocale', () => {
  it('maps the closed locale set for Intl', () => {
    expect(intlLocale('es')).toBe('es-ES');
    expect(intlLocale('en')).toBe('en-US');
  });

  it('falls back to es-ES for any unexpected value', () => {
    expect(intlLocale('fr')).toBe('es-ES');
    expect(intlLocale('EN')).toBe('es-ES');
    expect(intlLocale('')).toBe('es-ES');
  });
});
