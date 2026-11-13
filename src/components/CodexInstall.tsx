import { useEffect, useSyncExternalStore } from 'react';
import { CODEX_PACKAGE, codexInstallActions, codexInstallView, type CodexInstallAction, type CodexInstallController } from '../lib/codex-install';
import { t } from '../i18n';

import { ownedHomeDir, useAppName } from '../lib/app-identity';
import type { Locale } from '../lib/types';

/**
 * Sustituye al aviso de copia solo para Codex: ofrece la instalación asistida
 * (con confirmación nativa del backend) y el rechequeo. Los demás proveedores
 * mantienen su flujo de copiar e instalar a mano.
 */
export function CodexInstall({ locale = 'es', controller, onRecheck }: { locale?: Locale; controller: CodexInstallController; onRecheck: () => void }) {
  const appName = useAppName();
  const targetFolder = `%USERPROFILE%\\${ownedHomeDir(appName)}\\tools\\codex-0.162.1`;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  // Visible mientras el componente está montado: al desmontarse se descarta la
  // lectura pasiva en vuelo, pero la instalación en curso sigue en el controlador
  // de la raíz y avisa al terminar.
  useEffect(() => {
    controller.setVisible(true);
    return () => controller.setVisible(false);
  }, [controller]);

  const view = codexInstallView(state);
  const actions = codexInstallActions(view);
  const can = (action: CodexInstallAction) => actions.includes(action);
  const copyCommand = () => {
    void navigator.clipboard?.writeText(`npm install -g ${CODEX_PACKAGE}`).catch(() => {});
  };
  // Relectura pasiva: nunca instala. Así, si Node aparece o el CLI se instala
  // fuera, el botón de instalar desaparece sin reinstalar nada.
  const recheck = () => {
    void controller.refresh();
    onRecheck();
  };

  return (
    <div className="eg-notice eg-notice--sm eg-notice--warning q-cli" role="status">
      <span className="eg-notice__text">
        {view.kind === 'loading' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.loadingBold')}</b> {t(locale, 'settings.providers.codexInstall.loadingRest')}
          </>
        )}
        {view.kind === 'ready' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.readyBold')}</b> {t(locale, 'settings.providers.codexInstall.readyRest')}
          </>
        )}
        {view.kind === 'installing' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.installingBold')}</b> {t(locale, 'settings.providers.codexInstall.installingRest')}
          </>
        )}
        {view.kind === 'installed' && view.justInstalled && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.installedBold')}</b> {t(locale, 'settings.providers.codexInstall.installedRest')}
          </>
        )}
        {view.kind === 'installed' && !view.justInstalled && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.installedStaleBold')}</b> {t(locale, 'settings.providers.codexInstall.installedStaleRest')}
          </>
        )}
        {view.kind === 'cancelled' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.cancelledBold')}</b> {t(locale, 'settings.providers.codexInstall.cancelledRest')}
          </>
        )}
        {view.kind === 'busy' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.busyBold')}</b> {t(locale, 'settings.providers.codexInstall.busyRest')}
          </>
        )}
        {view.kind === 'unsupported' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.unsupportedBold')}</b> {t(locale, 'settings.providers.codexInstall.unsupportedRest')}
          </>
        )}
        {view.kind === 'no-node' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.noNodeBold')}</b> {t(locale, 'settings.providers.codexInstall.noNodeRest')}
          </>
        )}
        {view.kind === 'error' && view.origin === 'read' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.errorReadBold')}</b> {view.message} {t(locale, 'settings.providers.codexInstall.errorReadRest')}
          </>
        )}
        {view.kind === 'error' && view.origin !== 'read' && (
          <>
            <b>{t(locale, 'settings.providers.codexInstall.errorInstallBold')}</b> {view.message} {t(locale, 'settings.providers.codexInstall.errorInstallRest')}
          </>
        )}
      </span>
      <span className="q-cli__cmd">
        {can('install') && (
          <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={() => void controller.requestInstall()}>
            {t(locale, 'settings.providers.codexInstall.install')}
          </button>
        )}
        {view.kind === 'installing' && (
          <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled>
            {t(locale, 'settings.providers.codexInstall.installing')}
          </button>
        )}
        {can('retry') && (
          <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={() => void controller.requestInstall()}>
            {t(locale, 'settings.providers.codexInstall.retry')}
          </button>
        )}
        {can('recheck') && (
          <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={recheck}>
            {t(locale, 'settings.providers.codexInstall.recheck')}
          </button>
        )}
        {can('copy') && (
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={copyCommand}>
            {t(locale, 'settings.providers.codexInstall.copy')}
          </button>
        )}
      </span>
      <details className="q-details">
        <summary>{t(locale, 'settings.providers.codexInstall.detailsSummary')}</summary>
        <ul className="q-note">
          <li>
            {t(locale, 'settings.providers.codexInstall.detailsPinnedBefore')}
            <code>{CODEX_PACKAGE}</code>
            {t(locale, 'settings.providers.codexInstall.detailsPinnedAfter')}
          </li>
          <li>
            {t(locale, 'settings.providers.codexInstall.detailsFolderBefore')}
            <code>{targetFolder}</code>
            {t(locale, 'settings.providers.codexInstall.detailsFolderAfter')}
          </li>
          <li>{t(locale, 'settings.providers.codexInstall.detailsScripts')}</li>
          <li>{t(locale, 'settings.providers.codexInstall.detailsNode')}</li>
        </ul>
      </details>
    </div>
  );
}
