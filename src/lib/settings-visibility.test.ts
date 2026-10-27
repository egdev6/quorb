import source from '../Settings.tsx?raw';
import types from './types.ts?raw';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEY, configKeyFor, isAccountVisible, setAccountVisibility } from './settings-visibility';
import type { AppConfig } from './types';

const fixture = (): AppConfig => ({
  accounts: [{ id: 'claude:work', provider: 'claude', label: 'Work', enabled: true }],
  hiddenProviders: ['claude', 'claude:work', 'openai_api', 'unrelated'],
  ...Object.fromEntries(Object.values(CONFIG_KEY).map((key) => [key, { enabled: true, retained: 'draft' }])),
} as unknown as AppConfig);

describe('obsolete hidden-circles block (#98)', () => {
  it('removes both presentations but keeps data and per-account controls', () => {
    expect(source.includes('Círculos ocultos')).toBe(false);
    expect(source.includes('Ninguno. Para ocultar uno')).toBe(false);
    expect(source.includes('cfg.hiddenProviders.map')).toBe(false);
    expect(types).toContain('hiddenProviders: string[]');
    expect(source.includes('label="Mostrar en el widget"')).toBe(true);
  });

  it('routes every "Mostrar en el widget" toggle through the visibility helpers', () => {
    // Un toggle con `set(...)` directo no saca el id de `hiddenProviders`: un
    // círculo ocultado desde el widget quedaría marcado e irrecuperable (#182).
    const toggles = [...source.matchAll(/<Toggle\s+label="Mostrar en el widget"[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(toggles.length).toBeGreaterThan(0);
    for (const t of toggles) expect(t).toMatch(/onChange=\{(onVisibility|\(v\) => setVisibility\()/);
    expect(source).toContain("checked={isAccountVisible(cfg, 'zai', cfg.zai.enabled)} onChange={(v) => setVisibility('zai', v)}");
  });

  it('shows an enabled but hidden circle as unchecked, without disabling polling', () => {
    const cfg = fixture();
    expect(isAccountVisible(cfg, 'claude', true)).toBe(false);
    expect(isAccountVisible(cfg, 'claude:work', true)).toBe(false);
    expect(isAccountVisible(cfg, 'codex', true)).toBe(true);
    expect(isAccountVisible(cfg, 'codex', false)).toBe(false);
    expect(cfg.claude.enabled).toBe(true);
  });

  it.each(Object.entries(CONFIG_KEY))('restores only principal %s and preserves its config', (id, key) => {
    const cfg = fixture();
    cfg.hiddenProviders.push(id);
    const next = setAccountVisibility(cfg, id, true);
    expect(next.hiddenProviders).toEqual(cfg.hiddenProviders.filter((x) => x !== id));
    expect(next[key]).toEqual(cfg[key]);
    expect(next.accounts).toBe(cfg.accounts);
    expect(cfg.hiddenProviders).toContain(id);
  });

  it('restores only an additional account, preserving drafts and the principal', () => {
    const cfg = fixture();
    const next = setAccountVisibility(cfg, 'claude:work', true);
    expect(next.hiddenProviders).toEqual(['claude', 'openai_api', 'unrelated']);
    expect(next.accounts[0]).toEqual(cfg.accounts[0]);
    expect(next.claude).toBe(cfg.claude);
    expect(cfg.hiddenProviders).toContain('claude:work');
  });

  it('disables without clearing hidden IDs and ignores unknown IDs', () => {
    const cfg = fixture();
    const next = setAccountVisibility(cfg, 'claude:work', false);
    expect(next.accounts[0].enabled).toBe(false);
    expect(next.hiddenProviders).toBe(cfg.hiddenProviders);
    const disabled = setAccountVisibility(cfg, 'claude', false);
    expect(disabled.claude.enabled).toBe(false);
    expect(disabled.hiddenProviders).toBe(cfg.hiddenProviders);
    expect(setAccountVisibility(disabled, 'claude', true).claude.enabled).toBe(true);
    expect(setAccountVisibility(next, 'claude:work', true).accounts[0].enabled).toBe(true);
    expect(setAccountVisibility(cfg, 'constructor', true)).toBe(cfg);
    expect(setAccountVisibility(cfg, 'missing', true)).toBe(cfg);
  });

  it('reactivating 9Router restores its aggregate orb and every sub-orb', () => {
    // Regresión del punto 1: 9Router no tiene id único en CONFIG_KEY; activarlo
    // debe recuperar el orbe agregado y todos los sub-orbes ocultados.
    const cfg = { ...fixture(), nineRouter: { enabled: false }, hiddenProviders: ['nine_router', 'nine_router:kiro', 'claude'] } as unknown as AppConfig;
    const next = setAccountVisibility(cfg, 'nine_router', true);
    expect(next.nineRouter.enabled).toBe(true);
    expect(next.hiddenProviders).toEqual(['claude']);
    // Desactivar no limpia ocultaciones (como el resto de proveedores).
    const off = setAccountVisibility({ ...cfg, nineRouter: { enabled: true } } as unknown as AppConfig, 'nine_router', false);
    expect(off.nineRouter.enabled).toBe(false);
    expect(off.hiddenProviders).toContain('nine_router:kiro');
  });

  it('maps nine_router to its config key for the draft/saved comparison', () => {
    // Regresión del punto 3 (P3): el flujo «cambios sin guardar» del paso de
    // conexión necesita la clave de config de 9Router. Sin este mapeo, el borrador
    // (p. ej. la Base URL cambiada) no se detectaba y el paso «URL ahora» daba por
    // bueno el destino persistido.
    expect(configKeyFor('nine_router')).toBe('nineRouter');
    // El resto sigue resolviéndose como hasta ahora (ids de informe → clave).
    expect(configKeyFor('anthropic_api')).toBe('anthropicApi');
    expect(configKeyFor('openai_api')).toBe('openaiApi');
    expect(configKeyFor('claude')).toBe('claude');
    expect(configKeyFor('desconocido')).toBeUndefined();
    // 9Router no ensucia CONFIG_KEY: su visibilidad usa una rama propia.
    expect('nine_router' in CONFIG_KEY).toBe(false);
  });

  it('flags a 9Router draft URL as unsaved (dirty) via its config key', () => {
    // Escenario del reviewer: se cambia la Base URL del borrador sin guardar.
    // Comparar `cfg.nineRouter` con `baseline.nineRouter` debe dar «dirty».
    const saved = { ...fixture(), nineRouter: { enabled: true, baseUrl: 'http://localhost:20128' } } as unknown as AppConfig;
    const draft = { ...saved, nineRouter: { ...saved.nineRouter, baseUrl: 'http://localhost:3000' } } as unknown as AppConfig;
    const key = configKeyFor('nine_router')!;
    // Igual que `sectionDirty`: compara la sección por su clave de config.
    expect(JSON.stringify(draft[key])).not.toBe(JSON.stringify(saved[key]));
    // Sin cambios, no hay borrador.
    expect(JSON.stringify(saved[key])).toBe(JSON.stringify(saved[key]));
  });
});
