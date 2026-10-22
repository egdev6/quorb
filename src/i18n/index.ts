// Núcleo i18n (T2b-U2 R3): `t()` con claves punteadas tipadas, interpolación
// `{name}` y orden de fallback locale → es → la propia clave. Sin librerías.
// Este módulo es puro (sin React ni Tauri) para que las pruebas de catálogo no
// arrastren dependencias de ventana.
import type { Locale } from '../lib/types';
import { en } from './en';
import { es, type Messages } from './es';

export type { Messages } from './es';

/** Claves válidas del catálogo en formato punteado, derivadas del árbol de `es`. */
type KeyPaths<T> = T extends string
  ? readonly []
  : { [K in keyof T & string]: readonly [K, ...KeyPaths<T[K]>] }[keyof T & string];
type JoinPath<P extends readonly string[]> = P extends readonly [infer F extends string, ...infer R extends readonly string[]]
  ? R['length'] extends 0
    ? F
    : `${F}.${JoinPath<R>}`
  : never;

export type MessageKey = JoinPath<KeyPaths<typeof es>>;

export type Params = Record<string, string | number>;

/** Interpolación `{name}`; los marcadores sin valor se dejan tal cual. */
export const formatMessage = (template: string, params?: Params): string =>
  params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
    : template;

/** Valor de una clave punteada en un árbol; vacío o ausente cuenta como fallo. */
const lookup = (tree: Messages, key: string): string | undefined => {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.length > 0 ? node : undefined;
};

/** Núcleo puro de `t()` sobre árboles concretos (testeable con casts). */
export const translate = (esTree: Messages, enTree: Messages, locale: Locale, key: string, params?: Params): string =>
  formatMessage(lookup(locale === 'en' ? enTree : esTree, key) ?? lookup(esTree, key) ?? key, params);

/** Texto del catálogo para la clave; nunca lanza ni devuelve undefined. */
export const t = (locale: Locale, key: MessageKey, params?: Params): string => translate(es, en, locale, key, params);

/** Mapa cerrado para Intl: solo `en` sale de `es-ES`; todo valor raro cae en español. */
export const intlLocale = (locale: string): 'es-ES' | 'en-US' => (locale === 'en' ? 'en-US' : 'es-ES');
