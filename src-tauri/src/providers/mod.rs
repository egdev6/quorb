//! Cada proveedor devuelve un `UsageReport`. Nunca hacen panic ni
//! devuelven `Err`: cualquier fallo se refleja en `status` + `message`.

pub mod anthropic_api;
pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod gemini;
pub mod nan;
pub mod nan_cloud;
pub mod nine_router;
pub mod nine_router_creds;
pub mod openai_api;
pub mod openrouter;

use crate::config::{Account, ApiCostConfig, AppConfig, CopilotConfig, NanConfig, OpenRouterConfig, SubscriptionConfig};
use crate::model::{Kind, UsageReport};
use crate::secrets;
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
        Self { id: &a.id, label: Some(&a.label) }
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

pub async fn fetch_all(cfg: &AppConfig, http: &reqwest::Client) -> Vec<UsageReport> {
    let mut jobs: Vec<BoxFuture<'_, Vec<UsageReport>>> = vec![];
    if cfg.claude.enabled {
        jobs.push(async move { vec![claude::fetch(&cfg.claude, Who::main("claude"), http).await] }.boxed());
    }
    if cfg.codex.enabled {
        jobs.push(async move { vec![codex::fetch(&cfg.codex, Who::main("codex"), http).await] }.boxed());
    }
    if cfg.gemini.enabled {
        jobs.push(async move { vec![gemini::fetch(&cfg.gemini, Who::main("gemini"), http).await] }.boxed());
    }
    if cfg.cursor.enabled {
        jobs.push(async move { vec![cursor::fetch(&cfg.cursor, Who::main("cursor"), http).await] }.boxed());
    }
    if cfg.copilot.enabled {
        jobs.push(async move { vec![copilot::fetch(&cfg.copilot, Who::main("copilot"), http).await] }.boxed());
    }
    if cfg.nan.enabled {
        jobs.push(async move { vec![nan::fetch(&cfg.nan, Who::main("nan"), http).await] }.boxed());
    }
    if cfg.openrouter.enabled {
        jobs.push(async move { vec![openrouter::fetch(&cfg.openrouter, Who::main("openrouter"), http).await] }.boxed());
    }
    if cfg.nine_router.enabled {
        // 9Router lleva su propio registro de uso; ademas del orbe agregado,
        // descubrimos sus sub-proveedores y los exponemos como cuentas propias.
        jobs.push(nine_router_all(cfg, http));
    }
    if cfg.anthropic_api.enabled {
        jobs.push(async move { vec![anthropic_api::fetch(&cfg.anthropic_api, Who::main("anthropic_api"), http).await] }.boxed());
    }
    if cfg.openai_api.enabled {
        jobs.push(async move { vec![openai_api::fetch(&cfg.openai_api, Who::main("openai_api"), http).await] }.boxed());
    }
    for a in cfg.accounts.iter().filter(|a| a.enabled) {
        jobs.push(async move { vec![fetch_account(cfg, a, http).await] }.boxed());
    }
    futures::future::join_all(jobs).await.into_iter().flatten().collect()
}

/// Orbe de 9Router más un informe por cada sub-proveedor que haya visto
/// (Claude, Kiro, GLM…). Los sub-proveedores se descubren desde el propio
/// historial de uso de 9Router: no se configuran a mano.
fn nine_router_all<'a>(cfg: &'a AppConfig, http: &'a reqwest::Client) -> BoxFuture<'a, Vec<UsageReport>> {
    // Una sola lectura de stats alimenta el orbe agregado y todos los sub-orbes.
    async move { nine_router::fetch_all(&cfg.nine_router, http).await }.boxed()
}
/// Consulta una sola cuenta (principal o adicional) aunque esté oculta en el widget,
/// para comprobar la conexión desde Ajustes. `None` si el id no existe.
pub async fn fetch_one(cfg: &AppConfig, id: &str, http: &reqwest::Client) -> Option<UsageReport> {
    if let Some(a) = cfg.accounts.iter().find(|a| a.id == id) {
        return Some(fetch_account(cfg, a, http).await);
    }
    Some(match id {
        "claude" => claude::fetch(&cfg.claude, Who::main("claude"), http).await,
        "codex" => codex::fetch(&cfg.codex, Who::main("codex"), http).await,
        "gemini" => gemini::fetch(&cfg.gemini, Who::main("gemini"), http).await,
        "cursor" => cursor::fetch(&cfg.cursor, Who::main("cursor"), http).await,
        "copilot" => copilot::fetch(&cfg.copilot, Who::main("copilot"), http).await,
        "nan" => nan::fetch(&cfg.nan, Who::main("nan"), http).await,
        "openrouter" => openrouter::fetch(&cfg.openrouter, Who::main("openrouter"), http).await,
        "nine_router" => nine_router::fetch(&cfg.nine_router, Who::main("nine_router"), http).await,
        "anthropic_api" => anthropic_api::fetch(&cfg.anthropic_api, Who::main("anthropic_api"), http).await,
        "openai_api" => openai_api::fetch(&cfg.openai_api, Who::main("openai_api"), http).await,
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
    let main = |c: &SubscriptionConfig, default: PathBuf| match c.credentials_path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default,
    };
    match id {
        "claude" => Some(main(&cfg.claude, home.join(".claude").join(".credentials.json"))),
        "codex" => codex::resolved_auth_path(cfg.codex.credentials_path.as_deref()).ok(),
        "gemini" => Some(main(&cfg.gemini, home.join(".gemini").join("oauth_creds.json"))),
        _ => None,
    }
}

/// Consulta una cuenta adicional con la config de su proveedor adaptada a ella.
fn fetch_account<'a>(cfg: &'a AppConfig, a: &'a Account, http: &'a reqwest::Client) -> BoxFuture<'a, UsageReport> {
    let who = Who::extra(a);
    let session = |main: &SubscriptionConfig| SubscriptionConfig {
        enabled: true,
        credentials_path: a.credentials_file(&home()).map(|p| p.to_string_lossy().into_owned()),
        login_command: main.login_command.clone(),
    };
    match a.provider.as_str() {
        "claude" => async move { claude::fetch(&session(&cfg.claude), who, http).await }.boxed(),
        "codex" => async move { codex::fetch(&session(&cfg.codex), who, http).await }.boxed(),
        "gemini" => async move { gemini::fetch(&session(&cfg.gemini), who, http).await }.boxed(),
        // Solo con su token: la sesión de la app de Cursor es la de la cuenta principal.
        "cursor" => async move { cursor::fetch(&SubscriptionConfig::default(), who, http).await }.boxed(),
        "copilot" => {
            let c = CopilotConfig {
                enabled: true,
                username: a.username.clone(),
                plan: if a.plan.is_empty() { CopilotConfig::default().plan } else { a.plan.clone() },
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
        "openrouter" => async move { openrouter::fetch(&OpenRouterConfig { enabled: true }, who, http).await }.boxed(),
        // Sub-proveedor de 9Router (`nine_router:claude`): filtra su uso en las stats.
        "nine_router" => async move { nine_router::fetch(&cfg.nine_router, who, http).await }.boxed(),
        "anthropic_api" | "openai_api" => {
            let c = ApiCostConfig { enabled: true, monthly_budget_usd: a.monthly_budget_usd };
            if a.provider == "anthropic_api" {
                async move { anthropic_api::fetch(&c, who, http).await }.boxed()
            } else {
                async move { openai_api::fetch(&c, who, http).await }.boxed()
            }
        }
        other => {
            let r = who.report(other, Kind::Subscription).fail(crate::model::Status::Error, format!("Proveedor desconocido: {other}"));
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
    let (y, m) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    Utc.with_ymd_and_hms(y, m, 1, 0, 0, 0).single().unwrap_or(now)
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
pub(crate) fn resolve_path(explicit: Option<&str>, candidates: &[PathBuf]) -> Result<PathBuf, String> {
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
    let raw = std::fs::read_to_string(path).map_err(|e| format!("No puedo leer {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("JSON inválido en {}: {e}", path.display()))
}

/// Huella de los ficheros de sesión de los CLIs (Claude Code, Codex, Gemini) de
/// todas las cuentas: suma de sus fechas de modificación en ms. Cambia en cuanto
/// un CLI renueva su token o se inicia sesión, y así el widget recarga al momento
/// sin que la app toque los tokens.
pub fn session_stamp(cfg: &AppConfig) -> u64 {
    let h = home();
    let main = |c: &SubscriptionConfig, default: PathBuf| match c.credentials_path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default,
    };
    let mut files: Vec<PathBuf> = vec![];
    if cfg.claude.enabled {
        files.push(main(&cfg.claude, h.join(".claude").join(".credentials.json")));
    }
    if cfg.codex.enabled {
        // Mismo resolver que `codex::fetch`: así el sello observa el fichero
        // que de verdad se lee (incluido el respaldo ~/.codex/auth.json).
        if let Ok(p) = codex::resolved_auth_path(cfg.codex.credentials_path.as_deref()) {
            files.push(p);
        }
    }
    if cfg.gemini.enabled {
        files.push(main(&cfg.gemini, h.join(".gemini").join("oauth_creds.json")));
    }
    files.extend(cfg.accounts.iter().filter(|a| a.enabled).filter_map(|a| a.credentials_file(&h)));
    files
        .iter()
        .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .fold(0u64, |acc, d| acc.wrapping_add(d.as_millis() as u64))
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

    /// Carpeta temporal propia de cada prueba, sin tocar el HOME real.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quorb-session-file-{}-{tag}", std::process::id()));
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
        let cfg = AppConfig { accounts: vec![extra_account("claude", &claude_dir)], ..Default::default() };
        // Cuenta adicional: fichero del CLI dentro de su propia carpeta.
        assert_eq!(session_file(&cfg, "claude:w1", &home), Some(claude_dir.join(".credentials.json")));

        // Cuenta adicional de Codex: `auth.json` de su carpeta.
        let codex_dir = home.join("codex-w1");
        std::fs::create_dir_all(&codex_dir).unwrap();
        let cfg = AppConfig { accounts: vec![extra_account("codex", &codex_dir)], ..Default::default() };
        assert_eq!(session_file(&cfg, "codex:w1", &home), Some(codex_dir.join("auth.json")));

        // Proveedor sin login por CLI: nunca hay fichero de sesión.
        let or_dir = home.join("openrouter-w1");
        std::fs::create_dir_all(&or_dir).unwrap();
        let cfg = AppConfig { accounts: vec![extra_account("openrouter", &or_dir)], ..Default::default() };
        assert_eq!(session_file(&cfg, "openrouter:w1", &home), None);

        // Id que no existe en la config.
        assert_eq!(session_file(&AppConfig::default(), "claude:otra", &home), None);

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_file_main_uses_credentials_path_or_home_default() {
        let home = temp_dir("main");
        let cfg = AppConfig::default();
        assert_eq!(session_file(&cfg, "claude", &home), Some(home.join(".claude").join(".credentials.json")));
        assert_eq!(session_file(&cfg, "gemini", &home), Some(home.join(".gemini").join("oauth_creds.json")));
        assert_eq!(session_file(&cfg, "cursor", &home), None);
        assert_eq!(session_file(&cfg, "desconocido", &home), None);

        let mut cfg = AppConfig::default();
        cfg.claude.credentials_path = Some("/tmp/creds/claude.json".into());
        assert_eq!(session_file(&cfg, "claude", &home), Some(PathBuf::from("/tmp/creds/claude.json")));
        // Ruta explícita vacía o solo espacios: se usa la de siempre.
        cfg.claude.credentials_path = Some("   ".into());
        assert_eq!(session_file(&cfg, "claude", &home), Some(home.join(".claude").join(".credentials.json")));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_file_preserves_paths_with_spaces_and_non_ascii() {
        let home = temp_dir("spaces");
        let mut cfg = AppConfig::default();
        cfg.claude.credentials_path = Some("/tmp/mi configuración/.claude/.credentials.json".into());
        assert_eq!(
            session_file(&cfg, "claude", &home),
            Some(PathBuf::from("/tmp/mi configuración/.claude/.credentials.json"))
        );
        cfg.gemini.credentials_path = Some("/home/usuario/Configuración ñ/oauth_creds.json".into());
        assert_eq!(
            session_file(&cfg, "gemini", &home),
            Some(PathBuf::from("/home/usuario/Configuración ñ/oauth_creds.json"))
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolve_path_error_lists_candidate_paths() {
        let candidates = [PathBuf::from("/home/u/.claude/.credentials.json"), PathBuf::from("/var/lib/creds x.json")];
        let err = resolve_path(Some("/no existe/ruta con espacios.json"), &candidates).unwrap_err();
        // La ruta con espacios y la lista de candidatos aparecen en el mensaje.
        assert!(err.contains("/no existe/ruta con espacios.json"));
    }

    #[test]
    fn month_start_is_first_day_midnight() {
        let now = Utc.with_ymd_and_hms(2026, 10, 6, 15, 30, 0).unwrap();
        assert_eq!(month_start(now).to_rfc3339(), "2026-10-01T00:00:00+00:00");
        let dec = Utc.with_ymd_and_hms(2026, 12, 20, 0, 0, 0).unwrap();
        assert_eq!(next_month_start(dec).to_rfc3339(), "2027-01-01T00:00:00+00:00");
        assert_eq!(month_window(now).1, 31 * 86400);
    }
}
