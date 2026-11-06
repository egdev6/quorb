// El puntero dentro del viewport de la ventana.

/**
 * True cuando el puntero cae dentro del viewport.
 *
 * El borde derecho e inferior quedan fuera: `width` y `height` ya están fuera.
 * Al soltar un reordenado decide si se retiene el hover: fuera de la ventana el
 * `mouseleave` ya ocurrió y nada liberaría la retención después.
 */
export function pointerInsideViewport(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}
