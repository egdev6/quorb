import { describe, expect, it } from 'vitest';
import type { AppConfig } from './types';
import { isDirty, isSettingsDirty, liveSaveConfig, reconcileLive, reconcileSaved, withCanonicalLive } from './settings-dirty';

const alerts = (over: Partial<AppConfig['alerts']> = {}): AppConfig['alerts'] => ({
  enabled: true,
  native: false,
  threshold: 90,
  exceededEffect: 'none',
  onReset: false,
  resetEffect: 'none',
  exceededMedia: null,
  resetMedia: null,
  mediaSize: 'medium',
  mediaSound: false,
  ...over,
});

const config = (over: Record<string, unknown> = {}): AppConfig =>
  ({ refreshMinutes: 5, orbSize: 48, accentColor: '#ff0036', providerOrder: ['claude', 'codex'], hiddenProviders: [], alerts: alerts(), ...over }) as unknown as AppConfig;

describe('isDirty', () => {
  it('is false without a canonical baseline, true after an edit and false again on revert', () => {
    const base = config();
    expect(isDirty(null, base)).toBe(false);
    expect(isDirty(base, null)).toBe(false);
    expect(isDirty(base, { ...base })).toBe(false);
    const edited = { ...base, refreshMinutes: 30, alerts: alerts({ native: true }) };
    expect(isDirty(base, edited)).toBe(true);
    expect(isDirty(base, { ...base, providerOrder: ['codex', 'claude'] })).toBe(true);
    expect(isDirty(base, { ...edited, refreshMinutes: base.refreshMinutes, alerts: alerts() })).toBe(false);
  });
});

describe('isDirty con campos vivos', () => {
  const base = config();

  it('treats reset visibility as live personalization and reconciles the confirmed preference', () => {
    const base = config({ showResets: true });
    const draft = config({ showResets: false });
    expect(isDirty(base, draft)).toBe(false);
    expect(reconcileLive(draft, { showResets: false } as Partial<AppConfig>, draft)).toEqual(draft);
    // The canonical response must carry this live field just like compact/opacity.
    const canonical = config({ showResets: true });
    expect(reconcileLive(draft, { showResets: false } as Partial<AppConfig>, canonical)).toEqual(canonical);
  });

  it('no se ensucia si solo cambia un campo vivo (antes y tras el autosave)', () => {
    expect(isDirty(base, { ...base, orbSize: 60 })).toBe(false);
    expect(isDirty(base, { ...base, accentColor: '#00aaff' })).toBe(false);
    // Autosave canónico ya confirmado: la base trae el valor aplicado.
    expect(isDirty({ ...base, orbSize: 60 }, { ...base, orbSize: 60 })).toBe(false);
  });

  it('sigue sucio con una edición normal junto a un cambio vivo', () => {
    expect(isDirty(base, { ...base, refreshMinutes: 30, orbSize: 60 })).toBe(true);
  });

  it('queda limpio al revertir la edición manual con un cambio vivo pendiente', () => {
    const draft = { ...base, refreshMinutes: 30, orbSize: 60 };
    expect(isDirty(base, draft)).toBe(true);
    expect(isDirty(base, { ...draft, refreshMinutes: base.refreshMinutes })).toBe(false);
  });

  it('la llegada del valor vivo canónico no limpia otra suciedad manual', () => {
    const draft = { ...base, refreshMinutes: 30, orbSize: 60 };
    expect(isDirty({ ...base, orbSize: 60 }, draft)).toBe(true);
    expect(isDirty({ ...base, orbSize: 60 }, { ...draft, refreshMinutes: base.refreshMinutes })).toBe(false);
  });

  it('no es sucio sin base canónica', () => {
    expect(isDirty(null, { ...base, orbSize: 60 })).toBe(false);
    expect(isDirty({ ...base, orbSize: 60 }, null)).toBe(false);
  });

  it('ignora los seis controles de personalización inmediata (#97)', () => {
    const lives: Partial<AppConfig>[] = [
      { opacity: 0.5 },
      { compact: true },
      { dockEdge: 'left' },
      { dockOffset: 0.1 },
      { autoHide: true },
      { alwaysOnTop: false },
    ];
    for (const patch of lives) {
      expect(isDirty(base, { ...base, ...patch })).toBe(false);
    }
  });

  it('un cambio vivo pendiente o fallido no ensucia: el manual sigue mandando', () => {
    const draft = { ...base, opacity: 0.4, autoHide: true, refreshMinutes: 30 };
    expect(isDirty(base, draft)).toBe(true);
    // Aunque el autosave aún no confirmó el valor vivo, revertir lo manual limpia.
    expect(isDirty(base, { ...draft, refreshMinutes: base.refreshMinutes })).toBe(false);
    // La llegada del valor vivo canónico no limpia otra suciedad manual.
    expect(isDirty({ ...base, opacity: 0.4 }, { ...draft, opacity: 0.4 })).toBe(true);
  });
});

describe('liveSaveConfig', () => {
  it('persists only the live field from the canonical baseline', () => {
    const base = config();
    const saved = liveSaveConfig(base, { orbSize: 60 });
    expect(saved.orbSize).toBe(60);
    expect(saved.refreshMinutes).toBe(5);
    expect(isDirty(saved, { ...base, orbSize: 60, refreshMinutes: 30 })).toBe(true);
  });
});

describe('withCanonicalLive (B5)', () => {
  it('conserva el borrador manual y adopta el canónico vivo confirmado', () => {
    const base = config();
    const draft = { ...base, refreshMinutes: 30, opacity: 0.94, autoHide: false };
    const out = withCanonicalLive(draft, { opacity: 0.36, autoHide: true });
    // El borrador manual queda intacto; solo los campos vivos toman el canónico.
    expect(out.refreshMinutes).toBe(30);
    expect(out.opacity).toBe(0.36);
    expect(out.autoHide).toBe(true);
  });
});

describe('reconcileLive', () => {
  it('keeps a newer input and manual edits when an older live response arrives', () => {
    const draft = config({ opacity: 0.7, refreshMinutes: 30 });
    const out = reconcileLive(draft, { opacity: 0.3 }, config({ opacity: 0.3 }));
    expect(out.opacity).toBe(0.7);
    expect(out.refreshMinutes).toBe(30);
  });

  it('adopts normalization when the input still matches the submitted patch', () => {
    const draft = config({ opacity: 0.1, refreshMinutes: 30 });
    const out = reconcileLive(draft, { opacity: 0.1 }, config({ opacity: 0.3 }));
    expect(out.opacity).toBe(0.3);
    expect(out.refreshMinutes).toBe(30);
  });
});

 describe('isSettingsDirty', () => {
  const base = config();

  it('combines the manual config dirty flag with the autostart draft', () => {
    expect(isSettingsDirty(base, base, true, true)).toBe(false);
    expect(isSettingsDirty(base, { ...base, refreshMinutes: 30 }, true, true)).toBe(true);
    expect(isSettingsDirty(base, base, true, false)).toBe(true);
    expect(isSettingsDirty(base, base, true, true)).toBe(false);
  });

  it('clears the autostart dirty flag when the draft returns to the confirmed value', () => {
    expect(isSettingsDirty(base, base, true, false)).toBe(true);
    expect(isSettingsDirty(base, base, true, true)).toBe(false);
  });

  it('treats an unknown OS basis as not dirty', () => {
    expect(isSettingsDirty(base, base, null, true)).toBe(false);
    expect(isSettingsDirty(base, base, true, null)).toBe(false);
  });

  it('does not clear the autostart dirty flag when only a live field is saved', () => {
    const withLive = { ...base, orbSize: 60 };
    expect(isSettingsDirty(base, withLive, true, false)).toBe(true);
  });
});

describe('reconcileSaved', () => {
  it('adopts the canonical saved values when the draft did not change', () => {
    const base = config({ accentColor: '#AAA' });
    expect(reconcileSaved(base, config({ accentColor: '#aaa' }), base).accentColor).toBe('#aaa');
  });

  it('keeps a live edit made during the save without losing canonical fields', () => {
    const base = config({ orbSize: 48, accentColor: '#AAA' });
    const saved = config({ orbSize: 48, accentColor: '#aaa' });
    const latest = config({ orbSize: 60, accentColor: '#AAA' });
    expect(reconcileSaved(base, saved, latest)).toEqual({ ...saved, orbSize: 60 });
  });

  it('merges nested edits field by field and keeps arrays edited during the save', () => {
    const base = config({ alerts: alerts({ threshold: 90, native: false }) });
    const saved = config({ alerts: alerts({ threshold: 80 }) });
    const latest = config({ alerts: alerts({ threshold: 90, native: true }), providerOrder: ['codex', 'claude'] });
    const out = reconcileSaved(base, saved, latest);
    expect(out.alerts.threshold).toBe(80);
    expect(out.alerts.native).toBe(true);
    expect(out.providerOrder).toEqual(['codex', 'claude']);
  });
});
