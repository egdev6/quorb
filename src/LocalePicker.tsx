// Selector de idioma del primer arranque (#235, S8). Sin idioma elegido no hay
// textos traducibles: solo nombres nativos, sin foco ni selección previa (P4) y
// sin detectar el idioma del sistema. Elegir llama a `choose_locale`, que guarda
// idioma + `localeSelected` y levanta la UI principal.
import { useEffect, useRef, useState } from 'react';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from './lib/api';
import type { Locale } from './lib/types';

export const PICKER_OPTIONS: ReadonlyArray<{ locale: Locale; label: string }> = [
  { locale: 'es', label: 'Español' },
  { locale: 'en', label: 'English' },
];

export const MIN_WIDTH = 420;
export const MIN_HEIGHT = 240;

const atLeast = (min: number, measured: number) => (Number.isFinite(measured) ? Math.max(min, Math.ceil(measured)) : min);

// P1: tamaño de la ventana = contenido medido (redondeado hacia arriba), con mínimo 420×240 en ambos ejes.
export const fitToContent = (measuredWidth: number, measuredHeight: number) => ({
  width: atLeast(MIN_WIDTH, measuredWidth),
  height: atLeast(MIN_HEIGHT, measuredHeight),
});

// T8b round 2: con el zoom de texto de GNOME, WebKitGTK escala como zoom de página: las medidas de
// getBoundingClientRect() son CSS px, pero setSize(LogicalSize) usa logical px. Factor = logical px por CSS px.
export const logicalPerCssPx = (devicePixelRatio: number, scaleFactor: number): number =>
  Number.isFinite(devicePixelRatio) && Number.isFinite(scaleFactor) && scaleFactor > 0 ? devicePixelRatio / scaleFactor : 1;

export function LocalePicker() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);

  // P1: ajustar ambos ejes al nodo de contenido; se re-mide al montar, al cargar fuentes y en cada cambio de tamaño.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const fit = async () => {
      const rect = content.getBoundingClientRect();
      try {
        const win = getCurrentWindow();
        const scale = await win.scaleFactor();
        // Factor conservador: el zoom según la spec (devicePixelRatio / scaleFactor)
        // y el mapeo real del viewport (alto lógico de la ventana / alto CSS de la
        // página). Con escala de texto alta el zoom no debe dejar la ventana corta.
        const kZoom = logicalPerCssPx(window.devicePixelRatio, scale);
        const logical = (await win.innerSize()).toLogical(scale);
        const kViewport = logical.height / window.innerHeight;
        const k = Math.max(kZoom, Number.isFinite(kViewport) && kViewport > 0 ? kViewport : 0);
        const { width, height } = fitToContent(rect.width * k, rect.height * k);
        await win.setSize(new LogicalSize(width, height));
      } catch (e) {
        console.error('LocalePicker: no se pudo ajustar el tamaño de la ventana', e);
      }
    };
    void fit();
    const observer = new ResizeObserver(() => void fit());
    observer.observe(content);
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) void fit();
    });
    return () => {
      active = false;
      observer.disconnect();
    };
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
    <main ref={contentRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, width: 'max-content', margin: '0 auto', minHeight: MIN_HEIGHT, padding: 24 }}>
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
