//! Claude Pro / Max — límites de sesión (5 h) y semanales.
//!
//! No hay API pública para esto. Se reutiliza la sesión OAuth que ya guarda
//! Claude Code (`~/.claude/.credentials.json`) y se consulta el mismo endpoint
//! que usa `/usage`. Es NO OFICIAL: puede cambiar o romperse.
//!
//! Importante: la app NO refresca el token por su cuenta (rotaría el refresh
//! token y podría cerrar la sesión del CLI). Si caduca, se abre Claude Code,
//! que lo renueva solo.

use super::{home, net_error, read_json, resolve_path, Who};
use crate::config::SubscriptionConfig;
use crate::model::{Kind, Meter, Status, UsageReport};
use serde_json::Value;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Presupuesto duro de la lectura del Keychain: el diálogo de autorización
/// puede quedar abierto indefinidamente y no debe colgar el refresco conjunto.
#[cfg(target_os = "macos")]
const KEYCHAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Resultado de consultar el Keychain de macOS por la sesión de Claude Code.
#[derive(Debug, PartialEq)]
enum KeychainOutcome {
    /// Sesión válida encontrada y parseada.
    Session(Credentials),
    /// No hay entrada, el usuario negó el acceso o el secreto no parsea.
    NoSession,
    /// La autorización no se completó dentro del presupuesto: estado accionable.
    TimedOut,
}

/// Respaldo de macOS: Claude Code guarda la sesión OAuth en el Keychain
/// (servicio «Claude Code-credentials»), no en ~/.claude/.credentials.json —
/// ese archivo es el layout de Linux/WSL. La primera lectura desde la app
/// puede mostrar el diálogo de permiso de Keychain («Permitir siempre»).
///
/// Solo aplica a la sesión principal sin ruta explícita: para cuentas
/// adicionales (o con `credentials_path` configurado) el secreto global del
/// Keychain pertenece a la principal y mezclarlo cambiaría la etiqueta bajo
/// la que se reporta el consumo. La ejecución corre fuera del executor
/// asíncrono y acotada por `KEYCHAIN_TIMEOUT` con kill del proceso.
#[cfg(target_os = "macos")]
async fn keychain_fallback() -> KeychainOutcome {
    let timeout = KEYCHAIN_TIMEOUT;
    match tokio::task::spawn_blocking(move || keychain_sync(timeout)).await {
        Ok(outcome) => outcome,
        Err(_) => KeychainOutcome::NoSession,
    }
}

#[cfg(not(target_os = "macos"))]
async fn keychain_fallback() -> KeychainOutcome {
    KeychainOutcome::NoSession
}

/// ¿Corresponde intentar el respaldo de Keychain? Solo la sesión principal
/// sin `credentials_path` explícito: las cuentas adicionales y las rutas
/// configuradas por el usuario apuntan a sesiones distintas de la global.
/// Sin gate de cfg: `fetch` la llama en todas las plataformas, y un gate
/// `any(test, macos)` rompería el build de producción en Windows/Linux
/// (detectado en revisión de #112).
fn should_fallback_keychain(credentials_path: Option<&str>) -> bool {
    credentials_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none()
}

/// Lanzamiento y espera acotada del proceso `security`. Corre en hilo propio
/// (vía `spawn_blocking`); en timeout mata el proceso y reporta `TimedOut`.
#[cfg(target_os = "macos")]
fn keychain_sync(timeout: std::time::Duration) -> KeychainOutcome {
    use std::process::{Command, Stdio};
    let child = match Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return KeychainOutcome::NoSession,
    };
    match wait_bounded(child, timeout) {
        WaitOutcome::Success(output) => match parse_keychain_secret(&output.stdout) {
            Some(c) => KeychainOutcome::Session(c),
            None => KeychainOutcome::NoSession,
        },
        // Salida no cero (entrada ausente, acceso denegado): no hay sesión;
        // NO es un timeout de autorización y no debe reportarse como tal.
        WaitOutcome::Failed => KeychainOutcome::NoSession,
        WaitOutcome::TimedOut => KeychainOutcome::TimedOut,
    }
}

/// Resultado diferenciado de la espera acotada: terminar bien, terminar mal
/// o agotar el presupuesto. Distintos a propósito — `keychain_sync` reporta
/// `NoSession` y `TimedOut` de forma distinta (revisión #112).
#[cfg(any(test, target_os = "macos"))]
enum WaitOutcome {
    /// Terminó con éxito dentro del presupuesto.
    Success(BoundedOutput),
    /// Terminó con código no cero (o error de wait): no hay sesión.
    Failed,
    /// No terminó dentro del presupuesto: proceso muerto.
    TimedOut,
}

/// Espera acotada de un hijo con stdout capturado: devuelve la salida si
/// terminó bien dentro del presupuesto; en timeout mata el árbol y devuelve
/// `TimedOut`; en salida fallida, `Failed`. Puro respecto del Keychain para
/// poder probarlo con procesos reales (`sleep`, `true`, `false`).
#[cfg(any(test, target_os = "macos"))]
fn wait_bounded(mut child: std::process::Child, timeout: std::time::Duration) -> WaitOutcome {
    use std::io::Read;
    let mut pipe = match child.stdout.take() {
        Some(p) => p,
        None => return WaitOutcome::Failed,
    };
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = pipe.read_to_string(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let stdout = reader.join().unwrap_or_default();
                return WaitOutcome::Success(BoundedOutput { stdout });
            }
            Ok(Some(_)) => return WaitOutcome::Failed,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return WaitOutcome::TimedOut;
            }
            Err(_) => return WaitOutcome::Failed,
        }
    }
}

/// Salida capturada de un proceso que terminó con éxito dentro del presupuesto.
#[cfg(any(test, target_os = "macos"))]
struct BoundedOutput {
    stdout: String,
}

/// Parser puro del secreto devuelto por `security … -w`: JSON con la misma
/// estructura que .credentials.json. Puro para poder probarlo sin Keychain.
#[cfg(any(test, target_os = "macos"))]
fn parse_keychain_secret(raw: &str) -> Option<Credentials> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|v| Credentials::parse(&v).ok())
}

pub async fn fetch(cfg: &SubscriptionConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("Claude", Kind::Subscription);

    let candidates = vec![home().join(".claude").join(".credentials.json")];
    let creds = match resolve_path(cfg.credentials_path.as_deref(), &candidates) {
        Ok(p) => match read_json(&p).and_then(|v| Credentials::parse(&v)) {
            Ok(c) => c,
            Err(e) => return report.fail(Status::Error, e),
        },
        // El archivo no existe: en macOS Claude Code guarda la sesión OAuth en
        // el Keychain, no en ~/.claude. El respaldo es solo de la sesión
        // principal sin ruta explícita (ver `should_fallback_keychain`).
        Err(e) => {
            if !should_fallback_keychain(cfg.credentials_path.as_deref()) {
                return report.fail(
                    Status::NeedsLogin,
                    format!("{e}. Inicia sesión en Claude Code."),
                );
            }
            match keychain_fallback().await {
                KeychainOutcome::Session(c) => c,
                KeychainOutcome::TimedOut => {
                    return report.fail(
                        Status::Warning,
                        "La autorización del Keychain no se completó a tiempo. Concede el acceso a «Claude Code-credentials» y espera al próximo refresco.",
                    )
                }
                KeychainOutcome::NoSession => {
                    return report.fail(
                        Status::NeedsLogin,
                        format!("{e}. Inicia sesión en Claude Code."),
                    )
                }
            }
        }
    };

    let mut report = report;
    report.plan = creds.plan.clone();

    if creds.is_expired(chrono::Utc::now().timestamp_millis()) {
        return report.fail(
            Status::NeedsLogin,
            "La sesión ha caducado. «Renovar sesión» abre Claude Code, que la renueva; Quorb se actualiza solo.",
        );
    }

    let res = http
        .get(USAGE_URL)
        .bearer_auth(&creds.access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("anthropic-version", "2023-06-01")
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => return report.fail(Status::NeedsLogin, "Token rechazado. «Renovar sesión» abre Claude Code para renovarlo; Quorb se actualiza solo."),
        429 => return report.fail(Status::Warning, "El endpoint de uso está limitando peticiones; reintento en el próximo ciclo."),
        code => return report.fail(Status::Error, format!("HTTP {code} en el endpoint de uso")),
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };
    report.meters = parse_usage(&body);
    if report.meters.is_empty() {
        return report.fail(
            Status::Warning,
            "Respuesta sin datos de uso (¿ha cambiado el formato?)",
        );
    }
    report
}

#[derive(Debug, PartialEq)]
pub(crate) struct Credentials {
    pub access_token: String,
    pub expires_at_ms: Option<i64>,
    pub plan: Option<String>,
}

impl Credentials {
    pub fn parse(v: &Value) -> Result<Self, String> {
        let o = v
            .get("claudeAiOauth")
            .ok_or("Credenciales sin «claudeAiOauth» (¿login con API key?)")?;
        let access_token = o
            .get("accessToken")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("Credenciales sin accessToken")?
            .to_string();
        Ok(Self {
            access_token,
            expires_at_ms: o.get("expiresAt").and_then(Value::as_i64),
            plan: o
                .get("subscriptionType")
                .and_then(Value::as_str)
                .map(pretty_plan),
        })
    }

    pub fn is_expired(&self, now_ms: i64) -> bool {
        // 60 s de margen
        self.expires_at_ms
            .map(|e| e - 60_000 <= now_ms)
            .unwrap_or(false)
    }
}

fn pretty_plan(s: &str) -> String {
    match s.to_ascii_lowercase().as_str() {
        "max" => "Max".into(),
        "pro" => "Pro".into(),
        "team" => "Team".into(),
        "enterprise" => "Enterprise".into(),
        other => other.to_string(),
    }
}

pub(crate) fn parse_usage(v: &Value) -> Vec<Meter> {
    const H5: i64 = 5 * 3600;
    const D7: i64 = 7 * 86400;
    const WINDOWS: [(&str, &str, &str, i64); 5] = [
        ("five_hour", "session", "Sesión · 5 h", H5),
        ("seven_day", "weekly", "Semana · todos", D7),
        ("seven_day_opus", "weekly_opus", "Semana · Opus", D7),
        ("seven_day_sonnet", "weekly_sonnet", "Semana · Sonnet", D7),
        ("seven_day_oauth_apps", "weekly_apps", "Semana · apps", D7),
    ];
    let mut out = vec![];
    for (key, id, label, secs) in WINDOWS {
        let Some(w) = v.get(key).filter(|w| w.is_object()) else {
            continue;
        };
        let Some(pct) = w.get("utilization").and_then(Value::as_f64) else {
            continue;
        };
        out.push(Meter {
            id: id.into(),
            label: label.into(),
            percent: Some(pct),
            resets_at: w
                .get("resets_at")
                .and_then(Value::as_str)
                .map(str::to_string),
            window_seconds: Some(secs),
            ..Default::default()
        });
    }
    if let Some(extra) = v
        .get("extra_usage")
        .filter(|e| e.get("is_enabled").and_then(Value::as_bool) == Some(true))
    {
        out.push(Meter {
            id: "extra_usage".into(),
            label: "Uso extra (mes)".into(),
            percent: extra.get("utilization").and_then(Value::as_f64),
            used: extra.get("used_credits").and_then(Value::as_f64),
            limit: extra.get("monthly_limit").and_then(Value::as_f64),
            unit: Some("créditos".into()),
            resets_at: None,
            window_seconds: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_credentials() {
        let v = json!({"claudeAiOauth": {"accessToken": "sk-ant-oat01-x", "refreshToken": "r", "expiresAt": 1_900_000_000_000_i64, "subscriptionType": "max"}});
        let c = Credentials::parse(&v).unwrap();
        assert_eq!(c.plan.as_deref(), Some("Max"));
        assert!(!c.is_expired(1_800_000_000_000));
        assert!(c.is_expired(1_900_000_000_000));
    }

    #[test]
    fn rejects_missing_oauth() {
        assert!(Credentials::parse(&json!({})).is_err());
    }

    /// Sesión real de Claude Code: el fixture es la estructura que escribe
    /// `~/.claude/.credentials.json` tras el login OAuth. Verifica que el
    /// parser acepta el archivo real y decide la caducidad con reloj inyectado
    /// (sin esperar a que caduque).
    #[test]
    fn parses_real_session_fixture() {
        let raw = include_str!("fixtures/claude-credentials.json");
        let v: Value = serde_json::from_str(raw).expect("fixture claude válido");
        let c = Credentials::parse(&v).expect("el fixture debe parsear como sesión real");
        assert_eq!(c.access_token, "example-access-token-abcdef");
        assert_eq!(c.plan.as_deref(), Some("Pro"));
        let exp = c.expires_at_ms.expect("el fixture trae expiresAt");
        assert!(
            !c.is_expired(1_800_000_000_000),
            "no caduca antes de su expiry"
        );
        assert!(c.is_expired(exp), "caduca en su expiry");
        // Un token sin expiresAt no se considera caducado (no inventamos expiración).
        let sin_expiry = Credentials {
            access_token: "t".into(),
            expires_at_ms: None,
            plan: None,
        };
        assert!(!sin_expiry.is_expired(exp));
    }

    #[test]
    fn parses_usage_windows_and_skips_nulls() {
        let v = json!({
            "five_hour": {"utilization": 37.0, "resets_at": "2026-10-06T18:00:00+00:00"},
            "seven_day": {"utilization": 12.5, "resets_at": "2026-10-10T07:00:00+00:00"},
            "seven_day_opus": null,
            "seven_day_sonnet": {"utilization": 3.0, "resets_at": null},
            "extra_usage": {"is_enabled": false}
        });
        let m = parse_usage(&v);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].label, "Sesión · 5 h");
        assert_eq!(m[0].percent, Some(37.0));
        assert_eq!(m[2].resets_at, None);
        assert_eq!(m[0].window_seconds, Some(5 * 3600));
    }

    #[test]
    fn meters_carry_stable_ids_independent_of_label() {
        let v = json!({
            "five_hour": {"utilization": 1.0, "resets_at": null},
            "seven_day": {"utilization": 2.0, "resets_at": null},
            "seven_day_opus": {"utilization": 3.0, "resets_at": null},
            "seven_day_sonnet": {"utilization": 4.0, "resets_at": null},
            "seven_day_oauth_apps": {"utilization": 5.0, "resets_at": null},
            "extra_usage": {"is_enabled": true, "utilization": 6.0}
        });
        let ids: Vec<_> = parse_usage(&v)
            .into_iter()
            .map(|m| (m.id, m.label))
            .collect();
        assert_eq!(
            ids,
            [
                ("session", "Sesión · 5 h"),
                ("weekly", "Semana · todos"),
                ("weekly_opus", "Semana · Opus"),
                ("weekly_sonnet", "Semana · Sonnet"),
                ("weekly_apps", "Semana · apps"),
                ("extra_usage", "Uso extra (mes)"),
            ]
            .map(|(i, l)| (i.to_string(), l.to_string()))
        );
    }

    /// El secreto del Keychain (`security … -w`) usa la misma estructura JSON
    /// que .credentials.json; salida vacía o basura → None (sin panic).
    #[test]
    fn parses_keychain_secret_and_rejects_garbage() {
        let secret = r#"{"claudeAiOauth":{"accessToken":"tok","expiresAt":"2030-01-01T00:00:00Z","scopes":[]}}"#;
        let c = parse_keychain_secret(secret).expect("secreto válido");
        assert_eq!(c.access_token, "tok");
        assert!(parse_keychain_secret("").is_none());
        assert!(parse_keychain_secret("no es json").is_none());
        assert!(parse_keychain_secret("{\"otra\":1}").is_none());
    }

    /// Regresión P1 (revisión #112): el respaldo del Keychain es solo de la
    /// sesión principal sin ruta explícita. Una cuenta adicional (siempre con
    /// `credentials_path` de su carpeta) o una ruta configurada por el usuario
    /// NO deben tocar el secreto global de la principal.
    #[test]
    fn keychain_fallback_only_for_main_session_without_explicit_path() {
        assert!(should_fallback_keychain(None));
        assert!(should_fallback_keychain(Some("  ")));
        assert!(!should_fallback_keychain(Some(
            "/cuenta/extra/.credentials.json"
        )));
        assert!(!should_fallback_keychain(Some(
            " ~/.claude/.credentials.json "
        )));
    }

    /// Regresión P2 (revisión #112): la espera es acotada — un proceso que no
    /// termina dentro del presupuesto muere y `wait_bounded` devuelve None
    /// rápido, sin colgar. Solo Unix: `sleep`/`true` no existen en Windows.
    #[cfg(unix)]
    #[test]
    fn wait_bounded_kills_a_hung_process_within_the_budget() {
        use std::process::{Command, Stdio};
        use std::time::Duration;

        let start = std::time::Instant::now();
        let hung = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("sleep disponible");
        assert!(matches!(
            wait_bounded(hung, Duration::from_millis(150)),
            WaitOutcome::TimedOut
        ));
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "la espera colgada se mata acotada"
        );

        let quick = Command::new("true")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("true disponible");
        let out = match wait_bounded(quick, Duration::from_secs(5)) {
            WaitOutcome::Success(o) => o,
            _ => panic!("un proceso que termina bien es Success"),
        };
        assert!(out.stdout.is_empty());

        // Salida no cero → Failed (no TimedOut): distinguir "no hay sesión"
        // de "la autorización se agotó" (revisión #112).
        let failing = Command::new("false")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("false disponible");
        assert!(matches!(
            wait_bounded(failing, Duration::from_secs(5)),
            WaitOutcome::Failed
        ));
    }
}
