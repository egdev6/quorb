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

/// Where the quota of every meter comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuotaSource {
    /// Real allowance of the account (the one NaN Cloud reports).
    Account,
    /// Published quotas (docs table or `/v1/models`): a fallback, not the account allowance.
    Published,
    /// No quota at all: there is no metered model.
    None,
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
                // La cuota de la sesión es la asignación de la cuenta: el dato viaja en el
                // informe para que el frente no confunda un cambio de fuente con un reinicio.
                report.quota_source = session_quota_source(&report.meters);
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

    // Cuota por cuenta del panel de NaN, con la MISMA API key (`GET /api/usage/quota` de
    // `cloud-api.nan.builders`): `nan_cloud::parse_quota` toma `cap`, que es la asignación de
    // la cuenta para el periodo en curso (el mismo número que el panel muestra como
    // "Allowance per billing period"); el consumo y las fechas salen del mismo payload, así
    // que cuota, uso y periodo son del mismo periodo. Si esta llamada falla o no trae
    // medidores, se lee `/v1/usage` y se cae a la cuota publicada, señalada como fallback.
    let account_quota = super::nan_cloud::fetch_account_quota(http, &key).await.ok();
    let account_meters = account_quota
        .as_ref()
        .map(super::nan_cloud::parse_quota)
        .filter(|m| !m.is_empty());

    let now = Utc::now();
    if let Some(meters) = account_meters {
        // 2. La cuota de la cuenta manda: cuota, consumo y fechas salen del mismo payload, así
        // que no se lee `/v1/usage` (mide el consumo de esta key, de otro periodo) ni se usa
        // `billing_day` (el periodo es el del payload).
        let (meters, source, header) =
            nan_meters(Some(meters), None, &quotas, now, cfg.billing_day);
        report.meters = meters;
        report.message = Some(header);
        report.quota_source = quota_source_name(source);
        report.status = status_for(source);
    } else {
        // 3. Consumo del periodo (desde el inicio del mes o del periodo de facturación, lo que sea antes)
        let period_start = billing_period_start(now, cfg.billing_day);
        let from = month_start(now).min(period_start);
        match fetch_usage(cfg, http, &key, from, now).await {
            Ok(pages) => {
                // Para el mes natural solo contamos días del mes; para glm5.3, desde el inicio del periodo.
                let month = summarize(&pages, Some(month_start(now)));
                let period = summarize(&pages, Some(period_start));
                let (meters, source, header) =
                    nan_meters(None, Some((&month, &period)), &quotas, now, cfg.billing_day);
                report.meters = meters;
                report.message = Some(header);
                report.quota_source = quota_source_name(source);
                report.status = status_for(source);
            }
            Err(e) => {
                report.status = Status::Warning;
                report.message = Some(format!(
                    "No pude leer /v1/usage ({e}). {}",
                    plan_quota(&cfg.plan)
                ));
            }
        }
    }

    // 4. Endpoint propio opcional (avanzado) + cabeceras de rate limit
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

/// Meters of the account: the account quota wins; published quotas are only the fallback.
///
/// The account payload carries quota, usage and period dates together, so when it arrives
/// the report describes that very period: the header and the meters never mix periods.
/// `usage` is the aggregated consumption of the API key (`/v1/usage`), used only when the
/// account payload does not answer.
pub(crate) fn nan_meters(
    account_meters: Option<Vec<Meter>>,
    usage: Option<(&UsageSummary, &UsageSummary)>,
    published: &BTreeMap<String, Quota>,
    now: DateTime<Utc>,
    billing_day: u32,
) -> (Vec<Meter>, QuotaSource, String) {
    // The account quota carries quota, usage and period dates in the same payload.
    if let Some(meters) = account_meters.filter(|m| !m.is_empty()) {
        let total: f64 = meters.iter().filter_map(|m| m.used).sum();
        let header = usage_message(total, QuotaSource::Account);
        return (meters, QuotaSource::Account, header);
    }
    let Some((month, period)) = usage else {
        // Sin lectura de `/v1/usage` no hay nada que medir; el error lo arma quien lo sabe.
        return (Vec::new(), QuotaSource::None, String::new());
    };
    let meters = quota_meters(month, period, published, now, billing_day);
    if meters.is_empty() {
        let header = usage_message(month.total(), QuotaSource::None);
        (Vec::new(), QuotaSource::None, header)
    } else {
        let header = usage_message(month.total(), QuotaSource::Published);
        (meters, QuotaSource::Published, header)
    }
}

/// Header of the report: it names the period the numbers come from. The published quota is
/// flagged as a fallback, not as the account one.
fn usage_message(total: f64, source: QuotaSource) -> String {
    match source {
        QuotaSource::Account => {
            format!("{} tokens del periodo de la cuenta · cuotas por modelo", compact(total))
        }
        QuotaSource::Published => format!(
            "{} tokens este mes · cuotas por modelo · cuota publicada (no es la asignación de tu cuenta)",
            compact(total)
        ),
        // Hay cuotas, pero el proveedor no devolvió consumo para ellas: el mensaje dice
        // que no hay datos, no que no haya cuotas con contador.
        QuotaSource::None => {
            "No hay datos de consumo disponibles para los modelos con cuota.".into()
        }
    }
}

/// La fuente de la cuota viaja como dato del informe (no en el id del medidor): el id no
/// cambia cuando cambia la fuente, así que el frente necesita el dato para no confundir
/// un cambio de regla con un reinicio de la cuota.
fn quota_source_name(source: QuotaSource) -> Option<&'static str> {
    match source {
        QuotaSource::Account => Some("account"),
        QuotaSource::Published => Some("published"),
        QuotaSource::None => None,
    }
}

/// La fuente de la cuota de la sesión: la asignación de la cuenta. Sin medidores no hay
/// cuota que nombrar, así que el informe no la declara.
fn session_quota_source(meters: &[Meter]) -> Option<&'static str> {
    if meters.is_empty() {
        None
    } else {
        quota_source_name(QuotaSource::Account)
    }
}

/// Estado del informe según de dónde salió la cuota: la de la cuenta va en `ok`; una cuota
/// publicada o ninguna cuota son avisos. Nunca `ok` sin medidores: así los datos anteriores
/// quedan como desactualizados en vez de borrarse en silencio.
fn status_for(source: QuotaSource) -> Status {
    match source {
        QuotaSource::Account => Status::Ok,
        QuotaSource::Published | QuotaSource::None => Status::Warning,
    }
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

/// Identidad del plan, sin cifras de cuota: la asignación de tokens depende de la cuenta
/// (cada una recibe la suya) y la muestran los medidores. Un texto con una cifra fija
/// prometería una cuota que no es la de la cuenta, pero el modelo del plan sí se nombra:
/// sin eso el mensaje dejaría de decir de qué plan habla.
fn plan_quota(plan: &str) -> &'static str {
    match plan {
        "premium" => "Plan: GLM 5.3.",
        "community" => "Plan de comunidad (prioridad de cola).",
        _ => "Plan: cluster sin contador · DeepSeek V4-Flash.",
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

    fn published_quotas() -> BTreeMap<String, Quota> {
        known_quotas()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
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
    fn account_quota_wins_over_the_published_table() {
        let payload = json!({"periodStart": "2026-10-01", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 200_000_000u64, "cap": 1_000_000_000u64, "remaining": 800_000_000u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let month = UsageSummary {
            per_model: BTreeMap::from([("deepseek-v4-flash".to_string(), 600_000_000.0)]),
            per_day: BTreeMap::new(),
        };
        let (meters, source, _header) = nan_meters(
            Some(crate::providers::nan_cloud::parse_quota(&payload)),
            Some((&month, &UsageSummary::default())),
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(source, QuotaSource::Account);
        assert_eq!(meters.len(), 1);
        assert_eq!(meters[0].limit, Some(1e9));
    }

    /// ¿El texto afirma una cuota fija ("3B", "500M", "400M")? Un número pegado a B o M es
    /// una cifra de tokens; pegado a otra cosa ("5.3", "V4") es parte del nombre del modelo.
    fn has_quota_figure(text: &str) -> bool {
        let b = text.as_bytes();
        b.iter().enumerate().any(|(i, c)| {
            c.is_ascii_digit()
                && matches!(b.get(i + 1), Some(next) if *next == b'B' || *next == b'M')
        })
    }

    #[test]
    fn the_plan_text_does_not_assert_fixed_quotas() {
        for plan in ["premium", "community", "member"] {
            let text = plan_quota(plan);
            assert!(
                !has_quota_figure(&text) && !text.contains("tokens"),
                "el plan {plan} afirma una cuota fija: {text}"
            );
        }
        // Quitar la cifra no puede volver el mensaje genérico: el plan sigue nombrando su modelo.
        assert!(plan_quota("premium").contains("GLM 5.3"));
        assert!(plan_quota("member").contains("DeepSeek V4-Flash"));
    }

    #[test]
    fn the_account_header_describes_the_account_period() {
        let msg = usage_message(1_452_206_378.0, QuotaSource::Account);
        assert!(msg.contains("periodo de la cuenta"), "{msg}");
        assert!(!msg.contains("este mes"), "{msg}");
    }

    #[test]
    fn published_quota_is_used_and_signalled_as_a_fallback() {
        let month = UsageSummary {
            per_model: BTreeMap::from([("deepseek-v4-flash".to_string(), 600_000_000.0)]),
            per_day: BTreeMap::new(),
        };
        let (meters, source, header) = nan_meters(
            None,
            Some((&month, &UsageSummary::default())),
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(source, QuotaSource::Published);
        assert_eq!(meters[0].limit, Some(3e9));
        assert!(header.contains("este mes"), "{header}");
        assert!(header.contains("cuota publicada"), "{header}");
    }

    #[test]
    fn the_header_and_the_meters_describe_the_same_account_period() {
        // The account payload carries the period: the meter and the header must name it.
        let payload = crate::providers::nan_cloud::real_account_payload();
        let (meters, source, header) = nan_meters(
            Some(crate::providers::nan_cloud::parse_quota(&payload)),
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(source, QuotaSource::Account);
        assert_eq!(meters.len(), 2);
        assert_eq!(
            meters[0].resets_at.as_deref(),
            Some("2026-12-05T22:15:31+00:00")
        );
        assert_eq!(
            meters[0].window_seconds,
            Some(30 * 86400 + 22 * 3600 + 15 * 60 + 31)
        );
        assert!(header.contains("periodo de la cuenta"), "{header}");
        assert!(!header.contains("este mes"), "{header}");
    }

    #[test]
    fn the_api_key_path_divides_by_the_allowance_of_the_account() {
        // The API key path reads the same account payload: the denominator is the
        // allowance of the account (`cap`), not the published table.
        let payload = crate::providers::nan_cloud::real_account_payload();
        let (meters, source, _header) = nan_meters(
            Some(crate::providers::nan_cloud::parse_quota(&payload)),
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(source, QuotaSource::Account);
        let deepseek = meters
            .iter()
            .find(|m| m.id == "model:deepseek-v4-flash")
            .expect("deepseek meter");
        let glm = meters
            .iter()
            .find(|m| m.id == "model:glm5.3-flash")
            .expect("glm meter");
        assert_eq!(deepseek.limit, Some(1e9));
        assert_eq!(deepseek.used, Some(955_581_032.0));
        assert!((deepseek.percent.unwrap() - 95.558).abs() < 0.01);
        assert_eq!(glm.limit, Some(5e8));
        assert_eq!(glm.used, Some(496_625_346.0));
        assert!((glm.percent.unwrap() - 99.325).abs() < 0.01);
    }

    #[test]
    fn the_account_period_wins_even_when_the_consumption_is_zero() {
        // Un payload cuyos modelos no tienen consumo sigue siendo un periodo de cuenta
        // válido: se conserva el cero del periodo recibido y no se recupera consumo de
        // otro periodo (la ruta de `/v1/usage`).
        let mut payload = crate::providers::nan_cloud::real_account_payload();
        if let Some(models) = payload["models"].as_array_mut() {
            for model in models {
                model["tokensUsed"] = json!(0);
            }
        }
        let (meters, source, _header) = nan_meters(
            Some(crate::providers::nan_cloud::parse_quota(&payload)),
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(
            source,
            QuotaSource::Account,
            "el periodo de la cuenta no se descarta por consumo cero"
        );
        assert_eq!(meters.len(), 2);
        let deepseek = meters
            .iter()
            .find(|m| m.id == "model:deepseek-v4-flash")
            .expect("el modelo con cuota y consumo cero conserva su medidor");
        assert_eq!(deepseek.used, Some(0.0));
        assert_eq!(deepseek.percent, Some(0.0));
        assert_eq!(deepseek.limit, Some(1e9));
    }

    #[test]
    fn the_report_says_when_there_is_no_consumption_data() {
        // Hay cuotas, pero el proveedor no devolvió consumo para ellas: el mensaje dice
        // que no hay datos, no que no haya cuotas con contador.
        let msg = usage_message(0.0, QuotaSource::None);
        assert!(msg.contains("datos de consumo disponibles"), "{msg}");
        assert!(!msg.contains("sin cuotas con contador"), "{msg}");
    }

    #[test]
    fn the_status_follows_the_quota_source() {
        // La cuota de la cuenta va en `ok`; una cuota publicada o ninguna cuota son avisos
        // (nunca `ok` sin medidores: así los datos anteriores no se borran en silencio).
        assert_eq!(status_for(QuotaSource::Account), Status::Ok);
        assert_eq!(status_for(QuotaSource::Published), Status::Warning);
        assert_eq!(status_for(QuotaSource::None), Status::Warning);
    }

    #[test]
    fn the_header_text_does_not_change_for_the_sources_with_data() {
        // El texto de la cuenta y el de la cuota publicada se mantienen byte a byte.
        assert_eq!(
            usage_message(1_452_206_378.0, QuotaSource::Account),
            "1.5B tokens del periodo de la cuenta · cuotas por modelo"
        );
        assert_eq!(
            usage_message(1_452_206_378.0, QuotaSource::Published),
            "1.5B tokens este mes · cuotas por modelo · cuota publicada (no es la asignación de tu cuenta)"
        );
    }

    #[test]
    fn the_quota_source_travels_in_the_report() {
        assert_eq!(quota_source_name(QuotaSource::Account), Some("account"));
        assert_eq!(quota_source_name(QuotaSource::Published), Some("published"));
        assert_eq!(quota_source_name(QuotaSource::None), None);
        // La sesión también usa la cuota de la cuenta, pero sin medidores no hay cuota.
        assert_eq!(session_quota_source(&[]), None);
        assert_eq!(session_quota_source(&[Meter::default()]), Some("account"));
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
