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
    // T2c-S1 (#66): textos propios del frontend que antes estaban inline.
    meters: {
      weekly: 'Semana',
      weeklyOpus: 'Opus',
      weeklySonnet: 'Sonnet',
      weeklyApps: 'Apps',
      budgetMonthly: 'Presupuesto',
      rateRequests: 'Peticiones',
      rateTokens: 'Tokens',
      extraUsage: 'Extra',
    },
    validity: {
      periodLabel: 'Periodo hasta',
      keyLabel: 'Clave caduca',
      periodNote: 'Fin del periodo comunicado por el proveedor; no confirma cancelación',
      keyNote: 'Caducidad de la clave comunicada por el proveedor',
    },
    resets: {
      one: '1 reset disponible',
      many: '{count} resets disponibles',
      codexNote: 'saldo comunicado por Codex; no son reinicios automáticos',
      zaiNote: 'saldo comunicado por z.ai; cada reset vence y se usa manualmente',
    },
    resetIn: {
      now: 'ahora',
      minutes: 'en {mins} min',
      hours: 'en {h} h',
      hoursMinutes: 'en {h} h {m} min',
      days: 'en {d} d',
      daysHours: 'en {d} d {h} h',
    },
    meterResets: 'Se reinicia {when}',
    status: {
      ok: 'Al día',
      warning: 'Atención',
      error: 'Error',
      needsLogin: 'Sin sesión',
      unconfigured: 'Sin configurar',
    },
    action: {
      login: 'Iniciar sesión',
      renew: 'Renovar sesión',
      renewHint: 'Abre el CLI oficial, que renueva la sesión; el widget se actualiza solo al terminar',
      configure: 'Configurar',
    },
    staleChip: 'caché',
    staleChipTitle: 'Datos del último ciclo correcto',
    budget: 'Presupuesto',
    copy: {
      summary: 'Copiar resumen',
      copied: 'Copiado ✓',
      failed: 'No se pudo copiar',
    },
    panel: {
      title: 'Detalle de {name}',
      insightsHeading: 'Ritmo e historial',
      officialUsage: 'Uso oficial ↗',
      updated: 'Actualizado {when}',
      everyMinutes: 'cada {mins} min',
    },
    summaryReset: 'reinicia {when}',
  },
};

/** Forma profunda de catálogo: cada hoja es `string`. */
type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };

export type Messages = DeepStrings<typeof es>;
