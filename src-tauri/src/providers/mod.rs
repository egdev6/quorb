//! Cada proveedor devuelve un `UsageReport`. Nunca hacen panic ni
//! devuelven `Err`: cualquier fallo se refleja en `status` + `message`.

pub mod anthropic_api;
pub mod antigravity;
pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod gemini;
pub mod grok;
pub mod minimax;
pub mod nan;
pub mod nan_cloud;
pub mod nine_router;
pub mod nine_router_creds;
pub mod openai_api;
pub mod opencode_go;
pub mod openrouter;
pub mod zai;

use crate::config::{
    credentials_file_name, Account, ApiCostConfig, AppConfig, CopilotConfig, NanConfig,
    OpenCodeGoConfig, OpenRouterConfig, SubscriptionConfig, ZaiConfig,
};
use crate::i18n::Locale;
use crate::model::{Kind, Status, UsageReport};
use crate::secrets;
use crate::wsl::SessionResolver;
use chrono::{DateTime, Datelike, TimeZone, Utc};
use futures::future::BoxFuture;
use futures::FutureExt;
use std::path::{Path, PathBuf};

/// Cuenta que se consulta: la principal de un proveedor (id = proveedor, secretos
/// sin sufijo) o una adicional (id `<proveedor>:<sufijo>`, secretos `<secreto>@<id>`).
#[derive(Clone, Copy, Debug)]
pub struct Who<'a> {
    pub id: &'a str,
    pub label: Option<&'a str>,
}

impl<'a> Who<'a> {
    pub fn main(id: &'a str) -> Self {
        Self { id, label: None }
    }

    pub fn extra(a: &'a Account) -> Self {
        Self {
            id: &a.id,
            label: Some(&a.label),
        }
    }

    pub fn is_main(&self) -> bool {
        self.label.is_none()
    }

    /// Informe con el id de la cuenta y su nombre («Claude · Trabajo»).
    pub fn report(&self, name: &str, kind: Kind) -> UsageReport {
        match self.label {
            None => UsageReport::new(self.id, name, kind),
            Some(l) => UsageReport::new(self.id, &format!("{name} · {l}"), kind),
        }
    }

    pub fn secret(&self, key: &str) -> Option<String> {
        if self.is_main() {
            secrets::get(key)
        } else {
            secrets::get(&secrets::scoped(key, self.id))
        }
    }
}

/// Acceso a las sesiones de los CLIs para este refresco (#91, revisión PR
/// #248): `Host` (credenciales locales), `Wsl` (resolvedor de la distro) o
/// `Unavailable` (el entorno elegido no se pudo resolver: distro detenida,
/// inexistente o WSL roto).
///
/// Con `Unavailable` los proveedores CUYA sesión vive en el entorno (los
/// cuatro CLIs y las cuentas adicionales) reportan el fallo, y los
/// independientes (Copilot, APIs, 9Router…) se consultan igual: un problema
/// de WSL no debe vaciar la tira completa.
// `SessionResolver` no implementa `Debug` (no hace falta aquí): sin derive.
#[derive(Clone, Copy)]
pub enum SessionAccess<'a> {
    /// Credenciales del host (Windows/macOS), el comportamiento de siempre.
    Host,
    /// Resolvedor de sesiones dentro de la distro elegida.
    Wsl(&'a SessionResolver),
    /// El entorno configurado está inaccesible en este refresco.
    Unavailable(&'a str),
}

impl<'a> SessionAccess<'a> {
    pub fn resolver(self) -> Option<&'a SessionResolver> {
        match self {
            SessionAccess::Wsl(r) => Some(r),
            _ => None,
        }
    }

    /// Motivo por el que el entorno no está disponible (solo `Unavailable`).
    pub fn unavailable(self) -> Option<&'a str> {
        match self {
            SessionAccess::Unavailable(e) => Some(e),
            _ => None,
        }
    }
}

pub async fn fetch_all(
    cfg: &AppConfig,
    http: &reqwest::Client,
    access: SessionAccess<'_>,
) -> Vec<UsageReport> {
    let resolver = access.resolver();
    // Entorno inaccesible: los CLIs reportan el fallo en su orbe (revisión PR
    // #248); el resto de proveedores se consulta con normalidad.
    let env_error = access.unavailable();
    // Los mensajes propios de credenciales/login nacen en la locale activa.
    let locale = crate::i18n::locale_from_config(&cfg.locale);
    let mut jobs: Vec<BoxFuture<'_, Vec<UsageReport>>> = vec![];
    if cfg.claude.enabled {
        jobs.push(
            async move {
                vec![match env_error {
                    Some(e) => Who::main("claude")
                        .report("Claude", Kind::Subscription)
                        .fail(Status::Error, e),
                    None => {
                        claude::fetch(&cfg.claude, locale, Who::main("claude"), http, resolver)
                            .await
                    }
                }]
            }
            .boxed(),
        );
    }
    if cfg.codex.enabled {
        jobs.push(
            async move {
                vec![match env_error {
                    Some(e) => Who::main("codex")
                        .report("ChatGPT · Codex", Kind::Subscription)
                        .fail(Status::Error, e),
                    None => {
                        codex::fetch(&cfg.codex, locale, Who::main("codex"), http, resolver).await
                    }
                }]
            }
            .boxed(),
        );
    }
    if cfg.gemini.enabled {
        jobs.push(
            async move {
                vec![match env_error {
                    Some(e) => Who::main("gemini")
                        .report("Gemini", Kind::Subscription)
                        .fail(Status::Error, e),
                    None => {
                        gemini::fetch(&cfg.gemini, locale, Who::main("gemini"), http, resolver)
                            .await
                    }
                }]
            }
            .boxed(),
        );
    }
    if cfg.grok.enabled {
        jobs.push(
            async move {
                vec![match env_error {
                    Some(e) => Who::main("grok")
                        .report("Grok", Kind::Subscription)
                        .fail(Status::Error, e),
                    None => grok::fetch(&cfg.grok, locale, Who::main("grok"), http, resolver).await,
                }]
            }
            .boxed(),
        );
    }
    if cfg.cursor.enabled {
        jobs.push(
            async move { vec![cursor::fetch(&cfg.cursor, locale, Who::main("cursor"), http).await] }
                .boxed(),
        );
    }
    if cfg.copilot.enabled {
        jobs.push(
            async move { vec![copilot::fetch(&cfg.copilot, Who::main("copilot"), http).await] }
                .boxed(),
        );
    }
    if cfg.nan.enabled {
        jobs.push(async move { vec![nan::fetch(&cfg.nan, Who::main("nan"), http).await] }.boxed());
    }
    if cfg.openrouter.enabled {
        jobs.push(async move { vec![openrouter::fetch(&cfg.openrouter, Who::main("openrouter"), http).await] }.boxed());
    }
    if cfg.minimax.enabled {
        jobs.push(
            async move { vec![minimax::fetch(&cfg.minimax, Who::main("minimax"), http).await] }
                .boxed(),
        );
    }
    if cfg.nine_router.enabled {
        // 9Router lleva su propio registro de uso; ademas del orbe agregado,
        // descubrimos sus sub-proveedores y los exponemos como cuentas propias.
        jobs.push(nine_router_all(cfg, http));
    }
    if cfg.anthropic_api.enabled {
        jobs.push(
            async move {
                vec![
                    anthropic_api::fetch(&cfg.anthropic_api, Who::main("anthropic_api"), http)
                        .await,
                ]
            }
            .boxed(),
        );
    }
    if cfg.openai_api.enabled {
        jobs.push(async move { vec![openai_api::fetch(&cfg.openai_api, Who::main("openai_api"), http).await] }.boxed());
    }
    if cfg.zai.enabled {
        jobs.push(async move { vec![zai::fetch(&cfg.zai, Who::main("zai"), http).await] }.boxed());
    }
    if cfg.opencode_go.enabled {
        jobs.push(
            async move {
                vec![opencode_go::fetch(&cfg.opencode_go, Who::main("opencode_go"), http).await]
            }
            .boxed(),
        );
    }
    if cfg.antigravity.enabled {
        jobs.push(
            async move {
                vec![antigravity::fetch(&cfg.antigravity, Who::main("antigravity"), http).await]
            }
            .boxed(),
        );
    }
    for a in cfg.accounts.iter().filter(|a| a.enabled) {
        jobs.push(async move { vec![fetch_account(cfg, a, http, access).await] }.boxed());
    }
    futures::future::join_all(jobs)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// Orbe de 9Router más un informe por cada sub-proveedor que haya visto
/// (Claude, Kiro, GLM…). Los sub-proveedores se descubren desde el propio
/// historial de uso de 9Router: no se configuran a mano.
fn nine_router_all<'a>(
    cfg: &'a AppConfig,
    http: &'a reqwest::Client,
) -> BoxFuture<'a, Vec<UsageReport>> {
    // Una sola lectura de stats alimenta el orbe agregado y todos los sub-orbes.
    async move { nine_router::fetch_all(&cfg.nine_router, http).await }.boxed()
}
/// Consulta una sola cuenta (principal o adicional) aunque esté oculta en el widget,
/// para comprobar la conexión desde Ajustes. `None` si el id no existe.
pub async fn fetch_one(
    cfg: &AppConfig,
    id: &str,
    http: &reqwest::Client,
    access: SessionAccess<'_>,
) -> Option<UsageReport> {
    if let Some(a) = cfg.accounts.iter().find(|a| a.id == id) {
        return Some(fetch_account(cfg, a, http, access).await);
    }
    let resolver = access.resolver();
    let env_error = access.unavailable();
    let locale = crate::i18n::locale_from_config(&cfg.locale);
    Some(match id {
        "claude" => match env_error {
            Some(e) => Who::main("claude")
                .report("Claude", Kind::Subscription)
                .fail(Status::Error, e),
            None => claude::fetch(&cfg.claude, locale, Who::main("claude"), http, resolver).await,
        },
        "codex" => match env_error {
            Some(e) => Who::main("codex")
                .report("ChatGPT · Codex", Kind::Subscription)
                .fail(Status::Error, e),
            None => codex::fetch(&cfg.codex, locale, Who::main("codex"), http, resolver).await,
        },
        "gemini" => match env_error {
            Some(e) => Who::main("gemini")
                .report("Gemini", Kind::Subscription)
                .fail(Status::Error, e),
            None => gemini::fetch(&cfg.gemini, locale, Who::main("gemini"), http, resolver).await,
        },
        "grok" => match env_error {
            Some(e) => Who::main("grok")
                .report("Grok", Kind::Subscription)
                .fail(Status::Error, e),
            None => grok::fetch(&cfg.grok, locale, Who::main("grok"), http, resolver).await,
        },
        "cursor" => cursor::fetch(&cfg.cursor, locale, Who::main("cursor"), http).await,
        "copilot" => copilot::fetch(&cfg.copilot, Who::main("copilot"), http).await,
        "nan" => nan::fetch(&cfg.nan, Who::main("nan"), http).await,
        "openrouter" => openrouter::fetch(&cfg.openrouter, Who::main("openrouter"), http).await,
        "minimax" => minimax::fetch(&cfg.minimax, Who::main("minimax"), http).await,
        "nine_router" => nine_router::fetch(&cfg.nine_router, Who::main("nine_router"), http).await,
        "anthropic_api" => {
            anthropic_api::fetch(&cfg.anthropic_api, Who::main("anthropic_api"), http).await
        }
        "openai_api" => openai_api::fetch(&cfg.openai_api, Who::main("openai_api"), http).await,
        "zai" => zai::fetch(&cfg.zai, Who::main("zai"), http).await,
        "opencode_go" => opencode_go::fetch(&cfg.opencode_go, Who::main("opencode_go"), http).await,
        "antigravity" => antigravity::fetch(&cfg.antigravity, Who::main("antigravity"), http).await,
        _ => return None,
    })
}

/// Fichero de sesión que deja el CLI de una cuenta: la principal de Claude, Codex
/// o Gemini (por proveedor) o una adicional (por id). `None` si no usa CLI.
/// `home` se inyecta para poder probar con carpetas propias.
pub fn session_file(cfg: &AppConfig, id: &str, home: &Path) -> Option<PathBuf> {
    let locale = crate::i18n::locale_from_config(&cfg.locale);
    if let Some(a) = cfg.accounts.iter().find(|a| a.id == id) {
        return a.credentials_file(home);
    }
    let main = |c: &SubscriptionConfig, default: PathBuf| match c
        .credentials_path
        .as_deref()
        .map(str::trim)
    {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default,
    };
    match id {
        "claude" => Some(main(
            &cfg.claude,
            home.join(".claude").join(".credentials.json"),
        )),
        "codex" => codex::resolved_auth_path(locale, cfg.codex.credentials_path.as_deref()).ok(),
        "gemini" => Some(main(
            &cfg.gemini,
            home.join(".gemini").join("oauth_creds.json"),
        )),
        "grok" => grok::resolved_auth_path(locale, cfg.grok.credentials_path.as_deref()).ok(),
        _ => None,
    }
}

/// Proveedor con sesión CLI, para `session_relative` (una sola fuente,
/// sin `expect` en runtime; revisión del mantenedor, 2026-11-06).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CliSessionKind {
    Claude,
    Codex,
    Gemini,
    Grok,
}

/// Ruta RELATIVA de la sesión de cada proveedor CLI (una sola fuente para
/// los cuatro `fetch` y `wsl_session_stamp`). Match exhaustivo sobre el
/// enum: no hay `expect` posible.
pub(crate) fn session_relative(kind: CliSessionKind) -> PathBuf {
    let parts: &[&str] = match kind {
        CliSessionKind::Claude => &[".claude", ".credentials.json"],
        CliSessionKind::Codex => &[".codex", "auth.json"],
        CliSessionKind::Gemini => &[".gemini", "oauth_creds.json"],
        CliSessionKind::Grok => &[".grok", "auth.json"],
    };
    crate::wsl::guest_relative(parts)
}

/// La ruta de sesión de una cuenta ADICIONAL en el entorno del resolvedor
/// (#91, revisión del mantenedor 2026-11-04).
///
/// En WSL se compone con semántica POSIX en TODO el recorrido: el
/// `PathBuf::join` de Windows insertaría `\` en el interior (y
/// `join_guest_path` solo normaliza la frontera), y el `cat` del guest no
/// puede leer una ruta con separadores del host. Por eso:
/// - `config_dir` con separador del host (`\`) o NO absoluto del guest
///   (empieza por `/`) → error de configuración ACCIONABLE, no una ruta
///   inválida que luego falla en silencio como «Sin sesión».
/// - `config_dir` absoluto del guest → se usa tal cual (la carpeta que
///   eligió el usuario), sin re-enraizar bajo el home.
/// - Sin `config_dir` → la carpeta por defecto (`~/.quorb`) compuesta bajo
///   el home del entorno.
/// En host devuelve la ruta de `credentials_file` de siempre.
///
/// La usan el fetch de la cuenta y el SONDEO de presencia (`account_session`,
/// revisión PR #92): con `resolver` la ruta sale del ENTORNO elegido (el
/// guest), no del disco del host — tras un login en WSL, sondear el host
/// daría por buena una sesión de Windows sin relación.
pub(crate) fn account_session_path(
    a: &Account,
    resolver: Option<&SessionResolver>,
) -> Result<Option<String>, String> {
    let Some(r) = resolver else {
        return Ok(a
            .credentials_file(&home())
            .map(|p| p.to_string_lossy().into_owned()));
    };
    // Proveedores SIN login por CLI (openrouter, zai, nan, copilot…): la
    // cuenta no resuelve sesión en este entorno; su fetch usa su token
    // normal. NO cortar `fetch_account` (revisión rust 2026-11-04).
    let Some(name) = credentials_file_name(a.provider.as_str()) else {
        return Ok(None);
    };
    match &a.config_dir {
        Some(d) => {
            let d = d.trim();
            // Regla única de «POSIX absoluta del guest» (wsl::guest_path_problem;
            // revisión del mantenedor, 2026-11-06).
            if let Some(problem) = crate::wsl::guest_path_problem(d) {
                return Err(format!(
                    "La carpeta de la cuenta {} no es válida en modo WSL: {problem}",
                    a.id
                ));
            }
            // La carpeta que eligió el usuario, tal cual (sin re-enraizar
            // bajo el home): una absoluta del guest no se compone con nada.
            Ok(Some(format!("{}/{}", d.trim_end_matches('/'), name)))
        }
        None => {
            // La MISMA ruta por defecto que el host (revisión del
            // mantenedor, 2026-11-06): `home_dir` del canal +
            // `accounts/<provider>-<suffix>` + fichero, con separador POSIX
            // del guest. Así dos cuentas del mismo proveedor NO comparten
            // fichero (el aislamiento que declara `wsl/session.rs`) y los
            // canales con otro `home_dir` no divergen.
            let account_dir = format!("{}-{}", a.provider, a.suffix());
            let rel = crate::wsl::guest_relative(&[
                crate::channel::current().home_dir,
                "accounts",
                account_dir.as_str(),
                name,
            ]);
            Ok(Some(
                r.default_path(rel.as_path()).to_string_lossy().into_owned(),
            ))
        }
    }
}

fn fetch_account<'a>(
    cfg: &'a AppConfig,
    a: &'a Account,
    http: &'a reqwest::Client,
    access: SessionAccess<'a>,
) -> BoxFuture<'a, UsageReport> {
    let who = Who::extra(a);
    let locale = crate::i18n::locale_from_config(&cfg.locale);
    // Algunas cuentas adicionales son de proveedores sin sesión CLI (Copilot,
    // APIs…): su fetch no depende del ENTORNO y no le aplica el fallo de WSL
    // (revisión PR #248). Las de proveedores CLI sí: su sesión vive en la
    // distro elegida.
    const CLI_PROVIDERS: &[&str] = &["claude", "codex", "gemini", "grok"];
    if let (Some(e), true) = (
        access.unavailable(),
        CLI_PROVIDERS.contains(&a.provider.as_str()),
    ) {
        return (async move {
            who.report(a.provider.as_str(), Kind::Subscription)
                .fail(Status::Error, e)
        })
        .boxed();
    }
    let resolver = access.resolver();
    // La ruta de la cuenta adicional se compone en el ENTORNO del resolvedor
    // (POSIX en WSL). Una configuración no POSIX en modo WSL (ruta del host,
    // relativa) es un error EXPLÍCITO de la cuenta, no un «Sin sesión»
    // silencioso (revisión del mantenedor, 2026-11-04).
    let account_path = match account_session_path(a, resolver) {
        Ok(p) => p,
        Err(message) => {
            return (async move {
                who.report(a.provider.as_str(), Kind::Subscription)
                    .fail(Status::Error, message)
            })
            .boxed();
        }
    };
    let session = move |main: &SubscriptionConfig| SubscriptionConfig {
        enabled: true,
        credentials_path: account_path.clone(),
        login_command: main.login_command.clone(),
    };
    match a.provider.as_str() {
        "claude" => {
            async move { claude::fetch(&session(&cfg.claude), locale, who, http, resolver).await }
                .boxed()
        }
        "codex" => {
            async move { codex::fetch(&session(&cfg.codex), locale, who, http, resolver).await }
                .boxed()
        }
        "gemini" => {
            async move { gemini::fetch(&session(&cfg.gemini), locale, who, http, resolver).await }
                .boxed()
        }
        "grok" => {
            async move { grok::fetch(&session(&cfg.grok), locale, who, http, resolver).await }
                .boxed()
        }
        // Solo con su token: la sesión de la app de Cursor es la de la cuenta principal.
        "cursor" => {
            async move { cursor::fetch(&SubscriptionConfig::default(), locale, who, http).await }
                .boxed()
        }
        "copilot" => {
            let c = CopilotConfig {
                enabled: true,
                username: a.username.clone(),
                plan: if a.plan.is_empty() {
                    CopilotConfig::default().plan
                } else {
                    a.plan.clone()
                },
                custom_allowance: a.custom_allowance,
            };
            async move { copilot::fetch(&c, who, http).await }.boxed()
        }
        "nan" => {
            let mut c: NanConfig = cfg.nan.clone();
            if !a.plan.is_empty() {
                c.plan = a.plan.clone();
            }
            async move { nan::fetch(&c, who, http).await }.boxed()
        }
        "openrouter" => {
            async move { openrouter::fetch(&OpenRouterConfig { enabled: true }, who, http).await }
                .boxed()
        }
        // Sub-proveedor de 9Router (`nine_router:claude`): filtra su uso en las stats.
        "nine_router" => {
            async move { nine_router::fetch(&cfg.nine_router, who, http).await }.boxed()
        }
        "zai" => async move { zai::fetch(&ZaiConfig { enabled: true }, who, http).await }.boxed(),
        "opencode_go" => {
            async move { opencode_go::fetch(&OpenCodeGoConfig { enabled: true }, who, http).await }
                .boxed()
        }
        "anthropic_api" | "openai_api" => {
            let c = ApiCostConfig {
                enabled: true,
                monthly_budget_usd: a.monthly_budget_usd,
            };
            if a.provider == "anthropic_api" {
                async move { anthropic_api::fetch(&c, who, http).await }.boxed()
            } else {
                async move { openai_api::fetch(&c, who, http).await }.boxed()
            }
        }
        other => {
            let r = who.report(other, Kind::Subscription).fail(
                crate::model::Status::Error,
                format!("Proveedor desconocido: {other}"),
            );
            async move { r }.boxed()
        }
    }
}

/// Primer instante del mes actual (UTC).
pub(crate) fn month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

/// Primer instante del mes siguiente (UTC).
pub(crate) fn next_month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let (y, m) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    Utc.with_ymd_and_hms(y, m, 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

/// Reinicio y duración del mes natural en curso, para medidores mensuales.
pub(crate) fn month_window(now: DateTime<Utc>) -> (String, i64) {
    let start = month_start(now);
    let end = next_month_start(now);
    (end.to_rfc3339(), (end - start).num_seconds())
}

pub(crate) fn unix_to_rfc3339(secs: i64) -> Option<String> {
    Utc.timestamp_opt(secs, 0).single().map(|d| d.to_rfc3339())
}

/// Ruta explícita si existe; si no, la primera candidata que exista. Los
/// mensajes nacen en la locale activa (L4, #66); las rutas van literales.
pub(crate) fn resolve_path(
    locale: Locale,
    explicit: Option<&str>,
    candidates: &[PathBuf],
) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        let p = PathBuf::from(p.trim());
        return if p.is_file() {
            Ok(p)
        } else {
            Err(crate::i18n::path_not_found(
                locale,
                &p.display().to_string(),
            ))
        };
    }
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| {
            let list: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
            crate::i18n::credentials_not_found(locale, &list.join(", "))
        })
}

pub(crate) fn read_json(locale: Locale, path: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        crate::i18n::cannot_read(locale, &path.display().to_string(), &e.to_string())
    })?;
    serde_json::from_str(&raw)
        .map_err(|e| crate::i18n::invalid_json(locale, &path.display().to_string(), &e.to_string()))
}

/// Huella de los ficheros de sesión de los CLIs (Claude Code, Codex, Gemini) de
/// todas las cuentas. Cambia en cuanto un CLI renueva su token o se inicia
/// sesión, y así el widget recarga al momento sin que la app toque los tokens.
///
/// En host es la suma de las fechas de modificación en ms; en WSL el fichero
/// vive dentro de la distro y no hay `mtime` accesible desde el host, así que
/// se lee su contenido por el adaptador y se suma su huella. Ambas solo
/// sirven para DETECTAR un cambio, no como identificador absoluto (#91).
pub async fn session_stamp(cfg: &AppConfig, resolver: Option<&SessionResolver>) -> u64 {
    match resolver {
        // WSL: las cuentas que la app lee viven dentro de la distro; el sello
        // observa exactamente los ficheros que se leen (misma fuente que los
        // fetch: `credentials_path` > home de la distro).
        Some(r) => wsl_session_stamp(cfg, r).await,
        // Host: mtimes del disco local, como siempre.
        None => host_session_stamp(cfg),
    }
}

/// Sello del entorno host: suma de mtimes de los ficheros de sesión.
fn host_session_stamp(cfg: &AppConfig) -> u64 {
    let locale = crate::i18n::locale_from_config(&cfg.locale);
    let h = home();
    let main = |c: &SubscriptionConfig, default: PathBuf| match c
        .credentials_path
        .as_deref()
        .map(str::trim)
    {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default,
    };
    let mut files: Vec<PathBuf> = vec![];
    if cfg.claude.enabled {
        files.push(main(
            &cfg.claude,
            h.join(".claude").join(".credentials.json"),
        ));
    }
    if cfg.codex.enabled {
        // Mismo resolver que `codex::fetch`: así el sello observa el fichero
        // que de verdad se lee (incluido el respaldo ~/.codex/auth.json).
        if let Ok(p) = codex::resolved_auth_path(locale, cfg.codex.credentials_path.as_deref()) {
            files.push(p);
        }
    }
    if cfg.gemini.enabled {
        files.push(main(
            &cfg.gemini,
            h.join(".gemini").join("oauth_creds.json"),
        ));
    }
    if cfg.grok.enabled {
        // Mismo resolver que `grok::fetch`: el sello observa el fichero que de
        // verdad se lee (incluido el respaldo ~/.grok/auth.json).
        if let Ok(p) = grok::resolved_auth_path(locale, cfg.grok.credentials_path.as_deref()) {
            files.push(p);
        }
    }
    files.extend(
        cfg.accounts
            .iter()
            .filter(|a| a.enabled)
            .filter_map(|a| a.credentials_file(&h)),
    );
    files
        .iter()
        .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .fold(0u64, |acc, d| acc.wrapping_add(d.as_millis() as u64))
}

/// Sello del entorno WSL: huella del CONTENIDO de cada fichero de sesión
/// dentro de la distro. Un `codex login` (o la renovación de un token) en la
/// distro cambia el contenido y por tanto el sello, aunque el host no tenga
/// mtime accesible (revisión PR #220).
async fn wsl_session_stamp(cfg: &AppConfig, r: &SessionResolver) -> u64 {
    // La ruta relativa sale de la MISMA fuente que los fetch
    // (`session_relative` sobre el enum; revisión del mantenedor, 2026-11-06).
    let main = |c: &SubscriptionConfig, kind: CliSessionKind| {
        let relative = session_relative(kind);
        r.resolve(
            c.credentials_path.as_deref(),
            &r.default_path(relative.as_path()),
        )
        .ok()
    };
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(p) = main(&cfg.claude, CliSessionKind::Claude) {
        paths.push(p);
    }
    if let Some(p) = main(&cfg.codex, CliSessionKind::Codex) {
        paths.push(p);
    }
    if let Some(p) = main(&cfg.gemini, CliSessionKind::Gemini) {
        paths.push(p);
    }
    if let Some(p) = main(&cfg.grok, CliSessionKind::Grok) {
        paths.push(p);
    }
    for a in cfg.accounts.iter().filter(|a| a.enabled) {
        // La cuenta adicional se compone en el ENTORNO con POSIX del guest;
        // una cuenta mal configurada (ruta del host) no contribuye a la
        // huella: el error explícito lo da el fetch de esa cuenta.
        if let Ok(Some(path)) = account_session_path(a, Some(r)) {
            paths.push(PathBuf::from(path));
        }
    }
    // Lecturas en PARALELO (issue #243): el sello corre cada 15 s y no debe
    // pagar un `wsl.exe cat` por proveedor en serie. La suma es conmutativa
    // (wrapping_add), así que el orden de resultados no altera la huella.
    // Con pocas cuentas `join_all` está bien; si crecieran mucho, acotar con
    // `buffer_unordered(n)` (nota del mantenedor, PR #248, no bloqueante).
    let results = futures::future::join_all(paths.iter().map(|p| r.read_async(p))).await;
    let mut acc = 0u64;
    for contents in results.into_iter().flatten() {
        acc = acc.wrapping_add(content_hash(contents.as_bytes()));
    }
    acc
}

/// Huella determinista del contenido (no criptográfica: solo detecta cambios).
fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Mensaje legible a partir de un error de reqwest.
pub(crate) fn net_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Tiempo de espera agotado".into()
    } else if e.is_connect() {
        "Sin conexión con el servidor".into()
    } else {
        format!("Error de red: {e}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl::{distro, DistroState, MockWslAdapter, ShellStrategy};
    use std::sync::Arc;

    /// #91 (revisión PR #220): el sello en WSL observa los ficheros DENTRO de
    /// la distro — un login allí (contenido que cambia) cambia el sello aunque
    /// el host no tenga mtime accesible y no vea el fichero.
    #[test]
    fn wsl_session_stamp_changes_when_the_token_is_renewed_inside_the_distro() {
        let mock = Arc::new(MockWslAdapter::new());
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/user"));
        let creds = PathBuf::from("/home/user/.claude/.credentials.json");
        mock.set_file(
            "Ubuntu-22.04",
            creds.clone(),
            "{\"claudeAiOauth\":{\"accessToken\":\"v1\"}}".to_string(),
        );
        let r = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
            Locale::Es,
        );
        let cfg = AppConfig {
            claude: SubscriptionConfig {
                enabled: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        let first = rt.block_on(wsl_session_stamp(&cfg, &r));
        // El CLI renueva el token dentro de la distro: el contenido cambia.
        mock.set_file(
            "Ubuntu-22.04",
            creds,
            "{\"claudeAiOauth\":{\"accessToken\":\"v2\"}}".to_string(),
        );
        let second = rt.block_on(wsl_session_stamp(&cfg, &r));
        assert_ne!(first, second, "un login en la distro debe cambiar el sello");
    }

    /// Revisión PR #248: «sin sesiones» (sello 0) es un estado LEGÍTIMO de una
    /// distro en marcha sin credenciales; `session_stamp` no lo confunde con
    /// «distro inaccesible» (que es `Err` en el comando, no 0).
    #[test]
    fn wsl_session_stamp_is_zero_when_the_distro_has_no_sessions() {
        let mock = Arc::new(MockWslAdapter::new());
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/user"));
        let r = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
            Locale::Es,
        );
        let cfg = AppConfig {
            claude: SubscriptionConfig {
                enabled: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        assert_eq!(rt.block_on(wsl_session_stamp(&cfg, &r)), 0);
    }

    /// Revisión del mantenedor (2026-11-04): la cuenta adicional en WSL se
    /// compone con POSIX en TODO el recorrido (el `PathBuf::join` de Windows
    /// insertaría `\` en el interior). El `WslCall` exacto que recibe el
    /// guest es `/home/user/.quorb/.credentials.json`, sin separadores del
    /// host.
    #[test]
    fn wsl_session_stamp_reads_extra_accounts_with_guest_posix_paths() {
        let mock = Arc::new(MockWslAdapter::new());
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/user"));
        let extra = PathBuf::from("/home/user/.quorb/accounts/claude-w1/.credentials.json");
        mock.set_file(
            "Ubuntu-22.04",
            extra.clone(),
            "{\"claudeAiOauth\":{\"accessToken\":\"v1\"}}".to_string(),
        );
        let r = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
            Locale::Es,
        );
        let cfg = AppConfig {
            accounts: vec![Account {
                id: "claude:w1".into(),
                provider: "claude".into(),
                enabled: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        let stamp = rt.block_on(wsl_session_stamp(&cfg, &r));
        assert_ne!(stamp, 0, "la cuenta adicional contribuye a la huella");
        assert!(
            mock.calls().iter().any(|c| matches!(
                c,
                crate::wsl::WslCall::ReadFile(d, p)
                    if d == "Ubuntu-22.04" && p == &extra
            )),
            "el guest recibe la ruta POSIX exacta de la cuenta adicional, llamadas: {:?}",
            mock.calls()
        );
        assert!(
            mock.calls()
                .iter()
                .all(|c| !format!("{:?}", c).contains('\\')),
            "ninguna ruta del guest lleva separadores del host"
        );
    }

    /// Regresión directa del `WslCall` desde `fetch_account` (issue #243,
    /// revisión del mantenedor): el invitado debe recibir la ruta POSIX
    /// EXACTA de la cuenta adicional. La sesión de Claude con token vencido
    /// responde NeedsLogin SIN tocar la red, así que el test es
    /// determinista: `expiresAt` en el pasado. El cliente reqwest se
    /// construye dentro del runtime (`enter`), porque el tokio del harness no
    /// expone reactor fuera de él.
    #[test]
    fn fetch_account_sends_the_exact_guest_path_for_extra_accounts() {
        let mock = Arc::new(MockWslAdapter::new());
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/user"));
        let extra = PathBuf::from("/home/user/.quorb/accounts/claude-w1/.credentials.json");
        mock.set_file(
            "Ubuntu-22.04",
            extra.clone(),
            r#"{"claudeAiOauth":{"accessToken":"vencido","expiresAt":1000}}"#.to_string(),
        );
        let r = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
            Locale::Es,
        );
        let cfg = AppConfig {
            accounts: vec![Account {
                id: "claude:w1".into(),
                provider: "claude".into(),
                enabled: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        // El cliente se construye DENTRO del contexto del runtime (`enter`):
        // el crate de tokio del harness no expone reactor fuera de él y
        // `reqwest::Client::new` exige un Handle activo.
        let _enter = rt.enter();
        let http = reqwest::Client::new();
        let report = rt
            .block_on(tokio::time::timeout(
                std::time::Duration::from_secs(10),
                fetch_account(&cfg, &cfg.accounts[0], &http, SessionAccess::Wsl(&r)),
            ))
            .expect("no debe colgar");
        let status = &report.status;
        assert!(
            matches!(status, crate::model::Status::NeedsLogin),
            "token vencido: {status:?} {:?}",
            report.message
        );
        assert!(
            mock.calls().iter().any(|c| matches!(
                c,
                crate::wsl::WslCall::ReadFile(d, p)
                    if d == "Ubuntu-22.04" && p == &extra
            )),
            "el guest recibe la ruta POSIX exacta, llamadas: {:?}",
            mock.calls()
        );
    }

    /// Revisión PR #248: con el entorno inaccesible, la cuenta adicional de un
    /// proveedor CLI reporta el fallo SIN tocar el adaptador (ni red, ni
    /// guest) — jamás una lectura silenciosa del otro entorno.
    #[test]
    fn fetch_account_reports_env_failure_without_touching_the_adapter() {
        let mock = Arc::new(MockWslAdapter::new());
        let cfg = AppConfig {
            accounts: vec![Account {
                id: "claude:w1".into(),
                provider: "claude".into(),
                enabled: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        // El cliente se construye DENTRO del contexto del runtime (`enter`),
        // como en el test directo de `fetch_account` (el tokio del harness no
        // expone reactor fuera de él). El fetch de `Unavailable` no hace red,
        // pero el constructor de reqwest ya exige el Handle.
        let _enter = rt.enter();
        let http = reqwest::Client::new();
        let report = rt.block_on(fetch_account(
            &cfg,
            &cfg.accounts[0],
            &http,
            SessionAccess::Unavailable("La distro «Ubuntu-22.04» está detenida"),
        ));
        assert!(
            matches!(report.status, crate::model::Status::Error),
            "{report:?}"
        );
        assert!(
            report.message.as_deref().unwrap_or("").contains("detenida"),
            "{report:?}"
        );
        assert!(
            mock.calls().is_empty(),
            "sin procesos del guest: {:?}",
            mock.calls()
        );
    }

    /// La composición POSIX de la cuenta adicional (revisión del
    /// mantenedor, 2026-11-04) es la única puerta de entrada de la cuenta en
    /// `fetch_account` y en `wsl_session_stamp`; un `Err` se convierte en el
    /// report de error de la cuenta sin tocar el adaptador ni la red.
    ///
    /// Absoluta del guest se usa tal cual; separadores del host o rutas
    /// relativas se rechazan con mensaje accionable.
    #[test]
    fn account_path_is_posix_and_rejects_host_shaped_config_dirs() {
        let mock = Arc::new(MockWslAdapter::new());
        let resolver = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
            Locale::Es,
        );
        let mk = |dir: Option<String>| Account {
            id: "claude:w1".into(),
            provider: "claude".into(),
            config_dir: dir,
            enabled: true,
            ..Default::default()
        };
        // Absoluta del guest: la carpeta que eligió el usuario, sin
        // re-enraizar bajo el home.
        assert_eq!(
            account_session_path(&mk(Some("/mnt/c/Users/yo/quorb".into())), Some(&resolver))
                .expect("config_dir absoluto del guest"),
            Some("/mnt/c/Users/yo/quorb/.credentials.json".to_string())
        );
        // Sin config_dir: la MISMA ruta por defecto que el host (home_dir
        // del canal + accounts/<provider>-<suffix>), POSIX.
        assert_eq!(
            account_session_path(&mk(None), Some(&resolver)).expect("defecto"),
            Some("/home/user/.quorb/accounts/claude-w1/.credentials.json".to_string())
        );
        // Separadores del host: rechazo explícito.
        let err = account_session_path(&mk(Some(r"C:\Users\yo\quorb".into())), Some(&resolver))
            .unwrap_err();
        assert!(err.contains("Windows"), "{err}");
        // Relativa: rechazo explícito (no debe caer al cwd del guest).
        let err = account_session_path(&mk(Some("accounts/claude-1".into())), Some(&resolver))
            .unwrap_err();
        assert!(err.contains("absoluta"), "{err}");
    }

    /// Los proveedores SIN login por CLI (openrouter, zai, nan…) no resuelven
    /// sesión en WSL: `Ok(None)` y su fetch normal sigue usando su token
    /// (review rust 2026-11-04).
    #[test]
    fn shellless_providers_are_not_truncated_in_wsl() {
        let mock = Arc::new(MockWslAdapter::new());
        let resolver = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
            Locale::Es,
        );
        let a = Account {
            id: "openrouter:w1".into(),
            provider: "openrouter".into(),
            enabled: true,
            ..Default::default()
        };
        assert_eq!(
            account_session_path(&a, Some(&resolver)).expect("sin error"),
            None
        );
    }

    /// Documenta el layout por defecto (review rust 2026-11-04): sin
    /// `config_dir`, dos cuentas del mismo proveedor comparten
    /// `~/.quorb/<fichero>` — igual que en host. El aislamiento real de la
    /// UI viene del `config_dir` que crea Ajustes (subcarpeta por cuenta).
    #[test]
    fn default_extra_accounts_are_isolated_without_config_dir() {
        let mock = Arc::new(MockWslAdapter::new());
        let resolver = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
            Locale::Es,
        );
        let mk = |id: &str| Account {
            id: id.into(),
            provider: "claude".into(),
            enabled: true,
            ..Default::default()
        };
        let p1 = account_session_path(&mk("claude:w1"), Some(&resolver))
            .expect("p1")
            .expect("some");
        let p2 = account_session_path(&mk("claude:w2"), Some(&resolver))
            .expect("p2")
            .expect("some");
        assert_eq!(p1, "/home/user/.quorb/accounts/claude-w1/.credentials.json");
        assert_eq!(p2, "/home/user/.quorb/accounts/claude-w2/.credentials.json");
        assert_ne!(p1, p2, "cada cuenta lee su propio fichero");
    }

    /// Carpeta temporal propia de cada prueba, sin tocar el HOME real.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("quorb-session-file-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn extra_account(provider: &str, dir: &Path) -> Account {
        Account {
            id: format!("{provider}:w1"),
            provider: provider.into(),
            config_dir: Some(dir.to_string_lossy().into_owned()),
            ..Default::default()
        }
    }

    #[test]
    fn session_file_maps_main_and_extra_accounts() {
        let home = temp_dir("home");
        let claude_dir = home.join("claude-w1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let cfg = AppConfig {
            accounts: vec![extra_account("claude", &claude_dir)],
            ..Default::default()
        };
        // Cuenta adicional: fichero del CLI dentro de su propia carpeta.
        assert_eq!(
            session_file(&cfg, "claude:w1", &home),
            Some(claude_dir.join(".credentials.json"))
        );

        // Cuenta adicional de Codex: `auth.json` de su carpeta.
        let codex_dir = home.join("codex-w1");
        std::fs::create_dir_all(&codex_dir).unwrap();
        let cfg = AppConfig {
            accounts: vec![extra_account("codex", &codex_dir)],
            ..Default::default()
        };
        assert_eq!(
            session_file(&cfg, "codex:w1", &home),
            Some(codex_dir.join("auth.json"))
        );

        // Cuenta adicional de Grok: mismo `auth.json` en su carpeta.
        let grok_dir = home.join("grok-w1");
        std::fs::create_dir_all(&grok_dir).unwrap();
        let cfg = AppConfig {
            accounts: vec![extra_account("grok", &grok_dir)],
            ..Default::default()
        };
        assert_eq!(
            session_file(&cfg, "grok:w1", &home),
            Some(grok_dir.join("auth.json"))
        );

        // Proveedor sin login por CLI: nunca hay fichero de sesión.
        let or_dir = home.join("openrouter-w1");
        std::fs::create_dir_all(&or_dir).unwrap();
        let cfg = AppConfig {
            accounts: vec![extra_account("openrouter", &or_dir)],
            ..Default::default()
        };
        assert_eq!(session_file(&cfg, "openrouter:w1", &home), None);

        // Id que no existe en la config.
        assert_eq!(
            session_file(&AppConfig::default(), "claude:otra", &home),
            None
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_file_main_uses_credentials_path_or_home_default() {
        let home = temp_dir("main");
        let cfg = AppConfig::default();
        assert_eq!(
            session_file(&cfg, "claude", &home),
            Some(home.join(".claude").join(".credentials.json"))
        );
        assert_eq!(
            session_file(&cfg, "gemini", &home),
            Some(home.join(".gemini").join("oauth_creds.json"))
        );
        assert_eq!(session_file(&cfg, "cursor", &home), None);
        assert_eq!(session_file(&cfg, "desconocido", &home), None);

        let mut cfg = AppConfig::default();
        cfg.claude.credentials_path = Some("/tmp/creds/claude.json".into());
        assert_eq!(
            session_file(&cfg, "claude", &home),
            Some(PathBuf::from("/tmp/creds/claude.json"))
        );
        // Ruta explícita vacía o solo espacios: se usa la de siempre.
        cfg.claude.credentials_path = Some("   ".into());
        assert_eq!(
            session_file(&cfg, "claude", &home),
            Some(home.join(".claude").join(".credentials.json"))
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_file_preserves_paths_with_spaces_and_non_ascii() {
        let home = temp_dir("spaces");
        let mut cfg = AppConfig::default();
        cfg.claude.credentials_path =
            Some("/tmp/mi configuración/.claude/.credentials.json".into());
        assert_eq!(
            session_file(&cfg, "claude", &home),
            Some(PathBuf::from(
                "/tmp/mi configuración/.claude/.credentials.json"
            ))
        );
        cfg.gemini.credentials_path = Some("/home/usuario/Configuración ñ/oauth_creds.json".into());
        assert_eq!(
            session_file(&cfg, "gemini", &home),
            Some(PathBuf::from(
                "/home/usuario/Configuración ñ/oauth_creds.json"
            ))
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolve_path_error_lists_candidate_paths() {
        let candidates = [
            PathBuf::from("/home/u/.claude/.credentials.json"),
            PathBuf::from("/var/lib/creds x.json"),
        ];
        let err = resolve_path(
            Locale::Es,
            Some("/no existe/ruta con espacios.json"),
            &candidates,
        )
        .unwrap_err();
        // La ruta con espacios y la lista de candidatos aparecen en el mensaje.
        assert!(err.contains("/no existe/ruta con espacios.json"));
    }

    /// L4 (#66): los errores de `resolve_path` nacen en la locale activa;
    /// las rutas viajan literales en ambos idiomas.
    #[test]
    fn resolve_path_errors_follow_the_locale() {
        let candidates = [PathBuf::from("/home/u/.claude/.credentials.json")];
        assert_eq!(
            resolve_path(Locale::Es, None, &candidates).unwrap_err(),
            "No encuentro credenciales en: /home/u/.claude/.credentials.json"
        );
        assert_eq!(
            resolve_path(Locale::En, None, &candidates).unwrap_err(),
            "No credentials found in: /home/u/.claude/.credentials.json"
        );
        assert_eq!(
            resolve_path(Locale::En, Some("/no/hay.json"), &candidates).unwrap_err(),
            "Path not found: /no/hay.json"
        );
    }

    /// L4 (#66, reporte de ludevdot): con la app en inglés y sin sesión de
    /// Claude disponible, tanto el error de credenciales como la indicación
    /// de login llegan en inglés; la ruta viaja literal. La ruta explícita
    /// inexistente evita el respaldo de Keychain y hace el test hermético.
    #[test]
    fn claude_login_messages_follow_the_app_locale() {
        let cfg = AppConfig {
            locale: "en".into(),
            claude: SubscriptionConfig {
                enabled: true,
                credentials_path: Some("/no/existe/quorb-l4-en.json".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        let http = reqwest::Client::new();
        let report = rt
            .block_on(fetch_one(&cfg, "claude", &http, SessionAccess::Host))
            .expect("informe de claude");
        assert_eq!(report.status, Status::NeedsLogin);
        assert_eq!(
            report.message.as_deref(),
            Some("Path not found: /no/existe/quorb-l4-en.json. Sign in to Claude Code.")
        );
    }

    /// S5.1 (review #272): consulta `id` con `fetch_one` apuntando su ruta de
    /// credenciales a un fichero con `contents`, y la app en `locale`. Ninguna
    /// de las rutas probadas llega a la red: el fallo es local.
    fn fetch_with_credentials(id: &str, locale: &str, tag: &str, contents: &str) -> UsageReport {
        let dir = temp_dir(tag);
        let file = dir.join("creds.json");
        std::fs::write(&file, contents).unwrap();
        let sub = SubscriptionConfig {
            enabled: true,
            credentials_path: Some(file.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let mut cfg = AppConfig {
            locale: locale.into(),
            ..Default::default()
        };
        match id {
            "claude" => cfg.claude = sub,
            "codex" => cfg.codex = sub,
            "gemini" => cfg.gemini = sub,
            "grok" => cfg.grok = sub,
            other => panic!("proveedor sin ruta de credenciales en el test: {other}"),
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        let http = reqwest::Client::new();
        let report = rt
            .block_on(fetch_one(&cfg, id, &http, SessionAccess::Host))
            .expect("informe del proveedor");
        let _ = std::fs::remove_dir_all(&dir);
        report
    }

    /// S5.1: el reporte exacto del revisor — con la app en `en`, un `auth.json`
    /// con `{}` mostraba el mensaje en español. Codex y Grok lo dicen en la
    /// locale de la app; en `es` el literal original no cambia.
    #[test]
    fn codex_and_grok_empty_auth_json_follows_the_app_locale() {
        for (id, en, es) in [
            (
                "codex",
                "auth.json has no tokens. Run “codex login”.",
                "auth.json sin tokens. Ejecuta «codex login».",
            ),
            (
                "grok",
                "auth.json has no valid credentials. Run “grok login”.",
                "auth.json sin credenciales válidas. Ejecuta «grok login».",
            ),
        ] {
            let report = fetch_with_credentials(id, "en", &format!("{id}-empty-en"), "{}");
            assert_eq!(report.status, Status::NeedsLogin, "{id} en");
            assert_eq!(report.message.as_deref(), Some(en), "{id} en");
            let report = fetch_with_credentials(id, "es", &format!("{id}-empty-es"), "{}");
            assert_eq!(report.status, Status::NeedsLogin, "{id} es");
            assert_eq!(report.message.as_deref(), Some(es), "{id} es");
        }
    }

    /// S5.1: Codex con solo API key también sigue la locale.
    #[test]
    fn codex_api_key_only_auth_json_follows_the_app_locale() {
        let raw = "{\"OPENAI_API_KEY\":\"sk-test\"}";
        let en = fetch_with_credentials("codex", "en", "codex-apikey-en", raw);
        assert_eq!(
            en.message.as_deref(),
            Some("Codex is authenticated with an API key, not with your ChatGPT account. Run “codex login”.")
        );
        let es = fetch_with_credentials("codex", "es", "codex-apikey-es", raw);
        assert_eq!(
            es.message.as_deref(),
            Some("Codex está autenticado con API key, no con tu cuenta de ChatGPT. Ejecuta «codex login».")
        );
    }

    /// S5.1: sesión de Claude caducada (el token local expiró, sin red) y
    /// credenciales sin `claudeAiOauth`.
    #[test]
    fn claude_expired_and_api_key_credentials_follow_the_app_locale() {
        let expired = "{\"claudeAiOauth\":{\"accessToken\":\"t\",\"expiresAt\":1}}";
        let en = fetch_with_credentials("claude", "en", "claude-expired-en", expired);
        assert_eq!(en.status, Status::NeedsLogin);
        assert_eq!(
            en.message.as_deref(),
            Some("The session has expired. “Renew session” opens Claude Code, which renews it; Quorb updates itself.")
        );
        let es = fetch_with_credentials("claude", "es", "claude-expired-es", expired);
        assert_eq!(
            es.message.as_deref(),
            Some("La sesión ha caducado. «Renovar sesión» abre Claude Code, que la renueva; Quorb se actualiza solo.")
        );
        let en = fetch_with_credentials("claude", "en", "claude-nooauth-en", "{}");
        assert_eq!(
            en.message.as_deref(),
            Some("Credentials without “claudeAiOauth” (signed in with an API key?)")
        );
    }

    /// S5.1: Gemini sin `refresh_token` y con el acceso caducado (sin red).
    #[test]
    fn gemini_expired_session_follows_the_app_locale() {
        let en = fetch_with_credentials("gemini", "en", "gemini-expired-en", "{}");
        assert_eq!(en.status, Status::NeedsLogin);
        assert_eq!(
            en.message.as_deref(),
            Some("The Gemini CLI session has expired. Open it to renew it.")
        );
        let es = fetch_with_credentials("gemini", "es", "gemini-expired-es", "{}");
        assert_eq!(
            es.message.as_deref(),
            Some("La sesión de Gemini CLI ha caducado. Ábrelo para renovarla.")
        );
    }

    #[test]
    fn month_start_is_first_day_midnight() {
        let now = Utc.with_ymd_and_hms(2026, 10, 6, 15, 30, 0).unwrap();
        assert_eq!(month_start(now).to_rfc3339(), "2026-10-01T00:00:00+00:00");
        let dec = Utc.with_ymd_and_hms(2026, 12, 20, 0, 0, 0).unwrap();
        assert_eq!(
            next_month_start(dec).to_rfc3339(),
            "2027-01-01T00:00:00+00:00"
        );
        assert_eq!(month_window(now).1, 31 * 86400);
    }
}
