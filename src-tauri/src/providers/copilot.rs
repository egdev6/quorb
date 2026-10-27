//! GitHub Copilot — peticiones premium del mes con la API oficial de facturación.
//!   `GET https://api.github.com/users/{usuario}/settings/billing/premium_request/usage?year=&month=`
//! Requiere un token *fine-grained* con el permiso de usuario «Plan» (lectura).
//! La API devuelve lo consumido; la cuota incluida depende del plan (Ajustes).
//! Docs: https://docs.github.com/en/rest/billing/usage

use super::{month_window, net_error, Who};
use crate::config::CopilotConfig;
use crate::model::{Kind, Meter, Spend, Status, UsageReport};
use crate::secrets;
use chrono::Datelike;
use serde_json::Value;

/// Peticiones premium incluidas al mes por plan (por usuario).
pub(crate) fn plan_allowance(plan: &str) -> (Option<f64>, &'static str) {
    match plan {
        "free" => (Some(50.0), "Free"),
        "pro" => (Some(300.0), "Pro"),
        "pro_plus" => (Some(1500.0), "Pro+"),
        "business" => (Some(300.0), "Business"),
        "enterprise" => (Some(1000.0), "Enterprise"),
        _ => (None, "Personalizado"),
    }
}

/// Medidor de peticiones premium del mes: uso sobre la cuota incluida del plan.
/// Extraído de `fetch` para poder testearlo sin red (seguimiento 2 de #66).
fn premium_meter(usage: f64, allowance: Option<f64>, reset: String, window: i64) -> Meter {
    Meter {
        id: "premium_requests".into(),
        label: "Peticiones premium".into(),
        percent: allowance.map(|a| usage / a * 100.0),
        used: Some(usage),
        limit: allowance,
        unit: Some("peticiones".into()),
        resets_at: Some(reset),
        window_seconds: Some(window),
    }
}

pub async fn fetch(cfg: &CopilotConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let mut report = who.report("GitHub Copilot", Kind::Subscription);
    let (default_allowance, plan_label) = plan_allowance(&cfg.plan);
    report.plan = Some(plan_label.into());
    let Some(token) = who.secret(secrets::GITHUB_TOKEN) else {
        return report.fail(
            Status::Unconfigured,
            "Añade un token de GitHub (fine-grained, permiso «Plan»: lectura) en Ajustes.",
        );
    };
    let user = cfg.username.trim();
    if user.is_empty() {
        return report.fail(
            Status::Unconfigured,
            "Indica tu usuario de GitHub en Ajustes.",
        );
    }

    let now = chrono::Utc::now();
    let res = http
        .get(format!(
            "https://api.github.com/users/{user}/settings/billing/premium_request/usage"
        ))
        .query(&[
            ("year", now.year().to_string()),
            ("month", now.month().to_string()),
        ])
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 => return report.fail(Status::Unconfigured, "Token de GitHub rechazado."),
        403 => {
            return report.fail(
                Status::Unconfigured,
                "El token no tiene el permiso «Plan» (lectura).",
            )
        }
        404 => {
            return report.fail(
                Status::Unconfigured,
                "Usuario de GitHub no encontrado o sin acceso a su facturación.",
            )
        }
        code => {
            return report.fail(
                Status::Error,
                format!("HTTP {code} en la API de facturación"),
            )
        }
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };

    let usage = parse(&body);
    let allowance = cfg
        .custom_allowance
        .map(f64::from)
        .filter(|a| *a > 0.0)
        .or(default_allowance);
    let (reset, window) = month_window(now);
    report
        .meters
        .push(premium_meter(usage.requests, allowance, reset, window));
    if usage.extra_amount > 0.0 {
        report.spend = Some(Spend {
            amount: usage.extra_amount,
            currency: "USD".into(),
            period_label: "Extra este mes".into(),
            budget: None,
        });
    }
    if !usage.top_models.is_empty() {
        report.message = Some(format!("Más usados: {}", usage.top_models.join(", ")));
    }
    report
}

#[derive(Debug, PartialEq)]
pub(crate) struct CopilotUsage {
    pub requests: f64,
    pub extra_amount: f64,
    pub top_models: Vec<String>,
}

pub(crate) fn parse(v: &Value) -> CopilotUsage {
    let items: Vec<&Value> = v
        .get("usageItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|i| {
            let p = i
                .get("product")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            p.is_empty() || p.contains("copilot")
        })
        .collect();
    let f = |i: &Value, k: &str| i.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let requests = items.iter().map(|i| f(*i, "grossQuantity")).sum::<f64>();
    let extra_amount = items.iter().map(|i| f(*i, "netAmount")).sum::<f64>();
    let mut by_model: Vec<(String, f64)> = vec![];
    for i in &items {
        let m = i
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if m.is_empty() {
            continue;
        }
        match by_model.iter_mut().find(|(n, _)| *n == m) {
            Some((_, q)) => *q += f(*i, "grossQuantity"),
            None => by_model.push((m, f(*i, "grossQuantity"))),
        }
    }
    by_model.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    CopilotUsage {
        requests,
        extra_amount,
        top_models: by_model
            .into_iter()
            .take(3)
            .map(|(m, q)| format!("{m} ({q:.0})"))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn premium_meter_bundles_id_label_unit_and_values() {
        let m = premium_meter(120.0, Some(300.0), "2026-11-01T00:00:00Z".into(), 2_592_000);
        assert_eq!(m.id, "premium_requests");
        assert_eq!(m.label, "Peticiones premium");
        assert_eq!(m.unit.as_deref(), Some("peticiones"));
        assert_eq!(m.percent, Some(40.0));
        assert_eq!(m.used, Some(120.0));
        assert_eq!(m.limit, Some(300.0));
        assert_eq!(m.resets_at.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert_eq!(m.window_seconds, Some(2_592_000));
        // Sin cuota conocida: hay uso pero ni límite ni porcentaje.
        let m = premium_meter(10.0, None, "r".into(), 1);
        assert_eq!(m.percent, None);
        assert_eq!(m.limit, None);
        assert_eq!(m.used, Some(10.0));
    }

    #[test]
    fn sums_premium_requests() {
        let v = json!({"timePeriod": {"year": 2026, "month": 10}, "user": "egdev6", "usageItems": [
            {"product": "Copilot", "sku": "Copilot Premium Request", "model": "Claude Sonnet 4.6", "unitType": "requests", "grossQuantity": 120, "netQuantity": 0, "netAmount": 0},
            {"product": "Copilot", "sku": "Copilot Premium Request", "model": "GPT-5", "grossQuantity": 200, "discountQuantity": 180, "netQuantity": 20, "netAmount": 0.8},
            {"product": "Actions", "sku": "minutes", "grossQuantity": 999, "netAmount": 5}
        ]});
        let u = parse(&v);
        assert_eq!(u.requests, 320.0);
        assert!((u.extra_amount - 0.8).abs() < 1e-9);
        assert_eq!(
            u.top_models,
            vec![
                "GPT-5 (200)".to_string(),
                "Claude Sonnet 4.6 (120)".to_string()
            ]
        );
    }

    #[test]
    fn allowances() {
        assert_eq!(plan_allowance("pro").0, Some(300.0));
        assert_eq!(plan_allowance("pro_plus").0, Some(1500.0));
        assert_eq!(plan_allowance("x").0, None);
    }
}
