//! Cursor — uso del plan en el ciclo de facturación actual.
//!
//! No hay API pública. Igual que otras herramientas de la comunidad, se reutiliza la
//! sesión de la app de Cursor: el token está en su base de datos local
//! (`%APPDATA%\Cursor\User\globalStorage\state.vscdb`, clave `cursorAuth/accessToken`)
//! y se consulta `GET https://cursor.com/api/usage-summary` (NO OFICIAL) con la cookie
//! `WorkosCursorSessionToken=<userId>%3A%3A<token>`. Solo se lee; nunca se escribe en Cursor.

use super::{net_error, Who};
use crate::config::SubscriptionConfig;
use crate::model::{Kind, Meter, Spend, Status, UsageReport, Validity, ValidityKind};
use crate::secrets;
use base64::Engine;
use chrono::DateTime;
use serde_json::Value;
use std::path::PathBuf;

pub async fn fetch(cfg: &SubscriptionConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("Cursor", Kind::Subscription);

    // Token: el pegado a mano en Ajustes manda; si no, el de la app de Cursor.
    // Las cuentas adicionales solo usan su token (la app guarda una única sesión).
    let token = match who.secret(secrets::CURSOR_TOKEN) {
        Some(t) => t,
        None if !who.is_main() => {
            return report.fail(
                Status::Unconfigured,
                "Pega el token de esta cuenta de Cursor en Ajustes.",
            );
        }
        None => match read_app_token(cfg.credentials_path.as_deref()) {
            Ok(t) => t,
            Err(e) => return report.fail(Status::NeedsLogin, e),
        },
    };
    let token = jwt_from_cookie(&token);
    let Some(user_id) = user_id_from_jwt(&token) else {
        return report.fail(
            Status::Error,
            "No reconozco el token de Cursor (¿formato cambiado?).",
        );
    };
    let cookie = format!("WorkosCursorSessionToken={user_id}%3A%3A{token}");

    let res = http
        .get("https://cursor.com/api/usage-summary")
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => {
            return report.fail(
                Status::NeedsLogin,
                "Sesión de Cursor caducada. Abre Cursor para renovarla.",
            )
        }
        code => return report.fail(Status::Error, format!("HTTP {code} en usage-summary")),
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };
    let mut report = report;
    let p = parse(&body);
    report.validity = p.validity;
    report.plan = p.plan;
    report.meters = p.meters;
    report.spend = p.spend;
    report.message = p.message;
    if report.meters.is_empty() && report.message.is_none() {
        report.message = Some("Sin datos de uso del plan en la respuesta.".into());
    }
    report
}

fn default_db() -> PathBuf {
    // Windows: %APPDATA%\Cursor\...; macOS/Linux para desarrollo.
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb")
}

/// Lee `cursorAuth/accessToken` de la base de datos de Cursor en modo solo lectura.
fn read_app_token(explicit: Option<&str>) -> Result<String, String> {
    let path = explicit.map(PathBuf::from).unwrap_or_else(default_db);
    if !path.is_file() {
        return Err(format!(
            "No encuentro la sesión de Cursor en {}. Inicia sesión en Cursor.",
            path.display()
        ));
    }
    // `immutable=1`: no toca los bloqueos de Cursor aunque esté abierto.
    let p = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('%', "%25")
        .replace('?', "%3F")
        .replace('#', "%23");
    let p = if p.starts_with('/') {
        p
    } else {
        format!("/{p}")
    };
    let uri = format!("file://{p}?immutable=1");
    let conn = rusqlite::Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("No puedo abrir la base de datos de Cursor: {e}"))?;
    let value: rusqlite::types::Value = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "Cursor no tiene sesión iniciada.".to_string())?;
    // Según la versión de Cursor el valor es texto o BLOB.
    let raw = match value {
        rusqlite::types::Value::Text(t) => t,
        rusqlite::types::Value::Blob(b) => String::from_utf8_lossy(&b).into_owned(),
        _ => return Err("Cursor no tiene sesión iniciada.".into()),
    };
    Ok(raw.trim().trim_matches('"').to_string())
}

/// `sub` del JWT («auth0|user_XXXX») → «user_XXXX».
/// Acepta el token o el valor entero de la cookie `WorkosCursorSessionToken`
/// (`<userId>%3A%3A<token>`), que es lo que se copia del navegador.
pub(crate) fn jwt_from_cookie(raw: &str) -> String {
    let raw = raw.trim();
    raw.rsplit("%3A%3A")
        .next()
        .unwrap_or(raw)
        .rsplit("::")
        .next()
        .unwrap_or(raw)
        .to_string()
}

pub(crate) fn user_id_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let sub = v.get("sub")?.as_str()?;
    Some(sub.rsplit('|').next().unwrap_or(sub).to_string())
}

pub(crate) struct Parsed {
    pub plan: Option<String>,
    pub meters: Vec<Meter>,
    pub spend: Option<Spend>,
    pub message: Option<String>,
    pub validity: Option<Validity>,
}

pub(crate) fn parse(v: &Value) -> Parsed {
    let start = v
        .get("billingCycleStart")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    let end = v
        .get("billingCycleEnd")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    let window = match (start, end) {
        (Some(s), Some(e)) if e > s => Some((e - s).num_seconds()),
        _ => None,
    };
    let resets_at = end.map(|e| e.with_timezone(&chrono::Utc).to_rfc3339());
    let plan = v.get("membershipType").and_then(Value::as_str).map(|m| {
        let mut c = m.chars();
        c.next()
            .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
            .unwrap_or_default()
    });

    let p = v.pointer("/individualUsage/plan");
    let n = |k: &str| p.and_then(|p| p.get(k)).and_then(Value::as_f64);
    let mut meters = vec![];
    let unlimited = v
        .get("isUnlimited")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !unlimited {
        let total = n("totalPercentUsed").or_else(|| match (n("used"), n("limit")) {
            (Some(u), Some(l)) if l > 0.0 => Some(u / l * 100.0),
            _ => None,
        });
        if let Some(pct) = total {
            meters.push(Meter {
                id: "plan_total".into(),
                label: "Plan · total".into(),
                percent: Some(pct),
                used: None,
                limit: None,
                unit: None,
                resets_at: resets_at.clone(),
                window_seconds: window,
            });
        }
        for (key, id, label) in [
            ("autoPercentUsed", "plan_auto", "Plan · Auto"),
            ("apiPercentUsed", "plan_api", "Plan · modelos API"),
        ] {
            if let Some(pct) = n(key) {
                meters.push(Meter {
                    id: id.into(),
                    label: label.into(),
                    percent: Some(pct),
                    used: None,
                    limit: None,
                    unit: None,
                    resets_at: resets_at.clone(),
                    window_seconds: window,
                });
            }
        }
    }

    // On-demand: dólares fuera del plan (vienen en céntimos en algunas cuentas).
    let od = v.pointer("/individualUsage/onDemand");
    let od_used = od.and_then(|o| o.get("used")).and_then(Value::as_f64);
    let spend = match (
        od.and_then(|o| o.get("enabled")).and_then(Value::as_bool),
        od_used,
    ) {
        (Some(true), Some(u)) if u > 0.0 => Some(Spend {
            amount: if u > 1000.0 { u / 100.0 } else { u },
            currency: "USD".into(),
            period_label: "On-demand".into(),
            budget: od
                .and_then(|o| o.get("limit"))
                .and_then(Value::as_f64)
                .map(|l| if l > 1000.0 { l / 100.0 } else { l }),
        }),
        _ => None,
    };
    let message = unlimited.then(|| "Plan sin límite de uso".to_string());
    let validity = end.map(|at| Validity {
        at: at.to_rfc3339(),
        kind: ValidityKind::Period,
    });
    Parsed {
        plan,
        meters,
        spend,
        message,
        validity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_the_whole_cookie() {
        assert_eq!(jwt_from_cookie("user_01%3A%3Aaaa.bbb.ccc"), "aaa.bbb.ccc");
        assert_eq!(jwt_from_cookie(" user_01::aaa.bbb.ccc "), "aaa.bbb.ccc");
        assert_eq!(jwt_from_cookie("aaa.bbb.ccc"), "aaa.bbb.ccc");
    }

    #[test]
    fn parses_usage_summary() {
        let v = json!({
            "billingCycleStart": "2026-09-20T10:00:00.000Z",
            "billingCycleEnd": "2026-10-20T10:00:00.000Z",
            "membershipType": "pro",
            "isUnlimited": false,
            "individualUsage": {
                "plan": {"used": 1200, "limit": 2000, "remaining": 800, "autoPercentUsed": 35.5, "apiPercentUsed": 72.0, "totalPercentUsed": 60.0},
                "onDemand": {"enabled": true, "used": 4.2, "limit": 20}
            }
        });
        let p = parse(&v);
        assert_eq!(p.plan.as_deref(), Some("Pro"));
        assert_eq!(p.meters.len(), 3);
        assert_eq!(p.meters[0].percent, Some(60.0));
        assert_eq!(p.meters[0].window_seconds, Some(30 * 86_400));
        assert_eq!(
            p.meters[0].resets_at.as_deref(),
            Some("2026-10-20T10:00:00+00:00")
        );
        assert_eq!(p.meters[2].label, "Plan · modelos API");
        assert_eq!(
            p.meters.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["plan_total", "plan_auto", "plan_api"]
        );
        assert_eq!(p.spend.map(|s| s.amount), Some(4.2));
    }

    #[test]
    fn reports_only_explicit_valid_billing_period_end() {
        let p = parse(&json!({"billingCycleEnd": "2030-02-01T00:00:00Z"}));
        let validity = p.validity.unwrap();
        assert_eq!(validity.kind, crate::model::ValidityKind::Period);
        assert_eq!(validity.at, "2030-02-01T00:00:00+00:00");
        assert!(parse(&json!({})).validity.is_none());
        assert!(parse(&json!({"billingCycleEnd": "invalid"}))
            .validity
            .is_none());
        assert!(parse(&json!({"billingCycleEnd": "2030-02-30T00:00:00Z"}))
            .validity
            .is_none());
    }

    #[test]
    fn falls_back_to_used_over_limit() {
        let p = parse(&json!({"individualUsage": {"plan": {"used": 50, "limit": 200}}}));
        assert_eq!(p.meters[0].percent, Some(25.0));
    }

    #[test]
    fn extracts_user_id_from_jwt() {
        // {"sub":"auth0|user_01ABC","exp":1}
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"auth0|user_01ABC","exp":1}"#);
        let token = format!("eyJhbGciOiJIUzI1NiJ9.{payload}.sig");
        assert_eq!(user_id_from_jwt(&token).as_deref(), Some("user_01ABC"));
        assert_eq!(user_id_from_jwt("nope"), None);
    }
}
