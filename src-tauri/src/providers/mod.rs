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

pub async fn fetch_all(
    cfg: &AppConfig,
    http: &reqwest::Client,
    resolver: Option<&SessionResolver>,
) -> Vec<UsageReport> {
    let mut jobs: Vec<BoxFuture<'_, Vec<UsageReport>>> = vec![];
    if cfg.claude.enabled {
        jobs.push(
            async move { vec![claude::fetch(&cfg.claude, Who::main("claude"), http, resolver).await] }
                .boxed(),
        );
    }
    if cfg.codex.enabled {
        jobs.push(
            async move { vec![codex::fetch(&cfg.codex, Who::main("codex"), http, resolver).await] }
                .boxed(),
        );
    }
    if cfg.gemini.enabled {
        jobs.push(
            async move { vec![gemini::fetch(&cfg.gemini, Who::main("gemini"), http, resolver).await] }
                .boxed(),
        );
    }
    if cfg.grok.enabled {
        jobs.push(
            async move { vec![grok::fetch(&cfg.grok, Who::main("grok"), http, resolver).await] }
                .boxed(),
        );
    }
    if cfg.cursor.enabled {
        jobs.push(
            async move { vec![cursor::fetch(&cfg.cursor, Who::main("cursor"), http).await] }
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
        jobs.push(async move { vec![fetch_account(cfg, a, http, resolver).await] }.boxed());
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
    resolver: Option<&SessionResolver>,
) -> Option<UsageReport> {
    if let Some(a) = cfg.accounts.iter().find(|a| a.id == id) {
        return Some(fetch_account(cfg, a, http, resolver).await);
    }
    Some(match id {
        "claude" => claude::fetch(&cfg.claude, Who::main("claude"), http, resolver).await,
        "codex" => codex::fetch(&cfg.codex, Who::main("codex"), http, resolver).await,
        "gemini" => gemini::fetch(&cfg.gemini, Who::main("gemini"), http, resolver).await,
        "grok" => grok::fetch(&cfg.grok, Who::main("grok"), http, resolver).await,
        "cursor" => cursor::fetch(&cfg.cursor, Who::main("cursor"), http).await,
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
        "codex" => codex::resolved_auth_path(cfg.codex.credentials_path.as_deref()).ok(),
        "gemini" => Some(main(
            &cfg.gemini,
            home.join(".gemini").join("oauth_creds.json"),
        )),
        "grok" => grok::resolved_auth_path(cfg.grok.credentials_path.as_deref()).ok(),
        _ => None,
    }
}

/// Consulta una cuenta adicional con la config de su proveedor adaptada a ella.
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
fn account_session_path(
    a: &Account,
    resolver: Option<&SessionResolver>,
) -> Result<Option<String>, String> {
    let Some(r) = resolver else {
        return Ok(a
            .credentials_file(&home())
            .map(|p| p.to_string_lossy().into_owned()));
    };
    let name = credentials_file_name(a.provider.as_str())
        .ok_or_else(|| format!("El proveedor {} no tiene login por CLI", a.provider))?;
    match &a.config_dir {
        Some(d) => {
            let d = d.trim();
            if d.contains('\\') {
                return Err(format!(
                    "La carpeta de la cuenta {} tiene separadores de Windows (\\), no válida en modo WSL: {d}",
                    a.id
                ));
            }
            if !d.starts_with('/') {
                return Err(format!(
                    "La carpeta de la cuenta {} debe ser una ruta absoluta del guest en modo WSL (empieza por '/'): {d}",
                    a.id
                ));
            }
            // La carpeta que eligió el usuario, tal cual (sin re-enraizar
            // bajo el home): una absoluta del guest no se compone con nada.
            Ok(Some(format!("{d}/{name}")))
        }
        None => {
            // La carpeta por defecto (`~/.quorb`) se compone bajo el home
            // del entorno con POSIX (r.default_path usa join_guest_path).
            let rel = crate::wsl::guest_relative(&[".quorb", name]);
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
    resolver: Option<&'a SessionResolver>,
) -> BoxFuture<'a, UsageReport> {
    let who = Who::extra(a);
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
            async move { claude::fetch(&session(&cfg.claude), who, http, resolver).await }.boxed()
        }
        "codex" => {
            async move { codex::fetch(&session(&cfg.codex), who, http, resolver).await }.boxed()
        }
        "gemini" => {
            async move { gemini::fetch(&session(&cfg.gemini), who, http, resolver).await }.boxed()
        }
        "grok" => {
            async move { grok::fetch(&session(&cfg.grok), who, http, resolver).await }.boxed()
        }
        // Solo con su token: la sesión de la app de Cursor es la de la cuenta principal.
        "cursor" => {
            async move { cursor::fetch(&SubscriptionConfig::default(), who, http).await }.boxed()
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

/// Ruta explícita si existe; si no, la primera candidata que exista.
pub(crate) fn resolve_path(
    explicit: Option<&str>,
    candidates: &[PathBuf],
) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        let p = PathBuf::from(p.trim());
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!("No existe {}", p.display()))
        };
    }
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| {
            let list: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
            format!("No encuentro credenciales en: {}", list.join(", "))
        })
}

pub(crate) fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("No puedo leer {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("JSON inválido en {}: {e}", path.display()))
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
        if let Ok(p) = codex::resolved_auth_path(cfg.codex.credentials_path.as_deref()) {
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
        if let Ok(p) = grok::resolved_auth_path(cfg.grok.credentials_path.as_deref()) {
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
    let main = |c: &SubscriptionConfig, rel: &str| {
        r.resolve(
            c.credentials_path.as_deref(),
            &r.default_path(Path::new(rel)),
        )
        .ok()
    };
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(p) = main(&cfg.claude, ".claude/.credentials.json") {
        paths.push(p);
    }
    if let Some(p) = main(&cfg.codex, ".codex/auth.json") {
        paths.push(p);
    }
    if let Some(p) = main(&cfg.gemini, ".gemini/oauth_creds.json") {
        paths.push(p);
    }
    if let Some(p) = main(&cfg.grok, ".grok/auth.json") {
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
    let mut acc = 0u64;
    for p in paths {
        if let Ok(contents) = r.read_async(&p).await {
            acc = acc.wrapping_add(content_hash(contents.as_bytes()));
        }
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
    use crate::wsl::{distro, DistroState, MockWslAdapter};
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
        let extra = PathBuf::from("/home/user/.quorb/.credentials.json");
        mock.set_file(
            "Ubuntu-22.04",
            extra.clone(),
            "{\"claudeAiOauth\":{\"accessToken\":\"v1\"}}".to_string(),
        );
        let r = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
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

    /// La composición POSIX de la cuenta adicional (revisión del
    /// mantenedor, 2026-11-04) es la única puerta de entrada de la cuenta en
    /// `fetch_account` y en `wsl_session_stamp`; un `Err` se convierte en el
    /// report de error de la cuenta sin tocar el adaptador ni la red.
    ///
    /// (El test directo de `fetch_account` necesita un cliente reqwest con
    /// reactor, que el tokio de CI no expone; la decisión de ruta está
    /// aislada aquí y su consumidor en el sello se prueba con el `WslCall`
    /// exacto.)
    /// La composición POSIX de la cuenta adicional: absoluta del guest se
    /// usa tal cual; separadores del host o rutas relativas se rechazan con
    /// mensaje accionable (revisión del mantenedor, 2026-11-04).
    #[test]
    fn account_path_is_posix_and_rejects_host_shaped_config_dirs() {
        let mock = Arc::new(MockWslAdapter::new());
        let resolver = crate::wsl::SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
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
        // Sin config_dir: la carpeta por defecto compuesta bajo el home del
        // entorno, POSIX.
        assert_eq!(
            account_session_path(&mk(None), Some(&resolver)).expect("defecto"),
            Some("/home/user/.quorb/.credentials.json".to_string())
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
        let err = resolve_path(Some("/no existe/ruta con espacios.json"), &candidates).unwrap_err();
        // La ruta con espacios y la lista de candidatos aparecen en el mensaje.
        assert!(err.contains("/no existe/ruta con espacios.json"));
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
