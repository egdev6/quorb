// Selector de idioma del primer arranque (#235, S8). Sin idioma elegido no hay
// textos traducibles: solo nombres nativos, sin foco ni selección previa (P4) y
// sin detectar el idioma del sistema.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import capabilitySource from '../src-tauri/capabilities/locale-picker.json?raw';
import { fitToContent, LocalePicker, MIN_HEIGHT, MIN_WIDTH, PICKER_OPTIONS } from './LocalePicker';
import source from './LocalePicker.tsx?raw';

describe('fitToContent (P1)', () => {
  it('clamps content smaller than the minimum to 420x240', () => {
    expect(fitToContent(300, 100)).toEqual({ width: 420, height: 240 });
    expect(MIN_WIDTH).toBe(420);
    expect(MIN_HEIGHT).toBe(240);
  });

  it('takes the content size when it is above the minimum, rounding up', () => {
    expect(fitToContent(560, 380)).toEqual({ width: 560, height: 380 });
    expect(fitToContent(500.2, 300.1)).toEqual({ width: 501, height: 301 });
  });

  it('clamps each axis independently', () => {
    expect(fitToContent(600, 100)).toEqual({ width: 600, height: 240 });
    expect(fitToContent(100, 400)).toEqual({ width: 420, height: 400 });
  });

  it('falls back to the minimum for non-finite measurements', () => {
    expect(fitToContent(Number.NaN, Number.NaN)).toEqual({ width: 420, height: 240 });
    expect(fitToContent(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toEqual({ width: 420, height: 240 });
  });
});

describe('LocalePicker', () => {
  it('offers exactly Español and English, in that order', () => {
    expect(PICKER_OPTIONS).toEqual([
      { locale: 'es', label: 'Español' },
      { locale: 'en', label: 'English' },
    ]);
  });

  it('renders both native names and the neutral title, with no preselected option', () => {
    const html = renderToStaticMarkup(<LocalePicker />);
    expect(html).toContain('>Español<');
    expect(html).toContain('>English<');
    expect(html).toContain('Quorb');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain('autofocus');
    expect(html).not.toContain('eg-btn--primary');
  });

  it('chooses through the first-run command only and never reads the system locale', () => {
    expect(source).toContain("api.chooseLocale(");
    expect(source).not.toContain('saveConfig');
    expect(source).not.toMatch(/navigator\.language|Intl\.|getLocale/);
  });

  it('fits its window to the content and never grants more than it needs', () => {
    expect(source).toContain('setSize(');
    const capability = JSON.parse(capabilitySource);
    expect(capability.windows).toEqual(['locale']);
    expect(capability.permissions).toEqual(
      expect.arrayContaining(['core:window:allow-destroy', 'core:window:allow-set-size']),
    );
    expect(capability.permissions).not.toContain('core:window:allow-show');
  });

  it('keeps the content centered when the window is wider than the content', () => {
    // Con `width: max-content` la caja se contrae al contenido: sin auto-margins
    // quedaría pegada a la izquierda cuando la ventana está en su mínimo de ancho.
    const html = renderToStaticMarkup(<LocalePicker />);
    expect(html).toContain('margin:0 auto');
  });

  it('measures its own content node and re-fits on resize and font load, sizing both axes', () => {
    expect(source).toContain('new ResizeObserver(');
    expect(source).toContain('document.fonts.ready');
    expect(source).toMatch(/useRef<HTMLElement/);
    expect(source).toMatch(/ref=\{contentRef\}/);
    expect(source).toContain('contentRef.current');
    expect(source).not.toContain('documentElement');
    expect(source).toContain('fitToContent(');
    expect(source).toContain('new LogicalSize(width, height)');
    expect(source).toContain('console.error(');
    expect(source).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});
