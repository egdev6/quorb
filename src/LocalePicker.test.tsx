// Selector de idioma del primer arranque (#235, S8). Sin idioma elegido no hay
// textos traducibles: solo nombres nativos, sin foco ni selección previa (P4) y
// sin detectar el idioma del sistema.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import capability from '../src-tauri/capabilities/locale-picker.json';
import { fitToContent, LocalePicker, logicalPerCssPx, MIN_HEIGHT, MIN_WIDTH, PICKER_OPTIONS } from './LocalePicker';

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

describe('logicalPerCssPx (T8b round 2)', () => {
  it('is identity when devicePixelRatio equals scaleFactor', () => {
    expect(logicalPerCssPx(1, 1)).toBe(1);
    expect(logicalPerCssPx(2, 2)).toBe(1);
  });

  it('returns the zoom factor when the page is zoomed (text scaling)', () => {
    expect(logicalPerCssPx(2.5, 1)).toBe(2.5);
    expect(logicalPerCssPx(2, 2.5)).toBeCloseTo(0.8, 10);
  });

  it('falls back to 1 for non-finite or non-positive scale factors', () => {
    expect(logicalPerCssPx(2, 0)).toBe(1);
    expect(logicalPerCssPx(2, Number.NaN)).toBe(1);
    expect(logicalPerCssPx(2, Number.POSITIVE_INFINITY)).toBe(1);
    expect(logicalPerCssPx(Number.NaN, 1)).toBe(1);
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

  it('grants the picker only the window permissions it uses', () => {
    // Solo ajusta tamaño y lee medidas; cerrar y elegir pasan por Rust y `choose_locale`.
    expect(capability.windows).toEqual(['locale']);
    expect(capability.permissions).toEqual(['core:default', 'core:window:allow-set-size']);
  });

  it('keeps the content centered when the window is wider than the content', () => {
    // Con `width: max-content` la caja se contrae al contenido: sin auto-margins
    // quedaría pegada a la izquierda cuando la ventana está en su mínimo de ancho.
    const html = renderToStaticMarkup(<LocalePicker />);
    expect(html).toContain('margin:0 auto');
  });

});
