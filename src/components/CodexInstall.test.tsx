// Prueba de renderizado real en servidor (renderToStaticMarkup), sin DOM falso:
// comprueba qué botones pinta el componente en cada estado del contrato.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodexInstall } from './CodexInstall';
import type { CodexInstallController, CodexInstallState } from '../lib/codex-install';

const stateFor = (patch: Partial<CodexInstallState> = {}): CodexInstallState => ({
  status: null,
  reading: false,
  installing: false,
  outcome: null,
  message: null,
  error: null,
  errorFrom: null,
  ...patch,
});

const controllerWith = (state: CodexInstallState): CodexInstallController => ({
  getState: () => state,
  subscribe: () => () => {},
  setVisible: () => {},
  start: () => {},
  stop: () => {},
  refresh: async () => state,
  requestInstall: async () => ({ ok: false, reason: 'inactive', message: 'inactivo' }),
});

const render = (state: CodexInstallState) => renderToStaticMarkup(<CodexInstall controller={controllerWith(state)} onRecheck={() => {}} />);

describe('CodexInstall (SSR)', () => {
  it('offers install only when the metadata is ready', () => {
    const html = render(
      stateFor({
        status: { supported: true, busy: false, nodeAvailable: true, installed: false, package: '@openai/codex@0.162.1', message: null, outcome: null },
      }),
    );
    expect(html).toContain('Instalar Codex');
  });

  it('offers recheck and copy, never install, when Node/npm is missing', () => {
    const html = render(
      stateFor({
        status: { supported: true, busy: false, nodeAvailable: false, installed: false, package: '@openai/codex@0.162.1', message: null, outcome: null },
      }),
    );
    expect(html).toContain('Volver a comprobar');
    expect(html).toContain('Copiar orden');
    expect(html).not.toContain('Instalar Codex');
  });

  it('offers recheck and copy, never install, on an unsupported platform', () => {
    const html = render(
      stateFor({
        status: { supported: false, busy: false, nodeAvailable: true, installed: false, package: '@openai/codex@0.162.1', message: null, outcome: null },
      }),
    );
    expect(html).toContain('Volver a comprobar');
    expect(html).toContain('Copiar orden');
    expect(html).not.toContain('Instalar Codex');
  });

  it('offers only recheck on a metadata read error, never a retry-install', () => {
    const html = render(stateFor({ error: 'backend caído', errorFrom: 'read' }));
    expect(html).toContain('Volver a comprobar');
    expect(html).not.toContain('Reintentar');
    expect(html).not.toContain('Instalar Codex');
  });

  it('offers retry and recheck on a real install error', () => {
    const html = render(stateFor({ error: 'rechazado', errorFrom: 'install' }));
    expect(html).toContain('Reintentar');
    expect(html).toContain('Volver a comprobar');
    expect(html).not.toContain('Instalar Codex');
  });

  it('does not offer any action while installing', () => {
    const html = render(stateFor({ installing: true }));
    expect(html).toContain('Instalando…');
    expect(html).not.toContain('>Instalar Codex<');
    expect(html).not.toContain('>Reintentar<');
    expect(html).not.toContain('>Volver a comprobar<');
  });
});
