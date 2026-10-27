//! OpenRouter — API oficial.
//!   · `GET https://openrouter.ai/api/v1/key`     → uso y límite de la key (diario/semanal/mensual)
//!   · `GET https://openrouter.ai/api/v1/credits` → saldo comprado y gastado de la cuenta
//! Docs: https://openrouter.ai/docs/api-reference/limits

use super::{month_window, net_error, Who};
use crate::config::OpenRouterConfig;
use crate::model::{Kind, Meter, Spend, Status, UsageReport, Validity, ValidityKind};
use crate::secrets;
use serde_json::Value;

const API: &str = "https://openrouter.ai/api/v1";

pub async fn fetch(_cfg: &OpenRouterConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("OpenRouter", Kind::Api);
    let Some(key) = who.secret(secrets::OPENROUTER_API_KEY) else {
        return report.fail(
            Status::Unconfigured,
            "Añade tu API key de OpenRouter en Ajustes.",
        );
    };

    let res = match http
        .get(format!("{API}/key"))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => return report.fail(Status::Unconfigured, "API key de OpenRouter rechazada."),
        code => return report.fail(Status::Error, format!("HTTP {code} en /key")),
    }
    let key_info: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };
    // El saldo es opcional: algunas keys no pueden leerlo.
    let credits = match http
        .get(format!("{API}/credits"))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
        _ => None,
    };

    let mut report = report;
    let parsed = parse(&key_info, credits.as_ref());
    report.meters = parsed.meters;
    report.spend = parsed.spend;
    report.plan = parsed.plan;
    report.validity = parsed.validity;
    report.message = parsed.message;
    report
}

pub(crate) struct Parsed {
    pub meters: Vec<Meter>,
    pub spend: Option<Spend>,
    pub plan: Option<String>,
    pub message: Option<String>,
    pub validity: Option<Validity>,
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| {
        x.as_f64()
            .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
    })
}

pub(crate) fn parse(key: &Value, credits: Option<&Value>) -> Parsed {
    let d = key.get("data").unwrap_or(key);
    let mut meters = vec![];

    // Límite de la key (si lo tiene)
    if let Some(limit) = num(d.get("limit")).filter(|l| *l > 0.0) {
        let remaining = num(d.get("limit_remaining"));
        let reset = d.get("limit_reset").and_then(Value::as_str);
        let used = match (remaining, reset) {
            (Some(r), _) => (limit - r).max(0.0),
            (None, Some("daily")) => num(d.get("usage_daily")).unwrap_or(0.0),
            (None, Some("weekly")) => num(d.get("usage_weekly")).unwrap_or(0.0),
            (None, Some("monthly")) => num(d.get("usage_monthly")).unwrap_or(0.0),
            _ => num(d.get("usage")).unwrap_or(0.0),
        };
        let (id, label, window) = match reset {
            Some("daily") => ("key_limit_daily", "Límite diario de la key", Some(86_400)),
            Some("weekly") => (
                "key_limit_weekly",
                "Límite semanal de la key",
                Some(7 * 86_400),
            ),
            Some("monthly") => ("key_limit_monthly", "Límite mensual de la key", None),
            _ => ("key_limit", "Límite de la key", None),
        };
        let (resets_at, window_seconds) = match reset {
            Some("monthly") => {
                let (r, w) = month_window(chrono::Utc::now());
                (Some(r), Some(w))
            }
            Some("daily") => (Some(next_utc_midnight()), window),
            Some("weekly") => (Some(next_utc_monday()), window),
            _ => (None, None),
        };
        meters.push(Meter {
            id: id.into(),
            label: label.into(),
            percent: Some(used / limit * 100.0),
            used: Some(used),
            limit: Some(limit),
            unit: Some("USD".into()),
            resets_at,
            window_seconds,
        });
    }

    // Saldo de la cuenta
    let cd = credits.map(|c| c.get("data").unwrap_or(c));
    if let (Some(total), Some(spent)) = (
        num(cd.and_then(|c| c.get("total_credits"))),
        num(cd.and_then(|c| c.get("total_usage"))),
    ) {
        if total > 0.0 {
            meters.push(Meter {
                id: "balance_spent".into(),
                label: "Saldo gastado".into(),
                percent: Some(spent / total * 100.0),
                used: Some(spent),
                limit: Some(total),
                unit: Some("USD".into()),
                resets_at: None,
                window_seconds: None,
            });
        }
    }

    let monthly = num(d.get("usage_monthly"));
    let spend = monthly.map(|amount| Spend {
        amount,
        currency: "USD".into(),
        period_label: "Este mes".into(),
        budget: None,
    });
    let daily = num(d.get("usage_daily"));
    let message = match (
        daily,
        cd.and_then(|c| num(c.get("total_credits")))
            .zip(cd.and_then(|c| num(c.get("total_usage")))),
    ) {
        (Some(day), Some((t, u))) => {
            Some(format!("Hoy {day:.2} $ · saldo {:.2} $", (t - u).max(0.0)))
        }
        (Some(day), None) => Some(format!("Hoy {day:.2} $")),
        (None, Some((t, u))) => Some(format!("Saldo {:.2} $", (t - u).max(0.0))),
        _ => None,
    };
    let plan = match d.get("is_free_tier").and_then(Value::as_bool) {
        Some(true) => Some("Free".into()),
        Some(false) => Some("Créditos".into()),
        None => None,
    };
    let validity = d
        .get("expires_at")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| Validity {
            at: at.to_rfc3339(),
            kind: ValidityKind::Key,
        });
    Parsed {
        meters,
        spend,
        plan,
        message,
        validity,
    }
}

fn next_utc_midnight() -> String {
    let now = chrono::Utc::now();
    (now.date_naive() + chrono::Days::new(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .to_rfc3339()
}

fn next_utc_monday() -> String {
    use chrono::Datelike;
    let now = chrono::Utc::now();
    let days = 7 - now.weekday().num_days_from_monday() as u64;
    (now.date_naive() + chrono::Days::new(days))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_key_with_monthly_limit_and_credits() {
        let key = json!({"data": {"label": "egdev", "usage": 52.3, "limit": 100, "limit_remaining": 70, "limit_reset": "monthly",
            "usage_daily": 1.25, "usage_weekly": 8.0, "usage_monthly": 30.0, "is_free_tier": false}});
        let credits = json!({"data": {"total_credits": 200, "total_usage": 52.3}});
        let p = parse(&key, Some(&credits));
        assert_eq!(p.meters.len(), 2);
        assert_eq!(p.meters[0].percent, Some(30.0));
        assert_eq!(p.meters[0].label, "Límite mensual de la key");
        assert_eq!(
            p.meters.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["key_limit_monthly", "balance_spent"]
        );
        assert!(p.meters[0].resets_at.is_some());
        assert!((p.meters[1].percent.unwrap() - 26.15).abs() < 0.01);
        assert_eq!(p.spend.as_ref().map(|s| s.amount), Some(30.0));
        assert_eq!(p.message.as_deref(), Some("Hoy 1.25 $ · saldo 147.70 $"));
        assert_eq!(p.plan.as_deref(), Some("Créditos"));
    }

    #[test]
    fn reads_only_explicit_valid_key_expiration() {
        let p = parse(
            &json!({"data": {"expires_at": "2030-02-01T00:00:00Z"}}),
            None,
        );
        let validity = p.validity.unwrap();
        assert_eq!(validity.kind, crate::model::ValidityKind::Key);
        assert_eq!(validity.at, "2030-02-01T00:00:00+00:00");
        for value in [
            json!(null),
            json!("not a date"),
            json!(123),
            json!("2030-02-30T00:00:00Z"),
        ] {
            assert!(parse(&json!({"data": {"expires_at": value}}), None)
                .validity
                .is_none());
        }
        assert!(parse(&json!({"data": {"limit_reset": "monthly"}}), None)
            .validity
            .is_none());
    }

    #[test]
    fn key_limit_ids_follow_the_reset_period() {
        for (reset, id) in [
            (json!("daily"), "key_limit_daily"),
            (json!("weekly"), "key_limit_weekly"),
            (json!("monthly"), "key_limit_monthly"),
            (json!(null), "key_limit"),
        ] {
            let p = parse(
                &json!({"data": {"usage": 5.0, "limit": 10, "limit_reset": reset}}),
                None,
            );
            assert_eq!(p.meters[0].id, id);
        }
    }

    #[test]
    fn key_without_limit_has_no_limit_meter() {
        let p = parse(
            &json!({"data": {"usage": 3.0, "limit": null, "usage_monthly": 3.0}}),
            None,
        );
        assert!(p.meters.is_empty());
        assert_eq!(p.spend.map(|s| s.amount), Some(3.0));
    }
}
