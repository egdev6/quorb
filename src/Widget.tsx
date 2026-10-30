import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { availableMonitors, currentMonitor, cursorPosition, getAllWindows, getCurrentWindow, primaryMonitor, type Monitor } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { emitTo, listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { api, type WidgetPatch } from './lib/api';
import { mergeReports, peakMeter, sessionsLost, trayTooltip } from './lib/format';
import { derivePalette } from './lib/palette';
import { detectAlerts, effectFor, nativeAlertsEnabled, notificationText, type AlertMemory } from './lib/alerts';
import { applyOrder, dropIndex, moveTo, officialUsageUrl } from './lib/order';
import { contains, isEdge, isVertical, nearestEdge, panelHeightLimit, stripRect, type Edge, type Rect } from './lib/dock';
import { ORB_SIZE, type AppConfig, type UsageReport } from './lib/types';
import { checkForUpdate, emitUpdateAvailable, installUpdate, shouldNotifyUpdate, startUpdatePolling, updateErrorText, type UpdatePhase } from './lib/updater';
import { useUpdaterMode } from './lib/useUpdater';
import { retryWithBackoff, STARTUP_RETRY, USAGE_RETRY } from './lib/startup';
import { createSessionMonitor } from './lib/session-monitor';
import { needsRefresh } from './lib/widget-refresh';
import { createWidgetRecovery, shouldAuditNativePosition } from './lib/widget-recovery';
import { placementOutcome, reasonKey, samePlacement, type WidgetPlacementReason, type WidgetPlacementReport } from './lib/widget-placement';
import { createLatestQueue, physicalPanelBounds, samePhysical, DETAIL_EVENTS, DETAIL_WINDOW, isCurrentDetailInteraction, panelWidthFor, type DetailInteraction, type DetailState, type PhysicalBounds } from './lib/detail-panel';
import { createDetailPresence, presenceFromPoint, shouldSampleNativePresence } from './lib/detail-presence';
import { openDelayForOs, osFromUA } from './lib/os-detect';
import { ProviderGauge } from './components/ProviderGauge';
import { accountTags } from './lib/accounts';
import { clipSurfaceSafely, measureSurfaceClip } from './lib/surface-clip';
import { peekRect, usesPeekWindow, waitForViewport, watchPreparation } from './lib/auto-hide';
import { useDockReveal } from './lib/useDockReveal';
import { currentDragMode, dragMode, fallbackDragMode, resetDragMode, setDragMode } from './lib/drag-session';
import { detectWindowManager } from './lib/wm-detect';
import { t } from './i18n';
import { localeFrom } from './i18n/use-locale';
import { StripFallback } from './components/StripFallback';

const CLOSE_DELAY = 280;
/**
 * Platform-scoped, not global: Linux needs the long delay because nothing else
 * contains an accidental sweep there, while Windows and macOS keep the original
 * 90 ms. The rationale and the per-platform values live in `openDelayForOs()`.
 */
const OPEN_DELAY = openDelayForOs(osFromUA(navigator.userAgent));
const HIDE_DELAY = 900;
/** Tras un aviso, la tira se muestra este tiempo aunque esté en auto-ocultar. */
const REVEAL_MS = 6000;

/** Zona útil del monitor (sin barra de tareas) en píxeles lógicos + escala + monitor completo en físicos. */
interface Geo {
  area: Rect;
  sf: number;
  monitor: string | null;
  screen: { x: number; y: number; width: number; height: number };
}

type WithWorkArea = Monitor & {
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
};

function geoOf(m: Monitor): Geo {
  // `workArea` excluye la barra de tareas; si la API no lo trae, usamos el monitor entero.
  const wa = (m as WithWorkArea).workArea ?? { position: m.position, size: m.size };
  const sf = m.scaleFactor || 1;
  return {
    area: { x: wa.position.x / sf, y: wa.position.y / sf, w: wa.size.width / sf, h: wa.size.height / sf },
    sf,
    monitor: m.name ?? null,
    screen: { x: m.position.x, y: m.position.y, width: m.size.width, height: m.size.height },
  };
}

async function resolveGeo(name: string | null): Promise<Geo | null> {
  const all = await availableMonitors().catch(() => [] as Monitor[]);
  const m =
    (name ? all.find((x) => x.name === name) : undefined) ??
    (await currentMonitor().catch(() => null)) ??
    (await primaryMonitor().catch(() => null)) ??
    all[0];
  return m ? geoOf(m) : null;
}

/** Campos que, si cambian, obligan a volver a pedir datos. */

// Pequeñas preferencias locales del widget (no críticas).
const local = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* sin almacenamiento */
    }
  },
};

/** Cada cuánto se mira si algún CLI ha renovado su sesión (lectura de fechas, barata). */
const SESSION_CHECK_MS = 15_000;

async function notify(title: string, body: string) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === 'granted';
    if (ok) sendNotification({ title, body });
  } catch {
    /* sin notificaciones */
  }
}

const Icon = {
  grip: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  update: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  ),
};

interface Size {
  w: number;
  h: number;
}

const sameSize = (a: Size | null, b: Size) => !!a && a.w === b.w && a.h === b.h;

export function Widget() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [reports, setReports] = useState<UsageReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // dock
  const locale = localeFrom(config);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [stripSize, setStripSize] = useState<Size | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [anchorRel, setAnchorRel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ strip: { x: 0, y: 0 } });

  // auto-ocultar
  const [inside, setInside] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [focused, setFocused] = useState(false);
  const { phase, markPrepared, finishTransition } = useDockReveal(collapsed);
  const [peekFocused, setPeekFocused] = useState(false);
  const [placementRetry, setPlacementRetry] = useState(0);
  const [placementFailed, setPlacementFailed] = useState(false);
  /** Motivo del backend cuando el gestor no concedió la geometría (#179). */
  const [placementReason, setPlacementReason] = useState<WidgetPlacementReason | null>(null);
  /** El motivo localizado: el código del backend se traduce con el catálogo (#179). */
  const placementReasonKey = reasonKey(placementReason);
  const placementReasonText = placementReasonKey ? t(locale, placementReasonKey) : null;
  const [revealUntil, setRevealUntil] = useState(0);

  // reordenar círculos
  const [reorder, setReorder] = useState<{ id: string; order: string[] } | null>(null);
  const [update, setUpdate] = useState<UpdatePhase>({ phase: 'idle' });
  const updaterMode = useUpdaterMode();

  const stripRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const widgetQueue = useRef(createLatestQueue()).current;
  const widgetBounds = useRef<PhysicalBounds | null>(null);
  /** True si la geometría cacheada vino del read-back del compositor (X11). */
  const widgetBoundsReadBack = useRef(false);
  const placementInFlight = useRef(false);
  const orbsRef = useRef<HTMLDivElement>(null);
  const detailStateRef = useRef<DetailState | null>(null);
  const detailReadyRef = useRef(false);
  const detailRevision = useRef(Date.now());
  const detailInsideRef = useRef(false);
  const insideRef = useRef(false);
  const configRef = useRef<AppConfig | null>(null);
  const reportsRef = useRef<UsageReport[]>([]);
  const geoRef = useRef<Geo | null>(null);
  const inFlight = useRef(false);
  const refreshAbort = useRef<AbortController | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  /**
   * Native cursor presence (#154): on macOS the DOM can stop delivering
   * `mouseleave` in transparent non-activating windows, pinning the popup.
   * While the popup is open we sample the global cursor position against the
   * native bounds of both windows — platform-independent close guarantee.
   */
  const presenceRef = useRef(
    createDetailPresence({
      isOpen: () => detailStateRef.current != null,
      scheduleClose: () => {
        // Direct close timer: never gated by the DOM-only `detailInsideRef`,
        // which is exactly what gets stuck on macOS.
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setHovered(null), CLOSE_DELAY);
      },
      cancelClose: () => window.clearTimeout(closeTimer.current),
    }),
  ).current;
  const shown = useRef(false);
  /** El usuario ocultó la tira desde la bandeja: la visibilidad es suya (#179). */
  const hiddenByUser = useRef(false);
  const drag = useRef<{ sx: number; sy: number; start: PhysicalPosition | null; sf: number; raf: number; pointerId: number; ending: boolean } | null>(null);
  const orbDrag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const lastReorderAt = useRef(0);
  const openPeakRef = useRef<() => void>(() => {});
  const dragWork = useRef<Promise<void>>(Promise.resolve());
  const dragMounted = useRef(true);

  const edge: Edge = config && isEdge(config.dockEdge) ? config.dockEdge : 'top';
  const offset = config?.dockOffset ?? 0.5;
  const vertical = isVertical(edge);
  const orbSize = Math.min(ORB_SIZE.max, Math.max(ORB_SIZE.min, config?.orbSize ?? ORB_SIZE.default));
  const panelWidth = panelWidthFor(orbSize);
  const [ring1, ring2, ring3] = derivePalette(config?.accentColor ?? '');
  geoRef.current = geo;

  // ───── avisos ─────
  const runAlerts = useCallback((prev: UsageReport[], next: UsageReport[]) => {
    const a = configRef.current?.alerts;
    if (!a?.enabled) return;
    const memory = local.get<AlertMemory>('alertMemory', {});
    const res = detectAlerts(prev, next, memory, a);
    local.set('alertMemory', res.memory);
    if (!res.events.length) return;

    setRevealUntil(Date.now() + REVEAL_MS);
    if (nativeAlertsEnabled(a)) {
      const n = notificationText(res.events);
      if (n) notify(n.title, n.body);
    }
    const fx = effectFor(res.events, a);
    if (fx && fx.effect !== 'none') {
      const { effect, moment } = fx;
      // En el primer ciclo puede que aún no sepamos el monitor: lo resolvemos aquí.
      const g = geoRef.current ? Promise.resolve(geoRef.current) : resolveGeo(configRef.current?.dockMonitor ?? null);
      g.then((geo) => geo && api.playEffect(effect, moment, geo.screen)).catch(() => {});
    }
  }, []);

  // ───── datos ─────
  const refresh = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const controller = new AbortController();
    refreshAbort.current = controller;
    setLoading(true);
    try {
      // Reintento acotado en cada refresco (arranque, manual o intervalo): un
      // fallo transitorio no obliga a esperar al siguiente ciclo. Si se agota,
      // el error se muestra (no se oculta el fallo).
      const next = await retryWithBackoff(() => api.fetchUsage(), { ...USAGE_RETRY, signal: controller.signal });
      if (controller.signal.aborted) return false;
      const prev = reportsRef.current;
      const merged = mergeReports(prev, next);
      reportsRef.current = merged;
      setReports(merged);
      api.setTrayTooltip(trayTooltip(merged)).catch(() => {});
      runAlerts(prev, merged);
      if (nativeAlertsEnabled(configRef.current?.alerts)) {
        const loc = localeFrom(configRef.current);
        for (const r of sessionsLost(prev, merged)) {
          notify(t(loc, 'widget.sessionExpiredTitle', { name: r.name }), t(loc, 'widget.sessionExpiredBody'));
        }
      }
      setUpdatedAt(new Date());
      setError(null);
      return true;
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e));
      return false;
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [runAlerts]);

  const applyConfig = useCallback((c: AppConfig) => {
    configRef.current = c;
    setConfig(c);
  }, []);

  const patchConfig = useCallback(
    async (patch: WidgetPatch) => {
      applyConfig(await api.patchConfig(patch));
    },
    [applyConfig],
  );

  // Recuperación manual tras agotar los reintentos: recarga la config si aún no
  // llegó y vuelve a pedir datos, sin que el usuario tenga que reiniciar.
  const retryStartup = useCallback(async () => {
    if (!configRef.current) {
      try {
        applyConfig(await api.getConfig());
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    await refresh();
  }, [applyConfig, refresh]);

  useEffect(() => {
    // La ventana puede montar antes de que el backend registre su estado: sin
    // reintento la config no llega y la tira queda vacía o en una posición
    // arbitraria hasta un refresco manual. Cancelable al desmontar.
    const controller = new AbortController();
    retryWithBackoff(() => api.getConfig(), { ...STARTUP_RETRY, signal: controller.signal })
      .then((c) => {
        if (!controller.signal.aborted) applyConfig(c);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    const unlisten = [
      listen('config-changed', async () => {
        const prev = configRef.current;
        const next = await api.getConfig();
        applyConfig(next);
        // Mover la tira o cambiar colores no debe disparar peticiones a los proveedores.
        if (needsRefresh(prev, next)) refresh();
      }),
      listen('refresh-now', () => refresh()),
      listen('open-peak', () => openPeakRef.current()),
      // La visibilidad de la tira es del usuario (#179): cuando la oculta
      // desde la bandeja no se vuelve a mostrar por nuestra cuenta, y cuando
      // la vuelve a mostrar hay que pedir la colocación de nuevo (la anterior
      // pudo quedarse sin leer mientras estaba oculta).
      listen('widget-hidden', () => {
        hiddenByUser.current = true;
      }),
      listen('widget-shown', () => {
        hiddenByUser.current = false;
        setPlacementRetry((n) => n + 1);
      }),
    ];
    return () => {
      controller.abort();
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, [refresh, applyConfig]);

  // Al desmontar, corta cualquier reintento de uso pendiente (sin setState tardío).
  useEffect(() => () => refreshAbort.current?.abort(), []);

  const refreshMinutes = config?.refreshMinutes;
  useEffect(() => {
    if (refreshMinutes == null) return;
    refresh();
    const id = window.setInterval(refresh, Math.max(1, refreshMinutes) * 60_000);
    return () => window.clearInterval(id);
  }, [refreshMinutes, refresh]);

  // Si Claude Code, Codex o Gemini renuevan su token (o se inicia sesión), sus
  // ficheros de credenciales cambian: se recarga al momento sin esperar al ciclo.
  useEffect(() => {
    const monitor = createSessionMonitor({
      stamp: () => api.sessionStamp(),
      refresh: () => refresh(),
    });
    const check = () => void monitor.check();
    check();
    const id = window.setInterval(check, SESSION_CHECK_MS);
    return () => {
      window.clearInterval(id);
      monitor.dispose();
    };
  }, [refresh]);

  // ───── monitor (y cambios de resolución / barra de tareas) ─────
  // Se resuelve aunque la config aún no haya llegado (monitor actual/principal),
  // para que la tira no quede vacía ni en una posición arbitraria si el primer
  // getConfig agota sus reintentos.
  const dockMonitor = config ? config.dockMonitor : null;
  useEffect(() => {
    let alive = true;
    const update = () =>
      resolveGeo(dockMonitor).then((g) => {
        if (!alive || !g) return;
        setGeo((old) => (old && JSON.stringify(old) === JSON.stringify(g) ? old : g));
      });
    update();
    const id = window.setInterval(update, 15_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [dockMonitor]);

  // ───── círculos visibles y en su orden ─────
  const order = reorder?.order ?? config?.providerOrder ?? [];
  const hiddenIds = config?.hiddenProviders ?? [];
  const visible = applyOrder(reports, order).filter((r) => !hiddenIds.includes(r.id));
  const tags = config ? accountTags(config) : {};
  const active = reports.find((r) => r.id === hovered) ?? null;

  // ───── auto-ocultar ─────
  // Actualizaciones: primera comprobación a los 20 s y luego cada 6 h. Los fallos son silenciosos.
  const autoUpdate = config?.autoUpdate ?? false;
  useEffect(() => {
    if (!autoUpdate) return;
    let stopped = false;
    const run = async () => {
      try {
        const info = await checkForUpdate();
        if (stopped) return;
        if (!info) {
          setUpdate((u) => (u.phase === 'installing' ? u : { phase: 'none', checkedAt: Date.now() }));
          return;
        }
        setUpdate((u) => (u.phase === 'installing' ? u : { phase: 'available', info }));
        // Ajustes puede estar abierto: comparte el hallazgo aunque el aviso nativo ya se haya visto.
        void emitUpdateAvailable(info);
        let store: Storage | null = null;
        try {
          store = localStorage;
        } catch {
          /* sin almacenamiento */
        }
        if (shouldNotifyUpdate(info.version, store)) {
          const loc = localeFrom(configRef.current);
          notify(t(loc, 'widget.updateAvailableTitle', { version: info.version }), t(loc, 'widget.updateAvailableBody'));
          setRevealUntil(Date.now() + REVEAL_MS);
        }
      } catch {
        /* sin red o sin releases: se reintenta en la siguiente vuelta */
      }
    };
    const stopPolling = startUpdatePolling(updaterMode, run);
    return () => {
      stopped = true;
      stopPolling();
    };
  }, [autoUpdate, updaterMode]);

  const startUpdate = async () => {
    if (updaterMode !== 'native' || update.phase !== 'available') return;
    const info = update.info;
    setUpdate({ phase: 'installing', info, progress: null });
    try {
      await installUpdate((progress) => setUpdate({ phase: 'installing', info, progress }));
    } catch (e) {
      setUpdate({ phase: 'available', info });
      notify(t(localeFrom(configRef.current), 'widget.updateFailedTitle'), updateErrorText(e));
    }
  };

  const autoHide = config?.autoHide ?? false;
  const showHandle = autoHide || phase !== 'open';
  useEffect(() => {
    if (!autoHide) {
      setCollapsed(false);
      return;
    }
    const busy = inside || focused || hovered != null || dragging || reorder != null;
    const wait = Math.max(HIDE_DELAY, revealUntil - Date.now());
    if (busy) {
      setCollapsed(false);
      return;
    }
    const t = window.setTimeout(() => setCollapsed(true), wait);
    return () => window.clearTimeout(t);
  }, [autoHide, inside, focused, hovered, dragging, reorder, revealUntil]);
  useEffect(() => {
    if (revealUntil > Date.now()) setCollapsed(false);
  }, [revealUntil]);

  // ───── tamaño real de la tira (el detalle se mide en su propia ventana) ─────
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      const s = stripRef.current?.getBoundingClientRect();
      if (s) {
        const n = { w: Math.ceil(s.width), h: Math.ceil(s.height) };
        setStripSize((o) => (sameSize(o, n) ? o : n));
      }
    });
    if (stripRef.current) ro.observe(stripRef.current);
    return () => ro.disconnect();
  }, []);

  // Expand before entering; shrink only after the exit transition. Hovering between
  // providers never changes this window, and each native rectangle is applied atomically.
  useEffect(() => {
    if (dragging) {
      // El arrastre manda: cancela la estabilización pendiente (#179).
      try {
        api.cancelWidgetPlacement().catch(() => {});
      } catch {
        /* un backend sin este comando no impide arrastrar */
      }
      widgetBounds.current = null;
      return;
    }
    if (!geo || !stripSize) return;
    let disposed = false;
    const s = stripRect(geo.area, edge, offset, stripSize.w, stripSize.h);
    const win = usesPeekWindow(phase) ? peekRect(s, edge) : s;
    // La petición lleva el borde anclado y el factor con el que se calculó el
    // rectángulo: con otro tamaño efectivo, el borde se conserva y la
    // conversión no depende del factor de la ventana (DPI mixto) (#179).
    const physical = { ...physicalPanelBounds(win, geo.sf), anchor: edge, scale: geo.sf };
    setPos({ strip: { x: s.x - win.x, y: s.y - win.y } });
    placementInFlight.current = true;
    widgetQueue(async (current) => {
      if (disposed || !current()) return;
      let limited = false;
      let reason: WidgetPlacementReason | null = null;
      // La comparación con la geometría cacheada usa la tolerancia del
      // backend **sólo** si esa geometría vino del read-back de X11: en el
      // resto de plataformas un cambio de 1 px sí es un cambio (#179).
      const same = samePlacement(widgetBounds.current, physical, widgetBoundsReadBack.current);
      // El backend es la autoridad: responde con la geometría que quedó en
      // pantalla, no con la solicitud encolada (#179).
      const apply = (report: WidgetPlacementReport) => {
        const outcome = placementOutcome(report, physical);
        // Sólo se cachea geometría fiable: una colocación cancelada (quedó a
        // medias) o una lectura fallida dejan la caché vacía.
        if (outcome.bounds) {
          widgetBounds.current = outcome.bounds;
          widgetBoundsReadBack.current = outcome.readBack;
        }
        limited = outcome.failed;
        reason = outcome.reason;
      };
      if (!same) {
        widgetBounds.current = null; // Never reuse a cache invalidated by a stale in-flight move.
        widgetBoundsReadBack.current = false;
        const report = await api.setWidgetBounds(physical);
        if (disposed || !current()) return;
        apply(report);
      }
      const surface = usesPeekWindow(phase) ? peekRef.current : stripRef.current;
      if (!surface) throw new Error('Widget surface is not mounted');
      const clip = measureSurfaceClip(surface, physical, geo.sf);
      // Auto-hide uses CSS blur throughout, so its moving shape has no static native
      // blur rectangle and no blur-radius change at the start/end of the animation.
      await clipSurfaceSafely(clip, (c) => api.setSurfaceClip(c, !autoHide && phase === 'open'), console.warn, surface);
      if (disposed || !current()) return;
      if (!shown.current && !hiddenByUser.current) {
        // La visibilidad es del frontend: el backend nunca muestra la ventana.
        await getCurrentWindow().show();
        if (disposed || !current()) return;
        shown.current = true;
      }
      // El backend no puede leer una ventana que todavía no es visible: se
      // vuelve a pedir la colocación para confirmar la geometría (#179).
      if (!same && reason === 'not_viewable' && !hiddenByUser.current) {
        const report = await api.setWidgetBounds(physical);
        if (disposed || !current()) return;
        apply(report);
      }
      if (phase === 'preparing' || phase === 'settling') await waitForViewport();
      if (disposed || !current()) return;
      setPlacementFailed(false);
      // El gestor no concedió la geometría: se informa (con su motivo) y la
      // tira ofrece reintento.
      if (limited) setPlacementFailed(true);
      setPlacementReason(limited ? reason : null);
      if (phase === 'preparing' || phase === 'settling') markPrepared(phase);
    }).catch((error) => {
      if (disposed) return;
      widgetBounds.current = null;
      setPlacementFailed(true); // The still-visible handle offers an explicit user retry.
      console.warn(error);
    }).finally(() => { if (!disposed) placementInFlight.current = false; });
    return () => { disposed = true; };
  }, [geo, stripSize, edge, offset, dragging, phase, autoHide, placementRetry, widgetQueue, markPrepared]);

  // Windows can displace or resize a normal window without changing the
  // monitor geometry or our cached target. Audit reality without moving healthy
  // windows or undoing a user hide/minimize/drag. The existing queue owns all moves.
  useEffect(() => {
    let disposed = false;
    const win = getCurrentWindow();
    // Windows DWM recovery (#147/#148): on Wayland/Linux, outerPosition() returns (0,0)
    // and GTK window sizing differs, causing infinite false-positive recovery loops.
    if (!shouldAuditNativePosition(osFromUA(navigator.userAgent))) return;
    const allowed = () => !disposed && !drag.current && !placementInFlight.current
      && (phase === 'open' || phase === 'hidden') && shown.current && widgetBounds.current !== null;
    const check = createWidgetRecovery({
      allowed,
      expected: () => widgetBounds.current,
      read: async () => {
        const expected = widgetBounds.current;
        const [position, size, monitors, visible, minimized] = await Promise.all([
          win.outerPosition(), win.outerSize(), availableMonitors(), win.isVisible(), win.isMinimized(),
        ]);
        return {
          bounds: { x: position.x, y: position.y, w: size.width, h: size.height },
          monitors: monitors.map((m) => ({ x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height })),
          visible, minimized, expected,
        };
      },
      recover: async (snapshot) => {
        // Refresh the dock target too: its saved monitor may have disconnected.
        const [fresh, visible, minimized] = await Promise.all([
          resolveGeo(dockMonitor), win.isVisible(), win.isMinimized(),
        ]);
        if (!allowed() || !fresh || !visible || minimized || !snapshot.expected
          || !samePhysical(widgetBounds.current, snapshot.expected)) return;
        widgetBounds.current = null;
        setGeo(fresh);
        setPlacementRetry((n) => n + 1);
      },
    });
    void check();
    const id = window.setInterval(() => { void check(); }, 5_000);
    return () => { disposed = true; window.clearInterval(id); };
  }, [dockMonitor, phase]);

  useEffect(() => watchPreparation(phase, () => setPlacementFailed(true)), [phase, placementRetry]);

  useLayoutEffect(() => {
    if (phase === 'open' && document.activeElement === peekRef.current) {
      stripRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [phase]);

  // Dragging rounds all corners without changing the native window dimensions.
  useEffect(() => {
    if (!dragging || !geo || !stripRef.current) return;
    let disposed = false;
    // Placement and dragging mutate the same native surface. Share their lane,
    // including the size read, rather than racing an outstanding docked clip.
    widgetQueue(async (current) => {
      if (disposed || !current()) return;
      const size = await getCurrentWindow().innerSize();
      if (disposed || !current() || !stripRef.current) return;
      await clipSurfaceSafely(
        measureSurfaceClip(stripRef.current, { w: size.width, h: size.height }, geo.sf),
        (clip) => api.setSurfaceClip(clip, !autoHide), console.warn, stripRef.current,
      );
    }).catch(console.warn);
    return () => { disposed = true; };
  }, [dragging, geo, autoHide, widgetQueue]);

  // Safety net for the compositor drag (issue #180, maintainer review point
  // 3): under the compositor's move grab the client may never receive the
  // closing pointerup, which would leave `dragging` stuck true (detail panel
  // blocked, auto-hide busy, placement not re-requested). A later buttonless
  // pointermove is the reliable release signal the webview still sees after
  // the grab ends. Compositor-only: the native branch owns its release
  // pipeline in onGripUp and must not be bypassed.
  useEffect(() => {
    if (!dragging || currentDragMode() !== 'compositor') return;
    const release = (e: { buttons: number }) => {
      if (e.buttons === 0) setDragging(false);
    };
    window.addEventListener('pointermove', release);
    return () => window.removeEventListener('pointermove', release);
  }, [dragging]);

  // The detail window owns its dimensions; hovering never mutates widget geometry.
  useEffect(() => {
    const strip = geo && stripSize ? stripRect(geo.area, edge, offset, stripSize.w, stripSize.h) : null;
    const state: DetailState | null = active && geo && strip && !dragging && !collapsed && phase === 'open' ? {
      // Keep the interaction session valid during background usage/config updates.
      revision: detailStateRef.current?.report.id === active.id
        ? detailStateRef.current.revision
        : ++detailRevision.current,
      report: active,
      area: geo.area,
      strip,
      edge,
      anchor: (vertical ? strip.y : strip.x) + anchorRel,
      width: panelWidth,
      maxHeight: panelHeightLimit(geo.area, edge, strip),
      scaleFactor: geo.sf,
      orbSize,
      opacity: config?.opacity ?? 0.94,
      colors: [ring1, ring2, ring3],
        updatedAt: updatedAt?.getTime() ?? null,
        refreshMinutes: config?.refreshMinutes ?? 5,
        error,
        // La URL de uso se resuelve aquí, que sí hay config: 9Router apunta a su
        // Base URL configurada (no a localhost fijo). Al detalle solo cruza la URL.
        usageUrl: officialUsageUrl(active.id, config?.nineRouter.baseUrl),
      } : null;
    detailStateRef.current = state;
    if (!state) detailInsideRef.current = false;
    if (detailReadyRef.current) emitTo(DETAIL_WINDOW, DETAIL_EVENTS.state, state).catch(console.warn);
  }, [active, geo, stripSize, edge, offset, vertical, anchorRel, dragging, collapsed, phase, panelWidth, orbSize, config?.opacity, config?.refreshMinutes, config?.nineRouter.baseUrl, ring1, ring2, ring3, updatedAt, error]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const add = async (promise: Promise<() => void>) => {
      const unlisten = await promise;
      if (disposed) unlisten(); else unlisteners.push(unlisten);
    };
    const register = async () => {
      await add(listen(DETAIL_EVENTS.ready, () => {
        if (disposed) return;
        detailReadyRef.current = true;
        emitTo(DETAIL_WINDOW, DETAIL_EVENTS.state, detailStateRef.current).catch(console.warn);
      }));
      await add(listen<DetailInteraction>(DETAIL_EVENTS.interaction, ({ payload }) => {
        if (disposed) return;
        const state = detailStateRef.current;
        if (!isCurrentDetailInteraction(state, payload)) return;
        if (payload.kind === 'enter') {
          detailInsideRef.current = true;
          window.clearTimeout(closeTimer.current);
        } else if (payload.kind === 'leave') {
          detailInsideRef.current = false;
          if (!insideRef.current) scheduleClose();
        } else if (payload.kind === 'hide') {
          cancelTimers();
          setHovered(null);
          const hidden = configRef.current?.hiddenProviders ?? [];
          patchConfig({ hiddenProviders: [...new Set([...hidden, payload.provider])] }).catch((err) => setError(String(err)));
        }
      }));
      await add(listen(DETAIL_EVENTS.widgetHidden, () => {
        cancelTimers();
        detailInsideRef.current = false;
        insideRef.current = false;
        setInside(false);
        setHovered(null);
      }));
      await add(listen(DETAIL_EVENTS.dismiss, () => {
        cancelTimers();
        detailInsideRef.current = false;
        setHovered(null);
      }));
      if (!disposed) await emitTo(DETAIL_WINDOW, DETAIL_EVENTS.requestReady);
    };
    register().catch(console.warn);
    return () => {
      disposed = true;
      detailReadyRef.current = false;
      unlisteners.forEach((unlisten) => unlisten());
      emitTo(DETAIL_WINDOW, DETAIL_EVENTS.state, null).catch(console.warn);
    };
  }, [patchConfig]);

  // ───── panel al pasar el ratón ─────
  const cancelTimers = () => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
  };

  const openFor = (id: string, el: HTMLElement) => {
    if (phase !== 'open' || drag.current || orbDrag.current?.moved || Date.now() - lastReorderAt.current < 400) return;
    cancelTimers();
    const strip = stripRef.current?.getBoundingClientRect();
    const orb = el.getBoundingClientRect();
    const rel = strip ? (vertical ? orb.top + orb.height / 2 - strip.top : orb.left + orb.width / 2 - strip.left) : 0;
    const go = () => {
      detailInsideRef.current = false;
      setAnchorRel(rel);
      setHovered(id);
    };
    if (hovered) go();
    else openTimer.current = window.setTimeout(go, OPEN_DELAY);
  };

  // Atajo «abrir el más cargado»: muestra la tira y abre el panel del círculo con el % más alto.
  openPeakRef.current = () => {
    const top = [...visible].sort((a, b) => (peakMeter(b)?.percent ?? -1) - (peakMeter(a)?.percent ?? -1))[0];
    if (!top) return;
    setRevealUntil(Date.now() + 8000);
    setCollapsed(false);
    window.setTimeout(() => {
      const el = orbsRef.current?.querySelector<HTMLElement>(`.orb[data-id="${top.id}"]`);
      const strip = stripRef.current?.getBoundingClientRect();
      if (!el || !strip) return;
      const orb = el.getBoundingClientRect();
      cancelTimers();
      setAnchorRel(vertical ? orb.top + orb.height / 2 - strip.top : orb.left + orb.width / 2 - strip.left);
      setHovered(top.id);
      // Si no pasas el ratón por encima, se cierra solo.
      closeTimer.current = window.setTimeout(() => setHovered(null), 8000);
    }, 80);
  };

  const scheduleClose = () => {
    cancelTimers();
    if (detailInsideRef.current) return;
    closeTimer.current = window.setTimeout(() => setHovered(null), CLOSE_DELAY);
  };

  // Muestreo nativo de presencia (#154): mientras el popup esté abierto, la
  // posición global del cursor frente a los bounds nativos de ambas ventanas
  // alimenta el tracker. Falla en silencio (Wayland puede no exponer la
  // posición): el muestreo degrada, nunca adivina.
  useEffect(() => {
    // Solo aplica en macOS (donde WebKit pierde eventos mouseleave en ventanas transparentes).
    // En Linux/Wayland, cursorPosition() devuelve (0,0) y causa falsos cierres del popup.
    if (!shouldSampleNativePresence(osFromUA(navigator.userAgent))) return;
    if (!hovered) {
      presenceRef.reset();
      return;
    }
    let disposed = false;
    const boundsOf = async (label: string): Promise<PhysicalBounds | null> => {
      try {
        const win = (await getAllWindows()).find((w) => w.label === label);
        if (!win) return null;
        const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
        return { x: pos.x, y: pos.y, w: size.width, h: size.height };
      } catch {
        return null;
      }
    };
    const sample = async () => {
      try {
        const point = await cursorPosition();
        const [widget, detail] = await Promise.all([boundsOf('widget'), boundsOf(DETAIL_WINDOW)]);
        if (disposed || !widget || !detail) return;
        const { widget: inWidget, detail: inDetail } = presenceFromPoint(point, widget, detail);
        // Sincroniza el flag DOM-only por si su `mouseleave` nunca llegó.
        detailInsideRef.current = inDetail;
        presenceRef.sample(inWidget, inDetail);
      } catch {
        // Sin posición de cursor (p. ej. Wayland): no hay conclusión.
      }
    };
    const interval = window.setInterval(() => { void sample(); }, 400);
    void sample();
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [hovered, presenceRef]);
  // #180: drag strategy decision, fetched ONCE at mount (single fast
  // `get_wm_info` command). Two deterministic defaults, both recorded here:
  // - While the decision is unresolved (`currentDragMode() === null`) the
  //   grip does nothing: starting the old delta pipeline on a Wayland
  //   session is precisely the corruption this issue fixes, so the drag is
  //   BLOCKED instead of guessed. Detection is a fast startup command, so
  //   blocking until it resolves is deterministic and imperceptible.
  // - If detection fails, the fallback is Linux-only (#210 review minor):
  //   Linux degrades to 'compositor' because the gesture cannot touch
  //   config.json, while Windows/macOS keep 'native' so a one-off probe
  //   failure never removes their magnet (see fallbackDragMode in
  //   src/lib/drag-session.ts).
  // - On unmount the store is cleared so a re-mounted widget re-detects
  //   instead of inheriting a stale decision.
  useEffect(() => {
    let disposed = false;
    detectWindowManager()
      .then((info) => {
        if (disposed) return;
        // `displayBackend` ships in the get_wm_info response (wm_compat.rs,
        // WU4 serde camelCase) and the TS mirror declares it typed now (WU5).
        // Detection failure still falls back to 'compositor' (catch below).
        setDragMode(dragMode(info.displayBackend).mode);
      })
      .catch(() => {
        if (!disposed) setDragMode(fallbackDragMode(osFromUA(navigator.userAgent)));
      });
    return () => {
      disposed = true;
      resetDragMode();
    };
  }, []);

  useEffect(() => {
    dragMounted.current = true;
    return () => {
      cancelTimers();
      dragMounted.current = false;
      if (drag.current) cancelAnimationFrame(drag.current.raf);
      drag.current = null;
    };
  }, []);

  // Red de seguridad: si algo falla al medir/colocar, mostramos igualmente la ventana.
  useEffect(() => {
    const t = window.setTimeout(() => {
      // La visibilidad es del usuario (#179): una tira oculta desde la bandeja
      // no se vuelve a mostrar por nuestra cuenta, ni siquiera por la red de
      // seguridad.
      if (!shown.current && !hiddenByUser.current) {
        shown.current = true;
        getCurrentWindow().show().catch(() => {});
      }
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  // ───── arrastrar la tira y soltar con imán al borde más cercano ─────
  const enqueueDrag = (job: () => Promise<void>) => {
    const result = dragWork.current.then(job);
    dragWork.current = result.catch(() => {});
    return result;
  };

  const onGripDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || !geo || !dragMounted.current) return;
    // #180: until the startup decision is known the grip does nothing (see
    // the decision effect above for both defaults).
    const mode = currentDragMode();
    if (mode == null) return;
    e.preventDefault();
    if (mode === 'compositor') {
      // Compositor branch: the drag is delegated to the compositor via the
      // xdg-shell move gesture. startDragging() consumes the pointerdown
      // serial itself, so we set up no pointer capture and no `drag.current`
      // delta state: under xdg-shell the client has no absolute position to
      // delta from (see onGripUp for the release-side counterpart).
      setDragging(true);
      cancelTimers();
      setHovered(null);
      getCurrentWindow().startDragging().catch((err) => {
        setError(String(err));
        setDragging(false);
      });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (drag.current) cancelAnimationFrame(drag.current.raf);
    cancelTimers();
    setHovered(null);
    setDragging(true);
    // `widgetBounds.current` es la verdad incluso cuando el compositor no
    // reporta posición: el caché lo escribe el propio `setWidgetBounds` que
    // colocó la ventana, no una lectura de `outerPosition()`. Por eso sirve
    // como origen síncrono del arrastre en xdg-shell, donde `outerPosition()`
    // devuelve (0, 0) por diseño y no puede arrancar la aritmética por delta.
    const initialStart = widgetBounds.current
      ? new PhysicalPosition(widgetBounds.current.x, widgetBounds.current.y)
      : null;
    const d = { sx: e.screenX, sy: e.screenY, start: initialStart, sf: geo.sf, raf: 0, pointerId: e.pointerId, ending: false };
    drag.current = d;
    const current = () => dragMounted.current && drag.current === d;
    enqueueDrag(async () => {
      if (!current()) return;
      const position = await getCurrentWindow().outerPosition();
      // Un (0, 0) real es una esquina legítima; solo se descarta cuando ya
      // tenemos un origen creíble del caché.
      if (current() && (position.x !== 0 || position.y !== 0 || !d.start)) {
        d.start = position;
      }
    }).catch((err) => {
      if (!current()) return;
      setError(String(err));
      drag.current = null;
      setDragging(false);
    });
  };

  const onGripMove = (e: PointerEvent<HTMLSpanElement>) => {
    // #180: in compositor mode the compositor moves the window during the
    // gesture, so this is a no-op — early return before any arithmetic or
    // rAF work. The native branch below keeps today's pipeline untouched.
    if (currentDragMode() === 'compositor') return;
    const d = drag.current;
    if (!d?.start || d.ending || e.pointerId !== d.pointerId) return;
    const current = () => dragMounted.current && drag.current === d;
    const x = Math.round(d.start.x + (e.screenX - d.sx) * d.sf);
    const y = Math.round(d.start.y + (e.screenY - d.sy) * d.sf);
    cancelAnimationFrame(d.raf);
    d.raf = requestAnimationFrame(() => {
      enqueueDrag(async () => {
        if (!current()) return;
        await getCurrentWindow().setPosition(new PhysicalPosition(x, y));
      }).catch((err) => { if (current()) setError(String(err)); });
    });
  };

  const onGripUp = async (e: PointerEvent<HTMLSpanElement>) => {
    // #180: in compositor mode the compositor owns the grab and the final
    // position, so this is minimal cleanup only — mirror of the `finally`
    // below, minus the native snap/persist work: no outerPosition(), no
    // nearestEdge(), no patchConfig(), no resolveGeo(). In this mode we set
    // up no pointer capture, no rAF and no `drag.current`, so there is
    // genuinely nothing else to release; a persisted edge computed from
    // untrustworthy coordinates would corrupt the config.json that X11
    // sessions also read.
    if (currentDragMode() === 'compositor') {
      setDragging(false);
      return;
    }
    const d = drag.current;
    if (!d || d.ending || e.pointerId !== d.pointerId) return;
    d.ending = true;
    const current = () => dragMounted.current && drag.current === d;
    const grip = (e.target as HTMLElement).closest('.strip__grip')?.getBoundingClientRect();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ya liberado */
    }
    cancelAnimationFrame(d.raf);
    try {
      // Core setters acknowledge enqueue; later getters follow those tasks in UI FIFO.
      await enqueueDrag(async () => {
        if (!current()) return;
        const [wpos, mons] = await Promise.all([getCurrentWindow().outerPosition(), availableMonitors()]);
        if (!current()) return;
        // `wpos` manda cuando el compositor informa algo: es la posición real.
        // Si informa (0,0) con un origen en caché, se toma la rama por delta
        // (caso de la esquina superior izquierda, reportado en #168). Como
        // `start` sale del mismo caché que escribió `setWidgetBounds`, la
        // desviación solo puede ser redondeo del compositor; si algún día se
        // reporta el orbe imantado en esa esquina, revisar primero el redondeo.
        const posX = (wpos.x !== 0 || wpos.y !== 0)
          ? wpos.x
          : (d.start?.x ?? 0) + (e.screenX - d.sx) * d.sf;
        const posY = (wpos.x !== 0 || wpos.y !== 0)
          ? wpos.y
          : (d.start?.y ?? 0) + (e.screenY - d.sy) * d.sf;
        const cx = posX + (grip ? grip.left + grip.width / 2 : 0) * d.sf;
        const cy = posY + (grip ? grip.top + grip.height / 2 : 0) * d.sf;
        const mon =
          mons.find((m) => contains({ x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height }, cx, cy)) ??
          (await currentMonitor());
        if (!current() || !mon) return;
        const g = geoOf(mon);
        const snap = nearestEdge(g.area, cx / g.sf, cy / g.sf);
        const saved = await api.patchConfig({ dockEdge: snap.edge, dockOffset: snap.offset, dockMonitor: g.monitor });
        if (!current()) return;
        setGeo(g);
        applyConfig(saved);
      });
    } catch (err) {
      if (current()) setError(String(err));
    } finally {
      if (current()) {
        drag.current = null;
        setDragging(false);
      }
    }
  };

  // ───── reordenar círculos arrastrándolos ─────
  const orbHandlers = (id: string) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      orbDrag.current = { id, x: e.clientX, y: e.clientY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const od = orbDrag.current;
      if (!od || od.id !== id) return;
      if (!od.moved && Math.hypot(e.clientX - od.x, e.clientY - od.y) < 6) return;
      if (!od.moved) {
        od.moved = true;
        cancelTimers();
        setHovered(null);
      }
      const ids = visible.map((r) => r.id);
      const others = [...(orbsRef.current?.querySelectorAll<HTMLElement>('.orb') ?? [])].filter((el) => el.dataset.id !== id);
      const centers = others.map((el) => {
        const b = el.getBoundingClientRect();
        return vertical ? b.top + b.height / 2 : b.left + b.width / 2;
      });
      const idx = dropIndex(centers, vertical ? e.clientY : e.clientX);
      const full = applyOrder(reports, config?.providerOrder ?? []).map((r) => r.id);
      // Reordenamos sobre la lista visible y conservamos los ocultos al final.
      const nextVisible = moveTo(ids, id, idx);
      setReorder({ id, order: [...nextVisible, ...full.filter((x) => !nextVisible.includes(x))] });
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      const od = orbDrag.current;
      orbDrag.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ya liberado */
      }
      if (od?.moved) lastReorderAt.current = Date.now();
      if (od?.moved && reorder) {
        const next = reorder.order;
        setReorder(null);
        patchConfig({ providerOrder: next }).catch((err) => setError(String(err)));
      }
    },
  });

  const small = config?.compact ?? false;
  const opacity = config?.opacity ?? 0.94;

  return (
    <div
      className="dock"
      role="toolbar"
      aria-label="Quorb"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      data-edge={edge}
      data-dragging={dragging || undefined}
      data-collapsed={phase === 'hidden' || undefined}
      data-auto-hide={showHandle || undefined}
      data-reveal={phase}
      data-placement-failed={placementFailed || undefined}
      data-placement-reason={placementReason ?? undefined}
      onFocusCapture={() => { setFocused(true); setCollapsed(false); }}
      onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
      style={{ '--panel-alpha': String(opacity), '--ring-1': ring1, '--ring-2': ring2, '--ring-3': ring3 } as CSSProperties}
      onMouseEnter={() => {
        insideRef.current = true;
        window.clearTimeout(closeTimer.current);
        setInside(true);
      }}
      onMouseLeave={() => {
        insideRef.current = false;
        setInside(false);
        scheduleClose();
      }}
    >
      {showHandle && <button
        ref={peekRef}
        type="button"
        className="peek"
        aria-label={placementFailed ? `${t(locale, 'widget.retryShow')}${placementReasonText ? `: ${placementReasonText}` : ''}` : t(locale, 'widget.show')}
        title={placementFailed ? placementReasonText ?? undefined : undefined}
        aria-controls="quorb-strip"
        aria-hidden={phase === 'open' && !peekFocused || undefined}
        tabIndex={phase === 'hidden' || placementFailed && (usesPeekWindow(phase) || phase === 'preparing') ? 0 : -1}
        onTransitionEnd={(e) => {
          if (phase === 'leaving-handle' && e.target === e.currentTarget && e.propertyName === 'opacity') finishTransition();
        }}
        onFocus={() => setPeekFocused(true)}
        onBlur={() => setPeekFocused(false)}
        onClick={() => { setCollapsed(false); setPlacementRetry((n) => n + 1); }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>
      </button>}

      <div
        ref={stripRef}
        id="quorb-strip"
        className="strip"
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && e.propertyName === 'transform'
            && !e.currentTarget.getAnimations().some((a) => a.playState === 'running')) finishTransition();
        }}
        data-small={small || undefined}
        data-vertical={vertical || undefined}
        aria-hidden={phase !== 'open' || undefined}
        inert={phase !== 'open'}
        style={{ left: pos.strip.x, top: pos.strip.y, '--orb': orbSize } as CSSProperties}
      >
        <span
          className="strip__grip"
          title={t(locale, 'widget.dragHint')}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          {Icon.grip}
        </span>

        <div ref={orbsRef} className="strip__orbs" data-reordering={reorder ? true : undefined}>
          {visible.map((r) => (
            <ProviderGauge
              key={r.id}
              report={r}
              small={small}
              size={orbSize}
              active={hovered === r.id}
              account={tags[r.id]}
              locale={locale}
              showResets={config?.showResets ?? true}
              threshold={config?.alerts.threshold}
              dragging={reorder?.id === r.id}
              onHover={(el) => openFor(r.id, el)}
              pointer={orbHandlers(r.id)}
            />
          ))}
          {visible.length === 0 && (
            <StripFallback error={error} busy={loading} ready={config != null} locale={locale} onRetry={retryStartup} onConfigure={() => api.openSettings()} />
          )}
        </div>

        <div className="strip__tools">
          {updaterMode === 'native' && (update.phase === 'available' || update.phase === 'installing') && (
            <button
              className="icon-btn icon-btn--update"
              data-spin={update.phase === 'installing' || undefined}
              onClick={startUpdate}
              disabled={update.phase === 'installing'}
              title={
                update.phase === 'installing'
                  ? t(locale, 'widget.updatingTo', { version: update.info.version, detail: update.progress != null ? ` · ${update.progress} %` : '…' })
                  : t(locale, 'widget.updateTo', { version: update.info.version })
              }
            >
              {Icon.update}
            </button>
          )}
          <button className="icon-btn" data-spin={loading || undefined} onClick={refresh} title={t(locale, 'widget.refreshNow')}>
            {Icon.refresh}
          </button>
          <button className="icon-btn" onClick={() => api.openSettings()} title={t(locale, 'widget.settings')}>
            {Icon.gear}
          </button>
        </div>
      </div>

    </div>
  );
}
