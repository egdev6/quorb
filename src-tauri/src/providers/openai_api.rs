//! OpenAI API (pago por uso) — gasto del mes con la Costs API oficial.
//! Requiere una Admin key (platform.openai.com > Settings > Organization > Admin keys).

use super::{month_start, month_window, net_error, Who};
use crate::config::ApiCostConfig;
use crate::model::{Kind, Meter, Spend, Status, UsageReport};
use crate::secrets;
use serde_json::Value;

const URL: &str = "https://api.openai.com/v1/organization/costs";

/// Medidor de presupuesto mensual: % del gasto sobre el tope configurado.
/// El importe ya se muestra en `spend`; el medidor aporta la serie del historial.
/// Extraído de `fetch` para poder testearlo sin red (seguimiento 2 de #66).
fn budget_meter(total: f64, budget: f64, currency: String, reset: String, window: i64) -> Meter {
    Meter {
        id: "budget_monthly".into(),
        label: "Presupuesto mensual".into(),
        percent: Some(total / budget * 100.0),
        // el importe ya se muestra en `spend`
        used: None,
        limit: None,
        unit: Some(currency),
        resets_at: Some(reset),
        window_seconds: Some(window),
    }
}

pub async fn fetch(cfg: &ApiCostConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("OpenAI API", Kind::Api);
    let Some(key) = who.secret(secrets::OPENAI_ADMIN_KEY) else {
        return report.fail(
            Status::Unconfigured,
            "Añade una Admin key de OpenAI en Ajustes.",
        );
    };

    let start = month_start(chrono::Utc::now()).timestamp().to_string();
    let mut total = 0.0;
    let mut currency = "USD".to_string();
    let mut page: Option<String> = None;
    for _ in 0..10 {
        let mut q: Vec<(&str, String)> = vec![
            ("start_time", start.clone()),
            ("bucket_width", "1d".into()),
            ("limit", "31".into()),
        ];
        if let Some(p) = &page {
            q.push(("page", p.clone()));
        }
        let res = match http.get(URL).query(&q).bearer_auth(&key).send().await {
            Ok(r) => r,
            Err(e) => return report.fail(Status::Error, net_error(e)),
        };
        match res.status().as_u16() {
            200 => {}
            401 | 403 => {
                return report.fail(
                    Status::Unconfigured,
                    "Admin key rechazada (¿es una key de proyecto en vez de admin?)",
                )
            }
            code => {
                return report.fail(Status::Error, format!("HTTP {code} en organization/costs"))
            }
        }
        let body: Value = match res.json().await {
            Ok(v) => v,
            Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
        };
        let (sum, cur) = sum_costs(&body);
        total += sum;
        if let Some(c) = cur {
            currency = c;
        }
        page = body
            .get("has_more")
            .and_then(Value::as_bool)
            .filter(|m| *m)
            .and_then(|_| {
                body.get("next_page")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        if page.is_none() {
            break;
        }
    }

    let mut report = report;
    report.spend = Some(Spend {
        amount: total,
        currency: currency.clone(),
        period_label: "Este mes".into(),
        budget: cfg.monthly_budget_usd,
    });
    if let Some(b) = cfg.monthly_budget_usd.filter(|b| *b > 0.0) {
        let (reset, window) = month_window(chrono::Utc::now());
        report
            .meters
            .push(budget_meter(total, b, currency, reset, window));
    }
    report
}

/// Suma `results[].amount.value` (en dólares) de todos los buckets.
pub(crate) fn sum_costs(v: &Value) -> (f64, Option<String>) {
    let mut currency = None;
    let total = v
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|b| {
            b.get("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|r| {
            let amount = r.get("amount")?;
            if currency.is_none() {
                currency = amount
                    .get("currency")
                    .and_then(Value::as_str)
                    .map(|c| c.to_uppercase());
            }
            amount.get("value").and_then(Value::as_f64)
        })
        .sum::<f64>();
    (total, currency)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn budget_meter_bundles_id_label_unit_and_values() {
        let m = budget_meter(
            30.0,
            120.0,
            "EUR".into(),
            "2026-11-01T00:00:00Z".into(),
            2_592_000,
        );
        assert_eq!(m.id, "budget_monthly");
        assert_eq!(m.label, "Presupuesto mensual");
        assert_eq!(m.unit.as_deref(), Some("EUR"));
        assert_eq!(m.percent, Some(25.0));
        // El importe ya se muestra en `spend`: el medidor no lo duplica.
        assert_eq!(m.used, None);
        assert_eq!(m.limit, None);
        assert_eq!(m.resets_at.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert_eq!(m.window_seconds, Some(2_592_000));
    }

    #[test]
    fn sums_costs() {
        let v = json!({
            "object": "page",
            "data": [
                {"object": "bucket", "start_time": 1, "results": [{"object": "organization.costs.result", "amount": {"value": 0.25, "currency": "usd"}}]},
                {"object": "bucket", "start_time": 2, "results": [{"amount": {"value": 1.5, "currency": "usd"}}]}
            ],
            "has_more": false
        });
        assert_eq!(sum_costs(&v), (1.75, Some("USD".into())));
    }
}
