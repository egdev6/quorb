//! z.ai — GLM Coding Plan: cuota de 5 h, cuota semanal, mensual de web tools
//! y saldo de resets manuales del plan.
//!
//! No hay API pública documentada para el uso del plan; se consultan los
//! mismos endpoints que usa el dashboard (`api.z.ai/api/monitor/usage/quota/limit`
//! para las cuotas y `api.z.ai/api/biz/customer-package-reset/list` para el
//! saldo de resets) con la API key de z.ai/manage-apikey. Es NO OFICIAL: puede
//! cambiar o romperse (mismo criterio que cursor.rs): degradar a
//! `fail(Status::Error)` sin romper la app. El endpoint `/use` que consume un
//! reset existe, pero Quorb es monitoreo read-only y nunca lo llama.

use super::{net_error, Who};
use crate::config::ZaiConfig;
use crate::model::{Kind, Meter, Status, UsageReport};
use crate::secrets;
use serde_json::Value;

const URL: &str = "https://api.z.ai/api/monitor/usage/quota/limit";
const RESETS_URL: &str = "https://api.z.ai/api/biz/customer-package-reset/list";
const H5: i64 = 5 * 3600;
const WEEK: i64 = 7 * 24 * 3600;

pub async fn fetch(_cfg: &ZaiConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("z.ai", Kind::Subscription);
    let Some(key) = who.secret(secrets::ZAI_API_KEY) else {
        return report.fail(Status::Unconfigured, "Añade tu API key de z.ai en Ajustes.");
    };

    let res = match http.get(URL).bearer_auth(&key).header("Accept", "application/json").send().await {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => return report.fail(Status::Unconfigured, "API key de z.ai rechazada (compruébala en z.ai/manage-apikey)."),
        429 => return report.fail(Status::Warning, "El endpoint de uso está limitando peticiones; reintento en el próximo ciclo."),
        code => return report.fail(Status::Error, format!("HTTP {code} en el endpoint de uso")),
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };
    if body.get("success").and_then(Value::as_bool) == Some(false) {
        let msg = body.get("msg").and_then(Value::as_str).unwrap_or("sin detalle");
        return report.fail(Status::Warning, format!("z.ai respondió sin datos de uso: {msg} (¿API key sin Coding Plan?)"));
    }

    let parsed = parse_quota(&body);
    let mut report = report;
    report.plan = parsed.plan;
    report.meters = parsed.meters;
    if report.meters.is_empty() {
        return report.fail(Status::Warning, "Respuesta sin datos de uso (¿ha cambiado el formato?)");
    }
    // El saldo de resets es un dato adicional: si su endpoint falla o cambia,
    // el reporte de cuotas sigue en pie sin saldo (nunca lo degrada). Va
    // después del chequeo porque `fail` limpia los metadatos de saldo.
    report.available_resets = fetch_available_resets(http, &key).await;
    report
}

/// Saldo de resets (5 h + semana) del plan personal, del endpoint que usa la
/// página de usage del dashboard. Es un extra: cualquier fallo (red, error de
/// negocio con HTTP 200, formato cambiado) devuelve `None` sin tumbar el
/// reporte de cuotas. Solo consultas GET; el `/use` no se toca.
async fn fetch_available_resets(http: &reqwest::Client, key: &str) -> Option<u32> {
    let res = http
        .get(RESETS_URL)
        .query(&[("targetType", "PERSONAL")])
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if res.status().as_u16() != 200 {
        return None;
    }
    let body: Value = res.json().await.ok()?;
    parse_available_resets(&body)
}

/// Resultado del parseo de la response del endpoint de cuotas.
pub(crate) struct Parsed {
    /// Nivel del plan (lite/pro/max…), si viene.
    pub plan: Option<String>,
    pub meters: Vec<crate::model::Meter>,
}

/// Extrae `data.level` y `data.limits[]` como medidores.
///
/// · `TOKENS_LIMIT` — cuota de coding. Puede venir dos veces: ventana de 5 h
///   (`unit` 3, `number` 5) y ventana semanal (`unit` 6, `number` 1); en ambas
///   `number` es el TAMAÑO de la ventana, no una cuota, así que se muestra solo
///   el % y el reinicio (mismo criterio que opencode-glm-quota). Las formas
///   antiguas (`number` = cuota en créditos) conservan su display.
/// · `TIME_LIMIT` — cuota mensual de web search / reader / Zread (usos).
/// Otros tipos se ignoran: si el formato cambia, `fetch` reporta Warning.
pub(crate) fn parse_quota(v: &Value) -> Parsed {
    let data = v.get("data").unwrap_or(v);
    let plan = data.get("level").and_then(Value::as_str).map(pretty_level);
    let mut meters = vec![];
    for limit in data.get("limits").and_then(Value::as_array).into_iter().flatten() {
        match limit.get("type").and_then(Value::as_str) {
            Some("TOKENS_LIMIT") => meters.push(tokens_meter(limit)),
            Some("TIME_LIMIT") => meters.push(meter(limit, "web_tools", "Web tools · mes", "usos", None)),
            _ => {}
        }
    }
    Parsed { plan, meters }
}

/// Un `TOKENS_LIMIT`: ventana del plan (5 h o semana) o cuota legada en créditos.
fn tokens_meter(limit: &Value) -> Meter {
    let (unit, number) = (limit.get("unit").and_then(Value::as_i64), limit.get("number").and_then(Value::as_i64));
    match (unit, number) {
        (Some(3), Some(5)) => window_meter(limit, "coding_5h", "Cuota · 5 h", H5),
        (Some(6), Some(1)) => window_meter(limit, "coding_week", "Cuota · semana", WEEK),
        _ => meter(limit, "coding_5h", "Cuota · 5 h", "créditos", Some(H5)),
    }
}

/// Ventana del plan: `number`/`usage` no son cuotas aquí; % y reinicio bastan.
fn window_meter(limit: &Value, id: &str, label: &str, window: i64) -> Meter {
    Meter {
        id: id.into(),
        label: label.into(),
        percent: limit.get("percentage").and_then(Value::as_f64),
        used: None,
        limit: None,
        unit: None,
        resets_at: next_reset(limit),
        window_seconds: Some(window),
    }
}

/// Un `limit` del endpoint como medidor; los campos opcionales ausentes quedan en `None`.
fn meter(limit: &Value, id: &str, label: &str, unit: &str, window: Option<i64>) -> Meter {
    Meter {
        id: id.into(),
        label: label.into(),
        percent: limit.get("percentage").and_then(Value::as_f64),
        used: limit.get("usage").and_then(Value::as_f64),
        limit: limit.get("number").and_then(Value::as_f64),
        unit: Some(unit.into()),
        resets_at: next_reset(limit),
        window_seconds: window,
    }
}

/// `nextResetTime` (ms) como RFC 3339; 0 o negativo no es un reinicio válido.
fn next_reset(limit: &Value) -> Option<String> {
    limit
        .get("nextResetTime")
        .and_then(Value::as_i64)
        .filter(|ms| *ms > 0)
        .map(|ms| ms / 1000)
        .and_then(super::unix_to_rfc3339)
}

fn pretty_level(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Saldo de resets del endpoint `customer-package-reset/list`: cuenta los
/// `available: true` de `fiveHourResets` + `weekResets` (la API no trae el
/// conteo hecho; el dashboard de z.ai lo computa igual). `None` si la respuesta
/// es un error de negocio (HTTP 200 + `success: false`) o no tiene la forma
/// esperada; `Some(0)` cuando el plan no tiene resets pendientes.
pub(crate) fn parse_available_resets(v: &Value) -> Option<u32> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let data = v.get("data")?.as_object()?;
    let groups = ["fiveHourResets", "weekResets"].map(|k| data.get(k).and_then(Value::as_array));
    if groups.iter().all(Option::is_none) {
        return None;
    }
    let count: usize = groups
        .into_iter()
        .flatten()
        .map(|rows| rows.iter().filter(|r| r.get("available").and_then(Value::as_bool) == Some(true)).count())
        .sum();
    u32::try_from(count).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Meter;
    use serde_json::json;

    /// Fixture con la forma documentada por tools comunitarias
    /// (zaiusage, agent-usage-widget) para este endpoint.
    fn fixture() -> Value {
        json!({
            "msg": "ok",
            "success": true,
            "data": {
                "level": "pro",
                "limits": [
                    {
                        "type": "TOKENS_LIMIT",
                        "unit": 0,
                        "number": 120,
                        "usage": 84,
                        "currentValue": 84,
                        "remaining": 36,
                        "percentage": 70,
                        "nextResetTime": 1_760_000_000_000_i64,
                        "usageDetails": [{ "modelCode": "glm-5.3", "usage": 60 }]
                    },
                    {
                        "type": "TIME_LIMIT",
                        "unit": 1,
                        "number": 300,
                        "usage": 120,
                        "currentValue": 120,
                        "remaining": 180,
                        "percentage": 40,
                        "nextResetTime": 1_762_000_000_000_i64,
                        "usageDetails": []
                    }
                ]
            }
        })
    }

    #[test]
    fn parses_plan_level() {
        let p = parse_quota(&fixture());
        assert_eq!(p.plan.as_deref(), Some("Pro"));
    }

    #[test]
    fn parses_five_hour_meter() {
        let p = parse_quota(&fixture());
        let m: Vec<&Meter> = p.meters.iter().collect();
        assert_eq!(m.len(), 2, "debe traer las dos cuotas conocidas");
        assert_eq!(m[0].id, "coding_5h", "el fallback legado de créditos comparte id con la ventana de 5 h");
        assert_eq!(m[0].label, "Cuota · 5 h");
        assert_eq!(m[0].percent, Some(70.0));
        assert_eq!(m[0].used, Some(84.0));
        assert_eq!(m[0].limit, Some(120.0));
        assert_eq!(m[0].unit.as_deref(), Some("créditos"));
        assert_eq!(m[0].resets_at, super::super::unix_to_rfc3339(1_760_000_000));
        assert_eq!(m[0].window_seconds, Some(5 * 3600));
    }

    #[test]
    fn distinguishes_weekly_window_from_five_hour() {
        // Formato actual del endpoint (documentado por opencode-glm-quota): dos
        // TOKENS_LIMIT, donde `number` es el TAMAÑO de la ventana — (unit 3, number 5)
        // = 5 h y (unit 6, number 1) = semana — no una cuota en créditos.
        let v = json!({
            "data": {
                "level": "pro",
                "limits": [
                    {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "usage": 1234567, "percentage": 61, "nextResetTime": 1_760_000_000_000_i64},
                    {"type": "TOKENS_LIMIT", "unit": 6, "number": 1, "usage": 23456789, "percentage": 42, "nextResetTime": 1_761_000_000_000_i64},
                    {"type": "TIME_LIMIT", "unit": 1, "number": 300, "usage": 120, "percentage": 40, "nextResetTime": 1_762_000_000_000_i64}
                ]
            }
        });
        let p = parse_quota(&v);
        assert_eq!(p.meters.len(), 3, "5 h, semana y web tools");
        assert_eq!(p.meters[0].id, "coding_5h");
        assert_eq!(p.meters[0].label, "Cuota · 5 h");
        assert_eq!(p.meters[0].window_seconds, Some(5 * 3600));
        assert_eq!(p.meters[0].percent, Some(61.0));
        assert_eq!(p.meters[0].used, None, "`usage` no es créditos en las ventanas");
        assert_eq!(p.meters[0].limit, None, "`number` es el tamaño de ventana, no la cuota");
        assert_eq!(p.meters[0].resets_at, super::super::unix_to_rfc3339(1_760_000_000));
        assert_eq!(p.meters[1].id, "coding_week");
        assert_eq!(p.meters[1].label, "Cuota · semana");
        assert_eq!(p.meters[1].window_seconds, Some(7 * 24 * 3600));
        assert_eq!(p.meters[1].percent, Some(42.0));
        assert_eq!(p.meters[1].used, None);
        assert_eq!(p.meters[1].limit, None);
        assert_eq!(p.meters[2].id, "web_tools");
        assert_eq!(p.meters[2].label, "Web tools · mes");
    }

    #[test]
    fn parses_monthly_web_tools_meter() {
        let p = parse_quota(&fixture());
        let m = &p.meters[1];
        assert_eq!(m.id, "web_tools");
        assert_eq!(m.label, "Web tools · mes");
        assert_eq!(m.percent, Some(40.0));
        assert_eq!(m.used, Some(120.0));
        assert_eq!(m.limit, Some(300.0));
        assert_eq!(m.unit.as_deref(), Some("usos"));
        assert_eq!(m.resets_at, super::super::unix_to_rfc3339(1_762_000_000));
    }

    #[test]
    fn ignores_unknown_limit_types_and_keeps_known_ones() {
        let v = json!({
            "data": {
                "level": "lite",
                "limits": [
                    {"type": "SOMETHING_NEW", "number": 10, "usage": 5, "percentage": 50, "nextResetTime": 0},
                    {"type": "TOKENS_LIMIT", "number": 60, "usage": 12, "percentage": 20, "nextResetTime": 1_760_000_000_000_i64}
                ]
            }
        });
        let p = parse_quota(&v);
        assert_eq!(p.meters.len(), 1);
        assert_eq!(p.meters[0].id, "coding_5h");
        assert_eq!(p.meters[0].label, "Cuota · 5 h");
    }

    #[test]
    fn empty_or_malformed_body_gives_no_meters() {
        assert!(parse_quota(&json!({})).meters.is_empty());
        assert!(parse_quota(&json!({"data": {"limits": []}})).meters.is_empty());
        assert!(parse_quota(&json!({"data": {"limits": null}})).meters.is_empty());
        // `success: false` (p. ej. key sin devpack) tampoco aporta medidores.
        assert!(parse_quota(&json!({"success": false, "msg": "no subscription"})).meters.is_empty());
    }

    #[test]
    fn missing_optional_fields_do_not_panic() {
        let v = json!({"data": {"limits": [{"type": "TOKENS_LIMIT"}]}});
        let p = parse_quota(&v);
        assert_eq!(p.meters.len(), 1);
        assert_eq!(p.meters[0].id, "coding_5h");
        assert_eq!(p.meters[0].percent, None);
        assert_eq!(p.meters[0].resets_at, None);
        assert_eq!(p.meters[0].used, None);
        assert_eq!(p.meters[0].limit, None);
    }

    #[test]
    fn malformed_data_shapes_degrade_without_panicking() {
        for v in [json!({"success": true, "data": null}), json!({"data": "pro"}), json!({"data": 42}), json!({"data": {"limits": {"a": 1}}})] {
            let p = parse_quota(&v);
            assert!(p.meters.is_empty() && p.plan.is_none());
        }
    }

    #[test]
    fn limits_entries_with_wrong_field_types_are_skipped_fields() {
        let p = parse_quota(&json!({"data": {"limits": ["x", 7, null, {"type": "TOKENS_LIMIT", "percentage": "80"}]}}));
        assert_eq!(p.meters.len(), 1);
        assert_eq!(p.meters[0].percent, None);
    }

    #[test]
    fn next_reset_time_boundaries_yield_none() {
        let p = parse_quota(&json!({"data": {"limits": [
            {"type": "TOKENS_LIMIT", "nextResetTime": -5},
            {"type": "TIME_LIMIT", "nextResetTime": 0},
            {"type": "TOKENS_LIMIT", "nextResetTime": 1.76e12},
        ]}}));
        assert_eq!(p.meters.len(), 3);
        assert!(p.meters.iter().all(|m| m.resets_at.is_none()));
    }

    #[test]
    fn non_string_level_is_none_but_plain_shape_parses() {
        assert_eq!(parse_quota(&json!({"data": {"level": 3}})).plan, None);
        let p = parse_quota(&json!({"level": "max", "limits": [{"type": "TOKENS_LIMIT", "number": 10, "usage": 1, "percentage": 10, "nextResetTime": 1760000000000i64}]}));
        assert_eq!(p.plan.as_deref(), Some("Max"));
        assert_eq!(p.meters.len(), 1);
    }

    /// Respuesta real del endpoint de resets (captura 2026-10-25): dos resets
    /// semanales disponibles y ninguno de 5 h.
    fn resets_fixture() -> Value {
        json!({
            "code": 200,
            "msg": "Operation successful",
            "success": true,
            "data": {
                "targetType": "PERSONAL",
                "lastFiveHourResetTime": null,
                "lastWeekResetTime": "2026-10-25 06:39:58",
                "fiveHourResets": [],
                "weekResets": [
                    {"recordId": 10, "grantType": "GLOBAL", "expireTime": "2026-12-22 23:59:59", "available": true},
                    {"recordId": 11, "grantType": "GLOBAL", "expireTime": "2026-12-22 23:59:59", "available": true}
                ]
            }
        })
    }

    #[test]
    fn parses_available_resets_across_both_groups() {
        assert_eq!(parse_available_resets(&resets_fixture()), Some(2));
        let mut v = resets_fixture();
        v["data"]["fiveHourResets"] = json!([
            {"recordId": 1, "available": true},
            {"recordId": 2, "available": false}
        ]);
        assert_eq!(parse_available_resets(&v), Some(3), "suma 5 h + semana e ignora vencidos");
    }

    #[test]
    fn all_expired_resets_is_a_valid_zero_balance() {
        let mut v = resets_fixture();
        v["data"]["weekResets"] = json!([
            {"recordId": 10, "available": false},
            {"recordId": 11, "available": false}
        ]);
        assert_eq!(parse_available_resets(&v), Some(0), "agotado es un saldo válido, no desconocido");
    }

    #[test]
    fn resets_without_available_flag_do_not_count() {
        let v = json!({"success": true, "data": {"weekResets": [{"recordId": 3}, null, {"available": null}]}});
        assert_eq!(parse_available_resets(&v), Some(0));
    }

    #[test]
    fn resets_business_errors_and_malformed_shapes_give_none() {
        for v in [
            json!({"code": 400, "msg": "Unsupported reset target type: 1", "data": null, "success": false}),
            json!({"success": true, "data": null}),
            json!({}),
            json!({"data": {"fiveHourResets": 7}}),
            json!({"success": true, "data": {"lastWeekResetTime": "x"}}),
        ] {
            assert_eq!(parse_available_resets(&v), None, "{v}");
        }
    }
}
