// Selector de idioma del primer arranque (#235, S8). Sin idioma elegido no hay
// textos traducibles: solo nombres nativos, sin foco ni selección previa (P4) y
// sin detectar el idioma del sistema.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import capabilitySource from '../src-tauri/capabilities/locale-picker.json?raw';
import { LocalePicker, PICKER_OPTIONS } from './LocalePicker';
import source from './LocalePicker.tsx?raw';

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
});
