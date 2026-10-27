//! Datos del panel de NaN Cloud (cloud.nan.builders), los mismos que ves en el dashboard:
//!   · `GET  https://cloud-api.nan.builders/api/usage/quota`   → tokens usados / cap / fin de periodo por modelo
//!   · `GET  https://cloud-api.nan.builders/api/metrics/usage` → totales 24 h / 30 días / mes y serie diaria
//!
//! Se autentican con la sesión de la web. Para conseguirla usamos el mismo
//! acceso que la CLI oficial (`nan auth login --email`): NaN envía un enlace de
//! un solo uso a tu correo, lo pegas en Ajustes y guardamos la cookie de sesión
//! resultante en el Administrador de credenciales de Windows.

use super::net_error;
use crate::model::{Daily, Meter};
use chrono::{DateTime, Months, NaiveDate, Utc};
use serde_json::Value;
use std::collections::BTreeMap;

pub const API: &str = "https://cloud-api.nan.builders";

pub enum CloudError {
    /// 401: hay que volver a iniciar sesión.
    Expired,
    Other(String),
}

/// Paso 1: pide a NaN que envíe el enlace de acceso al correo.
pub async fn login_request(http: &reqwest::Client, email: &str) -> Result<(), String> {
    let email = email.trim();
    if !email.contains('@') {
        return Err("Escribe un correo válido".into());
    }
    let res = http
        .post(format!("{API}/api/auth/login/request"))
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(net_error)?;
    match res.status().as_u16() {
        200..=299 => Ok(()),
        429 => Err("Demasiados intentos; espera unos minutos.".into()),
        code => Err(format!("NaN respondió HTTP {code}")),
    }
}

/// Paso 2: abre el enlace del correo (sin navegador) y devuelve la cabecera `Cookie` de la sesión.
pub async fn login_complete(link: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(link.trim()).map_err(|_| "Eso no parece un enlace".to_string())?;
    if !is_nan_host(&url) {
        return Err("El enlace debe ser de nan.builders".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("quorb/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let mut jar: BTreeMap<String, String> = BTreeMap::new();
    for _ in 0..8 {
        let res = client.get(url.clone()).send().await.map_err(net_error)?;
        for v in res.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Some((k, val)) = v.to_str().ok().and_then(parse_set_cookie) {
                if val.is_empty() {
                    jar.remove(&k);
                } else {
                    jar.insert(k, val);
                }
            }
        }
        if !res.status().is_redirection() {
            break;
        }
        let Some(loc) = res
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
        else {
            break;
        };
        let next = url.join(loc).map_err(|e| e.to_string())?;
        // Solo seguimos dentro de nan.builders: nunca mandamos nada a otro dominio.
        if !is_nan_host(&next) {
            break;
        }
        url = next;
    }
    if jar.is_empty() {
        return Err("El enlace no ha devuelto una sesión. Puede que ya se haya usado (son de un solo uso): pide otro.".into());
    }
    Ok(cookie_header(&jar))
}

/// Comprueba la sesión y devuelve el nombre de usuario.
pub async fn whoami(http: &reqwest::Client, cookie: &str) -> Result<String, CloudError> {
    let v = get_json(http, cookie, "/api/auth/me").await?;
    Ok(v.pointer("/handle")
        .or_else(|| v.pointer("/username"))
        .or_else(|| v.pointer("/user/handle"))
        .or_else(|| v.pointer("/email"))
        .and_then(Value::as_str)
        .unwrap_or("tu cuenta")
        .to_string())
}

pub struct CloudUsage {
    pub meters: Vec<Meter>,
    pub daily: Vec<Daily>,
    pub last24h: Option<f64>,
    pub month: Option<f64>,
}

pub async fn fetch(http: &reqwest::Client, cookie: &str) -> Result<CloudUsage, CloudError> {
    let quota = get_json(http, cookie, "/api/usage/quota").await?;
    // Las métricas son un extra: si fallan, seguimos con las cuotas.
    let metrics = get_json(http, cookie, "/api/metrics/usage").await.ok();
    Ok(CloudUsage {
        meters: parse_quota(&quota),
        daily: metrics.as_ref().map(parse_daily).unwrap_or_default(),
        last24h: metrics
            .as_ref()
            .and_then(|m| m.pointer("/last24h/totalTokens"))
            .and_then(Value::as_f64),
        month: metrics
            .as_ref()
            .and_then(|m| m.pointer("/monthToDate/totalTokens"))
            .and_then(Value::as_f64),
    })
}

async fn get_json(http: &reqwest::Client, cookie: &str, path: &str) -> Result<Value, CloudError> {
    let res = http
        .get(format!("{API}{path}"))
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| CloudError::Other(net_error(e)))?;
    match res.status().as_u16() {
        200 => res
            .json()
            .await
            .map_err(|e| CloudError::Other(format!("respuesta no JSON: {e}"))),
        401 | 403 => Err(CloudError::Expired),
        code => Err(CloudError::Other(format!("HTTP {code} en {path}"))),
    }
}

fn is_nan_host(u: &reqwest::Url) -> bool {
    u.scheme() == "https"
        && u.host_str()
            .map(|h| h == "nan.builders" || h.ends_with(".nan.builders"))
            .unwrap_or(false)
}

/// `name=value; Path=/; HttpOnly` → (name, value)
pub(crate) fn parse_set_cookie(h: &str) -> Option<(String, String)> {
    let first = h.split(';').next()?.trim();
    let (k, v) = first.split_once('=')?;
    let k = k.trim();
    if k.is_empty() {
        return None;
    }
    Some((k.to_string(), v.trim().to_string()))
}

pub(crate) fn cookie_header(jar: &BTreeMap<String, String>) -> String {
    jar.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Un medidor por modelo con tokens usados (ordenados por %, el mayor primero).
pub(crate) fn parse_quota(v: &Value) -> Vec<Meter> {
    let period_start = v
        .get("periodStart")
        .and_then(Value::as_str)
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc());
    let mut out: Vec<Meter> = v
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let model = m.get("model").and_then(Value::as_str)?;
            let used = m.get("tokensUsed").and_then(Value::as_f64)?;
            let cap = m.get("cap").and_then(Value::as_f64).filter(|c| *c > 0.0)?;
            if used <= 0.0 {
                return None;
            }
            let end = m
                .get("periodEnd")
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc));
            // Mensual: desde periodStart. Periodo de facturación (glm5.3): un mes antes del fin.
            let start = match (end, period_start) {
                (Some(e), Some(s)) if m.get("windowHours").is_none() => Some(s.min(e)),
                (Some(e), _) => e.checked_sub_months(Months::new(1)),
                _ => None,
            };
            Some(Meter {
                id: format!("model:{model}"),
                label: model.to_string(),
                percent: Some(used / cap * 100.0),
                used: Some(used),
                limit: Some(cap),
                unit: Some("tokens".into()),
                resets_at: end.map(|e| e.to_rfc3339()),
                window_seconds: match (start, end) {
                    (Some(s), Some(e)) if e > s => Some((e - s).num_seconds()),
                    _ => None,
                },
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.percent
            .partial_cmp(&a.percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Tokens por día (todas las familias de modelo sumadas) de `timeSeries`.
pub(crate) fn parse_daily(v: &Value) -> Vec<Daily> {
    let mut days: BTreeMap<String, f64> = BTreeMap::new();
    for p in v
        .get("timeSeries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(date) = p.get("date").and_then(Value::as_str) else {
            continue;
        };
        let t = ["inputTokens", "outputTokens"]
            .iter()
            .filter_map(|k| p.get(*k).and_then(Value::as_f64))
            .sum::<f64>();
        *days.entry(date.to_string()).or_default() += t;
    }
    days.into_iter()
        .map(|(date, value)| Daily { date, value })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_quota_like_the_dashboard() {
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 444165538u64, "cap": 3000000000u64, "remaining": 2555834462u64, "periodEnd": "2026-11-01T00:00:00Z"},
            {"model": "mimo-v2.6-flash", "tokensUsed": 75802306, "cap": 1000000000u64, "periodEnd": "2026-11-01T00:00:00Z"},
            {"model": "glm5.3", "tokensUsed": 0, "cap": 3000000000u64, "periodEnd": "2026-10-17T05:53:20Z", "fullWindowTokens": 400000000, "windowHours": 4},
            {"model": "qwen3.8-flash", "tokensUsed": 0, "cap": 500000000, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let m = parse_quota(&v);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].label, "deepseek-v4-flash");
        assert_eq!(m[0].id, "model:deepseek-v4-flash");
        assert_eq!(m[1].id, "model:mimo-v2.6-flash");
        assert!((m[0].percent.unwrap() - 14.8055).abs() < 0.01);
        assert_eq!(m[0].resets_at.as_deref(), Some("2026-11-01T00:00:00+00:00"));
        assert_eq!(m[0].window_seconds, Some(31 * 86400));
        assert_eq!(m[1].label, "mimo-v2.6-flash");
    }

    #[test]
    fn billing_period_window_is_one_month() {
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "glm5.3", "tokensUsed": 1000, "cap": 3000000000u64, "periodEnd": "2026-10-17T05:53:20Z", "windowHours": 4}
        ]});
        assert_eq!(parse_quota(&v)[0].window_seconds, Some(30 * 86400));
    }

    #[test]
    fn sums_daily_series() {
        let v = json!({"timeSeries": [
            {"date": "2026-10-05", "model": "a", "inputTokens": 10, "outputTokens": 5},
            {"date": "2026-10-05", "model": "b", "inputTokens": 1, "outputTokens": 1},
            {"date": "2026-10-06", "model": "a", "inputTokens": 7, "outputTokens": 0}
        ]});
        let d = parse_daily(&v);
        assert_eq!(
            d,
            vec![
                Daily {
                    date: "2026-10-05".into(),
                    value: 17.0
                },
                Daily {
                    date: "2026-10-06".into(),
                    value: 7.0
                }
            ]
        );
    }

    #[test]
    fn cookies() {
        assert_eq!(
            parse_set_cookie("session=abc.def; Path=/; HttpOnly; Secure"),
            Some(("session".into(), "abc.def".into()))
        );
        assert_eq!(parse_set_cookie("; Path=/"), None);
        let jar = BTreeMap::from([
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "2".to_string()),
        ]);
        assert_eq!(cookie_header(&jar), "a=1; b=2");
    }

    #[test]
    fn only_nan_hosts() {
        assert!(is_nan_host(
            &reqwest::Url::parse("https://cloud-api.nan.builders/x").unwrap()
        ));
        assert!(is_nan_host(
            &reqwest::Url::parse("https://nan.builders/x").unwrap()
        ));
        assert!(!is_nan_host(
            &reqwest::Url::parse("https://evil-nan.builders.com/x").unwrap()
        ));
        assert!(!is_nan_host(
            &reqwest::Url::parse("http://cloud.nan.builders/x").unwrap()
        ));
    }
}
