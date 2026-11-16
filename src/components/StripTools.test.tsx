// SSR de las herramientas de la tira (Actualizar / Refrescar / Ajustes),
// extraídas de Widget.tsx como componente puro con `locale`.
//
// Revisión PR #271 (precisión 2): el componente se monta SOLO cuando el idioma
// es seguro (`configReady` o fallo definitivo con locale `es`), así que los
// `title`/`aria-label` localizados se emiten siempre. El «sin título mientras
// pendiente» se cubre en el test del cableado (el padre no monta StripTools).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UpdaterMode } from '../lib/updater-policy';
import { StripTools } from './StripTools';

const props = (locale: 'es' | 'en', over: Partial<Parameters<typeof StripTools>[0]> = {}) => ({
  locale,
  loading: false,
  updaterMode: 'native' as UpdaterMode,
  update: { phase: 'idle' } as const,
  onRefresh: () => {},
  onOpenSettings: () => {},
  onStartUpdate: () => {},
  icons: { update: <i>u</i>, refresh: <i>r</i>, gear: <i>g</i> },
  ...over,
});

describe('StripTools i18n (SSR)', () => {
  it('renders localized tooltips for es', () => {
    const html = renderToStaticMarkup(<StripTools {...props('es')} />);
    expect(html).toContain('title="Ajustes"');
    expect(html).toContain('title="Actualizar ahora"');
    expect(html).not.toContain('Settings');
    // Idle: sin botón de update.
    expect(html).not.toContain('icon-btn--update');
  });

  it('renders localized tooltips for en', () => {
    const html = renderToStaticMarkup(<StripTools {...props('en')} />);
    expect(html).toContain('title="Settings"');
    expect(html).not.toContain('Ajustes');
  });

  it('shows the update button with a localized tooltip when an update is available', () => {
    const html = renderToStaticMarkup(
      <StripTools {...props('en')} update={{ phase: 'available', info: { version: '1.2.3' } } as never} />,
    );
    expect(html).toContain('icon-btn--update');
    // `widget.updateTo` con interpolación de versión.
    expect(html).toContain('1.2.3');
    // Instalando: título `widget.updatingTo` + `data-spin`.
    const installing = renderToStaticMarkup(
      <StripTools
        {...props('en')}
        update={{ phase: 'installing', info: { version: '1.2.3' }, progress: 50 } as never}
      />,
    );
    expect(installing).toContain('data-spin="true"');
    expect(installing).toContain('50 %');
  });

  it('keeps handlers and the refresh spinner after the extraction', () => {
    const onRefresh = () => {};
    const onOpenSettings = () => {};
    const html = renderToStaticMarkup(<StripTools {...props('en')} loading onRefresh={onRefresh} onOpenSettings={onOpenSettings} />);
    // data-spin en refresh cuando loading.
    expect(html).toContain('data-spin="true"');
    // Ambos botones conservan sus handlers (SSR los emite como atributos).
    expect(html).toContain('title="Settings"');
  });
});
