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
  // T2c slice 1 (#66): tira del widget y detalle de proveedor. Valores verbatim.
  widget: {
    sessionExpiredTitle: '{name}: sesión caducada',
    sessionExpiredBody: 'Pulsa «Renovar sesión» en su panel. Quorb se actualiza solo en cuanto se renueve.',
    updateAvailableTitle: 'Quorb {version} disponible',
    updateAvailableBody: 'Pulsa el icono de descarga de la tira para actualizar.',
    updateFailedTitle: 'No se pudo actualizar Quorb',
    show: 'Mostrar Quorb',
    retryShow: 'Reintentar mostrar Quorb',
    dragHint: 'Arrastrar: se pega al borde más cercano',
    retry: 'Reintentar',
    loading: 'Cargando…',
    configure: 'Configurar',
    updatingTo: 'Actualizando a {version}{detail}',
    updateTo: 'Actualizar a Quorb {version}',
    refreshNow: 'Actualizar ahora',
    settings: 'Ajustes',
  },
  details: {
    range24h: '24 h',
    range7d: '7 días',
    range30d: '30 días',
    windowJustStarted: 'Acaba de empezar la ventana',
    paceBurnsOut: 'Ritmo {pace}× · se agota {when}',
    paceWontLast: 'Ritmo {pace}× · no llegas al reinicio',
    paceProjected: 'Ritmo {pace}× · acabarías en {pct} %',
    paceNotice: '{label} se agota{when}, antes del reinicio.',
    atThisPace: 'A este ritmo',
    elapsedTitle: 'Tiempo transcurrido de la ventana',
    notEnoughReadings: 'Aún no hay suficientes lecturas. Se irán guardando cada pocos minutos.',
    historyAria: 'Historial de consumo',
    dailyAria: 'Tokens por día',
    dailyBarTitle: '{day}: {value} tokens',
    dailyMax: 'máx. {value}',
    paceTitle: 'Ritmo de consumo',
    noWindow: 'Sin ventana de tiempo conocida para calcular el ritmo.',
    spendLabel: 'Gasto',
    monthProjection: 'Al ritmo actual: {amount} a fin de mes',
    monthJustStarted: 'Acaba de empezar el mes',
    historyTitle: 'Historial',
    historyRangeAria: 'Rango del historial',
    loading: 'Cargando…',
    scaleTo: 'escala 0–{max} %',
    noReadings: 'Aún no hay lecturas guardadas.',
    dailyTitle: 'Tokens por día · 30 días',
  },
};

/** Forma profunda de catálogo: cada hoja es `string`. */
type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };

export type Messages = DeepStrings<typeof es>;
