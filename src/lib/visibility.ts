/** Prefijo de los ids de cuenta de 9Router: el orbe agregado y sus suborbes. */
const NINE_ROUTER_PREFIX = 'nine_router';

/** ¿El id pertenece a 9Router (orbe agregado `nine_router` o sub-orbes `nine_router:x`)? */
export function isNineRouterId(id: string): boolean {
  return id === NINE_ROUTER_PREFIX || id.startsWith(`${NINE_ROUTER_PREFIX}:`);
}

/** Ids de 9Router ocultos (del conjunto de `hiddenProviders`). */
export function hiddenNineRouterIds(hiddenProviders: string[]): string[] {
  return hiddenProviders.filter(isNineRouterId);
}

/**
 * Quita de `hiddenProviders` todos los ids de 9Router. Al reactivar el proveedor
 * en Ajustes se recuperan el orbe agregado y sus suborbes que se hubieran ocultado
 * desde el widget (regresión: desactivar/reactivar no los devolvía).
 */
export function revealNineRouter(hiddenProviders: string[]): string[] {
  return hiddenProviders.filter((id) => !isNineRouterId(id));
}

/** Quita de `hiddenProviders` un conjunto de ids concretos (para «mostrar» un suborbe). */
export function revealIds(hiddenProviders: string[], ids: string[]): string[] {
  const set = new Set(ids);
  return hiddenProviders.filter((id) => !set.has(id));
}

/**
 * Nombre legible de un suborbe de 9Router a partir de su id de cuenta. El orbe
 * agregado es «9Router»; un suborbe `nine_router:kiro` o `nine_router:zhipu` es
 * «9Router · kiro». El id ya viene saneado (minúsculas), así que sirve de etiqueta.
 */
export function nineRouterSubName(id: string): string {
  if (id === NINE_ROUTER_PREFIX) return '9Router';
  const suffix = id.startsWith(`${NINE_ROUTER_PREFIX}:`) ? id.slice(NINE_ROUTER_PREFIX.length + 1) : id;
  return `9Router · ${suffix}`;
}
