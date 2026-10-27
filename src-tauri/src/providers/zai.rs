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
use chrono::{DateTime, TimeZone, Utc};
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

    let res = match http
        .get(URL)
        .bearer_auth(&key)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => {
            return report.fail(
                Status::Unconfigured,
                "API key de z.ai rechazada (compruébala en z.ai/manage-apikey).",
            )
        }
        429 => {
            return report.fail(
                Status::Warning,
                "El endpoint de uso está limitando peticiones; reintento en el próximo ciclo.",
            )
        }
        code => return report.fail(Status::Error, format!("HTTP {code} en el endpoint de uso")),
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };
    if body.get("success").and_then(Value::as_bool) == Some(false) {
        let msg = body
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("sin detalle");
        return report.fail(
            Status::Warning,
            format!("z.ai respondió sin datos de uso: {msg} (¿API key sin Coding Plan?)"),
        );
    }

    let parsed = parse_quota(&body);
    let mut report = report;
    report.plan = parsed.plan;
    report.meters = parsed.meters;
    if report.meters.is_empty() {
        return report.fail(
            Status::Warning,
            "Respuesta sin datos de uso (¿ha cambiado el formato?)",
        );
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
/// · `TIME_LIMIT` — cuota mensual de web search / reader / Zread: el consumo
///   viene en `currentValue`, el cupo en `usage` y `number` es la ventana
///   (contrato real observado en #94, revisión de #182).
/// Otros tipos se ignoran, y un límite reconocido sin % ni consumo tampoco
///   emite medidor (un cupo solo no dibuja anillo): si el formato cambia o no
///   trae datos de uso, `fetch` reporta Warning por el guard de medidores
///   vacíos (checklist #94-3).
pub(crate) fn parse_quota(v: &Value) -> Parsed {
    let data = v.get("data").unwrap_or(v);
    let plan = data.get("level").and_then(Value::as_str).map(pretty_level);
    let mut meters = vec![];
    for limit in data
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let meter = match limit.get("type").and_then(Value::as_str) {
            Some("TOKENS_LIMIT") => tokens_meter(limit),
            Some("TIME_LIMIT") => web_tools_meter(limit),
            _ => continue,
        };
        // Reconocer el tipo no basta: sin % ni consumo el medidor quedaría
        // vacío (el anillo lee `percent`; un cupo solo no se ve) y
        // `meters.is_empty()` no degradaría a Warning (revisión #182).
        if meter.percent.is_some() || meter.used.is_some() {
            meters.push(meter);
        }
    }
    Parsed { plan, meters }
}

/// Un `TOKENS_LIMIT`: ventana del plan (5 h o semana) o cuota legada en créditos.
fn tokens_meter(limit: &Value) -> Meter {
    let (unit, number) = (
        limit.get("unit").and_then(Value::as_i64),
        limit.get("number").and_then(Value::as_i64),
    );
    match (unit, number) {
        (Some(3), Some(5)) => window_meter(limit, "five_hour", "Cuota · 5 h", H5),
        (Some(6), Some(1)) => window_meter(limit, "weekly", "Cuota · semana", WEEK),
        _ => credits_meter(limit),
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

/// Medidor `TIME_LIMIT` de web tools con el contrato REAL observado (captura
/// de #94, revisión de #182): el consumo viene en `currentValue`, el cupo en
/// `usage` y `number` describe la ventana mensual, no un límite de usos.
fn web_tools_meter(limit: &Value) -> Meter {
    let mut m = base_meter(limit, "web_tools", "Web tools · mes", "usos", None);
    m.used = limit.get("currentValue").and_then(Value::as_f64);
    m.limit = limit.get("usage").and_then(Value::as_f64);
    m
}

/// Medidor legado de `TOKENS_LIMIT` en créditos: forma documentada por tools
/// comunitarias (zaiusage, agent-usage-widget), donde `usage` es el consumo y
/// `number` la cuota.
fn credits_meter(limit: &Value) -> Meter {
    let mut m = base_meter(limit, "five_hour", "Cuota · 5 h", "créditos", Some(H5));
    m.used = limit.get("usage").and_then(Value::as_f64);
    m.limit = limit.get("number").and_then(Value::as_f64);
    m
}

/// Base común de medidor por `limit`: id, label, % y reinicio; las cantidades
/// las fija el contrato particular de cada tipo.
fn base_meter(limit: &Value, id: &str, label: &str, unit: &str, window: Option<i64>) -> Meter {
    Meter {
        id: id.into(),
        label: label.into(),
        percent: limit.get("percentage").and_then(Value::as_f64),
        used: None,
        limit: None,
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

/// Timestamps del endpoint de resets (`"2026-10-25 06:39:58"`): espacio como
/// separador y sin zona — no son RFC3339 y el parser genérico los rechaza.
///
/// Decisión de TZ: se asume la zona del servidor de z.ai, Asia/Shanghai
/// (UTC+8 fijo, sin horario de verano). Evidencia (captura de #94, 24-oct):
/// `lastWeekResetTime: "2026-10-25 06:39:58"` se registró ANTES de la toma de
/// la propia captura (2026-10-24T23:20:45Z); con UTC o Madrid el instante
/// sería posterior a ella (imposible), con UTC+8 es 22:39:58Z (encaja).
pub(crate) fn zai_timestamp(s: &str) -> Option<DateTime<Utc>> {
    let naive = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()?;
    chrono::FixedOffset::east_opt(8 * 3600)?
        .from_local_datetime(&naive)
        .single()
        .map(|t| t.with_timezone(&Utc))
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
/// esperada; `Some(0)` cuando el plan no tiene resets pendientes. Los
/// `last*ResetTime`, si vienen, deben parsear con `zai_timestamp`: un valor
/// ilegible delata un cambio de esquema y degrada el saldo sin tocar medidores.
pub(crate) fn parse_available_resets(v: &Value) -> Option<u32> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let data = v.get("data")?.as_object()?;
    for key in ["lastFiveHourResetTime", "lastWeekResetTime"] {
        if let Some(s) = data.get(key).and_then(Value::as_str) {
            // Timestamp ilegible = esquema cambiado: el saldo degrada a None.
            zai_timestamp(s)?;
        }
    }
    let groups = ["fiveHourResets", "weekResets"].map(|k| data.get(k).and_then(Value::as_array));
    if groups.iter().all(Option::is_none) {
        return None;
    }
    let count: usize = groups
        .into_iter()
        .flatten()
        .map(|rows| {
            rows.iter()
                .filter(|r| r.get("available").and_then(Value::as_bool) == Some(true))
                .count()
        })
        .sum();
    u32::try_from(count).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Meter;
    use serde_json::json;

    /// Fixture mixto: TOKENS_LIMIT en la forma de créditos documentada por
    /// tools comunitarias (zaiusage, agent-usage-widget) y TIME_LIMIT con la
    /// captura REAL de #94 (2026-10-13): `currentValue` = consumo, `usage` =
    /// cupo, `number` = ventana.
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
                        "unit": 5,
                        "number": 1,
                        "usage": 4000,
                        "currentValue": 0,
                        "remaining": 4000,
                        "percentage": 0,
                        "nextResetTime": 1_762_000_000_000_i64,
                        "usageDetails": [
                            { "modelCode": "search-prime", "usage": 0 },
                            { "modelCode": "web-reader", "usage": 0 },
                            { "modelCode": "zread", "usage": 0 }
                        ]
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
        assert_eq!(
            m[0].id, "five_hour",
            "el fallback legado de créditos comparte id con la ventana de 5 h"
        );
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
                    {"type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 4000, "currentValue": 0, "percentage": 0, "nextResetTime": 1_762_000_000_000_i64}
                ]
            }
        });
        let p = parse_quota(&v);
        assert_eq!(p.meters.len(), 3, "5 h, semana y web tools");
        assert_eq!(p.meters[0].id, "five_hour");
        assert_eq!(p.meters[0].label, "Cuota · 5 h");
        assert_eq!(p.meters[0].window_seconds, Some(5 * 3600));
        assert_eq!(p.meters[0].percent, Some(61.0));
        assert_eq!(
            p.meters[0].used, None,
            "`usage` no es créditos en las ventanas"
        );
        assert_eq!(
            p.meters[0].limit, None,
            "`number` es el tamaño de ventana, no la cuota"
        );
        assert_eq!(
            p.meters[0].resets_at,
            super::super::unix_to_rfc3339(1_760_000_000)
        );
        assert_eq!(p.meters[1].id, "weekly");
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
        // Contrato REAL del TIME_LIMIT (captura de #94, revisión de #182): el
        // consumo viene en `currentValue`, el cupo en `usage` y `number` es el
        // tamaño de la ventana (unit 5, number 1 = mensual), no un límite de usos.
        let p = parse_quota(&fixture());
        let m = &p.meters[1];
        assert_eq!(m.id, "web_tools");
        assert_eq!(m.label, "Web tools · mes");
        assert_eq!(m.percent, Some(0.0));
        assert_eq!(m.used, Some(0.0), "el consumo real es `currentValue`");
        assert_eq!(m.limit, Some(4000.0), "el cupo real es `usage`");
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
        assert_eq!(p.meters[0].id, "five_hour");
        assert_eq!(p.meters[0].label, "Cuota · 5 h");
    }

    #[test]
    fn empty_or_malformed_body_gives_no_meters() {
        assert!(parse_quota(&json!({})).meters.is_empty());
        assert!(parse_quota(&json!({"data": {"limits": []}}))
            .meters
            .is_empty());
        assert!(parse_quota(&json!({"data": {"limits": null}}))
            .meters
            .is_empty());
        // `success: false` (p. ej. key sin devpack) tampoco aporta medidores.
        assert!(
            parse_quota(&json!({"success": false, "msg": "no subscription"}))
                .meters
                .is_empty()
        );
    }

    #[test]
    fn limit_without_consumption_data_emits_no_meter() {
        // El anillo y las alertas leen solo `percent` (format.ts, alerts.ts): un
        // cupo sin % ni consumo no dibuja nada, así que tampoco cuenta como dato
        // utilizable y el guard debe degradar a Warning.
        for v in [
            json!({"data": {"limits": [{"type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 4000}]}}),
            json!({"data": {"limits": [{"type": "TOKENS_LIMIT", "unit": 0, "number": 120}]}}),
        ] {
            assert!(
                parse_quota(&v).meters.is_empty(),
                "solo cupo no es uso: {v}"
            );
        }
        // Con consumo pero sin %, el medidor sí se emite (texto "0 usos").
        let p = parse_quota(
            &json!({"data": {"limits": [{"type": "TIME_LIMIT", "usage": 4000, "currentValue": 0}]}}),
        );
        assert_eq!(p.meters.len(), 1);
        assert_eq!(
            (p.meters[0].used, p.meters[0].limit),
            (Some(0.0), Some(4000.0))
        );
    }

    #[test]
    fn bare_limit_types_without_usable_data_emit_no_meter() {
        // Revisión de #182: reconocer el `type` no basta para emitir un medidor;
        // sin % ni cantidades hay que dejar que el guard de `fetch` degrade a
        // Warning en vez de mostrar un anillo vacío (checklist de #94, punto 3).
        for v in [
            json!({"data": {"limits": [{"type": "TOKENS_LIMIT"}]}}),
            json!({"data": {"limits": [{"type": "TIME_LIMIT"}]}}),
            json!({"data": {"limits": [{"type": "TOKENS_LIMIT", "nextResetTime": 1_760_000_000_000_i64}]}}),
            json!({"data": {"limits": [{"type": "TIME_LIMIT", "nextResetTime": 1_760_000_000_000_i64}]}}),
        ] {
            assert!(
                parse_quota(&v).meters.is_empty(),
                "sin datos de uso no hay medidor: {v}"
            );
        }
        // Con un % presente el medidor sí se emite y los campos ausentes quedan
        // en None sin pánico (cobertura del test que reemplaza este caso).
        let p =
            parse_quota(&json!({"data": {"limits": [{"type": "TOKENS_LIMIT", "percentage": 55}]}}));
        assert_eq!(p.meters.len(), 1);
        assert_eq!(p.meters[0].percent, Some(55.0));
        assert!(
            p.meters[0].used.is_none()
                && p.meters[0].limit.is_none()
                && p.meters[0].resets_at.is_none()
        );
    }

    #[test]
    fn malformed_data_shapes_degrade_without_panicking() {
        for v in [
            json!({"success": true, "data": null}),
            json!({"data": "pro"}),
            json!({"data": 42}),
            json!({"data": {"limits": {"a": 1}}}),
        ] {
            let p = parse_quota(&v);
            assert!(p.meters.is_empty() && p.plan.is_none());
        }
    }

    #[test]
    fn limits_entries_with_wrong_field_types_are_skipped_fields() {
        let p = parse_quota(
            &json!({"data": {"limits": ["x", 7, null, {"type": "TOKENS_LIMIT", "percentage": "80", "usage": 12}]}}),
        );
        assert_eq!(p.meters.len(), 1);
        assert_eq!(p.meters[0].percent, None);
        assert_eq!(p.meters[0].used, Some(12.0));
    }

    #[test]
    fn next_reset_time_boundaries_yield_none() {
        let p = parse_quota(&json!({"data": {"limits": [
            {"type": "TOKENS_LIMIT", "percentage": 10, "nextResetTime": -5},
            {"type": "TIME_LIMIT", "percentage": 20, "nextResetTime": 0},
            {"type": "TOKENS_LIMIT", "percentage": 30, "nextResetTime": 1.76e12},
        ]}}));
        assert_eq!(p.meters.len(), 3);
        assert!(p.meters.iter().all(|m| m.resets_at.is_none()));
    }

    #[test]
    fn non_string_level_is_none_but_plain_shape_parses() {
        assert_eq!(parse_quota(&json!({"data": {"level": 3}})).plan, None);
        let p = parse_quota(
            &json!({"level": "max", "limits": [{"type": "TOKENS_LIMIT", "number": 10, "usage": 1, "percentage": 10, "nextResetTime": 1760000000000i64}]}),
        );
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
        assert_eq!(
            parse_available_resets(&v),
            Some(3),
            "suma 5 h + semana e ignora vencidos"
        );
    }

    #[test]
    fn all_expired_resets_is_a_valid_zero_balance() {
        let mut v = resets_fixture();
        v["data"]["weekResets"] = json!([
            {"recordId": 10, "available": false},
            {"recordId": 11, "available": false}
        ]);
        assert_eq!(
            parse_available_resets(&v),
            Some(0),
            "agotado es un saldo válido, no desconocido"
        );
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

    #[test]
    fn zai_timestamps_assume_shanghai_fixed_offset() {
        assert_eq!(
            zai_timestamp("2026-10-25 06:39:58").map(|t| t.to_rfc3339()),
            Some("2026-10-24T22:39:58+00:00".into()),
            "la captura real de #94 solo precede a su propia toma con UTC+8"
        );
        assert_eq!(
            zai_timestamp("2026-12-22 23:59:59").map(|t| t.to_rfc3339()),
            Some("2026-12-22T15:59:59+00:00".into())
        );
        for bad in [
            "",
            "x",
            "2026-10-25",
            "2026-10-25T06:39:58Z",
            "2026-10-25 06:39",
            "2026-13-45 99:99:99",
        ] {
            assert!(zai_timestamp(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn resets_with_unparseable_last_reset_time_degrade_to_none() {
        let mut v = resets_fixture();
        v["data"]["lastWeekResetTime"] = json!("hace un rato");
        assert_eq!(
            parse_available_resets(&v),
            None,
            "esquema cambiado: saldo desconocido"
        );
        // null/ausente se tolera: el saldo sigue contando.
        v["data"]["lastWeekResetTime"] = Value::Null;
        assert_eq!(parse_available_resets(&v), Some(2));
    }

    #[test]
    fn http_404_body_degrades_to_warning_without_inventing_rings() {
        // El 404 de /api/monitor/usage (reportado en #94) responde un sobre de
        // error: sin medidores, `fetch` degrada a Warning, nunca a un anillo.
        let v = json!({"code": 404, "msg": "Not Found", "success": false, "data": null});
        let p = parse_quota(&v);
        assert!(p.meters.is_empty() && p.plan.is_none());
    }

    #[test]
    fn credit_limit_and_zero_percent_variants_do_not_invent_rings() {
        // egdev6: no descartar otras variantes (CREDIT_LIMIT, 0 %): solo se
        // muestran los tipos conocidos presentes en la respuesta.
        let v = json!({"data": {"level": "max", "limits": [
            {"type": "CREDIT_LIMIT", "number": 100, "usage": 100, "percentage": 0, "nextResetTime": 1_760_000_000_000_i64},
            {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 61, "nextResetTime": 1_760_000_000_000_i64}
        ]}});
        let p = parse_quota(&v);
        assert_eq!(p.meters.len(), 1, "CREDIT_LIMIT no genera medidor");
        assert_eq!(p.meters[0].id, "five_hour");
    }

    #[test]
    fn each_known_limit_type_stands_alone() {
        // «Caso sin alguno de los tipos»: cada tipo conocido basta para su
        // medidor; no se exige el conjunto completo.
        let only_tokens = json!({"data": {"limits": [{"type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 42}]}});
        let only_time = json!({"data": {"limits": [{"type": "TIME_LIMIT", "percentage": 10}]}});
        assert_eq!(parse_quota(&only_tokens).meters[0].id, "weekly");
        assert_eq!(parse_quota(&only_time).meters[0].id, "web_tools");
    }
}
