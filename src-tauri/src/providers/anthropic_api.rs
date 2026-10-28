//! Anthropic API (pago por uso) — gasto del mes con la Cost API oficial.
//! Requiere una Admin API key (`sk-ant-admin...`), creada en Console > Settings > Admin keys.
//! Docs: https://platform.claude.com/docs/en/manage-claude/usage-cost-api

use super::{month_start, month_window, net_error, Who};
use crate::config::ApiCostConfig;
use crate::model::{Kind, Meter, Spend, Status, UsageReport};
use crate::secrets;
use serde_json::Value;

const URL: &str = "https://api.anthropic.com/v1/organizations/cost_report";

/// Medidor de presupuesto mensual: % del gasto sobre el tope configurado.
/// El importe ya se muestra en `spend`; el medidor aporta la serie del historial.
/// Extraído de `fetch` para poder testearlo sin red (seguimiento 2 de #66).
fn budget_meter(amount: f64, budget: f64, unit: String, reset: String, window: i64) -> Meter {
    Meter {
        id: "budget_monthly".into(),
        label: "Presupuesto mensual".into(),
        percent: Some(amount / budget * 100.0),
        // el importe ya se muestra en `spend`
        used: None,
        limit: None,
        unit: Some(unit),
        resets_at: Some(reset),
        window_seconds: Some(window),
    }
}

pub async fn fetch(cfg: &ApiCostConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("Anthropic API", Kind::Api);
    let Some(key) = who.secret(secrets::ANTHROPIC_ADMIN_KEY) else {
        return report.fail(
            Status::Unconfigured,
            "Añade una Admin API key de Anthropic en Ajustes.",
        );
    };

    let now = chrono::Utc::now();
    let start = month_start(now).format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let end = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let mut total_cents = 0.0;
    let mut page: Option<String> = None;
    for _ in 0..10 {
        let mut q: Vec<(&str, String)> = vec![
            ("starting_at", start.clone()),
            ("ending_at", end.clone()),
            ("bucket_width", "1d".into()),
            ("limit", "31".into()),
        ];
        if let Some(p) = &page {
            q.push(("page", p.clone()));
        }
        let res = http
            .get(URL)
            .query(&q)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
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
                    Status::Unconfigured,
                    "Admin key rechazada (¿es una key normal en vez de admin?)",
                )
            }
            code => return report.fail(Status::Error, format!("HTTP {code} en cost_report")),
        }
        let body: Value = match res.json().await {
            Ok(v) => v,
            Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
        };
        total_cents += sum_cents(&body);
        page = next_page(&body);
        if page.is_none() {
            break;
        }
    }

    let amount = total_cents / 100.0;
    let mut report = report;
    report.spend = Some(Spend {
        amount,
        currency: "USD".into(),
        period_label: "Este mes".into(),
        budget: cfg.monthly_budget_usd,
    });
    if let Some(b) = cfg.monthly_budget_usd.filter(|b| *b > 0.0) {
        let (reset, window) = month_window(chrono::Utc::now());
        report
            .meters
            .push(budget_meter(amount, b, "USD".into(), reset, window));
    }
    report
}

/// Suma `amount` (string decimal en centavos de USD) de todos los buckets.
pub(crate) fn sum_cents(v: &Value) -> f64 {
    v.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|bucket| {
            bucket
                .get("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|r| {
            let a = r.get("amount")?;
            a.as_f64()
                .or_else(|| a.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
        .sum()
}

pub(crate) fn next_page(v: &Value) -> Option<String> {
    if v.get("has_more").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    v.get("next_page")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn budget_meter_bundles_id_label_unit_and_values() {
        let m = budget_meter(
            12.5,
            50.0,
            "USD".into(),
            "2026-11-01T00:00:00Z".into(),
            2_592_000,
        );
        assert_eq!(m.id, "budget_monthly");
        assert_eq!(m.label, "Presupuesto mensual");
        assert_eq!(m.unit.as_deref(), Some("USD"));
        assert_eq!(m.percent, Some(25.0));
        // El importe ya se muestra en `spend`: el medidor no lo duplica.
        assert_eq!(m.used, None);
        assert_eq!(m.limit, None);
        assert_eq!(m.resets_at.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert_eq!(m.window_seconds, Some(2_592_000));
    }

    #[test]
    fn sums_amounts_in_cents() {
        let v = json!({
            "data": [
                {"starting_at": "2026-10-01T00:00:00Z", "results": [{"currency": "USD", "amount": "123.5"}, {"currency": "USD", "amount": "76.5"}]},
                {"starting_at": "2026-10-02T00:00:00Z", "results": []}
            ],
            "has_more": true,
            "next_page": "abc"
        });
        assert_eq!(sum_cents(&v), 200.0);
        assert_eq!(next_page(&v).as_deref(), Some("abc"));
        assert_eq!(
            next_page(&json!({"has_more": false, "next_page": "x"})),
            None
        );
    }
}
