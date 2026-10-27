import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ProviderCard } from './components/ProviderCard';
import { ProviderDetails } from './components/ProviderDetails';
import { api } from './lib/api';
import { intlLocale, t } from './i18n';
import { useLocale } from './i18n/use-locale';
import { reportSummary } from './lib/format';
import { clipSurfaceSafely, measureSurfaceClip } from './lib/surface-clip';
import { createLatestQueue, basePanelZoom, detailBounds, fitPanel, panelScaleFromTransform, physicalPanelBounds, sameFit, samePhysical, DETAIL_EVENTS, type DetailInteraction, type DetailState, type PanelFit, type PhysicalBounds } from './lib/detail-panel';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  }
}

export function DetailPanel() {
  const [data, setData] = useState<DetailState | null>(null);
  // Idioma de esta ventana: una lectura + `config-changed`; `es` hasta cargar.
  const locale = useLocale();
  const [positioned, setPositioned] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<DetailState | null>(null);
  const enqueue = useRef(createLatestQueue()).current;
  // Fitted geometry; `null` until the first measurement, when the basal zoom is used.
  const [fit, setFit] = useState<PanelFit | null>(null);
  // Last native geometry actually applied (physical, incl. DPI). Only recorded after a
  // successful apply so superseded or failed jobs cannot skip a needed retry.
  const lastAppliedRef = useRef<PhysicalBounds | null>(null);
  const positionedRef = useRef(false);

  const interact = (kind: DetailInteraction['kind']) => {
    const state = dataRef.current;
    if (!state) return;
    emitTo('widget', DETAIL_EVENTS.interaction, {
      revision: state.revision, provider: state.report.id, kind,
    } satisfies DetailInteraction).catch(console.warn);
  };

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const ready = () => emitTo('widget', DETAIL_EVENTS.ready).catch(console.warn);
    const register = async () => {
      const stateListener = await listen<DetailState | null>(DETAIL_EVENTS.state, ({ payload }) => {
        if (disposed) return;
        const wasClosed = dataRef.current === null;
        dataRef.current = payload;
        // Invalidate an in-flight show immediately, before React commits new content.
        enqueue(async () => { if (!payload) await getCurrentWindow().hide(); }).catch(console.warn);
        if (!payload || wasClosed) { setPositioned(false); positionedRef.current = false; lastAppliedRef.current = null; }
        setData(payload);
      });
      if (disposed) { stateListener(); return; }
      unlisteners.push(stateListener);
      const requestListener = await listen(DETAIL_EVENTS.requestReady, ready);
      if (disposed) { requestListener(); return; }
      unlisteners.push(requestListener);
      await ready();
    };
    register().catch(console.warn);
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      dataRef.current = null;
      enqueue(async () => { await getCurrentWindow().hide(); }).catch(console.warn);
    };
  }, [enqueue]);

  useLayoutEffect(() => {
    if (!data || !panelRef.current) return;
    let disposed = false;
    const base = basePanelZoom(data.orbSize);
    // Natural height in unscaled CSS pixels. `borderBoxSize` is a layout metric, so a
    // `transform: scale()` never feeds back into it; the rect fallback recovers the same
    // value from the exact transform, read from the committed inline style.
    const layoutHeightOf = (panel: HTMLDivElement, entry?: ResizeObserverEntry): number => {
      const box = entry?.borderBoxSize?.[0];
      if (box && Number.isFinite(box.blockSize) && box.blockSize > 0) return box.blockSize;
      return panel.getBoundingClientRect().height / panelScaleFromTransform(panel.style.transform);
    };
    const layout = (entry?: ResizeObserverEntry) => {
      const panel = panelRef.current;
      if (disposed || !panel) return;
      const next = fitPanel(data, layoutHeightOf(panel, entry), base);
      setFit((old) => (old && sameFit(old, next) ? old : next));
      // Compare native (physical) bounds, not logical ones: a DPI change with identical
      // logical geometry must still resize the window.
      const physical = physicalPanelBounds(detailBounds(data, next), data.scaleFactor);
      if (positionedRef.current && samePhysical(lastAppliedRef.current, physical)) return;
      enqueue(async (current) => {
        if (!current() || disposed) return;
        // An in-flight move can outlive its layout. Clear the old geometry before
        // awaiting it, so a return to that geometry cannot incorrectly dedupe.
        lastAppliedRef.current = null;
        // Move and resize together: moving a taller previous panel first briefly
        // covers the widget below it. Physical bounds already include DPI rounding.
        await api.setDetailBounds(physical);
        if (!current() || disposed) return;
        await clipSurfaceSafely(measureSurfaceClip(panel, physical, next.zoom * data.scaleFactor), api.setSurfaceClip, console.warn, panel);
        if (!current() || disposed) return;
        positionedRef.current = true;
        setPositioned(true);
        // The native command refuses to show an orphan panel when the widget is hidden.
        await api.showDetail();
        if (!current() || disposed) return;
        // Cache only after the whole native apply succeeded, so a stale or failed job
        // never marks a geometry as applied while the window still holds the old one.
        lastAppliedRef.current = physical;
      }).catch(console.warn);
    };
    layout();
    const observer = new ResizeObserver((entries) => layout(entries[0]));
    observer.observe(panelRef.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [data, enqueue]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!data) return null;
  const usageUrl = data.usageUrl;
  // El panel se diseña a la medida del DS (círculo de 56 px) y se escala entero con el tamaño de los círculos.
  const base = basePanelZoom(data.orbSize);
  const scale = fit?.zoom ?? base;
  const updated = data.updatedAt == null ? '—' : new Date(data.updatedAt).toLocaleTimeString(intlLocale(locale), { hour: '2-digit', minute: '2-digit' });
  return (
    <div
      className="dock detail-dock"
      data-edge={data.edge}
      style={{ '--panel-alpha': String(data.opacity), '--popup-primary': data.colors[0], '--ring-1': data.colors[0], '--ring-2': data.colors[1], '--ring-3': data.colors[2] } as CSSProperties}
      onMouseEnter={() => interact('enter')}
      onMouseLeave={() => interact('leave')}
    >
      <div
        ref={panelRef}
        className="panel q-panel eg-module-card eg-module-card--glass"
        role="dialog"
        aria-label={t(locale, 'details.panel.title', { name: data.report.name })}
        // No transitions/animations: a transitioned `transform` would make the measured
        // rect lag behind the fitted scale and corrupt the next measurement.
        style={{ left: 0, top: 0, width: data.width / base, transform: `scale(${scale})`, transformOrigin: 'top left', transition: 'none', animation: 'none', overflow: 'hidden', '--orb': data.orbSize, visibility: positioned ? 'visible' : 'hidden' } as CSSProperties}
      >
        <ProviderCard report={data.report} locale={locale} />
        <section className="panel__insights" aria-labelledby="panel-insights-title">
          <h2 id="panel-insights-title" className="panel__heading">{t(locale, 'details.panel.insightsHeading')}</h2>
          <ProviderDetails key={data.report.id} report={data.report} locale={locale} />
        </section>
        <div className="panel__actions">
          {usageUrl && <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => openUrl(usageUrl).catch(console.warn)}>{t(locale, 'details.panel.officialUsage')}</button>}
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={async () => setToast((await copyText(reportSummary(data.report, new Date(), locale))) ? t(locale, 'details.copy.copied') : t(locale, 'details.copy.failed'))}>{toast ?? t(locale, 'details.copy.summary')}</button>
        </div>
        <footer className="panel__foot"><span>{t(locale, 'details.panel.updated', { when: updated })}</span><span>{t(locale, 'details.panel.everyMinutes', { mins: data.refreshMinutes })}</span></footer>
        {data.error && <p className="panel__error">{data.error}</p>}
      </div>
    </div>
  );
}
