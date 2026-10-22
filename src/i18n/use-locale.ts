// Locale por ventana (T2b-U2 R5): selector puro + hook pequeño.
// El hook lee la config una vez y se mantiene al día con `config-changed`;
// antes de la primera lectura el locale efectivo es `es`. Widget no necesita
// este hook: ya guarda la config completa y refresca con el mismo evento.
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from '../lib/api';
import type { AppConfig, Locale } from '../lib/types';

/** Locale efectivo de una config (o de su ausencia): `es` por defecto. */
export const localeFrom = (config: AppConfig | null | undefined): Locale => config?.locale ?? 'es';

/** Config a guardar al cambiar el selector de Idioma: fusiona y conserva el resto. */
export const withLocale = (config: AppConfig, locale: Locale): AppConfig => ({ ...config, locale });

export interface LocaleChangeDeps {
  setDraft: (update: (draft: AppConfig | null) => AppConfig | null) => void;
  getConfig: () => Promise<AppConfig>;
  enqueueSave: (build: () => Promise<AppConfig>) => Promise<AppConfig>;
}

/**
 * Cambio del selector de Idioma en Ajustes. Guarda al momento sobre la config
 * más reciente del backend y además lo adopta en el borrador del formulario:
 * si no, el borrador queda «sucio» y «Guardar cambios» devolvería el idioma
 * anterior.
 *
 * Si el guardado falla, el backend manda: se relee su locale y el borrador
 * vuelve a él (el selector muestra el locale del backend, así que sin esto
 * «Guardar cambios» aplicaría un idioma que nunca se persistió) y el error
 * sube para que Ajustes lo muestre.
 */
export async function changeLocale(locale: Locale, deps: LocaleChangeDeps): Promise<void> {
  deps.setDraft((draft) => (draft ? withLocale(draft, locale) : draft));
  try {
    await deps.enqueueSave(() => deps.getConfig().then((current) => withLocale(current, locale)));
  } catch (err) {
    const current = await deps.getConfig().catch(() => null);
    if (current) deps.setDraft((draft) => (draft ? withLocale(draft, localeFrom(current)) : draft));
    throw err;
  }
}

/** Locale actual de esta ventana: una lectura + `config-changed`. */
export function useLocale(): Locale {
  const [locale, setLocale] = useState<Locale>('es');
  useEffect(() => {
    let disposed = false;
    const apply = (config: AppConfig) => {
      if (!disposed) setLocale(localeFrom(config));
    };
    api.getConfig().then(apply).catch(console.error);
    // El payload del evento no siempre es la config (a veces es `()`): se relee.
    const off = listen('config-changed', () => {
      api.getConfig().then(apply).catch(() => {});
    });
    return () => {
      disposed = true;
      off.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  return locale;
}
