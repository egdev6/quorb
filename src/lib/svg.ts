// Utilidades para insertar SVG de logos inline.

/**
 * Los SVG van inline en el mismo documento: los `id` (gradientes, máscaras, clips)
 * y las clases de sus `<style>` chocarían entre logos (p. ej. dos `id="a"`).
 * Los prefijamos con el nombre del archivo para aislarlos.
 */
export function scopeSvg(name: string, svg: string): string {
  const p = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '__';
  return svg
    .replace(/\bid="([^"]+)"/g, `id="${p}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${p}$1)`)
    .replace(/(xlink:)?href="#([^"]+)"/g, (_m, x = '', id) => `${x}href="#${p}${id}"`)
    .replace(
      /\bclass="([^"]+)"/g,
      (_m, cls: string) =>
        `class="${cls
          .split(/\s+/)
          .map((c) => p + c)
          .join(' ')}"`,
    )
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (_m, attrs, css: string) => `<style${attrs}>${css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, `.${p}$1`)}</style>`);
}
