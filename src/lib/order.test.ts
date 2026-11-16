import { describe, expect, it } from 'vitest';
import { OFFICIAL_USAGE_URL, applyOrder, dropIndex, moveTo, officialUsageUrl, nineRouterDashboardUrl } from './order';
import { reportSummary } from './format';
import type { UsageReport } from './types';

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join();

describe('order', () => {
  it('applies a saved order, unknown ids go last', () => {
    const items = [{ id: 'claude' }, { id: 'codex' }, { id: 'nan' }, { id: 'openai_api' }];
    expect(ids(applyOrder(items, ['nan', 'claude']))).toBe('nan,claude,codex,openai_api');
    expect(ids(applyOrder(items, []))).toBe('claude,codex,nan,openai_api');
  });

  it('moves an id to a position', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 2).join()).toBe('b,c,a,d');
    expect(moveTo(['a', 'b', 'c'], 'c', 0).join()).toBe('c,a,b');
  });

  it('finds the drop index from centers', () => {
    expect(dropIndex([10, 50, 90], 5)).toBe(0);
    expect(dropIndex([10, 50, 90], 60)).toBe(2);
    expect(dropIndex([10, 50, 90], 200)).toBe(3);
  });

  // #264/L18: durante el arrastre el DOM conserva el orden guardado (mover un
  // nodo libera la captura del puntero), así que los centros llegan en el
  // orden del DOM, que no es el visual. El índice lo decide la posición.
  it('finds the drop index from centers that are not in visual order', () => {
    expect(dropIndex([90, 10, 50], 20)).toBe(1);
    expect(dropIndex([90, 10, 50], 60)).toBe(2);
    expect(dropIndex([90, 10, 50], 200)).toBe(3);
    expect(dropIndex([50, 90, 10], 60)).toBe(2);
    expect(dropIndex([50, 90, 10], 5)).toBe(0);
  });

  it('resolves the official usage URL for main and scoped ids', () => {
    expect(officialUsageUrl('openrouter')).toBe(OFFICIAL_USAGE_URL.openrouter);
    expect(officialUsageUrl('openrouter:abc123')).toBe(OFFICIAL_USAGE_URL.openrouter);
    expect(officialUsageUrl('claude:trabajo')).toBe(OFFICIAL_USAGE_URL.claude);
    expect(officialUsageUrl('codex')).toBe('https://chatgpt.com/settings/usage?tab=overview');
    expect(officialUsageUrl('desconocido')).toBeUndefined();
    expect(officialUsageUrl('desconocido:abc')).toBeUndefined();
  });

  // Regresión del 4º feedback (P3): el enlace al dashboard de 9Router debe usar su
  // Base URL configurada, no un localhost fijo (que apuntaba a otra instancia o
  // fallaba si se personalizaba host/puerto). Cubre también los subproveedores.
  it('builds the 9Router dashboard URL from the configured base URL', () => {
    expect(officialUsageUrl('nine_router', 'http://192.168.1.50:8080')).toBe('http://192.168.1.50:8080/dashboard');
    expect(officialUsageUrl('nine_router:kiro', 'http://192.168.1.50:8080')).toBe('http://192.168.1.50:8080/dashboard');
    // Normaliza la barra final y los espacios.
    expect(nineRouterDashboardUrl('  http://localhost:20128/  ')).toBe('http://localhost:20128/dashboard');
    expect(nineRouterDashboardUrl('http://localhost:20128')).toBe('http://localhost:20128/dashboard');
    // Sin Base URL no hay enlace (no se inventa localhost).
    expect(officialUsageUrl('nine_router')).toBeUndefined();
    expect(officialUsageUrl('nine_router:kiro')).toBeUndefined();
    // Y 9Router ya no tiene una URL fija en el mapa.
    expect(OFFICIAL_USAGE_URL.nine_router).toBeUndefined();
  });

  it('builds a copyable summary', () => {
    const r: UsageReport = {
      id: 'claude', name: 'Claude', kind: 'subscription', status: 'ok', plan: 'Max',
      meters: [{ id: '', label: 'Sesión · 5 h', percent: 37.4, used: null, limit: null, unit: null, resetsAt: null, windowSeconds: null }],
      spend: { amount: 4.5, currency: 'USD', periodLabel: 'Este mes', budget: null },
      message: null, action: null, fetchedAt: '',
    };
    expect(reportSummary(r).replace(/\u00a0/g, ' ')).toBe('Claude (Max)\n· Sesión · 5 h: 37 %\n· Este mes: 4,50 $');
  });
});
