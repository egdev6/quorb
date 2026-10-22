// Catálogo español (T2b-U2 R1). Los valores nacen VERBATIM de los literales
// actuales del código (matiz 4 de egdev6 en #66: nunca retraducidos); solo los
// textos de UI nueva (el selector de Idioma) son copy española de origen.
// Las claves, en camelCase inglés, se agrupan por área.
export const es = {
  settings: {
    /** Marca lateral (`q-brand__ver`) y ceja de la cabecera (`eg-eyebrow`). */
    title: 'Ajustes',
    nav: {
      providers: 'Proveedores',
      look: 'Apariencia',
      alerts: 'Alertas',
      shortcuts: 'Atajos',
      updates: 'Actualizaciones',
    },
    pages: {
      providers: { title: 'Suscripciones y APIs', desc: 'Qué se consulta y cómo se conecta cada proveedor.' },
      look: { title: 'Apariencia', desc: 'Tamaño y color de los anillos, y dónde vive la tira.' },
      alerts: { title: 'Alertas', desc: 'Qué pasa al superar un límite y cuando se reinicia.' },
      shortcuts: { title: 'Atajos', desc: 'Combinaciones de teclado que funcionan desde cualquier app.' },
      updates: { title: 'Actualizaciones', desc: 'Versión instalada, actualizaciones automáticas y el proyecto.' },
    },
    language: {
      title: 'Idioma',
      label: 'Idioma',
      hint: 'Se aplica al momento en todas las ventanas.',
      error: 'No se pudo guardar el idioma',
    },
  },
};

/** Forma profunda de catálogo: cada hoja es `string`. */
type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };

export type Messages = DeepStrings<typeof es>;
