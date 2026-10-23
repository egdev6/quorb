//! SuperGrok (Grok Build CLI) — uso semanal de créditos de la suscripción.
//!
//! Igual que con Claude/Codex: no hay API pública para la suscripción. Se
//! reutiliza el token OAuth que guarda `grok login` en `~/.grok/auth.json`
//! (o `$GROK_HOME/auth.json`) y se consulta el endpoint de billing que usa el
//! propio CLI. NO OFICIAL: si el formato cambia, se degrada con mensaje claro.
//! La app no refresca tokens: si caducan, basta con ejecutar `grok login`.
//!
//! Formato de `auth.json` (visto en campo): las claves de nivel superior son
//! URLs de scope OIDC (`https://auth.x.ai::<client-id>`, legado
//! `https://accounts.x.ai/sign-in`) y cada valor trae `key` (bearer),
//! `expires_at`, `email`… Se prefiere la entrada `auth.x.ai`.

use super::{home, net_error, read_json, resolve_path, Who};
use crate::config::SubscriptionConfig;
use crate::model::{Kind, Meter, Status, UsageReport};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::path::{Path, PathBuf};

const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL: &str = "https://cli-chat-proxy.grok.com/v1/settings";
/// Prefijo de la entrada OIDC actual del CLI (SuperGrok); el legado es otra URL.
const AUTH_PREFIX: &str = "https://auth.x.ai::";
const AUTH_LEGACY: &str = "https://accounts.x.ai/sign-in";
/// Ventana semanal por defecto cuando la respuesta no trae período medible.
const WEEK_SECONDS: i64 = 7 * 86_400;

/// Candidatos de `auth.json` en el orden en que se buscan: `$GROK_HOME` (si
/// existe) y `~/.grok` como respaldo. Compartido por `fetch` y por
/// `providers::session_file`/`session_stamp`.
pub(crate) fn auth_candidates(grok_home: Option<&Path>, home: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = grok_home {
        candidates.push(dir.join("auth.json"));
    }
    candidates.push(home.join(".grok").join("auth.json"));
    candidates
}

/// Ruta efectiva de `auth.json`: respeta `credentials_path` explícito y, si no,
/// el primer candidato existente.
pub(crate) fn auth_path(credentials_path: Option<&str>, grok_home: Option<&Path>, home: &Path) -> Result<PathBuf, String> {
    resolve_path(credentials_path, &auth_candidates(grok_home, home))
}

/// `auth_path` leyendo `GROK_HOME` del entorno (uso real; los tests inyectan).
pub(crate) fn resolved_auth_path(credentials_path: Option<&str>) -> Result<PathBuf, String> {
    auth_path(credentials_path, std::env::var_os("GROK_HOME").map(PathBuf::from).as_deref(), &home())
}

pub async fn fetch(cfg: &SubscriptionConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("Grok", Kind::Subscription);

    let path = match resolved_auth_path(cfg.credentials_path.as_deref()) {
        Ok(p) => p,
        Err(e) => return report.fail(Status::NeedsLogin, format!("{e}. Ejecuta «grok login».")),
    };
    let auth_json = match read_json(&path) {
        Ok(v) => v,
        Err(e) => return report.fail(Status::NeedsLogin, e),
    };
    let now = Utc::now();
    let auth = match Auth::parse(&auth_json, now) {
        Ok(a) => a,
        Err(e) => return report.fail(Status::NeedsLogin, e),
    };

    let res = match http
        .get(BILLING_URL)
        .bearer_auth(&auth.token)
        .header("x-xai-token-auth", "xai-grok-cli")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => return report.fail(Status::NeedsLogin, "Sesión caducada. Ejecuta «grok login» para renovarla."),
        429 => return report.fail(Status::Warning, "El endpoint de uso está limitando peticiones."),
        code => return report.fail(Status::Error, format!("HTTP {code} en el endpoint de uso")),
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };

    let mut report = report;
    let parsed = parse(&body, now);
    report.meters = parsed.meters;
    report.plan = plan(&auth.token, http).await.or(parsed.plan_hint);
    if report.meters.is_empty() {
        return report.fail(Status::Warning, parsed.message.unwrap_or_else(|| "Respuesta sin datos de uso (¿ha cambiado el formato?)".into()));
    }
    report.message = parsed.message;
    report
}

/// Nombre del plan (`subscription_tier_display`): enriquecimiento opcional; un
/// fallo o respuesta sin el campo no afecta al medidor.
async fn plan(token: &str, http: &reqwest::Client) -> Option<String> {
    let res = http
        .get(SETTINGS_URL)
        .bearer_auth(token)
        .header("x-xai-token-auth", "xai-grok-cli")
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    let v: Value = res.json().await.ok()?;
    v.get("subscription_tier_display")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// Credenciales elegidas de `auth.json`.
#[derive(Debug, PartialEq)]
pub(crate) struct Auth {
    pub token: String,
}

impl Auth {
    /// Elige la entrada del fichero: primero una `auth.x.ai::` no caducada;
    /// si ninguna, el legado no caducado; si tampoco, la preferida caducada
    /// (para poder decir «ejecuta grok login» en vez de «no hay credenciales»).
    pub fn parse(v: &Value, now: DateTime<Utc>) -> Result<Self, String> {
        let obj = v.as_object().ok_or("auth.json no es un objeto")?;
        let token_of = |e: Option<&Value>| -> Option<String> {
            e.and_then(|e| e.get("key"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let expired = |e: Option<&Value>| -> bool {
            e.and_then(|e| e.get("expires_at"))
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|at| at <= now)
                .unwrap_or(false)
        };
        let pick = |prefix: &'static str| {
            // La primera entrada del prefijo con token vivo; si todas están
            // caducadas, la primera con token igualmente (degrada a NeedsLogin).
            let entries = obj
                .iter()
                .filter(|(k, v)| k.starts_with(prefix) && v.is_object())
                .map(|(_, v)| v);
            let mut expired_first: Option<String> = None;
            for e in entries {
                if let Some(t) = token_of(Some(e)) {
                    if !expired(Some(e)) {
                        return Some(t);
                    }
                    if expired_first.is_none() {
                        expired_first = Some(t);
                    }
                }
            }
            expired_first
        };
        if let Some(t) = pick(AUTH_PREFIX) {
            return Ok(Auth { token: t });
        }
        if let Some(t) = pick(AUTH_LEGACY) {
            return Ok(Auth { token: t });
        }
        Err("auth.json sin credenciales válidas. Ejecuta «grok login».".into())
    }
}

/// Resultado del parseo del payload de billing.
pub(crate) struct Parsed {
    pub meters: Vec<Meter>,
    pub plan_hint: Option<String>,
    pub message: Option<String>,
}

pub(crate) fn parse(body: &Value, _now: DateTime<Utc>) -> Parsed {
    let cfg = body.get("config");
    let percent = cfg
        .and_then(|c| c.get("creditUsagePercent"))
        .and_then(Value::as_f64)
        // Fallback legacy: proporción on-demand usada sobre su tope.
        .or_else(|| {
            let used = body.pointer("/usage/onDemandUsed/val").and_then(Value::as_f64)?;
            let cap = body.pointer("/onDemandCap/val").and_then(Value::as_f64).filter(|c| *c > 0.0)?;
            Some(used / cap * 100.0)
        });

    // Fin e inicio de la ventana: período actual y, si no, período de facturación.
    let period_end = ["currentPeriod/end", "billingPeriodEnd"].iter().find_map(|p| cfg.and_then(|c| c.pointer(&format!("/{p}"))).and_then(Value::as_str));
    let period_start = ["currentPeriod/start", "billingPeriodStart"].iter().find_map(|p| cfg.and_then(|c| c.pointer(&format!("/{p}"))).and_then(Value::as_str));
    let resets_at: Option<String> = period_end.map(str::to_string);
    let window = match (period_start.and_then(rfc3339), resets_at.as_deref().and_then(rfc3339)) {
        (Some(s), Some(e)) if e > s => Some((e - s).num_seconds().max(1)),
        _ => None,
    };

    let meters = match (percent, resets_at.as_deref()) {
        (Some(p), at) => {
            let label = if p > 100.5 { "Uso de créditos" } else { "Uso semanal" };
            vec![Meter {
                id: "weekly".into(),
                label: label.into(),
                percent: Some(p.clamp(0.0, 100.0)),
                used: None,
                limit: None,
                unit: None,
                resets_at: at.map(str::to_string),
                window_seconds: window.or(Some(WEEK_SECONDS)),
            }]
        }
        _ => vec![],
    };
    let message = meters.is_empty().then(|| {
        if resets_at.is_some() {
            "El endpoint no reporta porcentaje de uso para este período.".into()
        } else {
            "Respuesta sin datos de uso (¿ha cambiado el formato?)".into()
        }
    });
    Parsed { meters, plan_hint: None, message }
}

fn rfc3339(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn auth_with(entries: Value) -> Value {
        entries
    }

    #[test]
    fn parses_auth_preferring_current_oidc_entry() {
        let now = Utc::now();
        let v = auth_with(json!({
            "https://accounts.x.ai/sign-in": {"key": "legacy-token", "expires_at": "2099-01-01T00:00:00Z"},
            "https://auth.x.ai::abc123": {"key": "current-token", "expires_at": "2099-01-01T00:00:00Z"}
        }));
        assert_eq!(Auth::parse(&v, now).unwrap().token, "current-token");
    }

    #[test]
    fn falls_back_to_legacy_entry() {
        let now = Utc::now();
        let v = auth_with(json!({
            "https://accounts.x.ai/sign-in": {"key": "legacy-token", "expires_at": "2099-01-01T00:00:00Z"}
        }));
        assert_eq!(Auth::parse(&v, now).unwrap().token, "legacy-token");
    }

    #[test]
    fn skips_expired_entry_but_reports_login() {
        let now = Utc::now();
        let v = auth_with(json!({
            "https://auth.x.ai::abc123": {"key": "old-token", "expires_at": "2000-01-01T00:00:00Z"}
        }));
        // Caducada: se acepta el token pero el flujo responderá NeedsLogin por
        // HTTP 401; aquí verificamos que no hay otra entrada que preferir.
        assert_eq!(Auth::parse(&v, now).unwrap().token, "old-token");
        let empty = auth_with(json!({}));
        assert!(Auth::parse(&empty, now).is_err());
    }

    #[test]
    fn parses_current_config_shape() {
        let body = json!({
            "config": {
                "creditUsagePercent": 42.5,
                "currentPeriod": {"start": "2026-01-05T00:00:00Z", "end": "2026-01-12T00:00:00Z"}
            }
        });
        let p = parse(&body, Utc::now());
        assert_eq!(p.meters.len(), 1);
        let m = &p.meters[0];
        assert_eq!(m.percent, Some(42.5));
        assert_eq!(m.resets_at.as_deref(), Some("2026-01-12T00:00:00Z"));
        assert_eq!(m.window_seconds, Some(WEEK_SECONDS));
        assert!(p.message.is_none());
    }

    #[test]
    fn falls_back_to_billing_period_window() {
        let body = json!({
            "config": {
                "creditUsagePercent": 10.0,
                "billingPeriodStart": "2026-01-01T00:00:00Z",
                "billingPeriodEnd": "2026-02-01T00:00:00Z"
            }
        });
        let p = parse(&body, Utc::now());
        let m = &p.meters[0];
        assert_eq!(m.resets_at.as_deref(), Some("2026-02-01T00:00:00Z"));
        assert_eq!(m.window_seconds, Some(31 * 86_400));
    }

    #[test]
    fn legacy_on_demand_ratio_when_no_percent() {
        let body = json!({
            "onDemandCap": {"val": 50000.0},
            "usage": {"onDemandUsed": {"val": 12500.0}},
            "config": {"billingPeriodEnd": "2026-02-01T00:00:00Z"}
        });
        let p = parse(&body, Utc::now());
        assert_eq!(p.meters[0].percent, Some(25.0));
    }

    #[test]
    fn period_without_percent_is_unknown_not_zero() {
        let body = json!({
            "config": {"currentPeriod": {"start": "2026-01-05T00:00:00Z", "end": "2026-01-12T00:00:00Z"}}
        });
        let p = parse(&body, Utc::now());
        assert!(p.meters.is_empty());
        assert_eq!(p.message.as_deref(), Some("El endpoint no reporta porcentaje de uso para este período."));
    }

    #[test]
    fn unrecognized_shape_reports_format_change() {
        let p = parse(&json!({"unexpected": true}), Utc::now());
        assert!(p.meters.is_empty());
        assert_eq!(p.message.as_deref(), Some("Respuesta sin datos de uso (¿ha cambiado el formato?)"));
    }

    #[test]
    fn auth_candidates_respect_grok_home() {
        let h = Path::new("/home/u");
        assert_eq!(auth_candidates(Some(Path::new("/custom")), h), vec![PathBuf::from("/custom/auth.json"), PathBuf::from("/home/u/.grok/auth.json")]);
        assert_eq!(auth_candidates(None, h), vec![PathBuf::from("/home/u/.grok/auth.json")]);
    }
}
