// Selector de idioma del primer arranque (#235, S8). Sin idioma elegido no hay
// textos traducibles: solo nombres nativos, sin foco ni selección previa (P4) y
// sin detectar el idioma del sistema. Elegir llama a `choose_locale`, que guarda
// idioma + `localeSelected` y levanta la UI principal.
import { useEffect, useState } from 'react';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from './lib/api';
import type { Locale } from './lib/types';

export const PICKER_OPTIONS: ReadonlyArray<{ locale: Locale; label: string }> = [
  { locale: 'es', label: 'Español' },
  { locale: 'en', label: 'English' },
];

const WIDTH = 420;
const MIN_HEIGHT = 240;

export function LocalePicker() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // P1: alto ajustado al contenido (con escala de texto alta), mínimo 420×240.
  useEffect(() => {
    const height = Math.max(MIN_HEIGHT, Math.ceil(document.documentElement.scrollHeight));
    void getCurrentWindow()
      .setSize(new LogicalSize(WIDTH, height))
      .catch(() => {});
  }, []);

  const choose = async (locale: Locale) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.chooseLocale(locale);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, minHeight: MIN_HEIGHT, padding: 24 }}>
      <h1 style={{ margin: 0, fontSize: 22 }}>Quorb</h1>
      <div style={{ display: 'flex', gap: 12 }}>
        {PICKER_OPTIONS.map((option) => (
          <button key={option.locale} type="button" className="eg-btn eg-btn--secondary" disabled={busy} onClick={() => choose(option.locale)}>
            {option.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
    </main>
  );
}
