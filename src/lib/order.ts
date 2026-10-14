// Orden y visibilidad de los círculos de la tira.

import { providerOf } from './accounts';

/** Ordena por `order` (ids); los que no estén van al final en su orden original. */
export function applyOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  return items
    .map((it, i) => ({ it, k: pos.get(it.id) ?? order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.it);
}

/** Mueve `id` a la posición `index` dentro de `ids`. */
export function moveTo(ids: string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const i = Math.max(0, Math.min(rest.length, index));
  return [...rest.slice(0, i), id, ...rest.slice(i)];
}

/** Índice en el que caería un elemento arrastrado según los centros de los demás. */
export function dropIndex(centers: number[], pointer: number): number {
  const i = centers.findIndex((c) => pointer < c);
  return i === -1 ? centers.length : i;
}

export const OFFICIAL_USAGE_URL: Record<string, string> = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/settings/usage?tab=overview',
  nan: 'https://cloud.nan.builders/dashboard',
  anthropic_api: 'https://console.anthropic.com/usage',
  openai_api: 'https://platform.openai.com/usage',
  gemini: 'https://aistudio.google.com/usage',
  cursor: 'https://cursor.com/dashboard?tab=usage',
  copilot: 'https://github.com/settings/billing/premium_requests_usage',
  openrouter: 'https://openrouter.ai/activity',
};

/** URL de uso oficial de un informe; normaliza el id para las cuentas adicionales (`openrouter:abc`). */
export const officialUsageUrl = (reportId: string): string | undefined => OFFICIAL_USAGE_URL[providerOf(reportId)];
