// Corte visible de i18n para las secciones sin proveedores de Ajustes (#66,
// T2c slice 2 PR-A): Apariencia, Alertas, Atajos y Actualizaciones, renderizadas
// en servidor (renderToStaticMarkup, sin DOM falso) con los literales exactos:
// en español tal y como están hoy en el código y en inglés tras la migración.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AlertsConfig, AppConfig, ShortcutsConfig } from './lib/types';
import { AlertsSection, LookSection, ProjectSection, SecretInput, ShortcutsSection, UpdatesSection } from './Settings';

// `UpdatesSection` lee el modo real del updater (Tauri) en un efecto, que SSR no
// ejecuta: se simula para poder renderizar sus dos ramas de forma determinista.
const { updaterMock } = vi.hoisted(() => ({ updaterMock: vi.fn() }));
vi.mock('./lib/useUpdater', () => ({ useUpdater: (auto: boolean) => updaterMock(auto) }));

const updater = (mode: string, state: Record<string, unknown>) =>
  updaterMock.mockReturnValue({ mode, state, check: () => {}, install: () => {} });

const lookCfg = {
  opacity: 0.9,
  compact: false,
  showResets: true,
  orbSize: 88,
  accentColor: '#e0645a',
  alwaysOnTop: true,
  dockEdge: 'top',
  dockOffset: 0.5,
  autoHide: true,
} as AppConfig;

const alertsCfg: AlertsConfig = {
  enabled: true,
  native: true,
  threshold: 80,
  exceededEffect: 'confetti',
  onReset: true,
  resetEffect: 'custom',
  exceededMedia: null,
  resetMedia: 'C:/efectos/anim.gif',
  mediaSize: 'small',
  mediaSound: false,
};

const shortcutsCfg: ShortcutsConfig = { enabled: true, toggle: 'Ctrl+Alt+H', openPeak: 'Ctrl+Alt+P', refresh: '' };

const noop = () => {};

const look = (locale: 'es' | 'en', liveError: string | null = 'fallo de prueba') =>
  renderToStaticMarkup(
    <LookSection locale={locale} cfg={lookCfg} liveError={liveError} onOrbSize={noop} onAccent={noop} onLiveChange={noop} onRetry={noop} />,
  );

const alerts = (locale: 'es' | 'en') =>
  renderToStaticMarkup(<AlertsSection locale={locale} alerts={alertsCfg} onAlerts={noop} onPersist={async () => {}} onError={noop} />);

const shortcuts = (locale: 'es' | 'en') =>
  renderToStaticMarkup(<ShortcutsSection locale={locale} shortcuts={shortcutsCfg} onShortcuts={noop} errors={['e']} warnings={[]} />);

describe('LookSection (SSR, i18n)', () => {
  it('renders the Spanish literals copied verbatim from the current code', () => {
    const html = look('es');
    for (const text of [
      'Anillos',
      'Vista previa a 88 px',
      'Tamaño del anillo',
      'Restablecer (48 px)',
      'Color de acento',
      'Usar #ff0036',
      'Elegir cualquier color (RGB)',
      'Colores resultantes',
      'Es el del anillo exterior y la primera barra; los otros dos tonos salen solos. Los avisos y el exceso conservan sus colores de alerta.',
      'Restablecer rojo egdev',
      'Opacidad de la tira y el panel',
      'Círculos pequeños',
      'Un solo anillo por suscripción: el límite más cercano.',
      'Mostrar resets en los círculos',
      'El saldo de resets siempre sigue disponible en el panel de detalle.',
      'Tira',
      'Borde',
      'Izquierda',
      'Derecha',
      'Arriba',
      'Abajo',
      'También puedes arrastrarla desde su asa: se pega al borde más cercano.',
      'Posición en el borde',
      'Ocultar sola',
      'Deja una franja en el borde y vuelve al acercar el ratón o cuando hay un aviso.',
      'Siempre encima',
      'Por encima del resto de ventanas.',
      'Personalización no aplicada',
      'Reintentar',
    ]) {
      expect(html, `falta «${text}» en es`).toContain(text);
    }
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = look('en');
    for (const text of [
      'Rings',
      'Preview at 88 px',
      'Ring size',
      'Reset (48 px)',
      'Accent color',
      'Use #ff0036',
      'Pick any color (RGB)',
      'Resulting colors',
      'Reset egdev red',
      'Strip and panel opacity',
      'Small circles',
      'A single ring per subscription: the closest limit.',
      'Show resets on the circles',
      'Strip',
      'Edge',
      'Left',
      'Right',
      'Top',
      'Bottom',
      'Position along the edge',
      'Hide on its own',
      'Always on top',
      'Above the rest of the windows.',
      'Personalization not applied',
      'Retry',
    ]) {
      expect(html, `falta «${text}» en en`).toContain(text);
    }
    for (const text of ['Anillos', 'Tira', 'Tamaño del anillo', 'Color de acento', 'Círculos pequeños', 'Borde', 'Izquierda', 'Ocultar sola', 'Siempre encima', 'Personalización no aplicada', 'Reintentar']) {
      expect(html, `sobra «${text}» en en`).not.toContain(text);
    }
  });
});

describe('AlertsSection (SSR, i18n)', () => {
  it('renders the Spanish literals copied verbatim from the current code', () => {
    const html = alerts('es');
    for (const text of [
      'Cuándo avisar',
      'Activar avisos',
      'Notificación del sistema',
      'Además del efecto en pantalla.',
      '1 · Al superar el límite',
      'Avisar al llegar a',
      'Una vez por ventana (sesión de 5 h, semana, mes…).',
      '2 · Al reiniciarse',
      'Avisar cuando el límite superado se reinicia',
      '«Claude · Sesión 5 h: disponible de nuevo»',
      'Efecto propio',
      'Un vídeo WebM (VP9) con canal alfa o una imagen animada GIF, WebP o APNG con transparencia. Se muestra centrado encima de todo, sin bloquear el ratón; el vídeo dura lo que dure (máx. 20 s) y las imágenes 4,5 s.',
      'Tamaño',
      'Pequeño',
      'Mediano',
      'Pantalla completa',
      'Con sonido',
      'Solo para vídeos.',
      'Efecto',
      'Confeti',
      'Glow de peligro',
      'Efecto propio (vídeo o imagen animada)',
      'Ninguno',
      'Probar',
      'Archivo',
      'Ningún archivo',
      'Elegir…',
      'Quitar',
    ]) {
      expect(html, `falta «${text}» en es`).toContain(text);
    }
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = alerts('en');
    for (const text of [
      'When to alert',
      'Enable alerts',
      'System notification',
      'In addition to the on-screen effect.',
      '1 · When the limit is exceeded',
      'Alert when reaching',
      'Once per window (5 h session, week, month…).',
      '2 · When it resets',
      'Alert when the exceeded limit resets',
      '“Claude · 5 h session: available again”',
      'Custom effect',
      'Custom effect (video or animated image)',
      'Size',
      'Small',
      'Medium',
      'Full screen',
      'With sound',
      'Videos only.',
      'Effect',
      'Test',
      'File',
      'No file',
      'Choose…',
      'Remove',
    ]) {
      expect(html, `falta «${text}» en en`).toContain(text);
    }
    for (const text of ['Cuándo avisar', 'Activar avisos', 'Notificación del sistema', 'Al superar el límite', 'Avisar al llegar a', 'Al reiniciarse', 'Efecto propio', 'Pequeño', 'Mediano', 'Pantalla completa', 'Con sonido', 'Probar', 'Archivo', 'Ningún archivo', 'Elegir…', 'Quitar']) {
      expect(html, `sobra «${text}» en en`).not.toContain(text);
    }
  });
});

describe('ShortcutsSection (SSR, i18n)', () => {
  it('renders the Spanish literals copied verbatim from the current code', () => {
    const html = shortcuts('es');
    for (const text of [
      'Atajos globales',
      'Activar atajos',
      'Funcionan aunque Quorb no tenga el foco.',
      'Atajos de teclado',
      'Acción',
      'Atajo',
      'Acciones',
      'Mostrar u ocultar la tira',
      'Abrir el más cargado',
      'Actualizar ahora',
      'Pulsa para cambiarlo',
      ': sin atajo.',
      'Sin atajo',
      'Cambiar',
      'Quitar',
      'Pulsa un atajo o «Cambiar» y teclea la combinación. Se aplican al guardar.',
    ]) {
      expect(html, `falta «${text}» en es`).toContain(text);
    }
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = shortcuts('en');
    for (const text of [
      'Global shortcuts',
      'Enable shortcuts',
      'They work even when Quorb is not focused.',
      'Keyboard shortcuts',
      'Action',
      'Shortcut',
      'Actions',
      'Show or hide the strip',
      'Open the most loaded',
      'Refresh now',
      'Press to change it',
      'no shortcut.',
      'No shortcut',
      'Change',
      'Remove',
      'Press a shortcut or “Change” and type the combination. They apply when you save.',
    ]) {
      expect(html, `falta «${text}» en en`).toContain(text);
    }
    for (const text of ['Atajos globales', 'Activar atajos', 'Atajos de teclado', 'Acción', 'Mostrar u ocultar la tira', 'Abrir el más cargado', 'Actualizar ahora', 'Sin atajo', 'Cambiar', 'Quitar', 'Pulsa un atajo o «Cambiar» y teclea la combinación. Se aplican al guardar.']) {
      expect(html, `sobra «${text}» en en`).not.toContain(text);
    }
  });
});

describe('UpdatesSection (SSR, i18n)', () => {
  it('renders the Spanish literals copied verbatim from the current code', () => {
    updater('unknown', { phase: 'idle' });
    const checking = renderToStaticMarkup(<UpdatesSection locale="es" auto onAuto={noop} />);
    expect(checking).toContain('Versión actual');
    expect(checking).toContain('Consultando el modo de actualización…');

    updater('native', { phase: 'none', checkedAt: 1 });
    const none = renderToStaticMarkup(<UpdatesSection locale="es" auto onAuto={noop} />);
    for (const text of [
      'Versión instalada',
      '· estás en la última versión',
      'Buscar ahora',
      'Buscar actualizaciones solo',
      'Al arrancar y cada 6 h. Si hay una nueva, aparece un icono de descarga en la tira.',
      'Llegan firmadas desde',
      'GitHub Releases',
      '; si la firma no coincide, no se instalan.',
    ]) {
      expect(none, `falta «${text}» en es`).toContain(text);
    }

    updater('native', { phase: 'available', info: { version: '1.2.3', notes: null, date: null } });
    const available = renderToStaticMarkup(<UpdatesSection locale="es" auto onAuto={noop} />);
    expect(available).toContain('Hay una versión nueva: 1.2.3.');
    expect(available).toContain('Se descarga, se comprueba la firma y Quorb se reinicia.');
    expect(available).toContain('Instalar y reiniciar');

    updater('native', { phase: 'installing', info: { version: '1.2.3', notes: null, date: null }, progress: null });
    const installing = renderToStaticMarkup(<UpdatesSection locale="es" auto onAuto={noop} />);
    expect(installing).toContain('Instalando…');
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    updater('unknown', { phase: 'idle' });
    const checking = renderToStaticMarkup(<UpdatesSection locale="en" auto onAuto={noop} />);
    expect(checking).toContain('Current version');
    expect(checking).toContain('Checking the update mode…');
    expect(checking).not.toContain('Versión actual');
    expect(checking).not.toContain('Consultando el modo de actualización…');

    updater('native', { phase: 'none', checkedAt: 1 });
    const none = renderToStaticMarkup(<UpdatesSection locale="en" auto onAuto={noop} />);
    for (const text of [
      'Installed version',
      '· you are on the latest version',
      'Check now',
      'Check for updates automatically',
      'At startup and every 6 h. If there is a new one, a download icon appears on the strip.',
      'They arrive signed from',
      'GitHub Releases',
      '; if the signature does not match, they are not installed.',
    ]) {
      expect(none, `falta «${text}» en en`).toContain(text);
    }

    updater('native', { phase: 'available', info: { version: '1.2.3', notes: null, date: null } });
    const available = renderToStaticMarkup(<UpdatesSection locale="en" auto onAuto={noop} />);
    expect(available).toContain('A new version is available: 1.2.3.');
    expect(available).toContain('It is downloaded, the signature is verified and Quorb restarts.');
    expect(available).toContain('Install and restart');

    updater('native', { phase: 'installing', info: { version: '1.2.3', notes: null, date: null }, progress: null });
    const installing = renderToStaticMarkup(<UpdatesSection locale="en" auto onAuto={noop} />);
    expect(installing).toContain('Installing…');

    for (const text of ['Versión instalada', 'estás en la última versión', 'Buscar ahora', 'Buscar actualizaciones solo', 'Hay una versión nueva', 'Instalar y reiniciar', 'Instalando', 'Llegan firmadas desde']) {
      expect(none + available + installing, `sobra «${text}» en en`).not.toContain(text);
    }
  });
});

describe('ProjectSection (SSR, i18n)', () => {
  it('renders the Spanish literals copied verbatim from the current code', () => {
    const html = renderToStaticMarkup(<ProjectSection locale="es" />);
    expect(html).toContain('Proyecto');
    expect(html).toContain('Quorb es open source (MIT). Si te ahorra un susto con los límites, una estrella en GitHub ayuda a que lo encuentre más gente.');
    expect(html).toContain('Pedir un proveedor');
    expect(html).toContain('GitHub');
    expect(html).toContain('egdev.es');
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = renderToStaticMarkup(<ProjectSection locale="en" />);
    expect(html).toContain('Project');
    expect(html).toContain('Quorb is open source (MIT). If it saves you a scare with the limits, a star on GitHub helps more people find it.');
    expect(html).toContain('Request a provider');
    expect(html).toContain('GitHub');
    expect(html).toContain('egdev.es');
    expect(html).not.toContain('Proyecto');
    expect(html).not.toContain('Pedir un proveedor');
  });
});

describe('SecretInput, shared primitive (SSR, i18n)', () => {
  it('renders its own Spanish literals verbatim in es and English in en', () => {
    const props = { id: 'cursor_token' as const, label: 'Token manual (opcional)', configured: false, onSaved: noop };
    const es = renderToStaticMarkup(<SecretInput {...props} locale="es" />);
    for (const text of ['Pega aquí la key', 'Guardar']) {
      expect(es, `falta «${text}» en es`).toContain(text);
    }
    const en = renderToStaticMarkup(<SecretInput {...props} locale="en" />);
    expect(en).toContain('Paste the key here');
    expect(en).toContain('Save');
    expect(en, 'sobra el placeholder español en en').not.toContain('Pega aquí la key');
  });
});
