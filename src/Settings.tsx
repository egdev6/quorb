import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { useAppName } from './lib/app-identity';
import { api } from './lib/api';
import { configKeyFor, isAccountVisible, setAccountVisibility } from './lib/settings-visibility';
import { ORB_SIZE, type Account, type AccountProvider, type AlertMoment, type AlertsConfig, type AppConfig, type Effect, type Locale, type MediaSize, type NineRouterPeriod, type ScopedSecretKey, type SecretKey, type SecretStatus, type ShortcutsConfig, type UsageReport } from './lib/types';
import { ACCOUNT_SECRETS, CLI_INSTALL, SESSION_DIR, accountReady, accountsOf, defaultSessionDir, newAccount, secretKey } from './lib/accounts';
import { ACCENT_PRESETS, DEFAULT_ACCENT, derivePalette, normalizeHex } from './lib/palette';
import { isDirty, isSettingsDirty, reconcileLive, reconcileSaved, withCanonicalLive } from './lib/settings-dirty';
import { createLiveCloseHandler, createLiveSaver, type LiveSaver, type LiveState } from './lib/settings-live';
import { createAutostartController } from './lib/autostart-controller';
import { configPersistedAfterSave, createWriteQueue, enqueueCanonicalConfig, runMixedSave, mixedSaveMessage, reloadSecretsAfterSave, type WriteQueue } from './lib/settings-save';
import { hiddenNineRouterIds, nineRouterSubName, revealIds } from './lib/visibility';
import { openAccountLogin } from './lib/account-login';
import { createPresencePoller, effectivePersisted, isConnectionDirty } from './lib/account-health';
import { createCodexInstallController, type CodexInstallController } from './lib/codex-install';
import { keyringErrorHint } from './lib/keyring-message';
import { comboFromEvent, prettyCombo } from './lib/shortcuts';
import { detectWindowManager, type WindowManagerInfo } from './lib/wm-detect';
import { desktopCompatRows, showDesktopCompat } from './lib/desktop-compat';
import { ProviderLogo } from './components/ProviderLogo';
import { CodexInstall } from './components/CodexInstall';
import quorbLogo from './assets/quorb-logo.png';
import { useUpdater } from './lib/useUpdater';
import { t, type MessageKey } from './i18n';
import { changeLocale as applyLocaleChange, useLocale } from './i18n/use-locale';
import { formatMoney, formatPercent, peakMeter } from './lib/format';

const LINKS = {
  anthropicAdmin: 'https://console.anthropic.com/settings/admin-keys',
  openaiAdmin: 'https://platform.openai.com/settings/organization/admin-keys',
  nanKeys: 'https://cloud.nan.builders/',
  nanDocs: 'https://nan.builders/docs',
  githubToken: 'https://github.com/settings/personal-access-tokens/new',
  openrouterKeys: 'https://openrouter.ai/settings/keys',
  minimaxKeys: 'https://www.minimax.io/',
  minimaxKeysCn: 'https://www.minimaxi.com/',
  zaiKeys: 'https://z.ai/manage-apikey/apikey-list',
  opencodeConsole: 'https://opencode.ai/console',
  geminiCli: 'https://github.com/google-gemini/gemini-cli',
  grokCli: 'https://x.ai/',
  releases: 'https://github.com/egdev6/quorb/releases',
  repo: 'https://github.com/egdev6/quorb',
  issues: 'https://github.com/egdev6/quorb/issues/new?template=provider-request.md',
  web: 'https://egdev.es',
};

/** Dentro del panel lateral de un proveedor, las secciones no repiten su tarjeta: el título va en la cabecera del panel. */
const InDrawer = createContext(false);

function Section({ title, kicker, id, children }: { title: string; kicker?: string; id?: string; children: ReactNode }) {
  const inDrawer = useContext(InDrawer);
  if (inDrawer) {
    return (
      <div className="q-drawer__section" id={id}>
        {kicker && <p className="eg-eyebrow">{kicker}</p>}
        {children}
      </div>
    );
  }
  return (
    <section className="eg-module-card eg-module-card--banded q-section" id={id} aria-label={title}>
      <div className="eg-module-card__head">
        <div className="q-section__titles">
          {kicker && <p className="eg-eyebrow">{kicker}</p>}
          <h2>{title}</h2>
        </div>
      </div>
      <div className="eg-module-card__body">{children}</div>
    </section>
  );
}

export function UpdatesSection({ auto, onAuto, locale = 'es' }: { auto: boolean; onAuto: (v: boolean) => void; locale?: Locale }) {
  const appName = useAppName();
  const [version, setVersion] = useState<string>('');
  const { mode, state, check, install } = useUpdater(auto);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion('?'));
  }, []);

  if (mode !== 'native') return (
    <Section title={t(locale, 'settings.updates.versionCurrent')}>
      <p className="q-note">{appName ?? '…'} <b>{version ? `v${version}` : ''}</b></p>
      <p className="q-note" role="status">
        {mode === 'manual' ? t(locale, 'settings.updates.manualMode')
          : mode === 'error' ? t(locale, 'settings.updates.modeError')
          : t(locale, 'settings.updates.modeChecking')}
      </p>
    </Section>
  );

  return (
    <Section title={t(locale, 'settings.updates.installedTitle')}>
      {(state.phase === 'available' || state.phase === 'installing') && (
        <div className="eg-notice eg-notice--info" role="status">
          <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
          <span className="eg-notice__text">
            <b>{t(locale, 'settings.updates.available', { version: state.info.version })}</b> {t(locale, 'settings.updates.availableDetail')}
          </span>
          <span className="eg-notice__actions">
            <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={state.phase === 'installing'} onClick={install}>
              {state.phase === 'installing' ? `${t(locale, 'settings.updates.installing')}${state.progress != null ? ` · ${state.progress} %` : '…'}` : t(locale, 'settings.updates.installNow')}
            </button>
          </span>
        </div>
      )}
      {state.phase === 'installing' && (
        <div className="q-update-bar" aria-hidden="true">
          <span style={{ width: `${state.progress ?? 15}%` }} data-indeterminate={state.progress == null || undefined} />
        </div>
      )}
      {(state.phase === 'available' || state.phase === 'installing') && state.info.notes && <pre className="q-pre">{state.info.notes}</pre>}
      <div className="q-inline">
        <span className="q-note">
          {appName ?? '…'} <b>{version ? `v${version}` : ''}</b>
          {state.phase === 'none' && t(locale, 'settings.updates.upToDate')}
        </span>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={state.phase === 'checking' || state.phase === 'installing'} onClick={() => check()}>
          {state.phase === 'checking' ? t(locale, 'settings.updates.checking') : t(locale, 'settings.updates.checkNow')}
        </button>
      </div>
      {state.phase === 'error' && <div className="eg-notice eg-notice--warning eg-notice--sm"><span className="eg-notice__text">{state.message}</span></div>}
      <Rows>
        <Toggle label={t(locale, 'settings.updates.autoLabel')} hint={t(locale, 'settings.updates.autoHint')} checked={auto} onChange={onAuto} />
      </Rows>
      <small className="eg-field__hint">
        {t(locale, 'settings.updates.signedIntro')}{' '}
        <button type="button" className="q-link" onClick={() => openUrl(LINKS.releases)}>
          GitHub Releases
        </button>
        {t(locale, 'settings.updates.signedOutro')}
      </small>
    </Section>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="q-row">
      <span className="q-row__text">
        <span className="q-row__label">{label}</span>
        {hint && <span className="q-row__hint">{hint}</span>}
      </span>
      <span className="eg-check eg-check--switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      </span>
    </label>
  );
}

/** Varias filas con interruptor seguidas, separadas por una línea. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="q-rows">{children}</div>;
}

function Field({ label, hint, value, children }: { label: string; hint?: ReactNode; value?: ReactNode; children: ReactNode }) {
  return (
    <label className={`eg-field${value != null ? ' eg-field--range' : ''}`}>
      <span className="eg-field__label">
        {label}
        {value != null && <output>{value}</output>}
      </span>
      {children}
      {hint && <small className="eg-field__hint">{hint}</small>}
    </label>
  );
}

/** Estilo de la pista de un range del DS (--v = parte rellena). */
const rangeFill = (v: number, min: number, max: number) => ({ '--v': `${((v - min) / (max - min)) * 100}%` }) as CSSProperties;

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch(console.error);
      }}
    >
      {children}
    </a>
  );
}

export function SecretInput({ id, label, configured, onSaved, hint, locale = 'es' }: { id: ScopedSecretKey; label: string; configured: boolean; onSaved: () => void; hint?: ReactNode; locale?: Locale }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (v: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.setSecret(id, v);
      setValue('');
      setMsg(v ? t(locale, 'settings.common.keyringSaved') : t(locale, 'settings.common.keyringRemoved'));
      onSaved();
    } catch (e) {
      // Si el backend falla por falta de llavero (Secret Service / libsecret en
      // Linux), muestra un mensaje accionable en vez del error técnico crudo.
      setMsg(keyringErrorHint(e) ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label={label} hint={msg ?? hint}>
      <div className="q-inline">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? t(locale, 'settings.common.secretConfigured') : t(locale, 'settings.common.secretPlaceholder')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="eg-btn eg-btn--primary" disabled={busy || !value.trim()} onClick={() => save(value)}>
          {t(locale, 'settings.common.save')}
        </button>
        {configured && (
          <button className="eg-btn eg-btn--destructive" disabled={busy} onClick={() => save('')} title={t(locale, 'settings.common.deleteKeyTitle')}>
            {t(locale, 'settings.common.remove')}
          </button>
        )}
      </div>
    </Field>
  );
}

/** Conectar NaN Cloud como la CLI oficial: enlace de un solo uso enviado al correo. */
function NanConnect({ connected, onChange, account }: { connected: boolean; onChange: () => void; account?: string }) {
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const [step, setStep] = useState<'email' | 'link'>('email');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return (
      <div className="q-inline">
        <span className="eg-status eg-status--success">Cuenta de NaN Cloud conectada{msg ? ` · ${msg}` : ''}</span>
        <button
          className="eg-btn eg-btn--destructive eg-btn--sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.setSecret(account ? secretKey('nan_session', account) : 'nan_session', '');
              onChange();
            })
          }
        >
          Desconectar
        </button>
      </div>
    );
  }

  return (
    <div className="eg-field">
      <span className="eg-field__label">Conectar tu cuenta (recomendado)</span>
      {step === 'email' ? (
        <div className="q-inline">
          <input type="email" placeholder="tu@correo.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button
            className="eg-btn eg-btn--primary"
            disabled={busy || !email.includes('@')}
            onClick={() =>
              run(async () => {
                await api.nanLoginRequest(email);
                setStep('link');
                setMsg('Te hemos enviado un enlace. Cópialo (sin abrirlo) y pégalo aquí.');
              })
            }
          >
            Enviar enlace
          </button>
        </div>
      ) : (
        <div className="q-inline">
          <input type="text" spellCheck={false} placeholder="https://…nan.builders/…" value={link} onChange={(e) => setLink(e.target.value)} />
          <button
            className="eg-btn eg-btn--primary"
            disabled={busy || !link.trim()}
            onClick={() =>
              run(async () => {
                const who = await api.nanLoginComplete(link, account);
                setMsg(`Conectado como ${who}`);
                setLink('');
                onChange();
              })
            }
          >
            Conectar
          </button>
          <button className="eg-btn eg-btn--ghost" disabled={busy} onClick={() => setStep('email')}>
            Volver
          </button>
        </div>
      )}
      <small className="eg-field__hint">
        {msg ??
          'Igual que «nan auth login --email»: NaN te manda un enlace de un solo uso. No lo abras en el navegador (se gastaría): cópialo y pégalo aquí. La sesión se guarda en el almacén de credenciales del sistema y da los mismos datos que tu dashboard.'}
      </small>
    </div>
  );
}

/** Muestra las respuestas en crudo de la API de NaN con tu key (para depurar). */
function NanProbe() {
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <details className="q-details">
      <summary>Probar la API de NaN con la key</summary>
      <button
        className="eg-btn eg-btn--ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setOut(await api.nanProbe());
          } catch (e) {
            setOut(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Consultando…' : 'Ver respuestas de /v1/models y /v1/usage'}
      </button>
      {out && <pre className="q-pre">{out}</pre>}
    </details>
  );
}

/** Contraseña del dashboard de 9Router: se guarda y se prueba el login a la vez. */
function NineRouterConnect({ connected, baseUrl, onChange }: { connected: boolean; baseUrl: string; onChange: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [out, setOut] = useState<string | null>(null);

  const save = async (value: string) => {
    setBusy(true);
    setMsg(null);
    try {
      if (!value.trim()) {
        await api.nineRouterLogout();
        setMsg('9Router desconectado');
      } else {
        // Prueba contra la URL del borrador: si el usuario cambió «Base URL» sin
        // guardar, el login debe ir a esa, no a la persistida (regresión punto 4).
        setOut(await api.nineRouterLogin(value, baseUrl));
        setMsg('Conectado');
      }
      setPassword('');
      onChange();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="q-details" open={!connected}>
      <summary>{connected ? '9Router conectado · volver a conectar' : 'Conectar con el dashboard'}</summary>
      <div className="q-inline">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={connected ? '•••••••• (configurada)' : 'Contraseña del dashboard'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="eg-btn eg-btn--primary" disabled={busy || !password.trim()} onClick={() => save(password)}>
          Guardar y probar
        </button>
        {connected && (
          <button className="eg-btn eg-btn--destructive" disabled={busy} onClick={() => save('')} title="Desconectar 9Router">
            Quitar
          </button>
        )}
      </div>
      <small className="eg-field__hint">
        {msg ?? 'La contraseña del dashboard de 9Router (por defecto «123456» hasta que la cambies). Se guarda en el almacén seguro del sistema.'}
      </small>
      {out && <pre className="q-pre">{out}</pre>}
    </details>
  );
}

const EFFECT_OPTIONS: { value: Effect; key: MessageKey }[] = [
  { value: 'confetti', key: 'settings.alerts.effectConfetti' },
  { value: 'glow', key: 'settings.alerts.effectGlow' },
  { value: 'custom', key: 'settings.alerts.effectCustom' },
  { value: 'none', key: 'settings.alerts.effectNone' },
];

async function testEffect(kind: Effect, moment: AlertMoment, alerts: AppConfig['alerts'], persist: (alerts: AppConfig['alerts']) => Promise<void>) {
  if (kind === 'none') return;
  // El archivo del efecto propio se lee de la config guardada: guardamos antes lo que haya en el formulario.
  await persist(alerts);
  const m = await currentMonitor();
  if (!m) return;
  await api.playEffect(kind, moment, { x: m.position.x, y: m.position.y, width: m.size.width, height: m.size.height });
}

/** Filtros del selector de archivo del efecto propio; el nombre se traduce. */
const mediaFilters = (locale: Locale) => [{ name: t(locale, 'settings.alerts.mediaFilter'), extensions: ['webm', 'mp4', 'gif', 'webp', 'png', 'apng'] }];

const fileName = (p: string | null) => (p ? p.split(/[\\/]/).pop() : null);

/** Un momento de aviso: efecto + archivo propio + botón de prueba. */
export function MomentEffect({
  moment,
  effect,
  media,
  alerts,
  onEffect,
  onMedia,
  onPersist,
  onError,
  locale = 'es',
}: {
  moment: AlertMoment;
  effect: Effect;
  media: string | null;
  alerts: AppConfig['alerts'];
  onEffect: (e: Effect) => void;
  onMedia: (p: string | null) => void;
  onPersist: (alerts: AppConfig['alerts']) => Promise<void>;
  onError: (msg: string) => void;
  locale?: Locale;
}) {
  return (
    <>
      <div className="q-inline">
        <label className="eg-field">
          <span className="eg-field__label">{t(locale, 'settings.alerts.effect')}</span>
          <select value={effect} onChange={(e) => onEffect(e.target.value as Effect)}>
            {EFFECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(locale, o.key)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="eg-btn eg-btn--ghost"
          disabled={effect === 'none' || (effect === 'custom' && !media)}
          onClick={() => testEffect(effect, moment, alerts, onPersist).catch((e) => onError(String(e)))}
        >
          {t(locale, 'settings.alerts.test')}
        </button>
      </div>
      {effect === 'custom' && (
        <div className="eg-field">
          <span className="eg-field__label">{t(locale, 'settings.alerts.file')}</span>
          <div className="q-inline">
            <input type="text" readOnly value={fileName(media) ?? ''} placeholder={t(locale, 'settings.alerts.noFile')} title={media ?? ''} />
            <button
              className="eg-btn eg-btn--ghost"
              onClick={async () => {
                const file = await openDialog({ multiple: false, directory: false, filters: mediaFilters(locale) });
                if (typeof file === 'string') onMedia(file);
              }}
            >
              {t(locale, 'settings.alerts.choose')}
            </button>
            {media && (
              <button className="eg-btn eg-btn--ghost" onClick={() => onMedia(null)}>
                {t(locale, 'settings.common.remove')}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Fila de la tabla de atajos: pulsa el atajo (o «Cambiar») y teclea la combinación nueva. */
export function ShortcutRow({ label, value, onChange, locale = 'es' }: { label: string; value: string; onChange: (v: string) => void; locale?: Locale }) {
  const [rec, setRec] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        <button
          ref={btn}
          type="button"
          className="q-kbd-btn"
          data-recording={rec || undefined}
          aria-label={t(locale, 'settings.shortcuts.rowAria', { label, value: value ? prettyCombo(value) : t(locale, 'settings.shortcuts.missing') })}
          onClick={() => setRec(true)}
          onBlur={() => setRec(false)}
          onKeyDown={(e) => {
            if (!rec) return;
            e.preventDefault();
            if (e.key === 'Escape') {
              setRec(false);
              return;
            }
            const combo = comboFromEvent(e);
            if (combo) {
              onChange(combo);
              setRec(false);
            }
          }}
        >
          {rec ? t(locale, 'settings.shortcuts.recording') : value ? prettyCombo(value).split(' + ').map((k) => <kbd key={k} className="eg-kbd">{k}</kbd>) : t(locale, 'settings.shortcuts.none')}
        </button>
      </td>
      <td className="eg-table__acts">
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => { setRec(true); btn.current?.focus(); }}>
          {t(locale, 'settings.shortcuts.change')}
        </button>
        {value && (
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => onChange('')}>
            {t(locale, 'settings.common.remove')}
          </button>
        )}
      </td>
    </tr>
  );
}

const numOrNull = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return s.trim() === '' || Number.isNaN(n) ? null : n;
};
const strOrNull = (s: string) => (s.trim() === '' ? null : s);

/** Aviso de que falta el CLI con el que se inicia sesión, con la orden para instalarlo. */
export function CliMissing({ provider, locale = 'es' }: { provider: AccountProvider; locale?: Locale }) {
  const how = CLI_INSTALL[provider];
  const [copied, setCopied] = useState(false);
  if (!how) return null;
  const copy = () =>
    navigator.clipboard
      .writeText(how.cmd)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  return (
    <div className="eg-notice eg-notice--sm eg-notice--warning q-cli" role="status">
      <span className="eg-notice__text">
        <b>{t(locale, 'settings.providers.cliMissing.title', { name: how.name })}</b>{' '}
        {t(locale, 'settings.providers.cliMissing.body', {
          where: how.whereKey ? t(locale, how.whereKey) : how.where,
          needs: how.needs ? t(locale, 'settings.providers.cliMissing.needs', { needs: how.needs }) : '',
        })}
      </span>
      <span className="q-cli__cmd">
        <code>{how.cmd}</code>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={copy}>
          {copied ? t(locale, 'settings.providers.cliMissing.copied') : t(locale, 'settings.providers.cliMissing.copy')}
        </button>
      </span>
    </div>
  );
}

/** Lo que necesita el paso de comprobación: lo guardado, las claves y si hay cambios sin guardar. */
type HealthProps = {
  /** Config guardada: cuando cambia (al guardar) se vuelve a comprobar. */
  saved: unknown;
  /** Estado de las claves del almacén seguro del sistema. */
  secretsSig: string;
  /** Hay cambios sin guardar en esta cuenta: se comprueba lo guardado. */
  dirty: boolean;
  /** Oculta en el widget (se comprueba igual). */
  hidden: boolean;
  /** Hay un guardado en curso: evita solapar «Conectar» y «Guardar y comprobar». */
  saving: boolean;
  /** Guarda y confirma (`true`) si la config quedó persistida. */
  onSave: () => Promise<boolean>;
  /** Si la cuenta tiene login por CLI, abre el login cuando el report viene con `needsLogin`. */
  onLogin?: () => void;
  /** `true` mientras `onLogin` está en curso: deshabilita el CTA (single-flight). */
  loginBusy?: boolean;
  /** Idioma del paso (`es` si no se indica). */
  locale?: Locale;
};

export type Health = { phase: 'checking' } | { phase: 'done'; report: UsageReport | null } | { phase: 'failed'; error: string };

export function healthSummary(r: UsageReport, locale: Locale = 'es'): string {
  const peak = peakMeter(r);
  const data =
    peak?.percent != null
      ? t(locale, 'settings.providers.health.peakAt', { label: peak.label, percent: formatPercent(peak.percent) })
      : r.spend
        ? `${r.spend.periodLabel}: ${formatMoney(r.spend.amount, r.spend.currency)}`
        : t(locale, 'settings.providers.health.dataReceived');
  return r.plan ? `${r.plan} · ${data}` : data;
}

/**
 * Último paso de cada proveedor y cuenta: consulta la cuenta con lo guardado y dice si
 * funciona y, si no, por qué (sesión caducada, clave rechazada, falta un dato…).
 */
function HealthStep({ id, saved, secretsSig, dirty, hidden, saving, onSave, onLogin, loginBusy, refreshKey, locale = 'es' }: HealthProps & { id: string; refreshKey?: unknown }) {
  const [h, setH] = useState<Health>({ phase: 'checking' });
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  // Marca de montaje: una respuesta que llegue tras desmontar no toca el estado.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(() => {
    const n = ++seq.current;
    setH({ phase: 'checking' });
    api
      .checkProvider(id)
      .then((report) => alive.current && n === seq.current && setH({ phase: 'done', report }))
      .catch((e) => alive.current && n === seq.current && setH({ phase: 'failed', error: String(e) }));
  }, [id]);
  // Al abrir, al guardar, al cambiar una clave o al aparecer la sesión del CLI.
  useEffect(() => {
    const t = window.setTimeout(run, 300);
    return () => window.clearTimeout(t);
  }, [run, saved, secretsSig, refreshKey]);

  return (
    <HealthStepView
      locale={locale}
      h={h}
      hidden={hidden}
      dirty={dirty}
      busy={busy}
      saving={saving}
      loginBusy={loginBusy}
      onRun={run}
      onSave={() => {
        setBusy(true);
        onSave().finally(() => setBusy(false));
      }}
      onLogin={onLogin}
    />
  );
}

/** Vista del paso de comprobación a partir de su estado. Extraída para poder
 *  renderizar en pruebas cada estado con el locale explícito. */
export function HealthStepView({ locale, h, hidden, dirty, busy, saving, loginBusy, onRun, onSave, onLogin }: {
  locale: Locale;
  h: Health;
  hidden: boolean;
  dirty: boolean;
  busy: boolean;
  saving: boolean;
  loginBusy?: boolean;
  onRun: () => void;
  onSave: () => void;
  onLogin?: () => void;
}) {
  const r = h.phase === 'done' ? h.report : null;
  const hasData = !!r && (r.meters.length > 0 || !!r.spend);
  const state =
    h.phase === 'checking'
      ? 'checking'
      : h.phase === 'failed'
        ? 'error'
        : !r || r.status === 'unconfigured'
          ? 'todo'
          : r.status === 'ok' || (r.status === 'warning' && hasData)
            ? 'ok'
            : r.status === 'error'
              ? 'error'
              : 'warn';
  const titleKey: Record<typeof state, MessageKey> = {
    checking: 'settings.providers.health.checking',
    ok: 'settings.providers.health.ok',
    todo: 'settings.providers.health.todo',
    warn: r?.status === 'needsLogin' ? 'settings.providers.health.needsLogin' : 'settings.providers.health.warn',
    error: 'settings.providers.health.error',
  };
  const title = t(locale, titleKey[state]);
  // El fallo de la comprobación no pisa el diagnóstico del guardado (vive en `saved`).
  const message =
    h.phase === 'failed'
      ? t(locale, 'settings.providers.health.failed', { error: h.error })
      : !r
        ? t(locale, 'settings.providers.health.saveToCheck')
        : r.message;

  return (
    <li data-done={state === 'ok' || undefined} data-state={state} aria-live="polite">
      <b>{title}</b>
      {state === 'ok' && r && (
        <span>
          {healthSummary(r, locale)}
          {hidden && t(locale, 'settings.providers.health.hiddenSuffix')}
        </span>
      )}
      {state === 'checking' && <span>{t(locale, 'settings.providers.health.consulting')}</span>}
      {message && state !== 'checking' && (
        <span className={`eg-notice eg-notice--sm eg-notice--${state === 'ok' ? 'info' : state === 'error' ? 'danger' : 'warning'} q-steps__notice`} role={state === 'ok' ? undefined : 'alert'}>
          <span className="eg-notice__text">{message}</span>
        </span>
      )}
      {dirty && <span className="q-note">{t(locale, 'settings.providers.health.dirtyNote')}</span>}
      <span className="q-steps__actions">
        {dirty ? (
          <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={busy || saving} onClick={onSave}>
            {t(locale, 'settings.providers.health.saveAndCheck')}
          </button>
        ) : (
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={state === 'checking'} onClick={onRun}>
            {t(locale, 'settings.providers.health.checkNow')}
          </button>
        )}
        {state === 'warn' && r?.status === 'needsLogin' && onLogin && (
          <button
            type="button"
            className="eg-btn eg-btn--primary eg-btn--sm"
            disabled={busy || saving || loginBusy}
            onClick={onLogin}
          >
            {t(locale, 'settings.providers.health.login')}
          </button>
        )}
      </span>
    </li>
  );
}

/** ¿Hay sesión del CLI para esta cuenta? Se mira cada 3 s mientras está abierta. */
function useCliSession(id: string, active: boolean): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!active) {
      setConnected(false);
      return;
    }
    // Presencia del fichero, no validez: al desmontar se para el sondeo y las
    // respuestas en vuelo se descartan (no marca conectada otra cuenta).
    const poller = createPresencePoller({
      exists: () => api.accountSessionFileExists(id),
      onResult: setConnected,
    });
    poller.start();
    return () => poller.stop();
  }, [id, active]);
  return connected;
}

/**
 * Pasos de una cuenta con login por CLI (Claude Code, Codex, Gemini), principal o
 * adicional: instalar el CLI si falta, iniciar sesión y comprobar que funciona.
 */
function CliConnect({
  locale,
  id,
  provider,
  loginCommand,
  cliMissing,
  persisted,
  extra,
  health,
  codexInstall,
  onCodexRecheck,
}: {
  /** Idioma de los pasos. */
  locale: Locale;
  id: string;
  provider: AccountProvider;
  loginCommand: string;
  cliMissing: boolean;
  /** Guardada tal cual (el login la busca en la config guardada). */
  persisted: boolean;
  /** Cuenta adicional (no la principal). */
  extra: boolean;
  health: HealthProps;
  /** Controlador raíz de la instalación asistida de Codex (solo se usa con `codex`). */
  codexInstall: CodexInstallController;
  /** Relectura del CLI compartida con la raíz tras una instalación. */
  onCodexRecheck: () => void;
}) {
  const connected = useCliSession(id, persisted);
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setLoginError(null);
    try {
      // El CLI busca la config guardada: si hay cambios pendientes (o la cuenta no
      // está guardada), `openAccountLogin` guarda antes y solo abre con una
      // confirmación explícita (`true`). Sin ella no hay login ni comprobación.
      await openAccountLogin(effectivePersisted(persisted, health.dirty), {
        save: health.onSave,
        open: () => api.openLogin(id),
      });
    } catch (e) {
      // Se queda en el paso hasta el siguiente intento y conserva el diagnóstico.
      setLoginError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CliConnectView
      locale={locale}
      id={id}
      provider={provider}
      loginCommand={loginCommand}
      cliMissing={cliMissing}
      persisted={persisted}
      extra={extra}
      health={health}
      codexInstall={codexInstall}
      onCodexRecheck={onCodexRecheck}
      connected={connected}
      busy={busy}
      loginError={loginError}
      onConnect={connect}
    />
  );
}

/** Vista de los pasos de conexión por CLI a partir de su estado. Extraída para
 *  poder renderizar en pruebas cada estado con el locale explícito. */
export function CliConnectView({
  locale,
  id,
  provider,
  loginCommand,
  cliMissing,
  persisted,
  extra,
  health,
  codexInstall,
  onCodexRecheck,
  connected,
  busy,
  loginError,
  onConnect,
}: {
  locale: Locale;
  id: string;
  provider: AccountProvider;
  loginCommand: string;
  cliMissing: boolean;
  persisted: boolean;
  extra: boolean;
  health: HealthProps;
  codexInstall: CodexInstallController;
  onCodexRecheck: () => void;
  /** Hay fichero de sesión del CLI. */
  connected: boolean;
  /** Hay un login o guardado en curso. */
  busy: boolean;
  /** Diagnóstico del último intento de login que falló. */
  loginError: string | null;
  onConnect: () => void;
}) {
  return (
    <>
      {cliMissing && (
        <li>
          <b>{t(locale, 'settings.providers.cliConnect.installTitle', { name: CLI_INSTALL[provider]?.name ?? t(locale, 'settings.providers.cliConnect.cliFallback') })}</b>
          <span>{t(locale, 'settings.providers.cliConnect.installBody')}</span>
          {provider === 'codex' ? <CodexInstall controller={codexInstall} onRecheck={onCodexRecheck} /> : <CliMissing provider={provider} locale={locale} />}
        </li>
      )}
      <li data-done={connected || undefined}>
        <b>{connected ? t(locale, 'settings.providers.cliConnect.sessionFound') : extra ? t(locale, 'settings.providers.cliConnect.loginOther') : t(locale, 'settings.providers.cliConnect.login')}</b>
        <span>
          {t(locale, 'settings.providers.cliConnect.opensTerminal')}{' '}
          <code>{loginCommand}</code>
          {provider === 'claude' && <>{t(locale, 'settings.providers.cliConnect.claudeLoginHint')} <code>/login</code>)</>}
          {provider === 'gemini' && <>{t(locale, 'settings.providers.cliConnect.geminiLoginHint')}</>}{t(locale, 'settings.providers.cliConnect.browserLogin')}
          {connected && t(locale, 'settings.providers.cliConnect.fileExists')}
          {extra && t(locale, 'settings.providers.cliConnect.extraNote')}
        </span>
        <span className="q-steps__actions">
          <button className={`eg-btn ${connected ? 'eg-btn--secondary' : 'eg-btn--primary'}`} disabled={busy || cliMissing || health.saving} onClick={onConnect}>
            {connected
              ? t(locale, 'settings.providers.cliConnect.reopenLogin')
              : effectivePersisted(persisted, health.dirty)
                ? t(locale, 'settings.providers.cliConnect.signIn')
                : t(locale, 'settings.providers.cliConnect.saveAndSignIn')}
          </button>
        </span>
        {loginError && (
          <span className="eg-notice eg-notice--sm eg-notice--warning q-steps__notice" role="alert">
            <span className="eg-notice__text">{loginError}</span>
          </span>
        )}
      </li>
      {persisted ? (
        <HealthStep id={id} {...health} onLogin={onConnect} loginBusy={busy} refreshKey={connected} />
      ) : (
        <li>
          <b>{t(locale, 'settings.providers.checkTitle')}</b>
          <span>{t(locale, 'settings.providers.cliConnect.checkAuto')}</span>
        </li>
      )}
    </>
  );
}

/** Configuración de una cuenta adicional: nombre, si se muestra y cómo se conecta, en pasos. */
export function AccountEditor({
  locale,
  account: a,
  visible,
  onVisibility,
  persisted,
  secrets,
  onChange,
  onRemove,
  onSecrets,
  loginCommand,
  cliMissing,
  health,
  codexInstall,
  onCodexRecheck,
}: {
  /** Idioma del editor. */
  locale: Locale;
  account: Account;
  visible: boolean;
  onVisibility: (enabled: boolean) => void;
  /** Ya está guardada tal cual en el backend (necesario para abrir su login y comprobarla). */
  persisted: boolean;
  /** Comando de login del proveedor (el de la cuenta principal). */
  loginCommand: string;
  /** El CLI de login no está instalado: se avisa con la orden para instalarlo. */
  cliMissing: boolean;
  health: HealthProps;
  secrets: SecretStatus;
  onChange: (patch: Partial<Account>) => void;
  onRemove: () => void;
  onSecrets: () => void;
  /** Instalación asistida de Codex, compartida por la raíz y todas las cuentas. */
  codexInstall: CodexInstallController;
  onCodexRecheck: () => void;
}) {
  const appName = useAppName();
  const key = (k: SecretKey) => secretKey(k, a.id);
  const has = (k: SecretKey) => !!secrets[key(k)];
  const session = SESSION_DIR[a.provider];
  const adminKey: SecretKey = a.provider === 'anthropic_api' ? 'anthropic_admin_key' : 'openai_admin_key';
  const check = persisted ? (
    <HealthStep id={a.id} {...health} />
  ) : (
    <li>
      <b>{t(locale, 'settings.providers.checkTitle')}</b>
      <span>{t(locale, 'settings.providers.accountEditor.checkSave')}</span>
      <span className="q-steps__actions">
        <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={health.saving} onClick={() => void health.onSave()}>
          {t(locale, 'settings.providers.health.saveAndCheck')}
        </button>
      </span>
    </li>
  );
  return (
    <Section kicker={t(locale, 'settings.providers.accountEditor.kicker')} title={a.label}>
      <div className="q-cols">
        <Field label={t(locale, 'settings.providers.accountEditor.nameLabel')} hint={t(locale, 'settings.providers.accountEditor.nameHint')}>
          <input type="text" value={a.label} onChange={(e) => onChange({ label: e.target.value })} />
        </Field>
      </div>
      <Toggle label={t(locale, 'settings.providers.showInWidget')} checked={visible} onChange={onVisibility} />

      <ol className="q-steps" aria-label={t(locale, 'settings.providers.accountEditor.stepsAria')}>
        <li data-done={a.label.trim() !== '' || undefined}>
          <b>{t(locale, 'settings.providers.accountEditor.nameStep')}</b>
          <span>{t(locale, 'settings.providers.accountEditor.nameStepBody')}</span>
        </li>

        {session && (
          <CliConnect locale={locale} id={a.id} provider={a.provider} loginCommand={loginCommand} cliMissing={cliMissing} persisted={persisted} extra health={health} codexInstall={codexInstall} onCodexRecheck={onCodexRecheck} />
        )}

        {a.provider === 'cursor' && (
          <>
            <li data-done={has('cursor_token') || undefined}>
              <b>{t(locale, 'settings.providers.accountEditor.cursorTokenTitle')}</b>
              <span>{t(locale, 'settings.providers.accountEditor.cursorTokenBody')}</span>
              <SecretInput locale={locale} id={key('cursor_token')} label={t(locale, 'settings.providers.accountEditor.cursorTokenLabel')} configured={has('cursor_token')} onSaved={onSecrets} />
            </li>
            {check}
          </>
        )}

        {a.provider === 'copilot' && (
          <>
            <li data-done={a.username.trim() !== '' || undefined}>
              <b>{t(locale, 'settings.providers.accountEditor.copilotUserPlan')}</b>
              <div className="q-cols">
                <Field label={t(locale, 'settings.providers.accountEditor.githubUser')}>
                  <input type="text" spellCheck={false} value={a.username} onChange={(e) => onChange({ username: e.target.value })} />
                </Field>
                <Field label={t(locale, 'settings.providers.planLabel')}>
                  <select value={a.plan || 'pro'} onChange={(e) => onChange({ plan: e.target.value })}>
                    <option value="free">Free · 50</option>
                    <option value="pro">Pro · 300</option>
                    <option value="pro_plus">Pro+ · 1500</option>
                    <option value="business">Business · 300</option>
                    <option value="enterprise">Enterprise · 1000</option>
                    <option value="custom">{t(locale, 'settings.providers.accountEditor.planCustom')}</option>
                  </select>
                </Field>
              </div>
              {a.plan === 'custom' && (
                <Field label={t(locale, 'settings.providers.accountEditor.customAllowance')}>
                  <input type="number" min={1} value={a.customAllowance ?? ''} onChange={(e) => onChange({ customAllowance: numOrNull(e.target.value) })} />
                </Field>
              )}
            </li>
            <li data-done={has('github_token') || undefined}>
              <b>{t(locale, 'settings.providers.accountEditor.readOnlyToken')}</b>
              <SecretInput
                locale={locale}
                id={key('github_token')}
                label={t(locale, 'settings.providers.accountEditor.githubTokenLabel')}
                configured={has('github_token')}
                onSaved={onSecrets}
                hint={<>{t(locale, 'settings.providers.accountEditor.githubTokenCreateIn')} <Link href={LINKS.githubToken}>GitHub › Fine-grained tokens</Link> {t(locale, 'settings.providers.accountEditor.githubTokenPermission')}</>}
              />
            </li>
            {check}
          </>
        )}

        {a.provider === 'nan' && (
          <>
            <li data-done={has('nan_session') || has('nan_api_key') || undefined}>
              <b>{t(locale, 'settings.providers.accountEditor.nanTitle')}</b>
              <NanConnect account={a.id} connected={has('nan_session')} onChange={onSecrets} />
              <SecretInput locale={locale} id={key('nan_api_key')} label={t(locale, 'settings.providers.accountEditor.nanApiKeyAlt')} configured={has('nan_api_key')} onSaved={onSecrets} />
            </li>
            <li data-done>
              <b>{t(locale, 'settings.providers.planLabel')}</b>
              <Field label={t(locale, 'settings.providers.planLabel')} hint={t(locale, 'settings.providers.accountEditor.nanPlanHint')}>
                <select value={a.plan || 'member'} onChange={(e) => onChange({ plan: e.target.value })}>
                  <option value="community">nan_community</option>
                  <option value="member">nan_member</option>
                  <option value="premium">GLM Premium</option>
                </select>
              </Field>
            </li>
            {check}
          </>
        )}

        {a.provider === 'openrouter' && (
          <>
            <li data-done={has('openrouter_api_key') || undefined}>
              <b>{t(locale, 'settings.providers.apiKey')}</b>
              <SecretInput
                locale={locale}
                id={key('openrouter_api_key')}
                label={t(locale, 'settings.providers.apiKey')}
                configured={has('openrouter_api_key')}
                onSaved={onSecrets}
                hint={<>{t(locale, 'settings.providers.accountEditor.openrouterHint')} <Link href={LINKS.openrouterKeys}>openrouter.ai › Keys</Link></>}
              />
            </li>
            {check}
          </>
        )}

        {a.provider === 'zai' && (
          <>
            <li data-done={has('zai_api_key') || undefined}>
              <b>{t(locale, 'settings.providers.apiKey')}</b>
              <SecretInput
                locale={locale}
                id={key('zai_api_key')}
                label={t(locale, 'settings.providers.apiKey')}
                configured={has('zai_api_key')}
                onSaved={onSecrets}
                hint={<>{t(locale, 'settings.providers.accountEditor.createIn')} <Link href={LINKS.zaiKeys}>z.ai › API Keys</Link>.</>}
              />
            </li>
            {check}
          </>
        )}

        {a.provider === 'opencode_go' && (
          <>
            <li data-done={has('opencode_go_api_key') || undefined}>
              <b>{t(locale, 'settings.providers.apiKey')}</b>
              <SecretInput
                locale={locale}
                id={key('opencode_go_api_key')}
                label={t(locale, 'settings.providers.accountEditor.apiKeyOf', { name: 'OpenCode Go' })}
                configured={has('opencode_go_api_key')}
                onSaved={onSecrets}
                hint={<>{t(locale, 'settings.providers.accountEditor.createIn')} <Link href={LINKS.opencodeConsole}>OpenCode › Console</Link>.</>}
              />
            </li>
            {check}
          </>
        )}

        {(a.provider === 'anthropic_api' || a.provider === 'openai_api') && (
          <>
            <li data-done={has(adminKey) || undefined}>
              <b>{t(locale, 'settings.providers.accountEditor.adminKeyTitle')}</b>
              <SecretInput
                locale={locale}
                id={key(adminKey)}
                label={t(locale, 'settings.providers.accountEditor.adminKey')}
                configured={has(adminKey)}
                onSaved={onSecrets}
                hint={<>{t(locale, 'settings.providers.accountEditor.adminKeyOwn')} <Link href={a.provider === 'anthropic_api' ? LINKS.anthropicAdmin : LINKS.openaiAdmin}>{t(locale, 'settings.providers.accountEditor.adminKey')}</Link>.</>}
              />
            </li>
            <li data-done={a.monthlyBudgetUsd != null || undefined}>
              <b>{t(locale, 'settings.providers.accountEditor.budgetTitle')}</b>
              <Field label={t(locale, 'settings.providers.accountEditor.budgetLabel')}>
                <input type="number" min={0} step="any" value={a.monthlyBudgetUsd ?? ''} onChange={(e) => onChange({ monthlyBudgetUsd: numOrNull(e.target.value) })} />
              </Field>
            </li>
            {check}
          </>
        )}
      </ol>

      {session && (
        <details className="q-details">
          <summary>{t(locale, 'settings.providers.accountEditor.advanced')}</summary>
          <p className="q-note">
            {t(locale, 'settings.providers.accountEditor.sessionNoteBefore')} <code>{session.env}</code>{' '}
            {t(locale, 'settings.providers.accountEditor.sessionNoteAfter', { reopen: t(locale, 'settings.providers.cliConnect.reopenLogin') })}
          </p>
          <Field
            label={t(locale, 'settings.providers.accountEditor.sessionDir')}
            hint={<>{t(locale, 'settings.providers.accountEditor.sessionDirEmpty')} <code>{defaultSessionDir(a, appName)}</code>{t(locale, 'settings.providers.accountEditor.sessionDirMiddle')} <code>{session.file}</code> {t(locale, 'settings.providers.accountEditor.sessionDirEnd')}</>}
          >
            <input type="text" spellCheck={false} value={a.configDir ?? ''} placeholder={defaultSessionDir(a, appName)} onChange={(e) => onChange({ configDir: strOrNull(e.target.value) })} />
          </Field>
        </details>
      )}

      <div className="q-inline">
        <button type="button" className="eg-btn eg-btn--destructive eg-btn--sm" onClick={onRemove}>
          {t(locale, 'settings.providers.accountEditor.remove')}
        </button>
        <small className="eg-field__hint">{t(locale, 'settings.providers.accountEditor.removeHint')}</small>
      </div>
    </Section>
  );
}

/** Nombres de proveedor: marcas, no se traducen; solo `codex` lleva una conjunción
 *  española y tiene `nameKey`. Las descripciones se resuelven con `t()` al pintar. */
const PROVIDER_TABS = [
  { id: 'claude', name: 'Claude', group: 'sub', descKey: 'settings.providers.desc.claude' },
  { id: 'codex', name: 'ChatGPT y Codex', nameKey: 'settings.providers.codexName', group: 'sub', descKey: 'settings.providers.desc.codex' },
  { id: 'gemini', name: 'Gemini', group: 'sub', descKey: 'settings.providers.desc.gemini' },
  { id: 'cursor', name: 'Cursor', group: 'sub', descKey: 'settings.providers.desc.cursor' },
  { id: 'grok', name: 'Grok', group: 'sub', descKey: 'settings.providers.desc.grok' },
  { id: 'copilot', name: 'GitHub Copilot', group: 'sub', descKey: 'settings.providers.desc.copilot' },
  { id: 'minimax', name: 'MiniMax', group: 'sub', descKey: 'settings.providers.desc.minimax' },
  { id: 'nan', name: 'NaN Builders', group: 'api', descKey: 'settings.providers.desc.nan' },
  { id: 'openrouter', name: 'OpenRouter', group: 'api', descKey: 'settings.providers.desc.openrouter' },
  { id: 'anthropic_api', name: 'Anthropic API', group: 'api', descKey: 'settings.providers.desc.anthropicApi' },
  { id: 'openai_api', name: 'OpenAI API', group: 'api', descKey: 'settings.providers.desc.openaiApi' },
  { id: 'nine_router', name: '9Router', group: 'api', descKey: 'settings.providers.desc.nineRouter' },
  { id: 'zai', name: 'z.ai', group: 'sub', descKey: 'settings.providers.desc.zai' },
  { id: 'opencode_go', name: 'OpenCode Go', group: 'sub', descKey: 'settings.providers.desc.opencodeGo' },
] as const satisfies readonly { id: string; name: string; nameKey?: MessageKey; group: 'sub' | 'api'; descKey: MessageKey }[];
/** Nombre visible de un proveedor en el idioma activo. */
const providerName = (p: { name: string; nameKey?: MessageKey }, locale: Locale) => (p.nameKey ? t(locale, p.nameKey) : p.name);
/** Secciones de Ajustes, una por responsabilidad (rediseño de Quorb en Claude Design).
 *  Los textos de cada una viven en el catálogo (`settings.nav.*` y `settings.pages.*`). */
const PAGES = [
  { id: 'providers', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { id: 'look', icon: 'M12 2a10 10 0 1 0 0 20c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2zM13.5 6.5h0M17.5 10.5h0M8.5 7.5h0M6.5 12.5h0' },
  { id: 'alerts', icon: 'M10.27 21a2 2 0 0 0 3.46 0M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33' },
  { id: 'shortcuts', icon: 'M2 4h20v16H2zM6 8h0M10 8h0M14 8h0M18 8h0M8 12h0M12 12h0M16 12h0M7 16h10' },
  { id: 'updates', icon: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5' },
] as const;

type PageId = (typeof PAGES)[number]['id'];
const isPage = (v: unknown): v is PageId => PAGES.some((p) => p.id === v);

function loadSection(): PageId {
  try {
    const v = localStorage.getItem('settingsSection');
    return isPage(v) ? v : 'providers';
  } catch {
    return 'providers';
  }
}

const EDGES: { id: AppConfig['dockEdge']; key: MessageKey }[] = [
  { id: 'left', key: 'settings.look.edgeLeft' },
  { id: 'right', key: 'settings.look.edgeRight' },
  { id: 'top', key: 'settings.look.edgeTop' },
  { id: 'bottom', key: 'settings.look.edgeBottom' },
];

type ProviderTab = (typeof PROVIDER_TABS)[number]['id'];
type ProviderState = 'on' | 'warn' | 'off';

const PROVIDER_BADGE: Record<ProviderState, { labelKey: MessageKey; tone: 'success' | 'warning' | 'neutral' }> = {
  on: { labelKey: 'settings.providers.badge.on', tone: 'success' },
  warn: { labelKey: 'settings.providers.badge.warn', tone: 'warning' },
  off: { labelKey: 'settings.providers.badge.off', tone: 'neutral' },
};

/** Estado de cada pestaña: activo, activo pero sin configurar, o desactivado.
 *  Una cuenta adicional activa y sin conectar también cuenta como «falta conectar». */
function providerState(id: ProviderTab, cfg: AppConfig, s: SecretStatus): ProviderState {
  const main = mainState(id, cfg, s);
  const extras = accountsOf(cfg, id).filter((a) => a.enabled);
  if (extras.some((a) => !accountReady(a, s))) return 'warn';
  return main === 'off' && extras.length > 0 ? 'on' : main;
}

/** Tarjeta de cada proveedor en la lista de «Proveedores». */
function ProviderCard({ locale, tab: p, state: st, extraAccounts, open, onSelect }: {
  locale: Locale;
  tab: (typeof PROVIDER_TABS)[number];
  state: ProviderState;
  extraAccounts: number;
  open: boolean;
  onSelect: () => void;
}) {
  const badge = PROVIDER_BADGE[st];
  return (
    <button
      type="button"
      className="eg-module-card q-provider"
      aria-current={open}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onSelect}
    >
      <span className="eg-module-card__head">
        <span className="q-provider__logo logo">
          <ProviderLogo id={p.id} name={providerName(p, locale)} />
        </span>
        <span className="eg-module-card__name">{providerName(p, locale)}</span>
      </span>
      <span className="q-provider__desc">
        {t(locale, p.descKey)}
        {extraAccounts > 0 && t(locale, 'settings.providers.accountsCount', { count: extraAccounts + 1 })}
      </span>
      <span className="eg-module-card__actions">
        <span className={`eg-status eg-status--${badge.tone}`}>{t(locale, badge.labelKey)}</span>
        <span className="eg-btn eg-btn--ghost eg-btn--sm q-provider__cta" aria-hidden="true">
          {st === 'warn' ? t(locale, 'settings.providers.connect') : t(locale, 'settings.providers.configure')}
        </span>
      </span>
    </button>
  );
}

/** Tarjeta de la página «Proveedores»: intervalo de consulta y las dos listas
 *  (suscripciones y APIs). Extraída para poder renderizarla en pruebas de i18n. */
export function ProvidersCard({ locale, cfg, secrets, tab, drawerOpen, onSelectTab, onRefreshMinutes }: {
  locale: Locale;
  cfg: AppConfig;
  secrets: SecretStatus;
  tab: ProviderTab;
  drawerOpen: boolean;
  onSelectTab: (id: ProviderTab) => void;
  onRefreshMinutes: (minutes: number) => void;
}) {
  const providerCard = (p: (typeof PROVIDER_TABS)[number]) => (
    <ProviderCard
      key={p.id}
      locale={locale}
      tab={p}
      state={providerState(p.id, cfg, secrets)}
      extraAccounts={accountsOf(cfg, p.id).length}
      open={drawerOpen && tab === p.id}
      onSelect={() => onSelectTab(p.id)}
    />
  );
  return (
    <section className="eg-module-card eg-module-card--banded q-section" aria-label={t(locale, 'settings.nav.providers')}>
      <div className="eg-module-card__head">
        <div className="q-section__titles">
          <h2>{t(locale, 'settings.nav.providers')}</h2>
        </div>
        <label className="q-section__aside">
          {t(locale, 'settings.providers.refreshEvery')}
          <input type="number" min={1} max={120} value={cfg.refreshMinutes} onChange={(e) => onRefreshMinutes(Number(e.target.value) || 1)} />
          {t(locale, 'settings.providers.refreshUnit')}
        </label>
      </div>
      <div className="eg-module-card__body">
      <p className="eg-eyebrow">{t(locale, 'settings.providers.subscriptions')}</p>
      <div className="q-providers">{PROVIDER_TABS.filter((p) => p.group === 'sub').map(providerCard)}</div>
      <p className="eg-eyebrow">{t(locale, 'settings.providers.apis')}</p>
      <div className="q-providers">{PROVIDER_TABS.filter((p) => p.group === 'api').map(providerCard)}</div>
      <small className="eg-field__hint">{t(locale, 'settings.providers.orderHint')}</small>
      </div>
    </section>
  );
}

/** Cabecera del panel lateral del proveedor abierto. */
export function ProviderDrawerHead({ locale, tab, state, closeRef, onClose }: {
  locale: Locale;
  tab: ProviderTab;
  state: ProviderState;
  closeRef?: Ref<HTMLButtonElement>;
  onClose: () => void;
}) {
  const current = PROVIDER_TABS.find((entry) => entry.id === tab) ?? PROVIDER_TABS[0];
  const badge = PROVIDER_BADGE[state];
  return (
    <header className="q-drawer__head">
      <span className="q-drawer__logo logo">
        <ProviderLogo id={current.id} name={providerName(current, locale)} />
      </span>
      <div className="q-drawer__titles">
        <p className="eg-eyebrow">{t(locale, 'settings.providers.drawerEyebrow')}</p>
        <h2 id="q-drawer-title">{providerName(current, locale)}</h2>
      </div>
      <span className={`eg-status eg-status--${badge.tone}`}>{t(locale, badge.labelKey)}</span>
      <button ref={closeRef} type="button" className="eg-icon-btn" aria-label={t(locale, 'settings.providers.drawerClose')} onClick={onClose}>
        <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </header>
  );
}

/** Pestañas de cuentas del panel del proveedor (principal + adicionales). */
export function AccountsBar({ locale, tab, accounts, selectedId, onSelect, onAdd }: {
  locale: Locale;
  tab: ProviderTab;
  accounts: Account[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="q-accounts">
      <div className="eg-tabs eg-tabs--sm" role="tablist" aria-label={t(locale, 'settings.providers.accountsAria')}>
        {[{ id: tab as string, label: t(locale, 'settings.providers.mainAccount') }, ...accounts].map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            className="eg-tabs__item"
            aria-selected={selectedId === a.id}
            onClick={() => onSelect(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {tab === 'nine_router' ? (
        <small className="eg-field__hint">{t(locale, 'settings.providers.nineRouterAuto')}</small>
      ) : (
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={onAdd}>
          {t(locale, 'settings.providers.addAccount')}
        </button>
      )}
    </div>
  );
}

/** Pie con el mensaje de guardado y los botones; el del panel lateral cierra el
 *  panel («Listo») y el de la ventana cierra Ajustes («Cerrar»). */
export function SettingsFoot({ locale, variant, saved, dirty, saving, onSave, onClose }: {
  locale: Locale;
  variant: 'drawer' | 'window';
  saved: string | null;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <footer className={variant === 'drawer' ? 'q-drawer__foot' : 'q-foot'}>
      <span className="q-foot__msg" role="status">{saved}</span>
      {variant === 'drawer' ? (
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={onClose}>
          {t(locale, 'settings.shell.done')}
        </button>
      ) : (
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={onClose}>
          {t(locale, 'settings.shell.close')}
        </button>
      )}
      <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={onSave} disabled={!dirty || saving}>
        {saving ? t(locale, 'settings.shell.saving') : t(locale, 'settings.shell.saveChanges')}
      </button>
    </footer>
  );
}

/** Interruptor «Arrancar al iniciar sesión» de la cabecera de Ajustes. */
export function AutostartSwitch({ locale, checked, disabled, onChange }: {
  locale: Locale;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="eg-check eg-check--switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{' '}
      {t(locale, 'settings.shell.autostart')}
    </label>
  );
}

/** Aviso de fallo del autostart; si ni se pudo leer, ofrece reintentar. */
export function AutostartNotice({ locale, error, unread, busy, onRetry }: {
  locale: Locale;
  error: string;
  unread: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="eg-notice eg-notice--warning eg-notice--sm" role="alert">
      <span className="eg-notice__text">
        {unread ? t(locale, 'settings.shell.autostartReadError') : ''}
        {error}
      </span>
      {unread && (
        <span className="eg-notice__actions">
          <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={busy} onClick={onRetry}>
            {t(locale, 'settings.common.retry')}
          </button>
        </span>
      )}
    </div>
  );
}

/** Bloque informativo «Sesión de escritorio» (solo Linux). */
export function DesktopSessionNotice({ locale, wmInfo }: { locale: Locale; wmInfo: WindowManagerInfo }) {
  return (
    <div className="eg-notice eg-notice--sm" role="status">
      <span className="eg-notice__text">
        <strong>
          {t(locale, 'settings.shell.desktopSession', { session: wmInfo.isWayland ? 'Wayland' : wmInfo.xdgSessionType ?? 'X11' })}
          {wmInfo.desktopSession ? ` · ${wmInfo.desktopSession}` : ''}
        </strong>
      </span>
      <p className="eg-notice__text">{wmInfo.recommendation}</p>
      <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
        {desktopCompatRows(wmInfo.surfaces, locale).map((row) => (
          <li key={row.label}>
            <strong>{row.label}</strong> ·{' '}
            {row.state === 'limited' ? <em>{t(locale, 'settings.shell.surfaceLimited')}</em> : <em>{t(locale, 'settings.shell.surfaceUnlimited')}</em>} {row.note}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Errores y avisos del último registro de atajos, para el panel de «Atajos».
 *  Extraída igual que SettingsNav para poder renderizarla en pruebas sin montar
 *  la ventana completa. Los errores son fallos de registro (rojo, alert); los
 *  avisos son degradación informada — p. ej. registro vía X11/XWayland bajo
 *  Wayland (#181) — y se muestran neutros, sin afirmar activación. */
export function ShortcutNotices({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  return (
    <>
      {errors.map((e) => (
        <div key={e} className="eg-notice eg-notice--danger eg-notice--sm" role="alert">
          <span className="eg-notice__text">{e}</span>
        </div>
      ))}
      {warnings.map((w) => (
        <div key={w} className="eg-notice eg-notice--warning eg-notice--sm" role="status">
          <span className="eg-notice__text">{w}</span>
        </div>
      ))}
    </>
  );
}

/** Sección «Apariencia»: anillos, color de acento y tira. Extraída igual que
 *  SettingsNav para poder renderizarla en pruebas de i18n con el locale
 *  explícito sin montar la ventana completa. */
export function LookSection({ locale, cfg, liveError, onOrbSize, onAccent, onLiveChange, onRetry }: {
  locale: Locale;
  cfg: AppConfig;
  liveError: string | null;
  onOrbSize: (v: number) => void;
  onAccent: (hex: string) => void;
  onLiveChange: (patch: Partial<AppConfig>) => void;
  onRetry: () => void;
}) {
  const palette = derivePalette(cfg.accentColor);
  return (
    <>
      <Section title={t(locale, 'settings.look.rings')}>
        <div className="q-preview">
          <span className="eg-gauge" role="img" aria-label={t(locale, 'settings.look.previewAria', { size: cfg.orbSize })} style={{ '--size': `${cfg.orbSize}px` } as CSSProperties}>
            <span className="eg-gauge__ring" style={{ '--p': 0.82 } as CSSProperties} />
            {!cfg.compact && <span className="eg-gauge__ring" style={{ '--p': 0.46 } as CSSProperties} />}
            {!cfg.compact && cfg.orbSize >= 40 && <span className="eg-gauge__ring" style={{ '--p': 0.31 } as CSSProperties} />}
            <span className="eg-gauge__logo logo">
              <ProviderLogo id="claude" name="Claude" />
            </span>
          </span>
          <Field label={t(locale, 'settings.look.ringSize')} value={`${cfg.orbSize} px`} hint={<button type="button" className="q-link" onClick={() => onOrbSize(ORB_SIZE.default)}>{t(locale, 'settings.look.resetSize', { size: ORB_SIZE.default })}</button>}>
            <input type="range" min={ORB_SIZE.min} max={ORB_SIZE.max} step={2} value={cfg.orbSize} style={rangeFill(cfg.orbSize, ORB_SIZE.min, ORB_SIZE.max)} onChange={(e) => onOrbSize(Number(e.target.value))} />
          </Field>
        </div>
        <div className="eg-field">
          <span className="eg-field__label">{t(locale, 'settings.look.accent')}</span>
          <div className="q-swatches">
            {ACCENT_PRESETS.map((c) => (
              <button key={c} type="button" className="q-swatch" style={{ background: c }} aria-label={t(locale, 'settings.look.useSwatch', { color: c })} aria-pressed={normalizeHex(cfg.accentColor) === c} onClick={() => onAccent(c)} />
            ))}
            <label className="q-swatch q-swatch--picker" title={t(locale, 'settings.look.pickAnyColor')}>
              <input type="color" value={normalizeHex(cfg.accentColor)} onChange={(e) => onAccent(e.target.value)} />
              <span aria-hidden="true">+</span>
            </label>
          </div>
          <span className="q-palette" aria-label={t(locale, 'settings.look.palette')}>
            {palette.map((c, i) => (
              <span key={i}>
                <i style={{ background: c }} />
                {c}
              </span>
            ))}
          </span>
          <small className="eg-field__hint">
            {t(locale, 'settings.look.accentHint')}{' '}
            <button type="button" className="q-link" onClick={() => onAccent(DEFAULT_ACCENT)}>{t(locale, 'settings.look.resetEgdevRed')}</button>
          </small>
        </div>
        <Field label={t(locale, 'settings.look.stripOpacity')} value={`${Math.round(cfg.opacity * 100)} %`}>
          <input type="range" min={0.3} max={1} step={0.02} value={cfg.opacity} style={rangeFill(cfg.opacity, 0.3, 1)} onChange={(e) => onLiveChange({ opacity: Number(e.target.value) })} />
        </Field>
        <Rows>
          <Toggle label={t(locale, 'settings.look.compact')} hint={t(locale, 'settings.look.compactHint')} checked={cfg.compact} onChange={(v) => onLiveChange({ compact: v })} />
          <Toggle label={t(locale, 'settings.look.showResets')} hint={t(locale, 'settings.look.showResetsHint')} checked={cfg.showResets ?? true} onChange={(v) => onLiveChange({ showResets: v })} />
        </Rows>
      </Section>

      <Section title={t(locale, 'settings.look.strip')}>
        <div className="eg-field">
          <span className="eg-field__label" id="lb-edge">{t(locale, 'settings.look.edge')}</span>
          <div className="q-chips" role="radiogroup" aria-labelledby="lb-edge">
            {EDGES.map((e) => (
              <button key={e.id} type="button" role="radio" aria-checked={cfg.dockEdge === e.id} className={`eg-chip${cfg.dockEdge === e.id ? ' is-active' : ''}`} onClick={() => onLiveChange({ dockEdge: e.id })}>
                {t(locale, e.key)}
              </button>
            ))}
          </div>
          <small className="eg-field__hint">{t(locale, 'settings.look.dragHint')}</small>
        </div>
        <Field label={t(locale, 'settings.look.dockPosition')} value={`${Math.round(cfg.dockOffset * 100)} %`}>
          <input type="range" min={0} max={1} step={0.01} value={cfg.dockOffset} style={rangeFill(cfg.dockOffset, 0, 1)} onChange={(e) => onLiveChange({ dockOffset: Number(e.target.value) })} />
        </Field>
        <Rows>
          <Toggle label={t(locale, 'settings.look.autoHide')} hint={t(locale, 'settings.look.autoHideHint')} checked={cfg.autoHide} onChange={(v) => onLiveChange({ autoHide: v })} />
          <Toggle label={t(locale, 'settings.look.alwaysOnTop')} hint={t(locale, 'settings.look.alwaysOnTopHint')} checked={cfg.alwaysOnTop} onChange={(v) => onLiveChange({ alwaysOnTop: v })} />
        </Rows>
        {liveError && (
          <div className="eg-field" role="alert">
            <span className="eg-field__label">{t(locale, 'settings.look.liveError')}</span>
            <small className="eg-field__hint">{liveError}</small>
            <button type="button" className="q-link" onClick={onRetry}>{t(locale, 'settings.common.retry')}</button>
          </div>
        )}
      </Section>
    </>
  );
}

/** Sección «Alertas»: cuándo avisar (dos momentos) y el efecto propio. Extraída
 *  por el mismo motivo que LookSection. */
export function AlertsSection({ locale, alerts, onAlerts, onPersist, onError }: {
  locale: Locale;
  alerts: AlertsConfig;
  onAlerts: (patch: Partial<AlertsConfig>) => void;
  onPersist: (alerts: AlertsConfig) => Promise<void>;
  onError: (msg: string) => void;
}) {
  return (
    <>
      <Section title={t(locale, 'settings.alerts.when')}>
        <Rows>
          <Toggle label={t(locale, 'settings.alerts.enable')} checked={alerts.enabled} onChange={(v) => onAlerts({ enabled: v })} />
          <Toggle label={t(locale, 'settings.alerts.native')} hint={t(locale, 'settings.alerts.nativeHint')} checked={alerts.native} onChange={(v) => onAlerts({ native: v })} />
        </Rows>
        <div className="q-moment">
          <h3>{t(locale, 'settings.alerts.exceededTitle')}</h3>
          <Field label={t(locale, 'settings.alerts.threshold')} value={`${Math.round(alerts.threshold)} %`} hint={t(locale, 'settings.alerts.thresholdHint')}>
            <input type="range" min={50} max={100} step={1} value={alerts.threshold} style={rangeFill(alerts.threshold, 50, 100)} onChange={(e) => onAlerts({ threshold: Number(e.target.value) })} />
          </Field>
          <MomentEffect locale={locale} moment="exceeded" effect={alerts.exceededEffect} media={alerts.exceededMedia} alerts={alerts} onEffect={(v) => onAlerts({ exceededEffect: v })} onMedia={(v) => onAlerts({ exceededMedia: v })} onPersist={onPersist} onError={onError} />
        </div>
        <div className="q-moment">
          <h3>{t(locale, 'settings.alerts.resetTitle')}</h3>
          <Rows>
            <Toggle label={t(locale, 'settings.alerts.onReset')} hint={t(locale, 'settings.alerts.onResetHint')} checked={alerts.onReset} onChange={(v) => onAlerts({ onReset: v })} />
          </Rows>
          {alerts.onReset && (
            <MomentEffect locale={locale} moment="reset" effect={alerts.resetEffect} media={alerts.resetMedia} alerts={alerts} onEffect={(v) => onAlerts({ resetEffect: v })} onMedia={(v) => onAlerts({ resetMedia: v })} onPersist={onPersist} onError={onError} />
          )}
        </div>
      </Section>

      <Section title={t(locale, 'settings.alerts.custom.title')}>
        <p className="q-note">
          {t(locale, 'settings.alerts.custom.note')}
        </p>
        <Field label={t(locale, 'settings.alerts.custom.size')}>
          <select value={alerts.mediaSize} onChange={(e) => onAlerts({ mediaSize: e.target.value as MediaSize })}>
            <option value="small">{t(locale, 'settings.alerts.custom.sizeSmall')}</option>
            <option value="medium">{t(locale, 'settings.alerts.custom.sizeMedium')}</option>
            <option value="full">{t(locale, 'settings.alerts.custom.sizeFull')}</option>
          </select>
        </Field>
        <Rows>
          <Toggle label={t(locale, 'settings.alerts.custom.sound')} hint={t(locale, 'settings.alerts.custom.soundHint')} checked={alerts.mediaSound} onChange={(v) => onAlerts({ mediaSound: v })} />
        </Rows>
      </Section>
    </>
  );
}

/** Sección «Atajos»: interruptor global, tabla de atajos y avisos del registro.
 *  Extraída por el mismo motivo que LookSection. */
export function ShortcutsSection({ locale, shortcuts, onShortcuts, errors, warnings }: {
  locale: Locale;
  shortcuts: ShortcutsConfig;
  onShortcuts: (patch: Partial<ShortcutsConfig>) => void;
  errors: string[];
  warnings: string[];
}) {
  return (
    <Section title={t(locale, 'settings.shortcuts.title')}>
      <Rows>
        <Toggle label={t(locale, 'settings.shortcuts.enable')} hint={t(locale, 'settings.shortcuts.enableHint')} checked={shortcuts.enabled} onChange={(v) => onShortcuts({ enabled: v })} />
      </Rows>
      {shortcuts.enabled && (
        <>
          <div className="eg-table-wrap">
            <table className="eg-table eg-table--compact">
              <caption className="q-sr">{t(locale, 'settings.shortcuts.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(locale, 'settings.shortcuts.colAction')}</th>
                  <th scope="col">{t(locale, 'settings.shortcuts.colShortcut')}</th>
                  <th scope="col" className="eg-table__acts"><span className="q-sr">{t(locale, 'settings.shortcuts.colActions')}</span></th>
                </tr>
              </thead>
              <tbody>
                <ShortcutRow locale={locale} label={t(locale, 'settings.shortcuts.toggleStrip')} value={shortcuts.toggle} onChange={(v) => onShortcuts({ toggle: v })} />
                <ShortcutRow locale={locale} label={t(locale, 'settings.shortcuts.openPeak')} value={shortcuts.openPeak} onChange={(v) => onShortcuts({ openPeak: v })} />
                <ShortcutRow locale={locale} label={t(locale, 'settings.shortcuts.refreshNow')} value={shortcuts.refresh} onChange={(v) => onShortcuts({ refresh: v })} />
              </tbody>
            </table>
          </div>
          <ShortcutNotices errors={errors} warnings={warnings} />
          <small className="eg-field__hint">{t(locale, 'settings.shortcuts.hint')}</small>
        </>
      )}
    </Section>
  );
}

/** Sección «Proyecto» (junto a la de actualizaciones). Extraída por el mismo
 *  motivo que LookSection. */
export function ProjectSection({ locale }: { locale: Locale }) {
  return (
    <Section title={t(locale, 'settings.updates.project')}>
      <p className="q-note">{t(locale, 'settings.updates.projectNote')}</p>
      <div className="q-chips">
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => openUrl(LINKS.repo)}>GitHub</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => openUrl(LINKS.issues)}>{t(locale, 'settings.updates.requestProvider')}</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => openUrl(LINKS.web)}>egdev.es</button>
      </div>
    </Section>
  );
}

function mainState(id: ProviderTab, cfg: AppConfig, s: SecretStatus): ProviderState {
  const on = (enabled: boolean, ready = true): ProviderState => (!enabled ? 'off' : ready ? 'on' : 'warn');
  switch (id) {
    case 'claude':
      return on(cfg.claude.enabled);
    case 'codex':
      return on(cfg.codex.enabled);
    case 'gemini':
      return on(cfg.gemini.enabled);
    case 'grok':
      return on(cfg.grok.enabled);
    case 'cursor':
      return on(cfg.cursor.enabled);
    case 'copilot':
      return on(cfg.copilot.enabled, !!s.github_token && cfg.copilot.username.trim() !== '');
    case 'nan':
      return on(cfg.nan.enabled, !!s.nan_session || !!s.nan_api_key);
    case 'openrouter':
      return on(cfg.openrouter.enabled, !!s.openrouter_api_key);
    case 'minimax':
      // Solo la Subscription Key es obligatoria; el saldo PAYG es un extra opcional.
      return on(cfg.minimax.enabled, !!s.minimax_subscription_key);
    case 'anthropic_api':
      return on(cfg.anthropicApi.enabled, !!s.anthropic_admin_key);
    case 'openai_api':
      return on(cfg.openaiApi.enabled, !!s.openai_admin_key);
    case 'nine_router':
      return on(cfg.nineRouter.enabled, !!s.nine_router_password);
    case 'zai':
      return on(cfg.zai.enabled, !!s.zai_api_key);
    case 'opencode_go':
      return on(cfg.opencodeGo.enabled, !!s.opencode_go_api_key);
  }
}

const isProviderTab = (v: unknown): v is ProviderTab => PROVIDER_TABS.some((t) => t.id === v);

function loadTab(): ProviderTab {
  try {
    const v = localStorage.getItem('settingsTab');
    return isProviderTab(v) ? v : 'claude';
  } catch {
    return 'claude';
  }
}

/** Cabecera de títulos de Ajustes (ceja + h1 + descripción). Extraída para poder
 *  renderizar y probar el corte visible de i18n sin montar la ventana completa. */
export function SettingsHeadTitles({ locale, section }: { locale: Locale; section: PageId }) {
  return (
    <div className="q-head__titles">
      <p className="eg-eyebrow">{t(locale, 'settings.title')}</p>
      <h1>{t(locale, `settings.pages.${section}.title`)}</h1>
      <p className="q-head__desc">{t(locale, `settings.pages.${section}.desc`)}</p>
    </div>
  );
}

/** Barra lateral de Ajustes: marca, secciones y plegado. Extraída por el mismo
 *  motivo: renderizable en pruebas con el locale explícito. */
export function SettingsNav({
  appName,
  section,
  locale,
  navCollapsed,
  onSelectSection,
  onToggleNav,
  pendingProviders,
  shortcutErrors,
  shortcutWarnings,
}: {
  appName: string | null;
  section: PageId;
  locale: Locale;
  navCollapsed: boolean;
  onSelectSection: (p: PageId) => void;
  onToggleNav: () => void;
  pendingProviders: number;
  shortcutErrors: string[];
  shortcutWarnings: string[];
}) {
  return (
    <aside className="q-settings__nav" aria-label="Quorb">
      <div className="q-brand">
        <img className="q-brand__logo" src={quorbLogo} alt="" aria-hidden="true" />
        <span className="q-brand__text">
          <span className="q-brand__name">{appName ?? '…'}</span>
          <span className="q-brand__ver">{t(locale, 'settings.title')}</span>
        </span>
      </div>
      <nav aria-label={t(locale, 'settings.nav.sectionsAria')}>
        <ul className="eg-menu eg-menu--nav">
          {PAGES.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="eg-menu__item"
                aria-current={section === p.id ? 'page' : undefined}
                aria-label={navCollapsed ? t(locale, `settings.nav.${p.id}`) : undefined}
                title={navCollapsed ? t(locale, `settings.nav.${p.id}`) : undefined}
                onClick={() => onSelectSection(p.id)}
              >
                <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d={p.icon} />
                </svg>
                <span className="eg-menu__label">{t(locale, `settings.nav.${p.id}`)}</span>
                {p.id === 'providers' && pendingProviders > 0 && (
                  <span className="eg-menu__count" title={t(locale, 'settings.nav.pendingTitle')}>{pendingProviders}</span>
                )}
                {p.id === 'shortcuts' && shortcutErrors.length + shortcutWarnings.length > 0 && (
                  <span className="eg-menu__count">{shortcutErrors.length + shortcutWarnings.length}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <button
        type="button"
        className="eg-menu__item q-nav-toggle"
        aria-expanded={!navCollapsed}
        aria-label={navCollapsed ? t(locale, 'settings.nav.expand') : t(locale, 'settings.nav.collapse')}
        title={navCollapsed ? t(locale, 'settings.nav.expand') : t(locale, 'settings.nav.collapse')}
        onClick={onToggleNav}
      >
        <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 4h18v16H3zM9 4v16" />
          <path d={navCollapsed ? 'm13 10 2 2-2 2' : 'm15 10-2 2 2 2'} />
        </svg>
        <span className="eg-menu__label">{t(locale, 'settings.nav.collapseShort')}</span>
      </button>
    </aside>
  );
}

/** Lo que comparten los paneles por proveedor de suscripción de Ajustes › Proveedores. */
type PanelProps = {
  locale: Locale;
  cfg: AppConfig;
  secrets: SecretStatus;
  set: <K extends keyof AppConfig>(key: K, patch: Partial<AppConfig[K]> | AppConfig[K]) => void;
  setVisibility: (id: string, enabled: boolean) => void;
  loadSecrets: () => void;
  healthFor: (id: string, hidden: boolean) => HealthProps;
};

/** Paneles por proveedor de suscripción (Claude, Codex, Gemini, Grok, Cursor, Copilot, MiniMax,
 *  z.ai y OpenCode Go). Extraídos de `Settings()` para poder renderizarlos en pruebas de i18n.
 *  Los títulos son marcas con su plan (`Claude (Pro / Max)`) y no se traducen. */
export function SubscriptionPanel({
  locale,
  cfg,
  set,
  setVisibility,
  healthFor,
  p,
  cli,
  codexInstall,
  onCodexRecheck,
}: Pick<PanelProps, 'locale' | 'cfg' | 'set' | 'setVisibility' | 'healthFor'> & {
  p: 'claude' | 'codex' | 'gemini' | 'grok';
  cli: Record<string, boolean>;
  codexInstall: CodexInstallController;
  onCodexRecheck: () => void;
}) {
  const info = {
    claude: {
      kicker: t(locale, 'settings.providers.panels.kickerOAuth'),
      title: 'Claude (Pro / Max)',
      note: t(locale, 'settings.providers.panels.claude.note'),
      file: t(locale, 'settings.providers.panels.credentialsFile'),
      hint: <>{t(locale, 'settings.providers.panels.emptyEquals')} <code>%USERPROFILE%\.claude\.credentials.json</code>. {t(locale, 'settings.providers.panels.claude.wsl')} <code>\\wsl.localhost\Ubuntu\home\{t(locale, 'settings.providers.panels.claude.wslUser')}\.claude\.credentials.json</code></>,
    },
    codex: {
      kicker: t(locale, 'settings.providers.panels.kickerOAuth'),
      title: 'ChatGPT (Plus / Pro · Codex)',
      note: t(locale, 'settings.providers.panels.codex.note'),
      file: t(locale, 'settings.providers.panels.authJsonFile'),
      hint: <>{t(locale, 'settings.providers.panels.emptyEquals')} <code>%CODEX_HOME%</code> {t(locale, 'settings.providers.panels.or')} <code>%USERPROFILE%\.codex\auth.json</code></>,
    },
    gemini: {
      kicker: t(locale, 'settings.providers.panels.gemini.kicker'),
      title: 'Gemini (Google AI Pro / Code Assist)',
      note: (
        <>
          {t(locale, 'settings.providers.panels.gemini.noteBefore')} <Link href={LINKS.geminiCli}>Gemini CLI</Link>{t(locale, 'settings.providers.panels.gemini.noteAfter')}
        </>
      ),
      file: t(locale, 'settings.providers.panels.credentialsFile'),
      hint: <>{t(locale, 'settings.providers.panels.emptyEquals')} <code>%USERPROFILE%\.gemini\oauth_creds.json</code></>,
    },
    grok: {
      kicker: t(locale, 'settings.providers.panels.kickerOAuth'),
      title: 'Grok (SuperGrok)',
      note: (
        <>
          {t(locale, 'settings.providers.panels.grok.noteBefore')} <code>grok login</code>{t(locale, 'settings.providers.panels.grok.noteAfter')}
        </>
      ),
      file: t(locale, 'settings.providers.panels.authJsonFile'),
      hint: <>{t(locale, 'settings.providers.panels.emptyEquals')} <code>%GROK_HOME%</code> {t(locale, 'settings.providers.panels.or')} <code>%USERPROFILE%\.grok\auth.json</code></>,
    },
  }[p];
  return (
    <Section kicker={info.kicker} title={info.title}>
      <Toggle label={t(locale, 'settings.providers.showInWidget')} checked={isAccountVisible(cfg, p, cfg[p].enabled)} onChange={(v) => setVisibility(p, v)} />
      <p className="q-note">{info.note}</p>
      <ol className="q-steps" aria-label={t(locale, 'settings.providers.panels.stepsAria')}>
        <CliConnect
          locale={locale}
          id={p}
          provider={p}
          loginCommand={cfg[p].loginCommand}
          cliMissing={cli[p] === false}
          persisted
          extra={false}
          health={healthFor(p, !cfg[p].enabled)}
          codexInstall={codexInstall}
          onCodexRecheck={onCodexRecheck}
        />
      </ol>
      <details className="q-details">
        <summary>{t(locale, 'settings.providers.panels.advancedSessionLogin')}</summary>
        <Field label={info.file} hint={info.hint}>
          <input type="text" spellCheck={false} value={cfg[p].credentialsPath ?? ''} onChange={(e) => set(p, { credentialsPath: strOrNull(e.target.value) })} />
        </Field>
        <Field label={t(locale, 'settings.providers.panels.loginCommand')}>
          <input type="text" spellCheck={false} value={cfg[p].loginCommand} onChange={(e) => set(p, { loginCommand: e.target.value })} />
        </Field>
      </details>
    </Section>
  );
}

export function CursorPanel({ locale, cfg, secrets, set, setVisibility, loadSecrets, healthFor }: PanelProps) {
  return (
    <Section kicker={t(locale, 'settings.providers.panels.cursor.kicker')} title="Cursor">
      <Toggle label={t(locale, 'settings.providers.showInWidget')} checked={isAccountVisible(cfg, 'cursor', cfg.cursor.enabled)} onChange={(v) => setVisibility('cursor', v)} />
      <p className="q-note">{t(locale, 'settings.providers.panels.cursor.note')}</p>
      <ol className="q-steps" aria-label={t(locale, 'settings.providers.panels.stepsAria')}>
        <li>
          <b>{t(locale, 'settings.providers.panels.cursor.loginTitle')}</b>
          <span>{t(locale, 'settings.providers.panels.cursor.loginBody')}</span>
          <SecretInput locale={locale} id="cursor_token" label={t(locale, 'settings.providers.panels.cursor.tokenLabel')} configured={!!secrets.cursor_token} onSaved={loadSecrets} />
        </li>
        <HealthStep id="cursor" {...healthFor('cursor', !cfg.cursor.enabled)} />
      </ol>
      <details className="q-details">
        <summary>{t(locale, 'settings.providers.panels.cursor.advanced')}</summary>
        <Field label={t(locale, 'settings.providers.panels.cursor.dbLabel')} hint={<>{t(locale, 'settings.providers.panels.emptyEquals')} <code>%APPDATA%\Cursor\User\globalStorage\state.vscdb</code></>}>
          <input type="text" spellCheck={false} value={cfg.cursor.credentialsPath ?? ''} onChange={(e) => set('cursor', { credentialsPath: strOrNull(e.target.value) })} />
        </Field>
      </details>
    </Section>
  );
}

export function CopilotPanel({ locale, cfg, secrets, set, setVisibility, loadSecrets, healthFor }: PanelProps) {
  return (
    <Section kicker={t(locale, 'settings.providers.panels.kickerOfficialApi')} title="GitHub Copilot">
      <Toggle label={t(locale, 'settings.providers.showInWidget')} checked={isAccountVisible(cfg, 'copilot', cfg.copilot.enabled)} onChange={(v) => setVisibility('copilot', v)} />
      <p className="q-note">{t(locale, 'settings.providers.panels.copilot.note')}</p>
      <ol className="q-steps" aria-label={t(locale, 'settings.providers.panels.stepsAria')}>
        <li data-done={cfg.copilot.username.trim() !== '' || undefined}>
          <b>{t(locale, 'settings.providers.accountEditor.copilotUserPlan')}</b>
          <div className="q-cols">
            <Field label={t(locale, 'settings.providers.accountEditor.githubUser')}>
              <input type="text" spellCheck={false} placeholder="egdev6" value={cfg.copilot.username} onChange={(e) => set('copilot', { username: e.target.value })} />
            </Field>
            <Field label={t(locale, 'settings.providers.planLabel')}>
              <select value={cfg.copilot.plan} onChange={(e) => set('copilot', { plan: e.target.value })}>
                <option value="free">Free · 50</option>
                <option value="pro">Pro · 300</option>
                <option value="pro_plus">Pro+ · 1500</option>
                <option value="business">Business · 300</option>
                <option value="enterprise">Enterprise · 1000</option>
                <option value="custom">{t(locale, 'settings.providers.accountEditor.planCustom')}</option>
              </select>
            </Field>
          </div>
          {cfg.copilot.plan === 'custom' && (
            <Field label={t(locale, 'settings.providers.accountEditor.customAllowance')}>
              <input type="number" min={1} value={cfg.copilot.customAllowance ?? ''} onChange={(e) => set('copilot', { customAllowance: numOrNull(e.target.value) })} />
            </Field>
          )}
        </li>
        <li data-done={!!secrets.github_token || undefined}>
          <b>{t(locale, 'settings.providers.accountEditor.readOnlyToken')}</b>
          <SecretInput
            locale={locale}
            id="github_token"
            label={t(locale, 'settings.providers.panels.copilot.tokenLabel')}
            configured={!!secrets.github_token}
            onSaved={loadSecrets}
            hint={<>{t(locale, 'settings.providers.panels.copilot.tokenCreateIn')} <Link href={LINKS.githubToken}>GitHub › Fine-grained tokens</Link> {t(locale, 'settings.providers.panels.copilot.tokenPermission')}</>}
          />
        </li>
        <HealthStep id="copilot" {...healthFor('copilot', !cfg.copilot.enabled)} />
      </ol>
    </Section>
  );
}

export function MiniMaxPanel({ locale, cfg, secrets, set, setVisibility, loadSecrets, healthFor }: PanelProps) {
  return (
    <Section kicker={t(locale, 'settings.providers.panels.kickerOfficialApi')} title="MiniMax">
      <Toggle label={t(locale, 'settings.providers.showInWidget')} checked={isAccountVisible(cfg, 'minimax', cfg.minimax.enabled)} onChange={(v) => setVisibility('minimax', v)} />
      <p className="q-note">
        {t(locale, 'settings.providers.panels.minimax.noteBefore')}
        <b> {t(locale, 'settings.providers.panels.minimax.noteBold')}</b> {t(locale, 'settings.providers.panels.minimax.noteAfter')}
      </p>
      <ol className="q-steps" aria-label={t(locale, 'settings.providers.panels.stepsAria')}>
        <li data-done={!!secrets.minimax_subscription_key || undefined}>
          <b>{t(locale, 'settings.providers.panels.minimax.subscriptionTitle')}</b>
          <SecretInput
            locale={locale}
            id="minimax_subscription_key"
            label="Subscription Key"
            configured={!!secrets.minimax_subscription_key}
            onSaved={loadSecrets}
            hint={<>{t(locale, 'settings.providers.panels.minimax.subscriptionHintBefore')} <Link href={LINKS.minimaxKeys}>minimax.io</Link>{t(locale, 'settings.providers.panels.minimax.subscriptionHintChina')} <Link href={LINKS.minimaxKeysCn}>minimaxi.com</Link> {t(locale, 'settings.providers.panels.minimax.subscriptionHintAfter')}</>}
          />
        </li>
        <li data-done={!!secrets.minimax_api_key || undefined}>
          <b>{t(locale, 'settings.providers.panels.minimax.paygTitle')}</b>
          <SecretInput
            locale={locale}
            id="minimax_api_key"
            label="API key PAYG"
            configured={!!secrets.minimax_api_key}
            onSaved={loadSecrets}
            hint={t(locale, 'settings.providers.panels.minimax.paygHint')}
          />
        </li>
        <HealthStep id="minimax" {...healthFor('minimax', !cfg.minimax.enabled)} />
      </ol>
      <details className="q-details">
        <summary>{t(locale, 'settings.providers.panels.minimax.advanced')}</summary>
        <Field
          label="Base URL"
          hint={t(locale, 'settings.providers.panels.minimax.baseUrlHint')}
        >
          <input
            type="text"
            spellCheck={false}
            value={cfg.minimax.baseUrl}
            onChange={(e) => set('minimax', { baseUrl: e.target.value })}
          />
        </Field>
      </details>
    </Section>
  );
}

export function ZaiPanel({ locale, cfg, secrets, setVisibility, loadSecrets, healthFor }: PanelProps) {
  return (
    <Section kicker={t(locale, 'settings.providers.panels.zai.kicker')} title="z.ai">
      <Toggle label={t(locale, 'settings.providers.showInWidget')} checked={isAccountVisible(cfg, 'zai', cfg.zai.enabled)} onChange={(v) => setVisibility('zai', v)} />
      <p className="q-note">{t(locale, 'settings.providers.panels.zai.note')}</p>
      <ol className="q-steps" aria-label={t(locale, 'settings.providers.panels.stepsAria')}>
        <li data-done={!!secrets.zai_api_key || undefined}>
          <b>{t(locale, 'settings.providers.apiKey')}</b>
          <SecretInput
            locale={locale}
            id="zai_api_key"
            label={t(locale, 'settings.providers.apiKey')}
            configured={!!secrets.zai_api_key}
            onSaved={loadSecrets}
            hint={<>{t(locale, 'settings.providers.accountEditor.createIn')} <Link href={LINKS.zaiKeys}>z.ai › API Keys</Link>.</>}
          />
        </li>
        <HealthStep id="zai" {...healthFor('zai', !cfg.zai.enabled)} />
      </ol>
    </Section>
  );
}

export function OpenCodeGoPanel({ locale, cfg, secrets, setVisibility, loadSecrets, healthFor }: PanelProps) {
  return (
    <Section kicker={t(locale, 'settings.providers.panels.opencodeGo.kicker')} title="OpenCode Go">
      <Toggle label={t(locale, 'settings.providers.showInWidget')} checked={isAccountVisible(cfg, 'opencode_go', cfg.opencodeGo.enabled)} onChange={(v) => setVisibility('opencode_go', v)} />
      <p className="q-note">{t(locale, 'settings.providers.panels.opencodeGo.note')}</p>
      <ol className="q-steps" aria-label={t(locale, 'settings.providers.panels.stepsAria')}>
        <li data-done={!!secrets.opencode_go_api_key || undefined}>
          <b>{t(locale, 'settings.providers.apiKey')}</b>
          <SecretInput
            locale={locale}
            id="opencode_go_api_key"
            label={t(locale, 'settings.providers.accountEditor.apiKeyOf', { name: 'OpenCode Go' })}
            configured={!!secrets.opencode_go_api_key}
            onSaved={loadSecrets}
            hint={<>{t(locale, 'settings.providers.accountEditor.createIn')} <Link href={LINKS.opencodeConsole}>OpenCode › Console</Link>.</>}
          />
        </li>
        <HealthStep id="opencode_go" {...healthFor('opencode_go', !cfg.opencodeGo.enabled)} />
      </ol>
    </Section>
  );
}


export function Settings() {
  const appName = useAppName();
  // Idioma de esta ventana: una lectura + `config-changed`; `es` hasta cargar.
  const locale = useLocale();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [baseline, setBaseline] = useState<AppConfig | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus>({});
  // CLIs de login instalados (Claude Code, Codex, Gemini): se avisa antes de pulsar
  // «Iniciar sesión» y se detecta solo cuando se instala (cada 5 s o al volver a la ventana).
  const [cli, setCli] = useState<Record<string, boolean>>({});
  // Relectura puntual del CLI fuera del intervalo: la usa la instalación asistida
  // al terminar para habilitar el login sin depender de que la ventana siga abierta.
  const cliRecheck = useCallback(() => {
    api
      .cliStatus()
      .then(setCli)
      .catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .cliStatus()
        .then((st) => alive && setCli(st))
        .catch(() => {});
    check();
    const t = window.setInterval(check, 5000);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener('focus', check);
    };
  }, []);
  // Controlador de la instalación asistida de Codex: vive en la raíz de Ajustes
  // para seguir vivo si el aviso del CLI desaparece (o se desmonta) antes de que
  // resuelva la instalación. Nunca instala por sí solo: solo lee estado pasivo.
  const [codexInstaller] = useState(() =>
    createCodexInstallController({
      getStatus: () => api.codexSetupStatus(),
      install: () => api.installCodex(),
      onInstalled: () => cliRecheck(),
    }),
  );
  useEffect(() => {
    codexInstaller.start();
    return () => codexInstaller.stop();
  }, [codexInstaller]);
  const [autostartController] = useState(() => createAutostartController({ read: isEnabled, enable, disable }));
  const [autostartState, setAutostartState] = useState(() => autostartController.getState());
  const [autostartDraft, setAutostartDraft] = useState<boolean | null>(null);
  // El borrador solo se siembra con la primera lectura: los reintentos no pisan ediciones.
  const autostartDraftReady = useRef(false);
  // Guarda síncrona además de `saving`: evita guardados manuales solapados.
  const savingRef = useRef(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<ProviderTab>(loadTab);
  // Cuenta abierta en el panel del proveedor: su id, o el del proveedor para la principal.
  const [accountSel, setAccountSel] = useState<string>(tab);
  // Menú lateral contraíble: solo iconos, recordado en este equipo.
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('settingsNavCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleNav = () =>
    setNavCollapsed((v) => {
      try {
        localStorage.setItem('settingsNavCollapsed', v ? '0' : '1');
      } catch {
        /* sin almacenamiento */
      }
      return !v;
    });
  // Panel lateral con la configuración del proveedor: entra de derecha a izquierda.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const closeDrawer = () => {
    setDrawerOpen(false);
    drawerOpener.current?.focus();
  };
  useEffect(() => {
    if (!drawerOpen) return;
    // El foco entra en el panel cuando ha empezado a deslizarse; Esc lo cierra.
    const t = window.setTimeout(() => drawerClose.current?.focus({ preventScroll: true }), 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDrawerOpen(false);
        drawerOpener.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);
  const selectTab = (t: ProviderTab) => {
    drawerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTab(t);
    setAccountSel(t);
    setDrawerOpen(true);
    try {
      localStorage.setItem('settingsTab', t);
    } catch {
      /* sin almacenamiento */
    }
  };
  const [section, setSection] = useState<PageId>(loadSection);
  useEffect(() => {
    if (section !== 'providers') setDrawerOpen(false);
  }, [section]);
  const selectSection = (p: PageId) => {
    setSection(p);
    try {
      localStorage.setItem('settingsSection', p);
    } catch {
      /* sin almacenamiento */
    }
    document.querySelector('.q-settings__main')?.scrollTo({ top: 0 });
  };
  const [shortcutErrors, setShortcutErrors] = useState<string[]>([]);
  const [shortcutWarnings, setShortcutWarnings] = useState<string[]>([]);
  const savedTimer = useRef<number | undefined>(undefined);
  // Ciclo de vida: en `false` no se actualiza la UI ni se recrean timers.
  const aliveRef = useRef(true);
  const [liveState, setLiveState] = useState<LiveState>({ saving: false, error: null, pending: false });
  const liveRef = useRef<LiveSaver | null>(null);
  // Cola única de escrituras de Ajustes: guardado manual, patch vivo y
  // relecturas se serializan para no pisarse (B5).
  const queueRef = useRef<WriteQueue | null>(null);
  if (!queueRef.current) queueRef.current = createWriteQueue();

  // Cola de escrituras de config de Ajustes: el guardado inmediato y el completo
  // no se pisan a medias y la base solo avanza con lo que confirma el backend.
  const enqueueSave = useCallback((build: () => AppConfig | Promise<AppConfig>): Promise<AppConfig> => {
    return queueRef.current!.run(async () => {
      const savedCfg = await api.saveConfig(await build());
      // Si el componente ya no está, no se actualiza la base ni se notifica nada.
      if (aliveRef.current) setBaseline(savedCfg);
      return savedCfg;
    });
  }, []);

  // La prueba de un efecto guarda antes los avisos del formulario: pasa por la
  // misma cola para que la base canónica no quede desincronizada del backend.
  const persistAlerts = (alerts: AppConfig['alerts']) =>
    enqueueSave(() => api.getConfig().then((current) => ({ ...current, alerts }))).then(() => undefined);

  // El selector de Idioma guarda por la misma cola que el resto de Ajustes y
  // también lo adopta en el borrador (ver `changeLocale` en i18n/use-locale).
  // Si el guardado falla, ese helper devuelve el borrador al locale del backend
  // y aquí solo queda avisarlo: el selector ya refleja lo persistido.
  const [localeError, setLocaleError] = useState<string | null>(null);
  const changeLocale = (loc: Locale) =>
    applyLocaleChange(loc, { setDraft: setCfg, getConfig: api.getConfig, enqueueSave })
      .then(() => setLocaleError(null))
      .catch((err: unknown) => setLocaleError(err instanceof Error ? err.message : String(err)));

  const loadSecrets = () => api.secretStatus().then(setSecrets).catch(console.error);

  useEffect(() => {
    api.getConfig()
      .then((c) => {
        setCfg(c);
        setBaseline(c);
      })
      .catch(console.error);
    loadSecrets();
    api.shortcutErrors().then(setShortcutErrors).catch(() => {});
    api.shortcutWarnings().then(setShortcutWarnings).catch(() => {});
  }, []);

  // Ciclo de vida del autostart (simétrico para StrictMode): la lectura inicial
  // la dispara `start()`; `stop()` descarta resultados en vuelo al desmontar.
  useEffect(() => {
    const off = autostartController.subscribe((s) => {
      setAutostartState(s);
      if (s.confirmed !== null && !autostartDraftReady.current) {
        autostartDraftReady.current = true;
        setAutostartDraft(s.confirmed);
      }
    });
    autostartController.start();
    return () => {
      off();
      autostartController.stop();
    };
  }, [autostartController]);

  // Bloque «Sesión de escritorio» (solo Linux): informa de límites por superficie
  // según el compositor detectado. El error de lectura se muestra silencioso
  // (sin intervención): no es un ajuste, es un estado informativo.
  const [wmInfo, setWmInfo] = useState<WindowManagerInfo | null>(null);
  useEffect(() => {
    if (!showDesktopCompat(navigator.userAgent)) return;
    detectWindowManager()
      .then(setWmInfo)
      .catch(() => {}); // sin lectura (p. ej. sin entorno de escritorio): el bloque no aparece
  }, []);

  // Ciclo de vida del componente: al desmontar se marca inactivo y se limpia el
  // timer de mensajes. Simétrico para StrictMode (setup/cleanup/setup).
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      window.clearTimeout(savedTimer.current);
    };
  }, []);

  // El autosave vivo se crea en un efecto (no en render) para que la simetría de
  // StrictMode cree una instancia nueva tras cada cleanup en vez de revivir una
  // desechada, que ignoraría los pushes siguientes (B3).
  useEffect(() => {
    const queue = queueRef.current!;
    let self: LiveSaver | null = null;
    const saver = createLiveSaver({
      delay: 120,
      // Patch atómico por la misma cola que el guardado manual: sin carreras (B5).
      save: (patch) => queue.run(() => api.patchLiveConfig(patch)),
      onSaved: (config, patch) => {
        // Descarta resultados de una instancia ya reemplazada o desmontada.
        if (liveRef.current !== self || !aliveRef.current) return;
        setCfg((c) => (c ? reconcileLive(c, patch, config) : c));
      },
    });
    self = saver;
    liveRef.current = saver;
    setLiveState(saver.getState());
    const off = saver.subscribe(setLiveState);
    return () => {
      off();
      if (liveRef.current === saver) liveRef.current = null;
      saver.dispose();
    };
  }, []);

  // Cerrar la ventana (la X o el botón «Cerrar») no debe perder el último cambio
  // vivo ni cerrarse con un fallo sin resolver: se frena el cierre, se envía lo
  // pendiente y, si algo queda sin resolver, la ventana sigue abierta con su
  // error y reintento visibles (B4).
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    win
      .onCloseRequested(createLiveCloseHandler(() => liveRef.current, () => win.close()))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!cfg) return <div className="q-settings" />;

  const dirty = isSettingsDirty(baseline, cfg, autostartState.confirmed, autostartDraft);

  const set = <K extends keyof AppConfig>(key: K, patch: Partial<AppConfig[K]> | AppConfig[K]) =>
    setCfg((c) =>
      c
        ? ({
            ...c,
            [key]: typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? { ...(c[key] as object), ...(patch as object) } : patch,
          } as AppConfig)
        : c,
    );

  const setVisibility = (id: string, enabled: boolean) =>
    setCfg((c) => c ? setAccountVisibility(c, id, enabled) : c);

  // Personalización inmediata (#97): tamaño, color y los seis controles de la
  // tira se aplican ya y se persisten por patch atómico del backend. No cuentan
  // como cambios manuales, así «Guardar cambios» sigue gobernando solo el resto
  // del formulario (y el autostart, que es otro flujo).
  const liveChange = (patch: Partial<AppConfig>) => {
    setCfg((c) => (c ? { ...c, ...patch } : c)); // optimista, para verlo ya
    liveRef.current?.push(patch);
  };
  const changeOrbSize = (v: number) => liveChange({ orbSize: v });
  const changeAccent = (hex: string) => liveChange({ accentColor: normalizeHex(hex) });

  const save = async (): Promise<boolean> => {
    // Un guardado ya en marcha no confirma nada: quien espere para abrir un
    // login recibe `false` y no abre la cuenta antes de que esté persistida.
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    const snapshot = withCanonicalLive(cfg, liveRef.current?.latestLive() ?? {}); // los campos vivos toman el canónico, no el borrador viejo
    const desired = autostartDraft; // instantánea del borrador al pulsar Guardar
    const cfgDirtyNow = isDirty(baseline, snapshot);
    const autostartDirtyNow = autostartState.confirmed !== null && desired !== null && desired !== autostartState.confirmed;
    let message: string | null = null;
    let persisted = false;
    try {
      const result = await runMixedSave(
        {
          configDirty: cfgDirtyNow,
          configSnapshot: snapshot,
          autostartDirty: autostartDirtyNow,
          autostartDesired: desired ?? autostartState.confirmed ?? false,
        },
        {
          saveConfig: (s) => enqueueCanonicalConfig(enqueueSave, s, () => liveRef.current?.latestLive() ?? {}),
          applyAutostart: (d) => autostartController.apply(d),
        },
      );
      // Guardada o sin cambios que guardar: la config persistida es la misma.
      // Un fallo del autostart no impide abrir el login de la cuenta.
      persisted = configPersistedAfterSave(result);
      // El backend ya escribió; si el componente se desmontó a mitad, no tocamos UI.
      if (!aliveRef.current) return false;
      if (result.config.status === 'saved') {
        const savedCfg = result.config.saved;
        // No descartes ediciones hechas mientras se guardaba: adopta lo canónico
        // del backend salvo en los campos que el usuario tocó después.
        setCfg((latest) => (latest ? reconcileSaved(snapshot, savedCfg, latest) : savedCfg));
        const [errors, warnings, status] = await Promise.all([
          api.shortcutErrors().catch(() => []),
          api.shortcutWarnings().catch(() => []),
          // secret_status solo enumera cuentas persistidas: sin releerlo, una key
          // guardada antes de crear la cuenta deja el proveedor en «Falta conectar».
          reloadSecretsAfterSave(result.config, () => api.secretStatus()).catch(() => null),
        ]);
        if (!aliveRef.current) return false;
        setShortcutErrors(errors);
        setShortcutWarnings(warnings);
        if (status) setSecrets(status);
      }
      // Mensaje explícito por parte: nunca un «Guardado ✓» conjunto falso.
      message = mixedSaveMessage(result, locale);
      setSaved(message);
    } catch (e) {
      persisted = false;
      if (aliveRef.current) {
        message = String(e);
        setSaved(message);
      }
    } finally {
      // El candado se libera siempre, aunque el componente se haya desmontado.
      savingRef.current = false;
      if (aliveRef.current) {
        setSaving(false);
        if (message) savedTimer.current = window.setTimeout(() => setSaved(null), 2500);
      }
    }
    return persisted;
  };

  const tabAccounts = accountsOf(cfg, tab);
  // Paso de comprobación: se repite al guardar o al cambiar una clave, y avisa si
  // hay cambios sin guardar en esa cuenta (se comprueba siempre lo guardado).
  const secretsSig = JSON.stringify(secrets);
  const sectionDirty = (id: string) => {
    const acc = cfg.accounts.find((a) => a.id === id);
    const k = configKeyFor(acc?.provider ?? id);
    return isConnectionDirty(acc, baseline?.accounts.find((a) => a.id === id), k ? cfg[k] : undefined, k ? baseline?.[k] : undefined);
  };
  const healthFor = (id: string, hidden: boolean): HealthProps => ({ saved: baseline, secretsSig, dirty: sectionDirty(id), hidden, saving, onSave: save, locale });
  const panel = { locale, cfg, secrets, set, setVisibility, loadSecrets, healthFor };
  const selAccount = tabAccounts.find((a) => a.id === accountSel) ?? null;
  const addAccount = () => {
    const a = newAccount(cfg, tab as AccountProvider);
    set('accounts', [...cfg.accounts, a]);
    setAccountSel(a.id);
  };
  const patchAccount = (id: string, patch: Partial<Account>) =>
    set(
      'accounts',
      cfg.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  /** ¿Está guardada tal cual? El login por CLI la busca en la config guardada. */
  const accountPersisted = (a: Account) => {
    const b = baseline?.accounts.find((x) => x.id === a.id);
    return !!b && b.configDir === a.configDir;
  };
  const removeAccount = (a: Account) => {
    set('accounts', cfg.accounts.filter((x) => x.id !== a.id));
    setAccountSel(tab);
    // Si nunca se guardó, el backend no sabrá borrar sus claves al guardar: se borran ya.
    if (!baseline?.accounts.some((x) => x.id === a.id)) {
      Promise.all(ACCOUNT_SECRETS[a.provider].map((k) => api.setSecret(secretKey(k, a.id), '')))
        .then(loadSecrets)
        .catch(console.error);
    }
  };
  const pendingProviders = PROVIDER_TABS.filter((t) => providerState(t.id, cfg, secrets) === 'warn').length;

  return (
    <div className="q-settings" data-nav-collapsed={navCollapsed || undefined}>
      <SettingsNav
        appName={appName}
        section={section}
        locale={locale}
        navCollapsed={navCollapsed}
        onSelectSection={selectSection}
        onToggleNav={toggleNav}
        pendingProviders={pendingProviders}
        shortcutErrors={shortcutErrors}
        shortcutWarnings={shortcutWarnings}
      />

      <main className="q-settings__main">
        <div className="q-settings__content">
          <header className="q-head">
            <SettingsHeadTitles locale={locale} section={section} />
            <AutostartSwitch
              locale={locale}
              checked={autostartDraft ?? autostartState.confirmed ?? false}
              disabled={autostartState.busy || autostartState.confirmed === null}
              onChange={setAutostartDraft}
            />
          </header>

          {autostartState.error && (
            <AutostartNotice
              locale={locale}
              error={autostartState.error}
              unread={autostartState.confirmed === null}
              busy={autostartState.busy}
              onRetry={() => void autostartController.load()}
            />
          )}

          {wmInfo && <DesktopSessionNotice locale={locale} wmInfo={wmInfo} />}

          {section === 'providers' && (
            <>
              <ProvidersCard
                locale={locale}
                cfg={cfg}
                secrets={secrets}
                tab={tab}
                drawerOpen={drawerOpen}
                onSelectTab={selectTab}
                onRefreshMinutes={(minutes) => set('refreshMinutes', minutes)}
              />
              <div className="q-drawer-scrim" data-open={drawerOpen || undefined} onClick={closeDrawer} aria-hidden="true" />
              <aside
                className="q-drawer"
                data-open={drawerOpen || undefined}
                role="dialog"
                aria-modal="true"
                aria-labelledby="q-drawer-title"
                aria-hidden={!drawerOpen}
                inert={!drawerOpen}
              >
                <ProviderDrawerHead locale={locale} tab={tab} state={providerState(tab, cfg, secrets)} closeRef={drawerClose} onClose={closeDrawer} />
                <div className="q-drawer__body" key={tab}>
                  <InDrawer.Provider value={true}>
      <AccountsBar locale={locale} tab={tab} accounts={tabAccounts} selectedId={selAccount?.id ?? tab} onSelect={setAccountSel} onAdd={addAccount} />
      {selAccount && (
        <AccountEditor
          locale={locale}
          key={selAccount.id}
          account={selAccount}
          visible={isAccountVisible(cfg, selAccount.id, selAccount.enabled)}
          onVisibility={(v) => setVisibility(selAccount.id, v)}
          persisted={accountPersisted(selAccount)}
          secrets={secrets}
          onChange={(patch) => patchAccount(selAccount.id, patch)}
          onRemove={() => removeAccount(selAccount)}
          onSecrets={loadSecrets}
          health={healthFor(selAccount.id, !selAccount.enabled)}
          cliMissing={cli[selAccount.provider] === false}
          loginCommand={
            selAccount.provider === 'claude' || selAccount.provider === 'codex' || selAccount.provider === 'gemini' || selAccount.provider === 'grok'
              ? cfg[selAccount.provider].loginCommand
              : ''
          }
          codexInstall={codexInstaller}
          onCodexRecheck={cliRecheck}
        />
      )}
      {!selAccount && (
        <>

      {(tab === 'claude' || tab === 'codex' || tab === 'gemini' || tab === 'grok') && (
        <SubscriptionPanel {...panel} p={tab} cli={cli} codexInstall={codexInstaller} onCodexRecheck={cliRecheck} />
      )}

      {tab === 'cursor' && <CursorPanel {...panel} />}

      {tab === 'copilot' && <CopilotPanel {...panel} />}

      {tab === 'minimax' && <MiniMaxPanel {...panel} />}
      {tab === 'openrouter' && (
        <Section kicker="Pago por uso · API oficial" title="OpenRouter">
          <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, 'openrouter', cfg.openrouter.enabled)} onChange={(v) => setVisibility('openrouter', v)} />
          <p className="q-note">Gasto del mes y de hoy, límite de la key (si tiene) y saldo de la cuenta.</p>
          <ol className="q-steps" aria-label="Cómo conectar la cuenta">
            <li data-done={!!secrets.openrouter_api_key || undefined}>
              <b>API key</b>
              <SecretInput
                locale={locale}
                id="openrouter_api_key"
                label="API key"
                configured={!!secrets.openrouter_api_key}
                onSaved={loadSecrets}
                hint={<>Créala en <Link href={LINKS.openrouterKeys}>openrouter.ai › Keys</Link>.</>}
              />
            </li>
            <HealthStep id="openrouter" {...healthFor('openrouter', !cfg.openrouter.enabled)} />
          </ol>
        </Section>
      )}

      {tab === 'zai' && <ZaiPanel {...panel} />}

      {tab === 'opencode_go' && <OpenCodeGoPanel {...panel} />}

      {tab === 'nan' && (
        <Section kicker="Suscripción · cuenta o API key" title="NaN Builders">
          <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, 'nan', cfg.nan.enabled)} onChange={(v) => setVisibility('nan', v)} />
          <p className="q-note">
            Con la cuenta conectada ves lo mismo que en tu dashboard: tokens usados frente a la cuota de cada modelo, cuándo se reinicia y la serie
            diaria. Sin cuenta, la API key usa <code>/v1/usage</code> y las cuotas publicadas. <Link href={LINKS.nanDocs}>Docs</Link>
          </p>
          <ol className="q-steps" aria-label="Cómo conectar la cuenta">
            <li data-done={!!secrets.nan_session || !!secrets.nan_api_key || undefined}>
              <b>Conecta tu cuenta o pega una API key</b>
              <NanConnect connected={!!secrets.nan_session} onChange={loadSecrets} />
              <SecretInput
                locale={locale}
                id="nan_api_key"
                label="API key (alternativa)"
                configured={!!secrets.nan_api_key}
                onSaved={loadSecrets}
                hint={<>Créala en <Link href={LINKS.nanKeys}>cloud.nan.builders</Link> › API Keys</>}
              />
            </li>
            <li data-done>
              <b>Plan</b>
              <Field label="Plan">
                <select value={cfg.nan.plan} onChange={(e) => set('nan', { plan: e.target.value })}>
                  <option value="community">nan_community</option>
                  <option value="member">nan_member</option>
                  <option value="premium">GLM Premium</option>
                </select>
              </Field>
            </li>
            <HealthStep id="nan" {...healthFor('nan', !cfg.nan.enabled)} />
          </ol>
          <details className="q-details">
            <summary>Avanzado · URL, facturación y endpoint de consumo</summary>
            <Field label="Base URL">
              <input type="text" spellCheck={false} value={cfg.nan.baseUrl} onChange={(e) => set('nan', { baseUrl: e.target.value })} />
            </Field>
            <Field label="Día de inicio de facturación" hint="Solo para GLM 5.3 (cuenta por periodo de Stripe) cuando usas la API key.">
              <input type="number" min={1} max={28} value={cfg.nan.billingDay} onChange={(e) => set('nan', { billingDay: Number(e.target.value) || 1 })} />
            </Field>
            <NanProbe />
            <Field label="Endpoint de consumo · URL" hint="Se llama con tu key como Bearer y debe devolver JSON.">
              <input type="text" spellCheck={false} value={cfg.nan.usageUrl ?? ''} onChange={(e) => set('nan', { usageUrl: strOrNull(e.target.value) })} />
            </Field>
            <div className="q-cols">
              <Field label="JSON Pointer · usado" hint="p. ej. /usage/used_tokens">
                <input type="text" spellCheck={false} value={cfg.nan.usedPointer ?? ''} onChange={(e) => set('nan', { usedPointer: strOrNull(e.target.value) })} />
              </Field>
              <Field label="JSON Pointer · límite" hint="p. ej. /usage/quota_tokens">
                <input type="text" spellCheck={false} value={cfg.nan.limitPointer ?? ''} onChange={(e) => set('nan', { limitPointer: strOrNull(e.target.value) })} />
              </Field>
            </div>
            <Field label="Etiqueta">
              <input type="text" value={cfg.nan.usageLabel ?? ''} placeholder="Consumo" onChange={(e) => set('nan', { usageLabel: strOrNull(e.target.value) })} />
            </Field>
          </details>
        </Section>
      )}

      {tab === 'nine_router' && (
        <Section kicker="Pasarela local · uso agregado" title="9Router">
            <Toggle
              label="Mostrar en el widget"
              checked={cfg.nineRouter.enabled}
              onChange={(v) => setVisibility('nine_router', v)}
            />
          <p className="q-note">
            Quorb lee el uso y el gasto que <b>9Router</b> ya registra en tu equipo: peticiones, tokens y coste por proveedor del periodo. Además del
            orbe agregado, cada proveedor que haya visto (Claude, Kiro, GLM…) aparece como su propia cuenta.
          </p>
          <ol className="q-steps" aria-label="Cómo conectar 9Router">
            <li data-done={!!secrets.nine_router_password || undefined}>
              <b>Conecta tu dashboard local</b>
              <NineRouterConnect connected={!!secrets.nine_router_password} baseUrl={cfg.nineRouter.baseUrl} onChange={loadSecrets} />
            </li>
            <li data-done>
              <b>Periodo y desglose</b>
              <Field label="Periodo de uso" hint="Rango que muestra el orbe y su historial.">
                <select value={cfg.nineRouter.period} onChange={(e) => set('nineRouter', { period: e.target.value as NineRouterPeriod })}>
                  <option value="today">Hoy</option>
                  <option value="24h">Últimas 24 h</option>
                  <option value="7d">Últimos 7 días</option>
                  <option value="30d">Últimos 30 días</option>
                  <option value="60d">Últimos 60 días</option>
                  <option value="all">Todo</option>
                </select>
              </Field>
              <Toggle
                label="Mostrar cada sub-proveedor como su propia cuenta"
                checked={cfg.nineRouter.showSubProviders}
                onChange={(v) => set('nineRouter', { showSubProviders: v })}
              />
              <Field label="Gasto mínimo por sub-proveedor (USD)" hint="No muestra un sub-orbe hasta que su gasto en el periodo supere esta cifra. 0 = cualquiera que gaste.">
                <input
                  type="number"
                  min={0}
                  step="0.5"
                  value={cfg.nineRouter.minSpendUsd}
                  onChange={(e) => set('nineRouter', { minSpendUsd: Math.max(0, Number(e.target.value) || 0) })}
                />
              </Field>
              <Field label="Presupuesto (USD)" hint="Opcional: pinta la barra de gasto del periodo frente al tope que pongas.">
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={cfg.nineRouter.monthlyBudgetUsd ?? ''}
                  onChange={(e) => set('nineRouter', { monthlyBudgetUsd: strOrNull(e.target.value) == null ? null : Number(e.target.value) })}
                />
              </Field>
            </li>
            <HealthStep id="nine_router" {...healthFor('nine_router', !cfg.nineRouter.enabled)} />
          </ol>
          <details className="q-details">
            <summary>Avanzado · dirección del servidor</summary>
            <Field label="Base URL" hint="Dónde escucha 9Router (por defecto http://localhost:20128).">
              <input type="text" spellCheck={false} value={cfg.nineRouter.baseUrl} onChange={(e) => set('nineRouter', { baseUrl: e.target.value })} />
            </Field>
          </details>
          {(() => {
            // Suborbes de 9Router ocultados desde el widget: se pueden recuperar aquí.
            const hidden = hiddenNineRouterIds(cfg.hiddenProviders);
            if (hidden.length === 0) return null;
            return (
              <div className="eg-field">
                <span className="eg-field__label">Suborbes ocultos de 9Router</span>
                <div className="q-chips">
                  {hidden.map((id) => (
                    <button key={id} type="button" className="eg-chip" onClick={() => set('hiddenProviders', revealIds(cfg.hiddenProviders, [id]))}>
                      {nineRouterSubName(id)} · mostrar
                    </button>
                  ))}
                </div>
                <small className="eg-field__hint">Los ocultaste desde su panel en la tira. Pulsa para volver a mostrarlos.</small>
              </div>
            );
          })()}
        </Section>
      )}

      {(tab === 'anthropic_api' || tab === 'openai_api') &&
        (() => {
          const k = tab === 'anthropic_api' ? 'anthropicApi' : 'openaiApi';
          const secret: SecretKey = tab === 'anthropic_api' ? 'anthropic_admin_key' : 'openai_admin_key';
          return (
            <Section kicker="Pago por uso · Admin key" title={tab === 'anthropic_api' ? 'Anthropic API' : 'OpenAI API'}>
              <Toggle label="Mostrar gasto del mes" checked={isAccountVisible(cfg, tab, cfg[k].enabled)} onChange={(v) => setVisibility(tab, v)} />
              <ol className="q-steps" aria-label="Cómo conectar la cuenta">
                <li data-done={!!secrets[secret] || undefined}>
                  <b>Admin key</b>
                  <SecretInput
                    locale={locale}
                    id={secret}
                    label={tab === 'anthropic_api' ? 'Admin API key (sk-ant-admin…)' : 'Admin key'}
                    configured={!!secrets[secret]}
                    onSaved={loadSecrets}
                    hint={
                      tab === 'anthropic_api' ? (
                        <>Las APIs de coste no admiten OAuth: hace falta una <Link href={LINKS.anthropicAdmin}>Admin key</Link> (solo lectura de la organización).</>
                      ) : (
                        <>Créala en <Link href={LINKS.openaiAdmin}>Organization › Admin keys</Link>.</>
                      )
                    }
                  />
                </li>
                <li data-done={cfg[k].monthlyBudgetUsd != null || undefined}>
                  <b>Presupuesto mensual (opcional)</b>
                  <Field label="USD al mes">
                    <input type="number" min={0} step="any" value={cfg[k].monthlyBudgetUsd ?? ''} onChange={(e) => set(k, { monthlyBudgetUsd: numOrNull(e.target.value) })} />
                  </Field>
                </li>
                <HealthStep id={tab} {...healthFor(tab, !cfg[k].enabled)} />
              </ol>
            </Section>
          );
        })()}
        </>
      )}
                  </InDrawer.Provider>
                </div>
                <SettingsFoot locale={locale} variant="drawer" saved={saved} dirty={dirty} saving={saving} onSave={save} onClose={closeDrawer} />
              </aside>
            </>
          )}

          {section === 'look' && (
            <div className="q-grid-2">
              <LookSection
                locale={locale}
                cfg={cfg}
                liveError={liveState.error}
                onOrbSize={changeOrbSize}
                onAccent={changeAccent}
                onLiveChange={liveChange}
                onRetry={() => void liveRef.current?.retry()}
              />

              <Section title={t(locale, 'settings.language.title')}>
                <Field label={t(locale, 'settings.language.label')} hint={t(locale, 'settings.language.hint')}>
                  <select value={locale} onChange={(e) => changeLocale(e.target.value as Locale)}>
                    {/* Las opciones se etiquetan siempre en su propia lengua. */}
                    <option value="es">Español</option>
                    <option value="en">English</option>
                  </select>
                </Field>
                {localeError && (
                  <div className="eg-field" role="alert">
                    <span className="eg-field__label">{t(locale, 'settings.language.error')}</span>
                    <small className="eg-field__hint">{localeError}</small>
                  </div>
                )}
              </Section>
            </div>
          )}

          {section === 'alerts' && (
            <div className="q-grid-2">
              <AlertsSection locale={locale} alerts={cfg.alerts} onAlerts={(patch) => set('alerts', patch)} onPersist={persistAlerts} onError={setSaved} />
            </div>
          )}

          {section === 'shortcuts' && (
            <ShortcutsSection locale={locale} shortcuts={cfg.shortcuts} onShortcuts={(patch) => set('shortcuts', patch)} errors={shortcutErrors} warnings={shortcutWarnings} />
          )}

          {section === 'updates' && (
            <div className="q-grid-2">
              <UpdatesSection locale={locale} auto={cfg.autoUpdate} onAuto={(v) => set('autoUpdate', v)} />
              <ProjectSection locale={locale} />
            </div>
          )}
        </div>

        <SettingsFoot locale={locale} variant="window" saved={saved} dirty={dirty} saving={saving} onSave={save} onClose={() => getCurrentWindow().close()} />
      </main>
    </div>
  );
}
