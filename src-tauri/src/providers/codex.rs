//! ChatGPT Plus / Pro (Codex) — límites de sesión (5 h) y semanales.
//!
//! Igual que con Claude: no hay API pública. Se reutiliza la sesión OAuth que
//! guarda `codex login` (`~/.codex/auth.json`, o `$CODEX_HOME/auth.json`) y se
//! consulta el endpoint que usa `/status` de Codex. NO OFICIAL.
//! La app no refresca tokens: si caducan, basta con ejecutar `codex`.

use super::{home, net_error, read_json, resolve_path, unix_to_rfc3339, Who};
use crate::config::SubscriptionConfig;
use crate::model::{Kind, Meter, Status, UsageReport, Validity, ValidityKind};
use base64::Engine;
use serde_json::Value;
use std::path::{Path, PathBuf};

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// Candidatos de `auth.json` en el orden en que se buscan.
///
/// Compartido por `fetch` y por `providers::session_stamp` para que ambos
/// observen el mismo fichero: `$CODEX_HOME/auth.json` (si la variable existe)
/// y `~/.codex/auth.json` como respaldo.
pub(crate) fn auth_candidates(codex_home: Option<&Path>, home: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = codex_home {
        candidates.push(dir.join("auth.json"));
    }
    candidates.push(home.join(".codex").join("auth.json"));
    candidates
}

/// Ruta efectiva de `auth.json`: respeta `credentials_path` explícito y, si no,
/// el primer candidato existente.
pub(crate) fn auth_path(
    credentials_path: Option<&str>,
    codex_home: Option<&Path>,
    home: &Path,
) -> Result<PathBuf, String> {
    resolve_path(credentials_path, &auth_candidates(codex_home, home))
}

/// `auth_path` leyendo `CODEX_HOME` del entorno (uso real; los tests inyectan).
pub(crate) fn resolved_auth_path(credentials_path: Option<&str>) -> Result<PathBuf, String> {
    auth_path(
        credentials_path,
        std::env::var_os("CODEX_HOME").map(PathBuf::from).as_deref(),
        &home(),
    )
}

pub async fn fetch(cfg: &SubscriptionConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("ChatGPT · Codex", Kind::Subscription);

    let path = match resolved_auth_path(cfg.credentials_path.as_deref()) {
        Ok(p) => p,
        Err(e) => return report.fail(Status::NeedsLogin, format!("{e}. Ejecuta «codex login».")),
    };
    let auth_json = match read_json(&path) {
        Ok(v) => v,
        Err(e) => return report.fail(Status::NeedsLogin, e),
    };
    let auth = match Auth::parse(&auth_json) {
        Ok(a) => a,
        Err(e) => return report.fail(Status::NeedsLogin, e),
    };

    let mut req = http
        .get(USAGE_URL)
        .bearer_auth(&auth.access_token)
        .header("Accept", "application/json");
    if let Some(acc) = &auth.account_id {
        req = req.header("chatgpt-account-id", acc);
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => {
            return report.fail(
                Status::NeedsLogin,
                "Sesión caducada. Ejecuta «codex» para renovarla.",
            )
        }
        429 => {
            return report.fail(
                Status::Warning,
                "El endpoint de uso está limitando peticiones.",
            )
        }
        code => return report.fail(Status::Error, format!("HTTP {code} en el endpoint de uso")),
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };
    let mut report = report;
    report.validity = parse_validity(
        auth_json
            .pointer("/tokens/id_token")
            .and_then(Value::as_str),
        auth.account_id.as_deref(),
        chrono::Utc::now(),
    );
    hydrate_usage(report, &body)
}

fn hydrate_usage(mut report: UsageReport, body: &Value) -> UsageReport {
    let (plan, meters) = parse_usage(body);
    report.plan = plan;
    report.available_resets = parse_available_resets(body);
    report.meters = meters;
    if report.meters.is_empty() && report.available_resets.is_none() {
        return report.fail(
            Status::Warning,
            "Respuesta sin datos de uso (¿ha cambiado el formato?)",
        );
    }
    report
}

#[derive(Debug, PartialEq)]
pub(crate) struct Auth {
    pub access_token: String,
    pub account_id: Option<String>,
}

impl Auth {
    pub fn parse(v: &Value) -> Result<Self, String> {
        let tokens = v.get("tokens").filter(|t| t.is_object());
        let Some(tokens) = tokens else {
            return Err(
                if v.get("OPENAI_API_KEY").and_then(Value::as_str).is_some() {
                    "Codex está autenticado con API key, no con tu cuenta de ChatGPT. Ejecuta «codex login».".into()
                } else {
                    "auth.json sin tokens. Ejecuta «codex login».".into()
                },
            );
        };
        let access_token = tokens
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("auth.json sin access_token")?
            .to_string();
        Ok(Self {
            access_token,
            account_id: tokens
                .get("account_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }
}

/// Display metadata only: never infer a billing date from OAuth exp or expose tokens.
fn parse_validity(
    token: Option<&str>,
    account_id: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Validity> {
    let token = token.filter(|t| t.len() <= 65_536)?;
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    if claims.get("exp").and_then(Value::as_i64)? <= now.timestamp() {
        return None;
    }
    let account = claims.get("https://api.openai.com/auth")?;
    let account_id = account_id.filter(|id| !id.is_empty())?;
    if account.get("chatgpt_account_id").and_then(Value::as_str)? != account_id {
        return None;
    }
    let at = chrono::DateTime::parse_from_rfc3339(
        account.get("chatgpt_subscription_active_until")?.as_str()?,
    )
    .ok()?;
    if at <= now {
        return None;
    }
    Some(Validity {
        at: at.to_rfc3339(),
        kind: ValidityKind::Period,
    })
}

fn window_label(seconds: Option<i64>, fallback: &str) -> String {
    match seconds {
        Some(s) if s > 0 && s <= 6 * 3600 => {
            format!("Sesión · {} h", (s as f64 / 3600.0).round() as i64)
        }
        Some(s) if (6 * 86400..=8 * 86400).contains(&s) => "Semana".into(),
        Some(s) if s > 0 && s % 86400 == 0 => format!("{} días", s / 86400),
        _ => fallback.into(),
    }
}

/// Id estable de la ventana; espeja las ramas de `window_label`.
fn window_id(seconds: Option<i64>, fallback_id: &str) -> String {
    match seconds {
        Some(s) if s > 0 && s <= 6 * 3600 => "session".into(),
        Some(s) if (6 * 86400..=8 * 86400).contains(&s) => "weekly".into(),
        Some(s) if s > 0 && s % 86400 == 0 => "window_days".into(),
        _ => fallback_id.into(),
    }
}

fn parse_window(w: &Value, fallback: &str, fallback_id: &str) -> Option<Meter> {
    let pct = w.get("used_percent").and_then(Value::as_f64)?;
    let secs = w.get("limit_window_seconds").and_then(Value::as_i64);
    Some(Meter {
        id: window_id(secs, fallback_id),
        label: window_label(secs, fallback),
        window_seconds: secs.filter(|s| *s > 0),
        percent: Some(pct),
        resets_at: w
            .get("reset_at")
            .and_then(Value::as_i64)
            .and_then(unix_to_rfc3339),
        ..Default::default()
    })
}

fn parse_available_resets(v: &Value) -> Option<u32> {
    let count = v
        .get("rate_limit_reset_credits")?
        .get("available_count")?
        .as_i64()?;
    u32::try_from(count).ok()
}

pub(crate) fn parse_usage(v: &Value) -> (Option<String>, Vec<Meter>) {
    let plan = v.get("plan_type").and_then(Value::as_str).map(|p| {
        let mut c = p.chars();
        c.next()
            .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
            .unwrap_or_default()
    });
    let mut meters = vec![];
    if let Some(rl) = v.get("rate_limit") {
        if let Some(m) = rl
            .get("primary_window")
            .and_then(|w| parse_window(w, "Ventana corta", "window_short"))
        {
            meters.push(m);
        }
        if let Some(mut m) = rl
            .get("secondary_window")
            .and_then(|w| parse_window(w, "Ventana larga", "window_long"))
        {
            // Dos ventanas con el mismo significado no pueden compartir id.
            if meters.iter().any(|x| x.id == m.id) {
                m.id = format!(
                    "{}_{}",
                    m.id,
                    m.window_seconds
                        .map_or_else(|| "secondary".to_string(), |s| s.to_string())
                );
            }
            meters.push(m);
        }
    }
    if let Some(c) = v
        .get("credits")
        .filter(|c| c.get("has_credits").and_then(Value::as_bool) == Some(true))
    {
        let unlimited = c.get("unlimited").and_then(Value::as_bool).unwrap_or(false);
        let balance = c.get("balance").and_then(|b| {
            b.as_f64()
                .or_else(|| b.as_str().and_then(|s| s.parse().ok()))
        });
        if !unlimited {
            if let Some(b) = balance {
                meters.push(Meter {
                    id: "credits".into(),
                    label: "Créditos disponibles".into(),
                    used: Some(b),
                    unit: Some("créditos".into()),
                    ..Default::default()
                });
            }
        }
    }
    (plan, meters)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Directorio temporal propio (sin dependencias externas) que se limpia solo.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("quorb-codex-test-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        /// Crea un fichero con contenido mínimo y devuelve su ruta.
        fn file(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, "{}").unwrap();
            p
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn auth_candidates_include_home_fallback() {
        let home = Path::new("/tmp/quorb-home");
        let codex = Path::new("/tmp/quorb-codex");
        assert_eq!(
            auth_candidates(Some(codex), home),
            vec![
                codex.join("auth.json"),
                home.join(".codex").join("auth.json")
            ]
        );
        assert_eq!(
            auth_candidates(None, home),
            vec![home.join(".codex").join("auth.json")]
        );
    }

    #[test]
    fn auth_path_prefers_codex_home_when_it_has_auth() {
        let home = TempDir::new("home-codexhome");
        let codex_home = TempDir::new("codexhome");
        let codex_auth = codex_home.file("auth.json");
        home.file(".codex/auth.json");
        assert_eq!(
            auth_path(None, Some(codex_home.path()), home.path()).unwrap(),
            codex_auth
        );
    }

    #[test]
    fn auth_path_falls_back_to_home_auth_when_codex_home_lacks_it() {
        // CODEX_HOME existe pero sin auth.json: ambos (fetch y stamp) deben ver ~/.codex/auth.json.
        let home = TempDir::new("home-fallback");
        let codex_home = TempDir::new("codexhome-empty");
        let home_auth = home.file(".codex/auth.json");
        assert_eq!(
            auth_path(None, Some(codex_home.path()), home.path()).unwrap(),
            home_auth
        );
    }

    #[test]
    fn auth_path_keeps_explicit_credentials_path_priority() {
        let home = TempDir::new("home-custom");
        let codex_home = TempDir::new("codexhome-custom");
        codex_home.file("auth.json");
        let custom = home.file("custom/auth.json");
        let explicit = custom.to_string_lossy().into_owned();
        assert_eq!(
            auth_path(Some(&explicit), Some(codex_home.path()), home.path()).unwrap(),
            custom
        );
    }

    #[test]
    fn auth_path_errors_when_nothing_exists() {
        let home = TempDir::new("home-empty");
        let codex_home = TempDir::new("codexhome-none");
        assert!(auth_path(None, Some(codex_home.path()), home.path()).is_err());
        let missing = home.path().join("missing.json");
        assert!(auth_path(Some(missing.to_string_lossy().as_ref()), None, home.path()).is_err());
    }

    #[test]
    fn parses_auth() {
        let v = json!({"OPENAI_API_KEY": null, "tokens": {"id_token": "a", "access_token": "b", "refresh_token": "c", "account_id": "acc"}});
        assert_eq!(
            Auth::parse(&v).unwrap(),
            Auth {
                access_token: "b".into(),
                account_id: Some("acc".into())
            }
        );
        assert!(Auth::parse(&json!({"OPENAI_API_KEY": "sk-..."}))
            .unwrap_err()
            .contains("API key"));
    }

    /// Sesión real de Codex: el fixture es la estructura que escribe
    /// `$CODEX_HOME/auth.json` (o `~/.codex/auth.json`) tras `codex login`.
    /// Verifica parseo y validez con reloj inyectado (sin credenciales reales).
    #[test]
    fn parses_real_session_fixture() {
        let raw = include_str!("fixtures/codex-auth.json");
        let v: Value = serde_json::from_str(raw).expect("fixture codex válido");
        let auth = Auth::parse(&v).expect("el fixture debe parsear como sesión real");
        assert_eq!(auth.access_token, "example-access-token-codex");
        assert_eq!(auth.account_id.as_deref(), Some("account-example-123"));
        // El id_token del fixture expira en el año ~2100: a día de hoy es válido.
        let now = chrono::DateTime::from_timestamp(1_800_000_000, 0).expect("now fijo");
        let id_token = v
            .pointer("/tokens/id_token")
            .and_then(Value::as_str)
            .unwrap();
        assert!(
            parse_validity(Some(id_token), Some("account-example-123"), now).is_some(),
            "la sesión real válida debe reportar validez"
        );
    }

    fn id_token(claims: Value) -> String {
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        format!("header.{payload}.signature")
    }

    #[test]
    fn reads_optional_period_end_from_current_matching_id_token() {
        let now = chrono::DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z")
            .unwrap()
            .to_utc();
        let token = id_token(json!({
            "exp": now.timestamp() + 3600,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acc",
                "chatgpt_subscription_active_until": "2030-02-01T00:00:00Z"
            }
        }));
        let v = parse_validity(Some(&token), Some("acc"), now).unwrap();
        assert_eq!(v.kind, crate::model::ValidityKind::Period);
        assert_eq!(v.at, "2030-02-01T00:00:00+00:00");
        assert!(parse_validity(Some(&token), Some("other"), now).is_none());
        assert!(parse_validity(Some(&token), None, now).is_none());
        assert!(
            parse_validity(Some(&token), Some("acc"), now + chrono::Duration::hours(2)).is_none()
        );
    }

    #[test]
    fn never_substitutes_token_expiration_for_subscription_period() {
        let now = chrono::Utc::now();
        for token in [
            "bad".to_string(),
            id_token(json!({"exp": now.timestamp() + 3600})),
            id_token(
                json!({"https://api.openai.com/auth": {"chatgpt_subscription_active_until": "bad"}}),
            ),
            id_token(
                json!({"exp": now.timestamp() + 3600, "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acc", "chatgpt_subscription_active_until": "2020-01-01T00:00:00Z"
                }}),
            ),
        ] {
            assert!(parse_validity(Some(&token), Some("acc"), now).is_none());
        }
        assert!(parse_validity(None, Some("acc"), now).is_none());
    }

    #[test]
    fn reset_credits_hydration_accepts_count_without_meters_or_period() {
        for count in [2, 0] {
            let body = json!({"rate_limit_reset_credits": {"available_count": count}});
            let report = hydrate_usage(
                UsageReport::new("codex", "Codex", Kind::Subscription),
                &body,
            );
            assert_eq!(report.status, Status::Ok);
            assert_eq!(report.available_resets, Some(count));
            assert!(report.meters.is_empty());
            assert!(report.validity.is_none());
            assert!(report.message.is_none());
        }
    }

    #[test]
    fn reset_credits_hydration_clears_metadata_when_usage_is_unknown() {
        for body in [
            json!({}),
            json!({"rate_limit_reset_credits": {"available_count": "2"}}),
        ] {
            let mut report = UsageReport::new("codex", "Codex", Kind::Subscription);
            report.available_resets = Some(2);
            report.validity = Some(Validity {
                at: "2030-02-01T00:00:00Z".into(),
                kind: ValidityKind::Period,
            });
            let report = hydrate_usage(report, &body);
            assert_eq!(report.status, Status::Warning);
            assert_eq!(report.available_resets, None);
            assert_eq!(report.validity, None);
            assert!(report.meters.is_empty());
        }
    }

    #[test]
    fn reset_credits_hydration_preserves_quota_and_existing_period_with_bad_count() {
        let body = json!({
            "plan_type": "plus",
            "rate_limit": {"primary_window": {"used_percent": 20, "limit_window_seconds": 18000}},
            "rate_limit_reset_credits": {"available_count": -1}
        });
        let mut report = UsageReport::new("codex", "Codex", Kind::Subscription);
        report.validity = Some(Validity {
            at: "2030-02-01T00:00:00Z".into(),
            kind: ValidityKind::Period,
        });
        let expected_validity = report.validity.clone();
        let report = hydrate_usage(report, &body);
        assert_eq!(report.status, Status::Ok);
        assert_eq!(report.available_resets, None);
        assert_eq!(report.validity, expected_validity);
        assert_eq!((report.plan, report.meters), parse_usage(&body));
    }

    #[test]
    fn reset_credits_accepts_checked_integer_counts() {
        for count in [2_u32, 0, u32::MAX] {
            let v = json!({"rate_limit_reset_credits": {"available_count": count}});
            assert_eq!(parse_available_resets(&v), Some(count));
        }
    }

    #[test]
    fn reset_credits_rejects_missing_or_invalid_counts_without_changing_usage() {
        let base = json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 20, "limit_window_seconds": 18000},
                "secondary_window": {"used_percent": 50, "limit_window_seconds": 604800}
            },
            "credits": {"has_credits": true, "unlimited": false, "balance": "15.0", "available_count": 99}
        });
        let expected = parse_usage(&base);
        assert_eq!(expected.0.as_deref(), Some("Plus"));
        assert_eq!(expected.1.len(), 3);
        assert_eq!(expected.1[2].used, Some(15.0));
        assert_eq!(parse_available_resets(&base), None);
        for invalid in [
            Value::Null,
            json!({}),
            json!([]),
            json!(2),
            json!("2"),
            json!(true),
            json!({"available_count": null}),
            json!({"available_count": -1}),
            json!({"available_count": u32::MAX as u64 + 1}),
            json!({"available_count": u64::MAX}),
            json!({"available_count": 2.0}),
            json!({"available_count": 2.5}),
            json!({"available_count": "2"}),
            json!({"available_count": true}),
        ] {
            let mut v = base.clone();
            v["rate_limit_reset_credits"] = invalid;
            assert_eq!(parse_available_resets(&v), None, "{v}");
            assert_eq!(parse_usage(&v), expected);
        }
    }

    #[test]
    fn parses_windows() {
        let v = json!({
            "plan_type": "plus",
            "rate_limit": {
                "allowed": true,
                "primary_window": {"used_percent": 20, "limit_window_seconds": 18000, "reset_after_seconds": 14400, "reset_at": 1704081600},
                "secondary_window": {"used_percent": 50, "limit_window_seconds": 604800, "reset_at": 1704499200}
            },
            "credits": {"has_credits": true, "unlimited": false, "balance": "15.0"}
        });
        let (plan, m) = parse_usage(&v);
        assert_eq!(plan.as_deref(), Some("Plus"));
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].label, "Sesión · 5 h");
        assert_eq!(m[0].percent, Some(20.0));
        assert_eq!(m[0].resets_at.as_deref(), Some("2024-01-01T04:00:00+00:00"));
        assert_eq!(m[1].label, "Semana");
        assert_eq!(m[1].window_seconds, Some(604800));
        assert_eq!(m[2].used, Some(15.0));
        assert_eq!(
            m.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["session", "weekly", "credits"]
        );
    }

    fn ids_for(primary: Value, secondary: Value) -> Vec<(String, String)> {
        let v = json!({"rate_limit": {"primary_window": primary, "secondary_window": secondary}});
        parse_usage(&v)
            .1
            .into_iter()
            .map(|m| (m.id, m.label))
            .collect()
    }

    #[test]
    fn window_ids_cover_days_and_fallback_windows() {
        let ids = ids_for(
            json!({"used_percent": 1, "limit_window_seconds": 3 * 86400}),
            json!({"used_percent": 2, "limit_window_seconds": 7 * 3600 + 1}),
        );
        assert_eq!(ids[0], ("window_days".to_string(), "3 días".to_string()));
        assert_eq!(
            ids[1],
            ("window_long".to_string(), "Ventana larga".to_string())
        );
        let ids = ids_for(json!({"used_percent": 1}), json!({"used_percent": 2}));
        assert_eq!(ids[0].0, "window_short");
        assert_eq!(ids[1].0, "window_long");
    }

    #[test]
    fn colliding_window_ids_are_made_unique_deterministically() {
        let ids = ids_for(
            json!({"used_percent": 1, "limit_window_seconds": 18000}),
            json!({"used_percent": 2, "limit_window_seconds": 18000}),
        );
        assert_eq!(
            ids.iter().map(|(i, _)| i.as_str()).collect::<Vec<_>>(),
            ["session", "session_18000"]
        );
        // Labels stay exactly as today.
        assert!(ids.iter().all(|(_, l)| l == "Sesión · 5 h"));
        let days = ids_for(
            json!({"used_percent": 1, "limit_window_seconds": 2 * 86400}),
            json!({"used_percent": 2, "limit_window_seconds": 3 * 86400}),
        );
        assert_eq!(
            days.iter().map(|(i, _)| i.as_str()).collect::<Vec<_>>(),
            ["window_days", "window_days_259200"]
        );
    }
}
