// Rincón de herramientas de la tira (Actualizar / Refrescar / Ajustes),
// extraído de Widget.tsx como componente puro con `locale` para SSR.
//
// Revisión PR #271 (precisión 2): se monta SOLO cuando el idioma es seguro
// (`configReady` o fallo definitivo `configFailed` con locale `es` por
// defecto). Mientras la config está pendiente no se renderiza: ningún botón
// activo sin nombre accesible. Por eso aquí los `title`/`aria-label`
// localizados se emiten SIEMPRE (el padre garantiza que hay idioma seguro).
import { t } from '../i18n';
import type { Locale } from '../lib/types';
import type { UpdaterMode } from '../lib/updater-policy';
import type { UpdatePhase } from '../lib/updater';
import type { ReactNode } from 'react';

export function StripTools({
  locale,
  loading,
  updaterMode,
  update,
  onRefresh,
  onOpenSettings,
  onStartUpdate,
  icons,
}: {
  locale: Locale;
  loading: boolean;
  updaterMode: UpdaterMode;
  update: UpdatePhase;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onStartUpdate: () => void;
  /** Los iconos viven en Widget; aquí entran como nodos para mantener el SSR puro. */
  icons: { update: ReactNode; refresh: ReactNode; gear: ReactNode };
}) {
  return (
    <div className="strip__tools">
      {updaterMode === 'native' && (update.phase === 'available' || update.phase === 'installing') && (
        <button
          type="button"
          className="icon-btn icon-btn--update"
          data-spin={update.phase === 'installing' || undefined}
          onClick={onStartUpdate}
          disabled={update.phase === 'installing'}
          title={
            update.phase === 'installing'
              ? t(locale, 'widget.updatingTo', { version: update.info.version, detail: update.progress != null ? ` · ${update.progress} %` : '…' })
              : t(locale, 'widget.updateTo', { version: update.info.version })
          }
        >
          {icons.update}
        </button>
      )}
      <button type="button" className="icon-btn" data-spin={loading || undefined} onClick={onRefresh} title={t(locale, 'widget.refreshNow')}>
        {icons.refresh}
      </button>
      <button type="button" className="icon-btn" onClick={onOpenSettings} title={t(locale, 'widget.settings')}>
        {icons.gear}
      </button>
    </div>
  );
}
