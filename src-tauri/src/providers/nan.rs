//! NaN Builders — cluster de modelos abiertos con API compatible OpenAI.
//!
//! Fuentes (docs públicas, oct 2026):
//!   · `GET /v1/usage?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` → tu uso de tokens
//!     por día y por modelo, con totales; paginado con `cursor` / `next_cursor`.
//!   · `GET /v1/models` → modelos disponibles para tu key (y sus límites, si los expone).
//!   · Cuotas por modelo (docs › Models): contador mensual (vuelve a 0 el día 1),
//!     por periodo de facturación (solo `glm5.3`) o sin contador.
//!   · Al agotar una cuota la API responde 402 o 429.
//!
//! La forma exacta de la respuesta de `/v1/usage` no está documentada, así que el
//! parser es tolerante: busca objetos con modelo + tokens (y fecha si la hay).
//! `nan_probe` (comando Tauri) devuelve la respuesta en crudo para ajustarlo.

use super::{month_start, net_error, next_month_start, Who};
use crate::config::NanConfig;
use crate::model::{Kind, Meter, Status, UsageReport};
use crate::secrets;
use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde_json::Value;
use std::collections::BTreeMap;

/// Cuota de un modelo.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Quota {
    pub tokens: f64,
    /// `true` = se reinicia con el periodo de facturación (no el día 1).
    pub billing_period: bool,
}

/// Cuotas publicadas en nan.builders/docs/models. Si `/v1/models` trae otras, mandan esas.
pub(crate) fn known_quotas() -> BTreeMap<&'static str, Quota> {
    let m = |t: f64| Quota {
        tokens: t,
        billing_period: false,
    };
    BTreeMap::from([
        (
            "glm5.3",
            Quota {
                tokens: 3e9,
                billing_period: true,
            },
        ),
        ("deepseek-v4-flash", m(3e9)),
        ("glm5.3-flash", m(2e9)),
        ("qwen3.8-flash", m(5e8)),
        ("mimo-v2.6-flash", m(1e9)),
    ])
}

/// Resumen de `/v1/usage`.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct UsageSummary {
    pub per_model: BTreeMap<String, f64>,
    pub per_day: BTreeMap<String, f64>,
}

impl UsageSummary {
    pub fn total(&self) -> f64 {
        self.per_model.values().sum()
    }
}

pub async fn fetch(cfg: &NanConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let mut report = who.report("NaN Builders", Kind::Subscription);
    report.plan = Some(plan_name(&cfg.plan).into());

    // A. Sesión de NaN Cloud: los mismos datos que el dashboard (preferente).
    let mut note: Option<String> = None;
    if let Some(cookie) = who.secret(secrets::NAN_SESSION) {
        match super::nan_cloud::fetch(http, &cookie).await {
            Ok(u) => {
                report.meters = u.meters;
                report.daily = u.daily;
                let mut parts = vec![];
                if let Some(m) = u.month {
                    parts.push(format!("{} tokens este mes", compact(m)));
                }
                if let Some(d) = u.last24h {
                    parts.push(format!("{} en 24 h", compact(d)));
                }
                if report.meters.is_empty() {
                    parts.push("sin consumo en modelos con cuota".into());
                }
                report.message = Some(parts.join(" · "));
                return report;
            }
            Err(super::nan_cloud::CloudError::Expired) => {
                note = Some(
                    "La sesión de NaN ha caducado: vuelve a conectar tu cuenta en Ajustes.".into(),
                );
            }
            Err(super::nan_cloud::CloudError::Other(e)) => {
                note = Some(format!("NaN Cloud no responde ({e})."));
            }
        }
    }

    // B. API key: /v1/usage + cuotas publicadas.
    let Some(key) = who.secret(secrets::NAN_API_KEY) else {
        let mut r = report.fail(
            if note.is_some() {
                Status::NeedsLogin
            } else {
                Status::Unconfigured
            },
            note.unwrap_or_else(|| {
                "Conecta tu cuenta de NaN (enlace por correo) o añade tu API key en Ajustes.".into()
            }),
        );
        r.action = Some("settings".into());
        return r;
    };

    // 1. Modelos (valida la key y, si los trae, límites por modelo)
    let res = match http
        .get(format!("{}/models", cfg.base_url))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Error, net_error(e)),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => return report.fail(Status::Unconfigured, "API key de NaN rechazada."),
        code => return report.fail(Status::Error, format!("HTTP {code} en /models")),
    }
    let rate_meters = rate_limit_meters(res.headers());
    let models_json = res.json::<Value>().await.unwrap_or(Value::Null);
    let mut quotas: BTreeMap<String, Quota> = known_quotas()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    quotas.extend(quotas_from_models(&models_json));

    // 2. Consumo del periodo (desde el inicio del mes o del periodo de facturación, lo que sea antes)
    let now = Utc::now();
    let period_start = billing_period_start(now, cfg.billing_day);
    let from = month_start(now).min(period_start);
    let usage = fetch_usage(cfg, http, &key, from, now).await;

    match usage {
        Ok(pages) => {
            // Para el mes natural solo contamos días del mes; para glm5.3, desde el inicio del periodo.
            let month = summarize(&pages, Some(month_start(now)));
            let period = summarize(&pages, Some(period_start));
            report.meters = quota_meters(&month, &period, &quotas, now, cfg.billing_day);
            let total = month.total();
            report.message = Some(format!(
                "{} tokens este mes · {}",
                compact(total),
                if report.meters.is_empty() {
                    "sin cuotas con contador"
                } else {
                    "cuotas por modelo"
                }
            ));
        }
        Err(e) => {
            report.status = Status::Warning;
            report.message = Some(format!(
                "No pude leer /v1/usage ({e}). {}",
                plan_quota(&cfg.plan)
            ));
        }
    }

    // 3. Endpoint propio opcional (avanzado) + cabeceras de rate limit
    if let Some(m) = custom_usage(cfg, http, &key).await {
        report.meters.insert(0, m);
    }
    report.meters.extend(rate_meters);
    if let Some(n) = note {
        report.status = Status::Warning;
        report.message = Some(match report.message.take() {
            Some(m) => format!("{n} {m}"),
            None => n,
        });
    }
    report
}

/// Llama a `/v1/usage` siguiendo `next_cursor` (máx. 10 páginas).
async fn fetch_usage(
    cfg: &NanConfig,
    http: &reqwest::Client,
    key: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<Value>, String> {
    let mut pages = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let mut q = vec![
            ("start_date", from.format("%Y-%m-%d").to_string()),
            ("end_date", to.format("%Y-%m-%d").to_string()),
        ];
        if let Some(c) = &cursor {
            q.push(("cursor", c.clone()));
        }
        let res = http
            .get(format!("{}/usage", cfg.base_url))
            .query(&q)
            .bearer_auth(key)
            .send()
            .await
            .map_err(net_error)?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status().as_u16()));
        }
        let body: Value = res
            .json()
            .await
            .map_err(|e| format!("respuesta no JSON: {e}"))?;
        cursor = body
            .get("next_cursor")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_string);
        pages.push(body);
        if cursor.is_none() {
            break;
        }
    }
    Ok(pages)
}

/// Respuestas en crudo de `/v1/models` y `/v1/usage` (para la pantalla de Ajustes).
pub async fn probe(cfg: &NanConfig, http: &reqwest::Client) -> Result<String, String> {
    let key = secrets::get(secrets::NAN_API_KEY).ok_or("Falta la API key de NaN")?;
    let now = Utc::now();
    let mut out = String::new();
    for (name, req) in [
        (
            "GET /v1/models",
            http.get(format!("{}/models", cfg.base_url)),
        ),
        (
            "GET /v1/usage",
            http.get(format!("{}/usage", cfg.base_url)).query(&[
                (
                    "start_date",
                    month_start(now).format("%Y-%m-%d").to_string(),
                ),
                ("end_date", now.format("%Y-%m-%d").to_string()),
            ]),
        ),
    ] {
        let res = req.bearer_auth(&key).send().await.map_err(net_error)?;
        let status = res.status().as_u16();
        let headers: Vec<String> = res
            .headers()
            .iter()
            .filter(|(k, _)| k.as_str().starts_with("x-"))
            .map(|(k, v)| format!("{k}: {}", v.to_str().unwrap_or("")))
            .collect();
        let body = res.text().await.unwrap_or_default();
        let body: String = body.chars().take(20_000).collect();
        out.push_str(&format!(
            "### {name} → {status}\n{}\n{body}\n\n",
            headers.join("\n")
        ));
    }
    Ok(out)
}

// ───────────────────────── parsing ─────────────────────────

const MODEL_KEYS: [&str; 4] = ["model", "model_id", "model_name", "name"];
const DATE_KEYS: [&str; 3] = ["date", "day", "bucket"];

fn tokens_of(o: &serde_json::Map<String, Value>) -> Option<f64> {
    for k in [
        "total_tokens",
        "tokens",
        "total",
        "token_count",
        "usage_tokens",
    ] {
        if let Some(v) = o.get(k).and_then(num) {
            return Some(v);
        }
    }
    let pair = |a: &str, b: &str| Some(o.get(a).and_then(num)? + o.get(b).and_then(num)?);
    pair("prompt_tokens", "completion_tokens").or_else(|| pair("input_tokens", "output_tokens"))
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

fn str_of<'a>(o: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| o.get(*k).and_then(Value::as_str))
}

/// Recorre el JSON y devuelve (modelo?, fecha?, tokens) de cada objeto con tokens.
fn collect(
    v: &Value,
    parent_date: Option<&str>,
    out: &mut Vec<(Option<String>, Option<String>, f64)>,
) {
    match v {
        Value::Array(a) => a.iter().for_each(|x| collect(x, parent_date, out)),
        Value::Object(o) => {
            let date = str_of(o, &DATE_KEYS).or(parent_date);
            let model = str_of(o, &MODEL_KEYS);
            if let Some(t) = tokens_of(o) {
                out.push((
                    model.map(str::to_string),
                    date.map(|d| d.chars().take(10).collect()),
                    t,
                ));
            }
            for (k, child) in o {
                // `{ "by_model": { "glm5.3": { "total_tokens": … } } }`
                if let Value::Object(map) = child {
                    if k.contains("model") {
                        for (name, inner) in map {
                            if let Value::Object(io) = inner {
                                if str_of(io, &MODEL_KEYS).is_none() {
                                    if let Some(t) = tokens_of(io) {
                                        out.push((
                                            Some(name.clone()),
                                            date.map(|d| d.chars().take(10).collect()),
                                            t,
                                        ));
                                        continue;
                                    }
                                }
                            }
                            collect(inner, date, out);
                        }
                        continue;
                    }
                }
                if child.is_array() || child.is_object() {
                    collect(child, date, out);
                }
            }
        }
        _ => {}
    }
}

/// Agrega las páginas de `/v1/usage`, contando solo días `>= since` cuando hay fecha.
pub(crate) fn summarize(pages: &[Value], since: Option<DateTime<Utc>>) -> UsageSummary {
    let mut rows = vec![];
    for p in pages {
        collect(p, None, &mut rows);
    }
    let since_day = since.map(|d| d.format("%Y-%m-%d").to_string());
    let in_range = |d: &Option<String>| match (d, &since_day) {
        (Some(d), Some(s)) => d.as_str() >= s.as_str(),
        _ => true,
    };

    let mut s = UsageSummary::default();
    // Totales por modelo sin fecha (sección «totals») mandan si existen y no hay filtro de fecha.
    let model_totals: Vec<_> = rows
        .iter()
        .filter(|(m, d, _)| m.is_some() && d.is_none())
        .collect();
    let model_daily: Vec<_> = rows
        .iter()
        .filter(|(m, d, _)| m.is_some() && d.is_some())
        .collect();
    if !model_daily.is_empty() {
        for (m, d, t) in &model_daily {
            if in_range(d) {
                *s.per_model.entry(m.clone().unwrap()).or_default() += t;
                *s.per_day.entry(d.clone().unwrap()).or_default() += t;
            }
        }
    } else {
        for (m, _, t) in &model_totals {
            *s.per_model.entry(m.clone().unwrap()).or_default() += t;
        }
        for (_, d, t) in rows.iter().filter(|(m, d, _)| m.is_none() && d.is_some()) {
            if in_range(d) {
                *s.per_day.entry(d.clone().unwrap()).or_default() += t;
            }
        }
    }
    s
}

/// Límites de tokens que `/v1/models` pueda exponer por modelo (campos con «quota»).
pub(crate) fn quotas_from_models(v: &Value) -> BTreeMap<String, Quota> {
    let mut out = BTreeMap::new();
    let Some(list) = v.get("data").and_then(Value::as_array) else {
        return out;
    };
    for m in list {
        let Some(id) = m.get("id").and_then(Value::as_str) else {
            continue;
        };
        let found = m.as_object().and_then(|o| {
            o.iter()
                .chain(
                    o.get("limits")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten(),
                )
                .find(|(k, v)| k.contains("quota") && num(v).map(|n| n >= 1e6).unwrap_or(false))
                .and_then(|(_, v)| num(v))
        });
        if let Some(t) = found {
            let billing = m.to_string().contains("billing");
            out.insert(
                id.to_string(),
                Quota {
                    tokens: t,
                    billing_period: billing,
                },
            );
        }
    }
    out
}

/// Inicio del periodo de facturación actual dado su día de inicio (1–28).
pub(crate) fn billing_period_start(now: DateTime<Utc>, day: u32) -> DateTime<Utc> {
    let day = day.clamp(1, 28);
    let this = Utc
        .with_ymd_and_hms(now.year(), now.month(), day, 0, 0, 0)
        .single()
        .unwrap_or(now);
    if now >= this {
        return this;
    }
    let (y, m) = if now.month() == 1 {
        (now.year() - 1, 12)
    } else {
        (now.year(), now.month() - 1)
    };
    Utc.with_ymd_and_hms(y, m, day, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

fn next_billing(now: DateTime<Utc>, day: u32) -> DateTime<Utc> {
    let start = billing_period_start(now, day);
    let (y, m) = if start.month() == 12 {
        (start.year() + 1, 1)
    } else {
        (start.year(), start.month() + 1)
    };
    Utc.with_ymd_and_hms(y, m, start.day(), 0, 0, 0)
        .single()
        .unwrap_or(now)
}

/// Un medidor por modelo con cuota y uso, ordenados por % (el anillo exterior es el más cercano a agotarse).
pub(crate) fn quota_meters(
    month: &UsageSummary,
    period: &UsageSummary,
    quotas: &BTreeMap<String, Quota>,
    now: DateTime<Utc>,
    billing_day: u32,
) -> Vec<Meter> {
    let mut out: Vec<Meter> = quotas
        .iter()
        .filter_map(|(model, q)| {
            let used = (if q.billing_period {
                period.per_model.get(model)
            } else {
                month.per_model.get(model)
            })
            .copied()?;
            if used <= 0.0 || q.tokens <= 0.0 {
                return None;
            }
            let (start, end) = if q.billing_period {
                (
                    billing_period_start(now, billing_day),
                    next_billing(now, billing_day),
                )
            } else {
                (month_start(now), next_month_start(now))
            };
            Some(Meter {
                id: format!("model:{model}"),
                label: model.clone(),
                percent: Some(used / q.tokens * 100.0),
                used: Some(used),
                limit: Some(q.tokens),
                unit: Some("tokens".into()),
                resets_at: Some(end.to_rfc3339()),
                window_seconds: Some((end - start).num_seconds()),
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

fn compact(n: f64) -> String {
    match n {
        n if n >= 1e9 => format!("{:.1}B", n / 1e9),
        n if n >= 1e6 => format!("{:.1}M", n / 1e6),
        n if n >= 1e3 => format!("{:.1}K", n / 1e3),
        n => format!("{n:.0}"),
    }
}

fn plan_name(plan: &str) -> &'static str {
    match plan {
        "premium" => "GLM Premium",
        "community" => "nan_community",
        _ => "nan_member",
    }
}

fn plan_quota(plan: &str) -> &'static str {
    match plan {
        "premium" => "Plan: 3B tokens/periodo de GLM 5.3 · 400M por ventana de 4 h.",
        "community" => "Plan de comunidad (prioridad de cola).",
        _ => "Plan: cluster sin contador · 3B tokens/mes en DeepSeek V4-Flash.",
    }
}

/// Convierte `x-ratelimit-limit-*` / `x-ratelimit-remaining-*` en medidores.
pub(crate) fn rate_limit_meters(h: &reqwest::header::HeaderMap) -> Vec<Meter> {
    let num = |name: &str| {
        h.get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<f64>().ok())
    };
    let mut out = vec![];
    for (suffix, id, label, unit) in [
        ("requests", "rate_requests", "Peticiones (ventana)", "req"),
        ("tokens", "rate_tokens", "Tokens (ventana)", "tokens"),
    ] {
        let (Some(limit), Some(remaining)) = (
            num(&format!("x-ratelimit-limit-{suffix}")),
            num(&format!("x-ratelimit-remaining-{suffix}")),
        ) else {
            continue;
        };
        if limit <= 0.0 {
            continue;
        }
        let used = (limit - remaining).max(0.0);
        out.push(Meter {
            id: id.into(),
            label: label.into(),
            percent: Some(used / limit * 100.0),
            used: Some(used),
            limit: Some(limit),
            unit: Some(unit.into()),
            resets_at: None,
            window_seconds: None,
        });
    }
    out
}

/// Endpoint propio opcional configurado en Ajustes (URL + JSON Pointers).
async fn custom_usage(cfg: &NanConfig, http: &reqwest::Client, key: &str) -> Option<Meter> {
    let url = cfg.usage_url.as_deref().filter(|u| !u.trim().is_empty())?;
    let res = http.get(url.trim()).bearer_auth(key).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    pointer_meter(&res.json::<Value>().await.ok()?, cfg)
}

pub(crate) fn pointer_meter(body: &Value, cfg: &NanConfig) -> Option<Meter> {
    let used = cfg
        .used_pointer
        .as_deref()
        .and_then(|p| body.pointer(p))
        .and_then(num)?;
    let limit = cfg
        .limit_pointer
        .as_deref()
        .and_then(|p| body.pointer(p))
        .and_then(num);
    Some(Meter {
        id: "custom".into(),
        label: cfg
            .usage_label
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Consumo".into()),
        percent: limit.filter(|l| *l > 0.0).map(|l| used / l * 100.0),
        used: Some(used),
        limit,
        unit: Some("tokens".into()),
        resets_at: None,
        window_seconds: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 6, 12, 0, 0).unwrap()
    }

    #[test]
    fn parses_daily_rows_with_model() {
        let page = json!({
            "start_date": "2026-09-20", "end_date": "2026-10-06",
            "data": [
                {"date": "2026-09-30", "model": "deepseek-v4-flash", "prompt_tokens": 100, "completion_tokens": 50},
                {"date": "2026-10-01", "model": "deepseek-v4-flash", "total_tokens": 600_000_000u64},
                {"date": "2026-10-02", "model": "glm5.3", "total_tokens": 300_000_000u64}
            ],
            "totals": {"total_tokens": 900_000_150u64}
        });
        let month = summarize(&[page.clone()], Some(month_start(now())));
        assert_eq!(month.per_model.get("deepseek-v4-flash"), Some(&6e8));
        assert_eq!(month.per_day.len(), 2);
        let meters = quota_meters(
            &month,
            &summarize(&[page], None),
            &known_quotas()
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            now(),
            1,
        );
        assert_eq!(meters[0].label, "deepseek-v4-flash");
        assert_eq!(meters[0].id, "model:deepseek-v4-flash");
        assert_eq!(meters[0].percent, Some(20.0));
        assert_eq!(
            meters[0].resets_at.as_deref(),
            Some("2026-11-01T00:00:00+00:00")
        );
    }

    #[test]
    fn parses_nested_days_and_by_model_maps() {
        let page = json!({
            "days": [
                {"day": "2026-10-01", "models": [{"model": "glm5.3-flash", "tokens": 1000}]},
                {"day": "2026-10-02", "by_model": {"glm5.3-flash": {"total_tokens": 500}}}
            ]
        });
        let s = summarize(&[page], None);
        assert_eq!(s.per_model.get("glm5.3-flash"), Some(&1500.0));
        assert_eq!(s.per_day.get("2026-10-02"), Some(&500.0));
    }

    #[test]
    fn billing_period_wraps_months() {
        assert_eq!(
            billing_period_start(now(), 15).to_rfc3339(),
            "2026-09-15T00:00:00+00:00"
        );
        assert_eq!(
            billing_period_start(now(), 3).to_rfc3339(),
            "2026-10-03T00:00:00+00:00"
        );
        assert_eq!(
            next_billing(now(), 15).to_rfc3339(),
            "2026-10-15T00:00:00+00:00"
        );
    }

    #[test]
    fn reads_quota_from_models() {
        let v = json!({"data": [{"id": "glm5.3", "limits": {"token_quota": 4000000000u64, "reset": "billing_period"}}, {"id": "x"}]});
        let q = quotas_from_models(&v);
        assert_eq!(
            q.get("glm5.3"),
            Some(&Quota {
                tokens: 4e9,
                billing_period: true
            })
        );
        assert!(!q.contains_key("x"));
    }

    #[test]
    fn reads_rate_limit_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-limit-requests", HeaderValue::from_static("60"));
        h.insert(
            "x-ratelimit-remaining-requests",
            HeaderValue::from_static("45"),
        );
        let m = rate_limit_meters(&h);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].percent, Some(25.0));
        assert_eq!(m[0].id, "rate_requests");
        assert_eq!(m[0].label, "Peticiones (ventana)");
    }

    #[test]
    fn token_rate_limit_has_its_own_id() {
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-limit-tokens", HeaderValue::from_static("1000"));
        h.insert(
            "x-ratelimit-remaining-tokens",
            HeaderValue::from_static("500"),
        );
        let m = rate_limit_meters(&h);
        assert_eq!(
            (m[0].id.as_str(), m[0].label.as_str()),
            ("rate_tokens", "Tokens (ventana)")
        );
    }

    #[test]
    fn reads_usage_with_pointers() {
        let cfg = NanConfig {
            used_pointer: Some("/usage/used".into()),
            limit_pointer: Some("/usage/quota".into()),
            ..Default::default()
        };
        let m = pointer_meter(
            &json!({"usage": {"used": "750000000", "quota": 3000000000u64}}),
            &cfg,
        )
        .unwrap();
        assert_eq!(m.percent, Some(25.0));
        assert!(pointer_meter(&json!({}), &cfg).is_none());
        assert_eq!((m.id.as_str(), m.label.as_str()), ("custom", "Consumo"));
    }

    #[test]
    fn custom_label_does_not_change_the_custom_id() {
        let cfg = NanConfig {
            used_pointer: Some("/u".into()),
            usage_label: Some("Mi cuota".into()),
            ..Default::default()
        };
        let m = pointer_meter(&json!({"u": 1}), &cfg).unwrap();
        assert_eq!((m.id.as_str(), m.label.as_str()), ("custom", "Mi cuota"));
    }
}
