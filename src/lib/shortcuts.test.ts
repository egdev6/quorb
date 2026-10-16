import { describe, expect, it } from 'vitest';
import { comboFromEvent, prettyCombo } from './shortcuts';

const ev = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('shortcuts', () => {
  it('builds Tauri-style combos', () => {
    expect(comboFromEvent(ev('KeyU', 'u', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+U');
    expect(comboFromEvent(ev('Digit1', '!', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1');
    expect(comboFromEvent(ev('F9', 'F9'))).toBe('F9');
    expect(comboFromEvent(ev('KeyI', 'i', { metaKey: true, altKey: true }))).toBe('Alt+Super+I');
  });

  it('waits for a real key and requires a modifier', () => {
    expect(comboFromEvent(ev('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull();
    expect(comboFromEvent(ev('KeyU', 'u'))).toBeNull();
    expect(comboFromEvent(ev('KeyU', 'U', { shiftKey: true }))).toBeNull();
  });

  it('pretty prints', () => {
    expect(prettyCombo('Ctrl+Alt+U', false)).toBe('Ctrl + Alt + U');
    expect(prettyCombo('Alt+Super+I', false)).toBe('Alt + Win + I');
  });

  describe('prettyCombo en macOS', () => {
    it('usa símbolos de macOS y sin separadores', () => {
      expect(prettyCombo('Ctrl+Alt+U', true)).toBe('⌃⌥U');
      expect(prettyCombo('Ctrl+Alt+U', false)).toBe('Ctrl + Alt + U');
    });

    it('mapea Super a ⌘ y Shift a ⇧ en macOS', () => {
      expect(prettyCombo('Super+Shift+R', true)).toBe('⌘⇧R');
    });

    it('deja la tecla normal intacta (incluye F y números)', () => {
      expect(prettyCombo('Ctrl+Alt+F5', true)).toBe('⌃⌥F5');
      expect(prettyCombo('Alt+Super+9', true)).toBe('⌥⌘9');
    });
  });
});
