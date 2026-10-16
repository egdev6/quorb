import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { availableMonitors, currentMonitor, getCurrentWindow, primaryMonitor, type Monitor } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
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
import { DETAIL_EVENTS, DETAIL_WINDOW, isCurrentDetailInteraction, type DetailInteraction, type DetailState } from './lib/detail-panel';
import { ProviderGauge } from './components/ProviderGauge';
import { accountTags } from './lib/accounts';

const CLOSE_DELAY = 280;
const OPEN_DELAY = 90;
/** Al ocultarse automáticamente queda esta franja (px lógicos) pegada al borde. */
const PEEK = 5;
const HIDE_DELAY = 900;
/** Tras un aviso, la tira se muestra este tiempo aunque esté en auto-ocultar. */
const REVEAL_MS = 6000;
/** Ancho del panel para un círculo de 60 px; escala en proporción al tamaño elegido. */
const PANEL_BASE_W = 330;
const panelWidthFor = (orb: number) => Math.round(Math.min(460, Math.max(220, (PANEL_BASE_W * orb) / 60)));

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
  const [geo, setGeo] = useState<Geo | null>(null);
  const [stripSize, setStripSize] = useState<Size | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [anchorRel, setAnchorRel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ strip: { x: 0, y: 0 } });

  // auto-ocultar
  const [inside, setInside] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [revealUntil, setRevealUntil] = useState(0);

  // reordenar círculos
  const [reorder, setReorder] = useState<{ id: string; order: string[] } | null>(null);
  const [update, setUpdate] = useState<UpdatePhase>({ phase: 'idle' });
  const updaterMode = useUpdaterMode();

  const stripRef = useRef<HTMLDivElement>(null);
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
  const shown = useRef(false);
  const drag = useRef<{ sx: number; sy: number; start: PhysicalPosition | null; sf: number; raf: number } | null>(null);
  const orbDrag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const lastReorderAt = useRef(0);
  const openPeakRef = useRef<() => void>(() => {});

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
        for (const r of sessionsLost(prev, merged)) {
          notify(`${r.name}: sesión caducada`, 'Pulsa «Renovar sesión» en su panel. Quorb se actualiza solo en cuanto se renueve.');
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
          notify(`Quorb ${info.version} disponible`, 'Pulsa el icono de descarga de la tira para actualizar.');
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
      notify('No se pudo actualizar Quorb', updateErrorText(e));
    }
  };

  const autoHide = config?.autoHide ?? false;
  useEffect(() => {
    if (!autoHide) {
      setCollapsed(false);
      return;
    }
    const busy = inside || hovered != null || dragging || reorder != null;
    const wait = Math.max(HIDE_DELAY, revealUntil - Date.now());
    if (busy) {
      setCollapsed(false);
      return;
    }
    const t = window.setTimeout(() => setCollapsed(true), wait);
    return () => window.clearTimeout(t);
  }, [autoHide, inside, hovered, dragging, reorder, revealUntil]);
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

  // ───── colocar sólo la tira: esta geometría no depende del hover ─────
  useEffect(() => {
    if (!geo || !stripSize || dragging) return;
    const s = stripRect(geo.area, edge, offset, stripSize.w, stripSize.h);
    let win: Rect;

    if (collapsed) {
      // Solo una franja fina en el borde; la tira queda fuera de la ventana.
      const a = geo.area;
      win =
        edge === 'top'
          ? { x: s.x, y: a.y, w: s.w, h: PEEK }
          : edge === 'bottom'
            ? { x: s.x, y: a.y + a.h - PEEK, w: s.w, h: PEEK }
            : edge === 'left'
              ? { x: a.x, y: s.y, w: PEEK, h: s.h }
              : { x: a.x + a.w - PEEK, y: s.y, w: PEEK, h: s.h };
    } else {
      win = s;
    }
    setPos({ strip: { x: s.x - win.x, y: s.y - win.y } });

    const w = getCurrentWindow();
    const sf = geo.sf;
    Promise.all([
      w.setPosition(new PhysicalPosition(Math.round(win.x * sf), Math.round(win.y * sf))),
      w.setSize(new PhysicalSize(Math.max(1, Math.round(win.w * sf)), Math.max(1, Math.round(win.h * sf)))),
    ])
      .then(() => {
        if (!shown.current) {
          shown.current = true;
          return w.show();
        }
      })
      .catch(() => {});
  }, [geo, stripSize, edge, offset, dragging, collapsed]);

  // The detail window owns its dimensions; hovering never mutates widget geometry.
  useEffect(() => {
    const strip = geo && stripSize ? stripRect(geo.area, edge, offset, stripSize.w, stripSize.h) : null;
    const state: DetailState | null = active && geo && strip && !dragging && !collapsed ? {
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
  }, [active, geo, stripSize, edge, offset, vertical, anchorRel, dragging, collapsed, panelWidth, orbSize, config?.opacity, config?.refreshMinutes, config?.nineRouter.baseUrl, ring1, ring2, ring3, updatedAt, error]);

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
    if (drag.current || orbDrag.current?.moved || Date.now() - lastReorderAt.current < 400) return;
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
  useEffect(() => () => cancelTimers(), []);

  // Red de seguridad: si algo falla al medir/colocar, mostramos igualmente la ventana.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!shown.current) {
        shown.current = true;
        getCurrentWindow().show().catch(() => {});
      }
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  // ───── arrastrar la tira y soltar con imán al borde más cercano ─────
  const onGripDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || !geo) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    cancelTimers();
    setHovered(null);
    setDragging(true);
    const d = { sx: e.screenX, sy: e.screenY, start: null as PhysicalPosition | null, sf: geo.sf, raf: 0 };
    drag.current = d;
    // Con el panel cerrado, la ventana mide lo mismo que la tira.
    getCurrentWindow()
      .outerPosition()
      .then((p) => {
        d.start = p;
      })
      .catch(() => {});
  };

  const onGripMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d?.start) return;
    const x = Math.round(d.start.x + (e.screenX - d.sx) * d.sf);
    const y = Math.round(d.start.y + (e.screenY - d.sy) * d.sf);
    cancelAnimationFrame(d.raf);
    d.raf = requestAnimationFrame(() => {
      getCurrentWindow().setPosition(new PhysicalPosition(x, y)).catch(() => {});
    });
  };

  const onGripUp = async (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ya liberado */
    }
    cancelAnimationFrame(d.raf);
    drag.current = null;
    try {
      const w = getCurrentWindow();
      const [wpos, mons] = await Promise.all([w.outerPosition(), availableMonitors()]);
      // El imán usa el punto donde sueltas el asa (no el centro de la tira):
      // así, al llevarla a un lateral, se pega a ese lateral aunque sea horizontal.
      const grip = (e.target as HTMLElement).closest('.strip__grip')?.getBoundingClientRect();
      const cx = wpos.x + (grip ? grip.left + grip.width / 2 : 0) * d.sf;
      const cy = wpos.y + (grip ? grip.top + grip.height / 2 : 0) * d.sf;
      const mon =
        mons.find((m) => contains({ x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height }, cx, cy)) ??
        (await currentMonitor());
      if (mon) {
        const g = geoOf(mon);
        const snap = nearestEdge(g.area, cx / g.sf, cy / g.sf);
        setGeo(g);
        await patchConfig({ dockEdge: snap.edge, dockOffset: snap.offset, dockMonitor: g.monitor });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDragging(false);
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
      data-edge={edge}
      data-dragging={dragging || undefined}
      data-collapsed={collapsed || undefined}
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
      {collapsed && <div className="peek" aria-label="Quorb (pasa el ratón para mostrar)" />}

      <div
        ref={stripRef}
        className="strip"
        data-small={small || undefined}
        data-vertical={vertical || undefined}
        aria-hidden={collapsed || undefined}
        style={{ left: pos.strip.x, top: pos.strip.y, '--orb': orbSize } as CSSProperties}
      >
        <span
          className="strip__grip"
          title="Arrastrar: se pega al borde más cercano"
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
              threshold={config?.alerts.threshold}
              dragging={reorder?.id === r.id}
              onHover={(el) => openFor(r.id, el)}
              pointer={orbHandlers(r.id)}
            />
          ))}
          {visible.length === 0 &&
            (error ? (
              <button className="btn btn--accent btn--sm" onClick={retryStartup} title={error}>
                Reintentar
              </button>
            ) : loading || !config ? (
              <span style={{ color: 'var(--text-2)', fontSize: 11, padding: '0 6px' }}>Cargando…</span>
            ) : (
              <button className="btn btn--accent btn--sm" onClick={() => api.openSettings()}>
                Configurar
              </button>
            ))}
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
                  ? `Actualizando a ${update.info.version}${update.progress != null ? ` · ${update.progress} %` : '…'}`
                  : `Actualizar a Quorb ${update.info.version}`
              }
            >
              {Icon.update}
            </button>
          )}
          <button className="icon-btn" data-spin={loading || undefined} onClick={refresh} title="Actualizar ahora">
            {Icon.refresh}
          </button>
          <button className="icon-btn" onClick={() => api.openSettings()} title="Ajustes">
            {Icon.gear}
          </button>
        </div>
      </div>

    </div>
  );
}
