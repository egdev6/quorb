import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { useAppName } from './lib/app-identity';
import { api } from './lib/api';
import { configKeyFor, isAccountVisible, setAccountVisibility } from './lib/settings-visibility';
import { ORB_SIZE, type Account, type AccountProvider, type AlertMoment, type AppConfig, type Effect, type Locale, type MediaSize, type NineRouterPeriod, type ScopedSecretKey, type SecretKey, type SecretStatus, type UsageReport } from './lib/types';
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
import { t } from './i18n';
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

function UpdatesSection({ auto, onAuto }: { auto: boolean; onAuto: (v: boolean) => void }) {
  const appName = useAppName();
  const [version, setVersion] = useState<string>('');
  const { mode, state, check, install } = useUpdater(auto);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion('?'));
  }, []);

  if (mode !== 'native') return (
    <Section title="Versión actual">
      <p className="q-note">{appName ?? '…'} <b>{version ? `v${version}` : ''}</b></p>
      <p className="q-note" role="status">
        {mode === 'manual' ? 'Actualización manual en macOS. No se buscan ni se instalan actualizaciones desde la app.'
          : mode === 'error' ? 'No se pudo determinar el modo de actualización. Reinicia Quorb para reintentar.'
          : 'Consultando el modo de actualización…'}
      </p>
    </Section>
  );

  return (
    <Section title="Versión instalada">
      {(state.phase === 'available' || state.phase === 'installing') && (
        <div className="eg-notice eg-notice--info" role="status">
          <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
          <span className="eg-notice__text">
            <b>Hay una versión nueva: {state.info.version}.</b> Se descarga, se comprueba la firma y Quorb se reinicia.
          </span>
          <span className="eg-notice__actions">
            <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={state.phase === 'installing'} onClick={install}>
              {state.phase === 'installing' ? `Instalando${state.progress != null ? ` · ${state.progress} %` : '…'}` : 'Instalar y reiniciar'}
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
          {state.phase === 'none' && ' · estás en la última versión'}
        </span>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={state.phase === 'checking' || state.phase === 'installing'} onClick={() => check()}>
          {state.phase === 'checking' ? 'Buscando…' : 'Buscar ahora'}
        </button>
      </div>
      {state.phase === 'error' && <div className="eg-notice eg-notice--warning eg-notice--sm"><span className="eg-notice__text">{state.message}</span></div>}
      <Rows>
        <Toggle label="Buscar actualizaciones solo" hint="Al arrancar y cada 6 h. Si hay una nueva, aparece un icono de descarga en la tira." checked={auto} onChange={onAuto} />
      </Rows>
      <small className="eg-field__hint">
        Llegan firmadas desde{' '}
        <button type="button" className="q-link" onClick={() => openUrl(LINKS.releases)}>
          GitHub Releases
        </button>
        ; si la firma no coincide, no se instalan.
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

function SecretInput({ id, label, configured, onSaved, hint }: { id: ScopedSecretKey; label: string; configured: boolean; onSaved: () => void; hint?: ReactNode }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (v: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.setSecret(id, v);
      setValue('');
      setMsg(v ? 'Guardada en el almacén seguro del sistema' : 'Eliminada');
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
          placeholder={configured ? '•••••••• (configurada)' : 'Pega aquí la key'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="eg-btn eg-btn--primary" disabled={busy || !value.trim()} onClick={() => save(value)}>
          Guardar
        </button>
        {configured && (
          <button className="eg-btn eg-btn--destructive" disabled={busy} onClick={() => save('')} title="Eliminar key">
            Quitar
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

const EFFECT_OPTIONS: { value: Effect; label: string }[] = [
  { value: 'confetti', label: 'Confeti' },
  { value: 'glow', label: 'Glow de peligro' },
  { value: 'custom', label: 'Efecto propio (vídeo o imagen animada)' },
  { value: 'none', label: 'Ninguno' },
];

async function testEffect(kind: Effect, moment: AlertMoment, alerts: AppConfig['alerts'], persist: (alerts: AppConfig['alerts']) => Promise<void>) {
  if (kind === 'none') return;
  // El archivo del efecto propio se lee de la config guardada: guardamos antes lo que haya en el formulario.
  await persist(alerts);
  const m = await currentMonitor();
  if (!m) return;
  await api.playEffect(kind, moment, { x: m.position.x, y: m.position.y, width: m.size.width, height: m.size.height });
}

const MEDIA_FILTERS = [{ name: 'Vídeo o imagen animada', extensions: ['webm', 'mp4', 'gif', 'webp', 'png', 'apng'] }];

const fileName = (p: string | null) => (p ? p.split(/[\\/]/).pop() : null);

/** Un momento de aviso: efecto + archivo propio + botón de prueba. */
function MomentEffect({
  moment,
  effect,
  media,
  alerts,
  onEffect,
  onMedia,
  onPersist,
  onError,
}: {
  moment: AlertMoment;
  effect: Effect;
  media: string | null;
  alerts: AppConfig['alerts'];
  onEffect: (e: Effect) => void;
  onMedia: (p: string | null) => void;
  onPersist: (alerts: AppConfig['alerts']) => Promise<void>;
  onError: (msg: string) => void;
}) {
  return (
    <>
      <div className="q-inline">
        <label className="eg-field">
          <span className="eg-field__label">Efecto</span>
          <select value={effect} onChange={(e) => onEffect(e.target.value as Effect)}>
            {EFFECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="eg-btn eg-btn--ghost"
          disabled={effect === 'none' || (effect === 'custom' && !media)}
          onClick={() => testEffect(effect, moment, alerts, onPersist).catch((e) => onError(String(e)))}
        >
          Probar
        </button>
      </div>
      {effect === 'custom' && (
        <div className="eg-field">
          <span className="eg-field__label">Archivo</span>
          <div className="q-inline">
            <input type="text" readOnly value={fileName(media) ?? ''} placeholder="Ningún archivo" title={media ?? ''} />
            <button
              className="eg-btn eg-btn--ghost"
              onClick={async () => {
                const file = await openDialog({ multiple: false, directory: false, filters: MEDIA_FILTERS });
                if (typeof file === 'string') onMedia(file);
              }}
            >
              Elegir…
            </button>
            {media && (
              <button className="eg-btn eg-btn--ghost" onClick={() => onMedia(null)}>
                Quitar
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Fila de la tabla de atajos: pulsa el atajo (o «Cambiar») y teclea la combinación nueva. */
function ShortcutRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
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
          aria-label={`${label}: ${value ? prettyCombo(value) : 'sin atajo'}. Pulsa para cambiarlo`}
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
          {rec ? 'Pulsa la combinación… (Esc cancela)' : value ? prettyCombo(value).split(' + ').map((k) => <kbd key={k} className="eg-kbd">{k}</kbd>) : 'Sin atajo'}
        </button>
      </td>
      <td className="eg-table__acts">
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => { setRec(true); btn.current?.focus(); }}>
          Cambiar
        </button>
        {value && (
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => onChange('')}>
            Quitar
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
function CliMissing({ provider }: { provider: AccountProvider }) {
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
        <b>Falta {how.name} en este equipo.</b> Quorb inicia sesión con su login oficial. Instálalo desde {how.where}
        {how.needs ? ` (necesita ${how.needs})` : ''}; Quorb lo detecta solo al terminar.
      </span>
      <span className="q-cli__cmd">
        <code>{how.cmd}</code>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={copy}>
          {copied ? 'Copiado' : 'Copiar'}
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
};

type Health = { phase: 'checking' } | { phase: 'done'; report: UsageReport | null } | { phase: 'failed'; error: string };

function healthSummary(r: UsageReport): string {
  const peak = peakMeter(r);
  const data =
    peak?.percent != null
      ? `${peak.label} al ${formatPercent(peak.percent)}`
      : r.spend
        ? `${r.spend.periodLabel}: ${formatMoney(r.spend.amount, r.spend.currency)}`
        : 'Datos recibidos';
  return r.plan ? `${r.plan} · ${data}` : data;
}

/**
 * Último paso de cada proveedor y cuenta: consulta la cuenta con lo guardado y dice si
 * funciona y, si no, por qué (sesión caducada, clave rechazada, falta un dato…).
 */
function HealthStep({ id, saved, secretsSig, dirty, hidden, saving, onSave, onLogin, loginBusy, refreshKey }: HealthProps & { id: string; refreshKey?: unknown }) {
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
  const title = {
    checking: 'Comprobando la conexión…',
    ok: 'Funciona',
    todo: 'Falta completar un paso',
    warn: r?.status === 'needsLogin' ? 'Sin sesión' : 'Atención',
    error: 'No funciona',
  }[state];
  // El fallo de la comprobación no pisa el diagnóstico del guardado (vive en `saved`).
  const message =
    h.phase === 'failed'
      ? `No se pudo comprobar ahora: ${h.error}. Vuelve a intentarlo.`
      : !r
        ? 'Guarda los cambios para comprobar esta cuenta.'
        : r.message;

  return (
    <li data-done={state === 'ok' || undefined} data-state={state} aria-live="polite">
      <b>{title}</b>
      {state === 'ok' && r && (
        <span>
          {healthSummary(r)}
          {hidden && ' · oculta en el widget'}
        </span>
      )}
      {state === 'checking' && <span>Consultando con lo guardado…</span>}
      {message && state !== 'checking' && (
        <span className={`eg-notice eg-notice--sm eg-notice--${state === 'ok' ? 'info' : state === 'error' ? 'danger' : 'warning'} q-steps__notice`} role={state === 'ok' ? undefined : 'alert'}>
          <span className="eg-notice__text">{message}</span>
        </span>
      )}
      {dirty && <span className="q-note">Tienes cambios sin guardar: la comprobación usa lo guardado.</span>}
      <span className="q-steps__actions">
        {dirty ? (
          <button
            type="button"
            className="eg-btn eg-btn--secondary eg-btn--sm"
            disabled={busy || saving}
            onClick={() => {
              setBusy(true);
              onSave().finally(() => setBusy(false));
            }}
          >
            Guardar y comprobar
          </button>
        ) : (
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={state === 'checking'} onClick={run}>
            Comprobar ahora
          </button>
        )}
        {state === 'warn' && r?.status === 'needsLogin' && onLogin && (
          <button
            type="button"
            className="eg-btn eg-btn--primary eg-btn--sm"
            disabled={busy || saving || loginBusy}
            onClick={onLogin}
          >
            Iniciar sesión
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
    <>
      {cliMissing && (
        <li>
          <b>Instala {CLI_INSTALL[provider]?.name ?? 'su CLI'}</b>
          <span>Hace falta para iniciar sesión y para renovarla cuando caduque, aunque ahora funcione.</span>
          {provider === 'codex' ? <CodexInstall controller={codexInstall} onRecheck={onCodexRecheck} /> : <CliMissing provider={provider} />}
        </li>
      )}
      <li data-done={connected || undefined}>
        <b>{connected ? 'Fichero de sesión encontrado' : extra ? 'Inicia sesión con la otra cuenta' : 'Inicia sesión'}</b>
        <span>
          Se abre una terminal con <code>{loginCommand}</code>
          {provider === 'claude' && <> (si no te lo pide, escribe <code>/login</code>)</>}
          {provider === 'gemini' && <> (elige «Login with Google»)</>}. El navegador hace el login oficial y el CLI guarda la sesión, que
          Quorb solo lee.
          {connected && ' El fichero existe, pero no confirma que la sesión siga siendo válida: míralo en la comprobación de abajo.'}
          {extra && ' Entra con la cuenta que quieres añadir, no con la principal: si el navegador ya tiene abierta la principal, usa una ventana privada.'}
        </span>
        <span className="q-steps__actions">
          <button className={`eg-btn ${connected ? 'eg-btn--secondary' : 'eg-btn--primary'}`} disabled={busy || cliMissing || health.saving} onClick={connect}>
            {connected ? 'Volver a abrir el login' : effectivePersisted(persisted, health.dirty) ? 'Iniciar sesión' : 'Guardar e iniciar sesión'}
          </button>
        </span>
        {loginError && (
          <span className="eg-notice eg-notice--sm eg-notice--warning q-steps__notice" role="alert">
            <span className="eg-notice__text">{loginError}</span>
          </span>
        )}
      </li>
      {persisted ? (
        <HealthStep id={id} {...health} onLogin={connect} loginBusy={busy} refreshKey={connected} />
      ) : (
        <li>
          <b>Comprobación</b>
          <span>Se hace sola en cuanto guardes e inicies sesión.</span>
        </li>
      )}
    </>
  );
}

/** Configuración de una cuenta adicional: nombre, si se muestra y cómo se conecta, en pasos. */
function AccountEditor({
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
      <b>Comprobación</b>
      <span>Guarda la cuenta para comprobar que funciona.</span>
      <span className="q-steps__actions">
        <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={health.saving} onClick={() => void health.onSave()}>
          Guardar y comprobar
        </button>
      </span>
    </li>
  );
  return (
    <Section kicker="Cuenta adicional" title={a.label}>
      <div className="q-cols">
        <Field label="Nombre" hint="Se ve en la tira junto al proveedor.">
          <input type="text" value={a.label} onChange={(e) => onChange({ label: e.target.value })} />
        </Field>
      </div>
      <Toggle label="Mostrar en el widget" checked={visible} onChange={onVisibility} />

      <ol className="q-steps" aria-label="Cómo conectar esta cuenta">
        <li data-done={a.label.trim() !== '' || undefined}>
          <b>Ponle nombre</b>
          <span>Arriba, para distinguirla de la principal en la tira (por ejemplo, «Trabajo»).</span>
        </li>

        {session && (
          <CliConnect id={a.id} provider={a.provider} loginCommand={loginCommand} cliMissing={cliMissing} persisted={persisted} extra health={health} codexInstall={codexInstall} onCodexRecheck={onCodexRecheck} />
        )}

        {a.provider === 'cursor' && (
          <>
            <li data-done={has('cursor_token') || undefined}>
              <b>Pega el token de esta cuenta</b>
              <span>La app de Cursor guarda una sola sesión (la principal). Entra en cursor.com con esta cuenta y copia la cookie WorkosCursorSessionToken.</span>
              <SecretInput id={key('cursor_token')} label="Token de la cuenta" configured={has('cursor_token')} onSaved={onSecrets} />
            </li>
            {check}
          </>
        )}

        {a.provider === 'copilot' && (
          <>
            <li data-done={a.username.trim() !== '' || undefined}>
              <b>Usuario y plan de GitHub</b>
              <div className="q-cols">
                <Field label="Usuario de GitHub">
                  <input type="text" spellCheck={false} value={a.username} onChange={(e) => onChange({ username: e.target.value })} />
                </Field>
                <Field label="Plan">
                  <select value={a.plan || 'pro'} onChange={(e) => onChange({ plan: e.target.value })}>
                    <option value="free">Free · 50</option>
                    <option value="pro">Pro · 300</option>
                    <option value="pro_plus">Pro+ · 1500</option>
                    <option value="business">Business · 300</option>
                    <option value="enterprise">Enterprise · 1000</option>
                    <option value="custom">Otra cantidad</option>
                  </select>
                </Field>
              </div>
              {a.plan === 'custom' && (
                <Field label="Peticiones premium incluidas al mes">
                  <input type="number" min={1} value={a.customAllowance ?? ''} onChange={(e) => onChange({ customAllowance: numOrNull(e.target.value) })} />
                </Field>
              )}
            </li>
            <li data-done={has('github_token') || undefined}>
              <b>Token de solo lectura</b>
              <SecretInput
                id={key('github_token')}
                label="Token de GitHub de esta cuenta (fine-grained)"
                configured={has('github_token')}
                onSaved={onSecrets}
                hint={<>Créalo con esta cuenta en <Link href={LINKS.githubToken}>GitHub › Fine-grained tokens</Link> con el permiso «Plan» (solo lectura).</>}
              />
            </li>
            {check}
          </>
        )}

        {a.provider === 'nan' && (
          <>
            <li data-done={has('nan_session') || has('nan_api_key') || undefined}>
              <b>Conecta la cuenta o pega una API key</b>
              <NanConnect account={a.id} connected={has('nan_session')} onChange={onSecrets} />
              <SecretInput id={key('nan_api_key')} label="API key (alternativa)" configured={has('nan_api_key')} onSaved={onSecrets} />
            </li>
            <li data-done>
              <b>Plan</b>
              <Field label="Plan" hint="La URL base y el resto de ajustes avanzados son los de la cuenta principal.">
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
              <b>API key</b>
              <SecretInput
                id={key('openrouter_api_key')}
                label="API key"
                configured={has('openrouter_api_key')}
                onSaved={onSecrets}
                hint={<>Puede ser de otra cuenta o de la misma con otro límite. <Link href={LINKS.openrouterKeys}>openrouter.ai › Keys</Link></>}
              />
            </li>
            {check}
          </>
        )}

        {a.provider === 'zai' && (
          <>
            <li data-done={has('zai_api_key') || undefined}>
              <b>API key</b>
              <SecretInput
                id={key('zai_api_key')}
                label="API key"
                configured={has('zai_api_key')}
                onSaved={onSecrets}
                hint={<>Créala en <Link href={LINKS.zaiKeys}>z.ai › API Keys</Link>.</>}
              />
            </li>
            {check}
          </>
        )}

        {(a.provider === 'anthropic_api' || a.provider === 'openai_api') && (
          <>
            <li data-done={has(adminKey) || undefined}>
              <b>Admin key de esta organización</b>
              <SecretInput
                id={key(adminKey)}
                label="Admin key"
                configured={has(adminKey)}
                onSaved={onSecrets}
                hint={<>Cada organización tiene su propia <Link href={a.provider === 'anthropic_api' ? LINKS.anthropicAdmin : LINKS.openaiAdmin}>Admin key</Link>.</>}
              />
            </li>
            <li data-done={a.monthlyBudgetUsd != null || undefined}>
              <b>Presupuesto mensual (opcional)</b>
              <Field label="USD al mes">
                <input type="number" min={0} step="any" value={a.monthlyBudgetUsd ?? ''} onChange={(e) => onChange({ monthlyBudgetUsd: numOrNull(e.target.value) })} />
              </Field>
            </li>
            {check}
          </>
        )}
      </ol>

      {session && (
        <details className="q-details">
          <summary>Avanzado · carpeta de sesión</summary>
          <p className="q-note">
            Cada cuenta guarda su sesión en su propia carpeta, así no toca la principal: el login se abre con <code>{session.env}</code>{' '}
            apuntando a ella. Si la comprobación pide renovar la sesión, «Volver a abrir el login» abre de nuevo el CLI.
          </p>
          <Field label="Carpeta de sesión" hint={<>Vacío = <code>{defaultSessionDir(a, appName)}</code>. Puedes usar una que ya tengas. Quorb lee <code>{session.file}</code> dentro de ella.</>}>
            <input type="text" spellCheck={false} value={a.configDir ?? ''} placeholder={defaultSessionDir(a, appName)} onChange={(e) => onChange({ configDir: strOrNull(e.target.value) })} />
          </Field>
        </details>
      )}

      <div className="q-inline">
        <button type="button" className="eg-btn eg-btn--destructive eg-btn--sm" onClick={onRemove}>
          Eliminar esta cuenta
        </button>
        <small className="eg-field__hint">Al guardar se borran también sus claves del almacén seguro del sistema.</small>
      </div>
    </Section>
  );
}

const PROVIDER_TABS = [
  { id: 'claude', name: 'Claude', group: 'sub', desc: 'Pro / Max · sesión de 5 h, semanal y por modelo' },
  { id: 'codex', name: 'ChatGPT y Codex', group: 'sub', desc: 'Plus / Pro · sesión y semanal de Codex' },
  { id: 'gemini', name: 'Gemini', group: 'sub', desc: 'Cuota diaria por modelo' },
  { id: 'cursor', name: 'Cursor', group: 'sub', desc: 'Uso del plan en el ciclo y on-demand' },
  { id: 'grok', name: 'Grok', group: 'sub', desc: 'SuperGrok · uso semanal de créditos del CLI' },
  { id: 'copilot', name: 'GitHub Copilot', group: 'sub', desc: 'Peticiones premium del mes' },
  { id: 'minimax', name: 'MiniMax', group: 'sub', desc: 'Cuota del plan M/Token y saldo de pago por uso' },
  { id: 'nan', name: 'NaN Builders', group: 'api', desc: 'Cuota del plan y tokens por día' },
  { id: 'openrouter', name: 'OpenRouter', group: 'api', desc: 'Saldo y gasto por clave' },
  { id: 'anthropic_api', name: 'Anthropic API', group: 'api', desc: 'Gasto del mes con clave de admin' },
  { id: 'openai_api', name: 'OpenAI API', group: 'api', desc: 'Gasto del mes con clave de admin' },
  { id: 'nine_router', name: '9Router', group: 'api', desc: 'Pasarela local · uso y gasto agregados' },
  { id: 'zai', name: 'z.ai', group: 'sub', desc: 'GLM Coding Plan · cuotas de 5 h, semanales y web tools' },
] as const;
/** Secciones de Ajustes, una por responsabilidad (rediseño de Quorb en Claude Design). */
const PAGES = [
  { id: 'providers', label: 'Proveedores', title: 'Suscripciones y APIs', desc: 'Qué se consulta y cómo se conecta cada proveedor.', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { id: 'look', label: 'Apariencia', title: 'Apariencia', desc: 'Tamaño y color de los anillos, y dónde vive la tira.', icon: 'M12 2a10 10 0 1 0 0 20c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2zM13.5 6.5h0M17.5 10.5h0M8.5 7.5h0M6.5 12.5h0' },
  { id: 'alerts', label: 'Alertas', title: 'Alertas', desc: 'Qué pasa al superar un límite y cuando se reinicia.', icon: 'M10.27 21a2 2 0 0 0 3.46 0M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33' },
  { id: 'shortcuts', label: 'Atajos', title: 'Atajos', desc: 'Combinaciones de teclado que funcionan desde cualquier app.', icon: 'M2 4h20v16H2zM6 8h0M10 8h0M14 8h0M18 8h0M8 12h0M12 12h0M16 12h0M7 16h10' },
  { id: 'updates', label: 'Actualizaciones', title: 'Actualizaciones', desc: 'Versión instalada, actualizaciones automáticas y el proyecto.', icon: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5' },
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

const EDGES: { id: AppConfig['dockEdge']; label: string }[] = [
  { id: 'left', label: 'Izquierda' },
  { id: 'right', label: 'Derecha' },
  { id: 'top', label: 'Arriba' },
  { id: 'bottom', label: 'Abajo' },
];

type ProviderTab = (typeof PROVIDER_TABS)[number]['id'];
type ProviderState = 'on' | 'warn' | 'off';

const PROVIDER_BADGE: Record<ProviderState, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  on: { label: 'Activo', tone: 'success' },
  warn: { label: 'Falta conectar', tone: 'warning' },
  off: { label: 'Desactivado', tone: 'neutral' },
};

/** Estado de cada pestaña: activo, activo pero sin configurar, o desactivado.
 *  Una cuenta adicional activa y sin conectar también cuenta como «falta conectar». */
function providerState(id: ProviderTab, cfg: AppConfig, s: SecretStatus): ProviderState {
  const main = mainState(id, cfg, s);
  const extras = accountsOf(cfg, id).filter((a) => a.enabled);
  if (extras.some((a) => !accountReady(a, s))) return 'warn';
  return main === 'off' && extras.length > 0 ? 'on' : main;
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
      <nav aria-label="Secciones de ajustes">
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
                  <span className="eg-menu__count" title="Activos pero sin configurar">{pendingProviders}</span>
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
        aria-label={navCollapsed ? 'Expandir el menú' : 'Contraer el menú'}
        title={navCollapsed ? 'Expandir el menú' : 'Contraer el menú'}
        onClick={onToggleNav}
      >
        <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 4h18v16H3zM9 4v16" />
          <path d={navCollapsed ? 'm13 10 2 2-2 2' : 'm15 10-2 2 2 2'} />
        </svg>
        <span className="eg-menu__label">Contraer</span>
      </button>
    </aside>
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
      message = mixedSaveMessage(result);
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
  const healthFor = (id: string, hidden: boolean): HealthProps => ({ saved: baseline, secretsSig, dirty: sectionDirty(id), hidden, saving, onSave: save });
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
  const palette = derivePalette(cfg.accentColor);

  const providerCard = (t: (typeof PROVIDER_TABS)[number]) => {
    const st = providerState(t.id, cfg, secrets);
    const badge = PROVIDER_BADGE[st];
    return (
      <button
        type="button"
        key={t.id}
        className="eg-module-card q-provider"
        aria-current={drawerOpen && tab === t.id}
        aria-haspopup="dialog"
        aria-expanded={drawerOpen && tab === t.id}
        onClick={() => selectTab(t.id)}
      >
        <span className="eg-module-card__head">
          <span className="q-provider__logo logo">
            <ProviderLogo id={t.id} name={t.name} />
          </span>
          <span className="eg-module-card__name">{t.name}</span>
        </span>
        <span className="q-provider__desc">
          {t.desc}
          {accountsOf(cfg, t.id).length > 0 && ` · ${accountsOf(cfg, t.id).length + 1} cuentas`}
        </span>
        <span className="eg-module-card__actions">
          <span className={`eg-status eg-status--${badge.tone}`}>{badge.label}</span>
          <span className="eg-btn eg-btn--ghost eg-btn--sm q-provider__cta" aria-hidden="true">
            {st === 'warn' ? 'Conectar' : 'Configurar'}
          </span>
        </span>
      </button>
    );
  };

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
            <label className="eg-check eg-check--switch">
              <input
                type="checkbox"
                checked={autostartDraft ?? autostartState.confirmed ?? false}
                disabled={autostartState.busy || autostartState.confirmed === null}
                onChange={(e) => setAutostartDraft(e.target.checked)}
              />{' '}
              Arrancar al iniciar sesión
            </label>
          </header>

          {autostartState.error && (
            <div className="eg-notice eg-notice--warning eg-notice--sm" role="alert">
              <span className="eg-notice__text">
                {autostartState.confirmed === null ? 'No se pudo leer «Arrancar al iniciar sesión»: ' : ''}
                {autostartState.error}
              </span>
              {autostartState.confirmed === null && (
                <span className="eg-notice__actions">
                  <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={autostartState.busy} onClick={() => void autostartController.load()}>
                    Reintentar
                  </button>
                </span>
              )}
            </div>
          )}

          {wmInfo && (
            <div className="eg-notice eg-notice--sm" role="status">
              <span className="eg-notice__text">
                <strong>
                  Sesión de escritorio: {wmInfo.isWayland ? 'Wayland' : wmInfo.xdgSessionType ?? 'X11'}
                  {wmInfo.desktopSession ? ` · ${wmInfo.desktopSession}` : ''}
                </strong>
              </span>
              <p className="eg-notice__text">{wmInfo.recommendation}</p>
              <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                {desktopCompatRows(wmInfo.surfaces).map((row) => (
                  <li key={row.label}>
                    <strong>{row.label}</strong> ·{' '}
                    {row.state === 'limited' ? <em>con límites:</em> : <em>sin límites conocidos:</em>} {row.note}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {section === 'providers' && (
            <>
              <section className="eg-module-card eg-module-card--banded q-section" aria-label="Proveedores">
                <div className="eg-module-card__head">
                  <div className="q-section__titles">
                    <h2>Proveedores</h2>
                  </div>
                  <label className="q-section__aside">
                    Consultar cada
                    <input type="number" min={1} max={120} value={cfg.refreshMinutes} onChange={(e) => set('refreshMinutes', Number(e.target.value) || 1)} />
                    min
                  </label>
                </div>
                <div className="eg-module-card__body">
                <p className="eg-eyebrow">Suscripciones</p>
                <div className="q-providers">{PROVIDER_TABS.filter((t) => t.group === 'sub').map(providerCard)}</div>
                <p className="eg-eyebrow">APIs y créditos</p>
                <div className="q-providers">{PROVIDER_TABS.filter((t) => t.group === 'api').map(providerCard)}</div>
                <small className="eg-field__hint">Para cambiar el orden de los anillos, arrástralos en la tira.</small>
                </div>
              </section>
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
                {(() => {
                  const current = PROVIDER_TABS.find((t) => t.id === tab) ?? PROVIDER_TABS[0];
                  const badge = PROVIDER_BADGE[providerState(current.id, cfg, secrets)];
                  return (
                    <header className="q-drawer__head">
                      <span className="q-drawer__logo logo">
                        <ProviderLogo id={current.id} name={current.name} />
                      </span>
                      <div className="q-drawer__titles">
                        <p className="eg-eyebrow">Configuración</p>
                        <h2 id="q-drawer-title">{current.name}</h2>
                      </div>
                      <span className={`eg-status eg-status--${badge.tone}`}>{badge.label}</span>
                      <button ref={drawerClose} type="button" className="eg-icon-btn" aria-label="Cerrar la configuración" onClick={closeDrawer}>
                        <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </header>
                  );
                })()}
                <div className="q-drawer__body" key={tab}>
                  <InDrawer.Provider value={true}>
      <div className="q-accounts">
        <div className="eg-tabs eg-tabs--sm" role="tablist" aria-label="Cuentas">
          {[{ id: tab as string, label: 'Principal' }, ...tabAccounts].map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              className="eg-tabs__item"
              aria-selected={(selAccount?.id ?? tab) === a.id}
              onClick={() => setAccountSel(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
        {tab === 'nine_router' ? (
          <small className="eg-field__hint">Los subproveedores de 9Router se descubren solos desde su historial de uso; no se añaden a mano.</small>
        ) : (
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={addAccount}>
            + Añadir cuenta
          </button>
        )}
      </div>
      {selAccount && (
        <AccountEditor
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

      {(tab === 'claude' || tab === 'codex' || tab === 'gemini' || tab === 'grok') &&
        (() => {
          const p = tab;
          const info = {
            claude: {
              kicker: 'Suscripción · OAuth',
              title: 'Claude (Pro / Max)',
              note: 'Límites de sesión (5 h), semanales y por modelo de tu plan. Quorb lee la sesión que guarda Claude Code: no ve tu contraseña ni toca los tokens.',
              file: 'Fichero de credenciales',
              hint: <>Vacío = <code>%USERPROFILE%\.claude\.credentials.json</code>. Para WSL: <code>\\wsl.localhost\Ubuntu\home\TU_USUARIO\.claude\.credentials.json</code></>,
            },
            codex: {
              kicker: 'Suscripción · OAuth',
              title: 'ChatGPT (Plus / Pro · Codex)',
              note: 'Límites de 5 h y semanales de tu plan de ChatGPT en Codex. Quorb lee la sesión que guarda el CLI de Codex.',
              file: 'Fichero auth.json',
              hint: <>Vacío = <code>%CODEX_HOME%</code> o <code>%USERPROFILE%\.codex\auth.json</code></>,
            },
            gemini: {
              kicker: 'Suscripción · sesión de Gemini CLI',
              title: 'Gemini (Google AI Pro / Code Assist)',
              note: (
                <>
                  Cuotas diarias por modelo. Quorb lee la sesión que guarda <Link href={LINKS.geminiCli}>Gemini CLI</Link>. Endpoints no oficiales.
                </>
              ),
              file: 'Fichero de credenciales',
              hint: <>Vacío = <code>%USERPROFILE%\.gemini\oauth_creds.json</code></>,
            },
            grok: {
              kicker: 'Suscripción · OAuth',
              title: 'Grok (SuperGrok)',
              note: (
                <>
                  Uso semanal de créditos de tu suscripción en el CLI de Grok. Quorb lee la sesión que guarda <code>grok login</code>. Endpoint no oficial.
                </>
              ),
              file: 'Fichero auth.json',
              hint: <>Vacío = <code>%GROK_HOME%</code> o <code>%USERPROFILE%\.grok\auth.json</code></>,
            },
          }[p];
          return (
            <Section kicker={info.kicker} title={info.title}>
              <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, p, cfg[p].enabled)} onChange={(v) => setVisibility(p, v)} />
              <p className="q-note">{info.note}</p>
              <ol className="q-steps" aria-label="Cómo conectar la cuenta">
                <CliConnect
                  id={p}
                  provider={p}
                  loginCommand={cfg[p].loginCommand}
                  cliMissing={cli[p] === false}
                  persisted
                  extra={false}
                  health={healthFor(p, !cfg[p].enabled)}
                  codexInstall={codexInstaller}
                  onCodexRecheck={cliRecheck}
                />
              </ol>
              <details className="q-details">
                <summary>Avanzado · fichero de sesión y comando de login</summary>
                <Field label={info.file} hint={info.hint}>
                  <input type="text" spellCheck={false} value={cfg[p].credentialsPath ?? ''} onChange={(e) => set(p, { credentialsPath: strOrNull(e.target.value) })} />
                </Field>
                <Field label="Comando de login">
                  <input type="text" spellCheck={false} value={cfg[p].loginCommand} onChange={(e) => set(p, { loginCommand: e.target.value })} />
                </Field>
              </details>
            </Section>
          );
        })()}

      {tab === 'cursor' && (
        <Section kicker="Suscripción · sesión de la app" title="Cursor">
          <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, 'cursor', cfg.cursor.enabled)} onChange={(v) => setVisibility('cursor', v)} />
          <p className="q-note">Uso del plan en el ciclo actual (total, Auto y modelos API) y gasto on-demand. Endpoint no oficial.</p>
          <ol className="q-steps" aria-label="Cómo conectar la cuenta">
            <li>
              <b>Inicia sesión en la app de Cursor</b>
              <span>
                Quorb lee la sesión que guarda la app de Cursor en este equipo (solo lectura). Si no usas la app aquí, pega un token manual: tiene
                prioridad sobre la sesión de la app.
              </span>
              <SecretInput id="cursor_token" label="Token manual (opcional)" configured={!!secrets.cursor_token} onSaved={loadSecrets} />
            </li>
            <HealthStep id="cursor" {...healthFor('cursor', !cfg.cursor.enabled)} />
          </ol>
          <details className="q-details">
            <summary>Avanzado · base de datos de Cursor</summary>
            <Field label="Base de datos de Cursor" hint={<>Vacío = <code>%APPDATA%\Cursor\User\globalStorage\state.vscdb</code></>}>
              <input type="text" spellCheck={false} value={cfg.cursor.credentialsPath ?? ''} onChange={(e) => set('cursor', { credentialsPath: strOrNull(e.target.value) })} />
            </Field>
          </details>
        </Section>
      )}

      {tab === 'copilot' && (
        <Section kicker="Suscripción · API oficial" title="GitHub Copilot">
          <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, 'copilot', cfg.copilot.enabled)} onChange={(v) => setVisibility('copilot', v)} />
          <p className="q-note">Peticiones premium del mes con la API de facturación de GitHub. Se reinician el día 1 (UTC).</p>
          <ol className="q-steps" aria-label="Cómo conectar la cuenta">
            <li data-done={cfg.copilot.username.trim() !== '' || undefined}>
              <b>Usuario y plan de GitHub</b>
              <div className="q-cols">
                <Field label="Usuario de GitHub">
                  <input type="text" spellCheck={false} placeholder="egdev6" value={cfg.copilot.username} onChange={(e) => set('copilot', { username: e.target.value })} />
                </Field>
                <Field label="Plan">
                  <select value={cfg.copilot.plan} onChange={(e) => set('copilot', { plan: e.target.value })}>
                    <option value="free">Free · 50</option>
                    <option value="pro">Pro · 300</option>
                    <option value="pro_plus">Pro+ · 1500</option>
                    <option value="business">Business · 300</option>
                    <option value="enterprise">Enterprise · 1000</option>
                    <option value="custom">Otra cantidad</option>
                  </select>
                </Field>
              </div>
              {cfg.copilot.plan === 'custom' && (
                <Field label="Peticiones premium incluidas al mes">
                  <input type="number" min={1} value={cfg.copilot.customAllowance ?? ''} onChange={(e) => set('copilot', { customAllowance: numOrNull(e.target.value) })} />
                </Field>
              )}
            </li>
            <li data-done={!!secrets.github_token || undefined}>
              <b>Token de solo lectura</b>
              <SecretInput
                id="github_token"
                label="Token de GitHub (fine-grained)"
                configured={!!secrets.github_token}
                onSaved={loadSecrets}
                hint={<>Créalo en <Link href={LINKS.githubToken}>GitHub › Fine-grained tokens</Link> con el permiso de cuenta «Plan»: solo lectura.</>}
              />
            </li>
            <HealthStep id="copilot" {...healthFor('copilot', !cfg.copilot.enabled)} />
          </ol>
        </Section>
      )}

      {tab === 'minimax' && (
        <Section kicker="Suscripción · API oficial" title="MiniMax">
          <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, 'minimax', cfg.minimax.enabled)} onChange={(v) => setVisibility('minimax', v)} />
          <p className="q-note">
            Cuota del plan y, si añades la segunda clave, tu saldo de pago por uso. Son
            <b> dos credenciales distintas</b> en la consola: la primera da acceso al plan y la segunda al saldo.
          </p>
          <ol className="q-steps" aria-label="Cómo conectar la cuenta">
            <li data-done={!!secrets.minimax_subscription_key || undefined}>
              <b>Subscription Key del plan</b>
              <SecretInput
                id="minimax_subscription_key"
                label="Subscription Key"
                configured={!!secrets.minimax_subscription_key}
                onSaved={loadSecrets}
                hint={<>Del panel M/Token en <Link href={LINKS.minimaxKeys}>minimax.io</Link>. En la región de China, en <Link href={LINKS.minimaxKeysCn}>minimaxi.com</Link> (el host por región se cambia en Ajustes avanzados).</>}
              />
            </li>
            <li data-done={!!secrets.minimax_api_key || undefined}>
              <b>API key de pago por uso (opcional)</b>
              <SecretInput
                id="minimax_api_key"
                label="API key PAYG"
                configured={!!secrets.minimax_api_key}
                onSaved={loadSecrets}
                hint={<>Sin ella solo se muestra la cuota del plan; el saldo es opcional y su fallo no lo degrade.</>}
              />
            </li>
            <HealthStep id="minimax" {...healthFor('minimax', !cfg.minimax.enabled)} />
          </ol>
          <details className="q-details">
            <summary>Avanzado · URL del API</summary>
            <Field
              label="Base URL"
              hint="Las claves son por región: global en api.minimax.io, China en api.minimaxi.com. Si el anillo sale con error 1004 o 2049, prueba con la de tu región."
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
      )}
      {tab === 'openrouter' && (
        <Section kicker="Pago por uso · API oficial" title="OpenRouter">
          <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, 'openrouter', cfg.openrouter.enabled)} onChange={(v) => setVisibility('openrouter', v)} />
          <p className="q-note">Gasto del mes y de hoy, límite de la key (si tiene) y saldo de la cuenta.</p>
          <ol className="q-steps" aria-label="Cómo conectar la cuenta">
            <li data-done={!!secrets.openrouter_api_key || undefined}>
              <b>API key</b>
              <SecretInput
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

      {tab === 'zai' && (
        <Section kicker="Suscripción · GLM Coding Plan" title="z.ai">
          <Toggle label="Mostrar en el widget" checked={isAccountVisible(cfg, 'zai', cfg.zai.enabled)} onChange={(v) => setVisibility('zai', v)} />
          <p className="q-note">Cuotas de coding de las últimas 5 h y de la semana, y cuota mensual de web tools del Coding Plan.</p>
          <ol className="q-steps" aria-label="Cómo conectar la cuenta">
            <li data-done={!!secrets.zai_api_key || undefined}>
              <b>API key</b>
              <SecretInput
                id="zai_api_key"
                label="API key"
                configured={!!secrets.zai_api_key}
                onSaved={loadSecrets}
                hint={<>Créala en <Link href={LINKS.zaiKeys}>z.ai › API Keys</Link>.</>}
              />
            </li>
            <HealthStep id="zai" {...healthFor('zai', !cfg.zai.enabled)} />
          </ol>
        </Section>
      )}

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
                <footer className="q-drawer__foot">
                  <span className="q-foot__msg" role="status">{saved}</span>
                  <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={closeDrawer}>
                    Listo
                  </button>
                  <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={save} disabled={!dirty || saving}>
                    {saving ? 'Guardando…' : 'Guardar cambios'}
                  </button>
                </footer>
              </aside>
            </>
          )}

          {section === 'look' && (
            <div className="q-grid-2">
              <Section title="Anillos">
                <div className="q-preview">
                  <span className="eg-gauge" role="img" aria-label={`Vista previa a ${cfg.orbSize} px`} style={{ '--size': `${cfg.orbSize}px` } as CSSProperties}>
                    <span className="eg-gauge__ring" style={{ '--p': 0.82 } as CSSProperties} />
                    {!cfg.compact && <span className="eg-gauge__ring" style={{ '--p': 0.46 } as CSSProperties} />}
                    {!cfg.compact && cfg.orbSize >= 40 && <span className="eg-gauge__ring" style={{ '--p': 0.31 } as CSSProperties} />}
                    <span className="eg-gauge__logo logo">
                      <ProviderLogo id="claude" name="Claude" />
                    </span>
                  </span>
                  <Field label="Tamaño del anillo" value={`${cfg.orbSize} px`} hint={<button type="button" className="q-link" onClick={() => changeOrbSize(ORB_SIZE.default)}>Restablecer ({ORB_SIZE.default} px)</button>}>
                    <input type="range" min={ORB_SIZE.min} max={ORB_SIZE.max} step={2} value={cfg.orbSize} style={rangeFill(cfg.orbSize, ORB_SIZE.min, ORB_SIZE.max)} onChange={(e) => changeOrbSize(Number(e.target.value))} />
                  </Field>
                </div>
                <div className="eg-field">
                  <span className="eg-field__label">Color de acento</span>
                  <div className="q-swatches">
                    {ACCENT_PRESETS.map((c) => (
                      <button key={c} type="button" className="q-swatch" style={{ background: c }} aria-label={`Usar ${c}`} aria-pressed={normalizeHex(cfg.accentColor) === c} onClick={() => changeAccent(c)} />
                    ))}
                    <label className="q-swatch q-swatch--picker" title="Elegir cualquier color (RGB)">
                      <input type="color" value={normalizeHex(cfg.accentColor)} onChange={(e) => changeAccent(e.target.value)} />
                      <span aria-hidden="true">+</span>
                    </label>
                  </div>
                  <span className="q-palette" aria-label="Colores resultantes">
                    {palette.map((c, i) => (
                      <span key={i}>
                        <i style={{ background: c }} />
                        {c}
                      </span>
                    ))}
                  </span>
                  <small className="eg-field__hint">
                    Es el del anillo exterior y la primera barra; los otros dos tonos salen solos. Los avisos y el exceso conservan sus colores de alerta.{' '}
                    <button type="button" className="q-link" onClick={() => changeAccent(DEFAULT_ACCENT)}>Restablecer rojo egdev</button>
                  </small>
                </div>
                <Field label="Opacidad de la tira y el panel" value={`${Math.round(cfg.opacity * 100)} %`}>
                  <input type="range" min={0.3} max={1} step={0.02} value={cfg.opacity} style={rangeFill(cfg.opacity, 0.3, 1)} onChange={(e) => liveChange({ opacity: Number(e.target.value) })} />
                </Field>
                <Rows>
                  <Toggle label="Círculos pequeños" hint="Un solo anillo por suscripción: el límite más cercano." checked={cfg.compact} onChange={(v) => liveChange({ compact: v })} />
                  <Toggle label="Mostrar resets en los círculos" hint="El saldo de resets siempre sigue disponible en el panel de detalle." checked={cfg.showResets ?? true} onChange={(v) => liveChange({ showResets: v })} />
                </Rows>
              </Section>

              <Section title="Tira">
                <div className="eg-field">
                  <span className="eg-field__label" id="lb-edge">Borde</span>
                  <div className="q-chips" role="radiogroup" aria-labelledby="lb-edge">
                    {EDGES.map((e) => (
                      <button key={e.id} type="button" role="radio" aria-checked={cfg.dockEdge === e.id} className={`eg-chip${cfg.dockEdge === e.id ? ' is-active' : ''}`} onClick={() => liveChange({ dockEdge: e.id })}>
                        {e.label}
                      </button>
                    ))}
                  </div>
                  <small className="eg-field__hint">También puedes arrastrarla desde su asa: se pega al borde más cercano.</small>
                </div>
                <Field label="Posición en el borde" value={`${Math.round(cfg.dockOffset * 100)} %`}>
                  <input type="range" min={0} max={1} step={0.01} value={cfg.dockOffset} style={rangeFill(cfg.dockOffset, 0, 1)} onChange={(e) => liveChange({ dockOffset: Number(e.target.value) })} />
                </Field>
                <Rows>
                  <Toggle label="Ocultar sola" hint="Deja una franja en el borde y vuelve al acercar el ratón o cuando hay un aviso." checked={cfg.autoHide} onChange={(v) => liveChange({ autoHide: v })} />
                  <Toggle label="Siempre encima" hint="Por encima del resto de ventanas." checked={cfg.alwaysOnTop} onChange={(v) => liveChange({ alwaysOnTop: v })} />
                </Rows>
                {liveState.error && (
                  <div className="eg-field" role="alert">
                    <span className="eg-field__label">Personalización no aplicada</span>
                    <small className="eg-field__hint">{liveState.error}</small>
                    <button type="button" className="q-link" onClick={() => void liveRef.current?.retry()}>Reintentar</button>
                  </div>
                )}
              </Section>

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
              <Section title="Cuándo avisar">
                <Rows>
                  <Toggle label="Activar avisos" checked={cfg.alerts.enabled} onChange={(v) => set('alerts', { enabled: v })} />
                  <Toggle label="Notificación del sistema" hint="Además del efecto en pantalla." checked={cfg.alerts.native} onChange={(v) => set('alerts', { native: v })} />
                </Rows>
                <div className="q-moment">
                  <h3>1 · Al superar el límite</h3>
                  <Field label="Avisar al llegar a" value={`${Math.round(cfg.alerts.threshold)} %`} hint="Una vez por ventana (sesión de 5 h, semana, mes…).">
                    <input type="range" min={50} max={100} step={1} value={cfg.alerts.threshold} style={rangeFill(cfg.alerts.threshold, 50, 100)} onChange={(e) => set('alerts', { threshold: Number(e.target.value) })} />
                  </Field>
                  <MomentEffect moment="exceeded" effect={cfg.alerts.exceededEffect} media={cfg.alerts.exceededMedia} alerts={cfg.alerts} onEffect={(v) => set('alerts', { exceededEffect: v })} onMedia={(v) => set('alerts', { exceededMedia: v })} onPersist={persistAlerts} onError={setSaved} />
                </div>
                <div className="q-moment">
                  <h3>2 · Al reiniciarse</h3>
                  <Rows>
                    <Toggle label="Avisar cuando el límite superado se reinicia" hint="«Claude · Sesión 5 h: disponible de nuevo»" checked={cfg.alerts.onReset} onChange={(v) => set('alerts', { onReset: v })} />
                  </Rows>
                  {cfg.alerts.onReset && (
                    <MomentEffect moment="reset" effect={cfg.alerts.resetEffect} media={cfg.alerts.resetMedia} alerts={cfg.alerts} onEffect={(v) => set('alerts', { resetEffect: v })} onMedia={(v) => set('alerts', { resetMedia: v })} onPersist={persistAlerts} onError={setSaved} />
                  )}
                </div>
              </Section>

              <Section title="Efecto propio">
                <p className="q-note">
                  Un vídeo WebM (VP9) con canal alfa o una imagen animada GIF, WebP o APNG con transparencia. Se muestra centrado encima de todo,
                  sin bloquear el ratón; el vídeo dura lo que dure (máx. 20 s) y las imágenes 4,5 s.
                </p>
                <Field label="Tamaño">
                  <select value={cfg.alerts.mediaSize} onChange={(e) => set('alerts', { mediaSize: e.target.value as MediaSize })}>
                    <option value="small">Pequeño</option>
                    <option value="medium">Mediano</option>
                    <option value="full">Pantalla completa</option>
                  </select>
                </Field>
                <Rows>
                  <Toggle label="Con sonido" hint="Solo para vídeos." checked={cfg.alerts.mediaSound} onChange={(v) => set('alerts', { mediaSound: v })} />
                </Rows>
              </Section>
            </div>
          )}

          {section === 'shortcuts' && (
            <Section title="Atajos globales">
              <Rows>
                <Toggle label="Activar atajos" hint="Funcionan aunque Quorb no tenga el foco." checked={cfg.shortcuts.enabled} onChange={(v) => set('shortcuts', { enabled: v })} />
              </Rows>
              {cfg.shortcuts.enabled && (
                <>
                  <div className="eg-table-wrap">
                    <table className="eg-table eg-table--compact">
                      <caption className="q-sr">Atajos de teclado</caption>
                      <thead>
                        <tr>
                          <th scope="col">Acción</th>
                          <th scope="col">Atajo</th>
                          <th scope="col" className="eg-table__acts"><span className="q-sr">Acciones</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        <ShortcutRow label="Mostrar u ocultar la tira" value={cfg.shortcuts.toggle} onChange={(v) => set('shortcuts', { toggle: v })} />
                        <ShortcutRow label="Abrir el más cargado" value={cfg.shortcuts.openPeak} onChange={(v) => set('shortcuts', { openPeak: v })} />
                        <ShortcutRow label="Actualizar ahora" value={cfg.shortcuts.refresh} onChange={(v) => set('shortcuts', { refresh: v })} />
                      </tbody>
                    </table>
                  </div>
                  <ShortcutNotices errors={shortcutErrors} warnings={shortcutWarnings} />
                  <small className="eg-field__hint">Pulsa un atajo o «Cambiar» y teclea la combinación. Se aplican al guardar.</small>
                </>
              )}
            </Section>
          )}

          {section === 'updates' && (
            <div className="q-grid-2">
              <UpdatesSection auto={cfg.autoUpdate} onAuto={(v) => set('autoUpdate', v)} />
              <Section title="Proyecto">
                <p className="q-note">Quorb es open source (MIT). Si te ahorra un susto con los límites, una estrella en GitHub ayuda a que lo encuentre más gente.</p>
                <div className="q-chips">
                  <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => openUrl(LINKS.repo)}>GitHub</button>
                  <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => openUrl(LINKS.issues)}>Pedir un proveedor</button>
                  <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => openUrl(LINKS.web)}>egdev.es</button>
                </div>
              </Section>
            </div>
          )}
        </div>

        <footer className="q-foot">
          <span className="q-foot__msg" role="status">{saved}</span>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => getCurrentWindow().close()}>
            Cerrar
          </button>
          <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </footer>
      </main>
    </div>
  );
}
