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
use chrono::{DateTime, Months, NaiveDate, NaiveTime, Utc};
use serde_json::Value;
use std::collections::BTreeMap;

pub const API: &str = "https://cloud-api.nan.builders";

/// Base del panel de NaN Cloud para una petición.
///
/// En producción es [`API`]; el backend la pasa desde la configuración (`NanConfig`:
/// `cloud_base_url`), que es inyectable para que los tests puedan apuntar al panel a
/// un servidor local y ejercitar el camino con API key sin salir a la red.
fn base_of(base: &str) -> &str {
    base.trim().trim_end_matches('/')
}

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

/// Credentials accepted by the Cloud API: the dashboard session (cookie) or an API key (bearer).
enum Auth<'a> {
    Cookie(&'a str),
    Bearer(&'a str),
}

/// Comprueba la sesión y devuelve el nombre de usuario.
pub async fn whoami(http: &reqwest::Client, cookie: &str) -> Result<String, CloudError> {
    let v = get_json(http, Auth::Cookie(cookie), API, "/api/auth/me").await?;
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
    /// Los modelos que el payload trajo y que no se pudieron declarar, con su motivo.
    pub dropped: Vec<Dropped>,
    pub daily: Vec<Daily>,
    pub last24h: Option<f64>,
    pub month: Option<f64>,
}

pub async fn fetch(
    http: &reqwest::Client,
    cookie: &str,
    base: &str,
) -> Result<CloudUsage, CloudError> {
    let quota = send_json(http, quota_request(http, Auth::Cookie(cookie), base)).await?;
    // Las métricas son un extra: si fallan, seguimos con las cuotas.
    let metrics = get_json(http, Auth::Cookie(cookie), base, "/api/metrics/usage")
        .await
        .ok();
    let (meters, dropped) = session_meters(&quota);
    Ok(CloudUsage {
        meters,
        dropped,
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

/// Account quota of an API key: same payload as the dashboard (quota, usage and dates together).
pub async fn fetch_account_quota(
    http: &reqwest::Client,
    key: &str,
    base: &str,
) -> Result<Value, CloudError> {
    send_json(http, quota_request(http, Auth::Bearer(key), base)).await
}

/// The request that reads the quota of the account (the payload the dashboard shows).
fn quota_request(http: &reqwest::Client, auth: Auth<'_>, base: &str) -> reqwest::RequestBuilder {
    request(http, auth, base, "/api/usage/quota")
}

/// Builds the request of a Cloud path with the given credentials.
fn request(
    http: &reqwest::Client,
    auth: Auth<'_>,
    base: &str,
    path: &str,
) -> reqwest::RequestBuilder {
    let req = http
        .get(format!("{}{path}", base_of(base)))
        .header(reqwest::header::ACCEPT, "application/json");
    match auth {
        Auth::Cookie(cookie) => req.header(reqwest::header::COOKIE, cookie),
        Auth::Bearer(key) => req.bearer_auth(key),
    }
}

async fn get_json(
    http: &reqwest::Client,
    auth: Auth<'_>,
    base: &str,
    path: &str,
) -> Result<Value, CloudError> {
    send_json(http, request(http, auth, base, path)).await
}

/// Sends the request and parses the JSON body; the errors name the path of the request.
async fn send_json(
    http: &reqwest::Client,
    req: reqwest::RequestBuilder,
) -> Result<Value, CloudError> {
    let req = req.build().map_err(|e| CloudError::Other(net_error(e)))?;
    let path = req.url().path().to_string();
    let res = http
        .execute(req)
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

/// Los medidores de la sesión: los que trae el payload del panel, tal cual.
///
/// Un modelo con cuota y consumo cero se declara al 0 %: una asignación sin consumo es
/// una asignación, no la ausencia de cuota. Es el mismo criterio que el camino de
/// cuenta (la API key), así que las dos rutas no descartan la cuota de la cuenta.
fn session_meters(v: &Value) -> (Vec<Meter>, Vec<Dropped>) {
    let ParsedQuota { meters, dropped } = parse_quota(v);
    (meters, dropped)
}

/// Un modelo que el payload trajo y que no se pudo declarar, con el motivo.
///
/// Un modelo malformado no puede desaparecer en silencio: el total del informe quedaría
/// incompleto y parecería completo. Por eso el descarte se declara y quien arma el
/// informe degrada su estado y nombra los modelos que faltan.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Dropped {
    /// El nombre del modelo, tal y como vino en el payload.
    pub model: String,
    /// Por qué no se pudo declarar.
    pub reason: &'static str,
}

/// El payload no trajo la cuota del modelo.
pub(crate) const NO_CAP: &str = "sin cap";
/// El payload no trajo el consumo del modelo.
pub(crate) const NO_TOKENS_USED: &str = "sin tokensUsed";
/// La cuota del modelo no es un tope (cero o negativa).
pub(crate) const CAP_NOT_POSITIVE: &str = "cap <= 0";
/// El consumo del modelo es negativo: el payload está malformado.
pub(crate) const NEGATIVE_TOKENS_USED: &str = "tokensUsed negativo";
/// El payload no trajo el nombre del modelo: sin nombre no hay modelo que medir.
pub(crate) const NO_MODEL: &str = "sin model";
/// El payload no trajo un fin de periodo legible: sin fin no hay ventana ni reinicio.
pub(crate) const INVALID_PERIOD_END: &str = "periodEnd inválido";

/// El resultado de leer el payload de cuota: los medidores que se pudieron declarar y
/// los modelos que el payload trajo y no se pudieron declarar.
pub(crate) struct ParsedQuota {
    /// Un medidor por modelo con cuota y consumo.
    pub meters: Vec<Meter>,
    /// Los modelos que no se pudieron declarar, con su motivo.
    pub dropped: Vec<Dropped>,
}

/// Un medidor por modelo con tokens usados (ordenados por %, el mayor primero), y los
/// modelos del payload que no se pudieron declarar, con su motivo.
pub(crate) fn parse_quota(v: &Value) -> ParsedQuota {
    let period_start = parse_period_start(v.get("periodStart"));
    let mut out: Vec<Meter> = vec![];
    let mut dropped: Vec<Dropped> = vec![];
    for m in v
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        // Sin nombre no hay modelo que nombrar: el payload no dice de qué modelo se
        // trata. No se pierde en silencio: entra en los descartados con su motivo.
        let Some(model) = m.get("model").and_then(Value::as_str) else {
            dropped.push(Dropped {
                model: String::new(),
                reason: NO_MODEL,
            });
            continue;
        };
        let Some(used) = m.get("tokensUsed").and_then(number) else {
            dropped.push(Dropped {
                model: model.to_string(),
                reason: NO_TOKENS_USED,
            });
            continue;
        };
        if used < 0.0 {
            dropped.push(Dropped {
                model: model.to_string(),
                reason: NEGATIVE_TOKENS_USED,
            });
            continue;
        }
        // Denominator: `cap` is the allowance the account got for the current period,
        // the same number the dashboard shows as "Allowance per billing period". A
        // prorated first period arrives prorated, so it needs no special case.
        let Some(limit) = m.get("cap").and_then(number) else {
            dropped.push(Dropped {
                model: model.to_string(),
                reason: NO_CAP,
            });
            continue;
        };
        if limit <= 0.0 {
            dropped.push(Dropped {
                model: model.to_string(),
                reason: CAP_NOT_POSITIVE,
            });
            continue;
        }
        // Sin fin de periodo no hay reinicio ni ventana: eso no es un tope con periodo,
        // así que el modelo se descarta con su motivo (y el informe degrada).
        let Some(end) = m
            .get("periodEnd")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
        else {
            dropped.push(Dropped {
                model: model.to_string(),
                reason: INVALID_PERIOD_END,
            });
            continue;
        };
        // Mensual: desde periodStart. Periodo de facturación (glm5.3): un mes antes del fin.
        // `periodStart` es una FECHA (el día del inicio del periodo) y `periodEnd` es un
        // INSTANTE con hora: el inicio real del periodo es ese día a la MISMA hora del
        // fin de ese modelo (la cuenta de verdad factura del 5 al 5 a las 22:15:31).
        // Si `periodStart` trae su propia hora, esa es la del inicio.
        //
        // `windowHours` es la ventana móvil del modelo: sólo cuenta si trae un NÚMERO.
        // La clave ausente y la clave con valor `null` son lo mismo (no hay ventana):
        // con `null` la ventana sale de "fin menos un mes" en vez de la del periodo de la
        // cuenta.
        let has_window = m.get("windowHours").and_then(Value::as_f64).is_some();
        let start = match period_start {
            Some((date, time)) if !has_window => {
                let time = time.unwrap_or_else(|| end.time());
                Some(date.and_time(time).and_utc().min(end))
            }
            _ => end.checked_sub_months(Months::new(1)),
        };
        out.push(Meter {
            id: format!("model:{model}"),
            label: model.to_string(),
            percent: Some(used / limit * 100.0),
            used: Some(used),
            limit: Some(limit),
            unit: Some("tokens".into()),
            resets_at: Some(end.to_rfc3339()),
            window_seconds: match start {
                Some(s) if end > s => Some((end - s).num_seconds()),
                _ => None,
            },
            quota_source: None,
        });
    }
    out.sort_by(|a, b| {
        b.percent
            .partial_cmp(&a.percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ParsedQuota {
        meters: out,
        dropped,
    }
}

/// Un número del payload: puede venir como número JSON o como texto (el proveedor
/// escribe las dos formas). Lo que no es un número, no lo es.
fn number(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    v.as_str()?.trim().parse::<f64>().ok()
}

/// El inicio del periodo: puede venir como fecha (el día) o como fecha con hora (el
/// instante). Con sólo fecha, la hora del inicio es la del fin de ese modelo (la
/// cuenta de verdad factura del 5 al 5 a las 22:15:31); con fecha y hora, esa es la
/// hora del inicio.
fn parse_period_start(v: Option<&Value>) -> Option<(NaiveDate, Option<NaiveTime>)> {
    let s = v?.as_str()?.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        let dt = dt.with_timezone(&Utc);
        return Some((dt.date_naive(), Some(dt.time())));
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .map(|d| (d, None))
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

/// Payload real de una cuenta (censurado): es lo que devuelve
/// `GET https://cloud-api.nan.builders/api/usage/quota` con la API key de la cuenta.
/// Fixture canónico de #252: la forma real del contrato, sin campos inventados.
#[cfg(test)]
pub(crate) fn real_account_payload() -> Value {
    serde_json::json!({"periodStart": "2026-11-05", "models": [
        {"model": "deepseek-v4-flash", "tokensUsed": 955_581_032u64, "cap": 1_000_000_000u64, "remaining": 44_418_968u64, "periodEnd": "2026-12-05T22:15:31Z", "extraTokens": 0u64, "extraUsable": true},
        {"model": "glm5.3-flash", "tokensUsed": 496_625_346u64, "cap": 500_000_000u64, "remaining": 3_374_654u64, "periodEnd": "2026-12-05T22:15:31Z", "extraTokens": 0u64, "extraUsable": true}
    ]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Los medidores que se pudieron declarar (sin los descartados).
    fn meters(v: &Value) -> Vec<Meter> {
        parse_quota(v).meters
    }

    #[test]
    fn parses_quota_like_the_dashboard() {
        // The real payload of an account is the canonical fixture: two metered models,
        // the same numbers the dashboard shows ("your tier").
        let m = meters(&real_account_payload());
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "model:glm5.3-flash");
        assert_eq!(m[1].id, "model:deepseek-v4-flash");
        assert!((m[0].percent.unwrap() - 99.325).abs() < 0.01);
        assert!((m[1].percent.unwrap() - 95.558).abs() < 0.01);
        assert_eq!(m[0].resets_at.as_deref(), Some("2026-12-05T22:15:31+00:00"));
        assert_eq!(m[0].window_seconds, Some(30 * 86400));
    }

    #[test]
    fn the_account_period_starts_at_the_hour_of_its_own_end() {
        // The real account payload: `periodStart` is a DATE (the 5th) and `periodEnd` is
        // an INSTANT (the 5th of the next month at 22:15:31). The real start of the period
        // is that day at the same hour, so the window is exactly 30 days, not 30 days
        // plus the hours of the day it starts at.
        let m = meters(&real_account_payload());
        let deepseek = m
            .iter()
            .find(|x| x.id == "model:deepseek-v4-flash")
            .expect("deepseek meter");
        let resets = deepseek
            .resets_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .expect("the meter resets at an instant");
        assert_eq!(
            resets,
            DateTime::parse_from_rfc3339("2026-12-05T22:15:31Z")
                .unwrap()
                .with_timezone(&Utc)
        );
        assert_eq!(deepseek.window_seconds, Some(2_592_000));
        assert_eq!(deepseek.window_seconds, Some(30 * 86400));
    }

    #[test]
    fn a_period_starts_at_the_hour_of_its_own_end() {
        // The rule of the start: `periodStart` is a DATE (the 5th) and `periodEnd` is an
        // INSTANT, so the period starts on that day at the same hour as its end. The
        // trivial case: a period that ends at midnight starts at midnight too and its
        // window is exactly the 30 days of the period.
        let v = json!({"periodStart": "2026-11-05", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 1000, "cap": 1000000000u64, "periodEnd": "2026-12-05T00:00:00Z"}
        ]});
        let m = meters(&v);
        assert_eq!(m[0].window_seconds, Some(2_592_000));

        // The same rule with an end that is NOT at midnight: the start takes that hour,
        // so the window is still exactly the 30 days of the period (and not 30 days plus
        // the hours of the day it starts at).
        let v = json!({"periodStart": "2026-11-05", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 1000, "cap": 1000000000u64, "periodEnd": "2026-12-05T03:00:00Z"}
        ]});
        let m = meters(&v);
        assert_eq!(m[0].window_seconds, Some(2_592_000));
    }

    #[test]
    fn the_canonical_fixture_yields_the_dates_of_the_real_account() {
        // The fixture is the contract of the provider, but what has to hold is what the
        // parsing gives: the real account's period, from the 5th at 22:15:31 to the 5th
        // of the next month at the same hour.
        let end = DateTime::parse_from_rfc3339("2026-12-05T22:15:31Z")
            .unwrap()
            .with_timezone(&Utc);
        let start = DateTime::parse_from_rfc3339("2026-11-05T22:15:31Z")
            .unwrap()
            .with_timezone(&Utc);
        let parsed = parse_quota(&real_account_payload());
        assert_eq!(parsed.meters.len(), 2);
        assert!(parsed.dropped.is_empty());
        for meter in &parsed.meters {
            assert_eq!(
                meter
                    .resets_at
                    .as_deref()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.with_timezone(&Utc)),
                Some(end)
            );
            let seconds = meter.window_seconds.expect("the meter has a window");
            assert_eq!(seconds, 2_592_000);
            // The window starts on the 5th at the hour of the end, not at midnight.
            assert_eq!(end.timestamp() - seconds, start.timestamp());
        }
    }

    #[test]
    fn uses_the_account_allowance_from_the_payload() {
        // Real payload of an account: `cap` is the allowance of the plan (1.000M) and
        // `tokensUsed` the consumption of that same period.
        let m = meters(&real_account_payload());
        let deepseek = m
            .iter()
            .find(|x| x.id == "model:deepseek-v4-flash")
            .expect("deepseek meter");
        let glm = m
            .iter()
            .find(|x| x.id == "model:glm5.3-flash")
            .expect("glm meter");
        assert_eq!(deepseek.limit, Some(1e9));
        assert_eq!(deepseek.used, Some(955_581_032.0));
        assert!((deepseek.percent.unwrap() - 95.558).abs() < 0.01);
        assert_eq!(glm.limit, Some(5e8));
        assert_eq!(glm.used, Some(496_625_346.0));
        assert!((glm.percent.unwrap() - 99.325).abs() < 0.01);
    }

    #[test]
    fn the_session_path_declares_the_models_with_no_consumption() {
        // La sesión declara lo que trae el payload: un modelo con cuota y consumo cero es
        // una asignación, no la ausencia de cuota. Se muestra al 0 %, igual que en el
        // camino de cuenta (no se descarta).
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "glm5.3", "tokensUsed": 0, "cap": 3000000000u64, "periodEnd": "2026-11-01T00:00:00Z"},
            {"model": "deepseek-v4-flash", "tokensUsed": 1000, "cap": 1000000000u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let (meters, dropped) = session_meters(&v);
        assert_eq!(meters.len(), 2);
        assert_eq!(meters[0].id, "model:deepseek-v4-flash");
        let glm = meters
            .iter()
            .find(|m| m.id == "model:glm5.3")
            .expect("el modelo con cuota y consumo cero se declara");
        assert_eq!(glm.used, Some(0.0));
        assert_eq!(glm.percent, Some(0.0));
        assert_eq!(glm.limit, Some(3e9));
        assert!(dropped.is_empty());
    }

    #[test]
    fn the_session_path_shows_a_quota_with_no_consumption_at_zero() {
        // Sesión con un único modelo con cuota y consumo 0: el medidor existe y está al
        // 0 %. Antes desaparecía, y con él la cuota que la cuenta tiene asignada.
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "glm5.3-flash", "tokensUsed": 0, "cap": 500000000u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let (meters, dropped) = session_meters(&v);
        assert_eq!(meters.len(), 1);
        assert_eq!(meters[0].id, "model:glm5.3-flash");
        assert_eq!(meters[0].used, Some(0.0));
        assert_eq!(meters[0].percent, Some(0.0));
        assert_eq!(meters[0].limit, Some(5e8));
        assert!(dropped.is_empty());
    }

    #[test]
    fn unknown_fields_do_not_change_the_meters() {
        // We assert nothing about the meaning of `extraTokens`/`extraUsable`: the only
        // claim here is that the parser ignores the fields it does not know.
        let with_extra = real_account_payload();
        let mut without_extra = real_account_payload();
        if let Some(models) = without_extra["models"].as_array_mut() {
            for model in models {
                if let Some(o) = model.as_object_mut() {
                    o.remove("extraTokens");
                    o.remove("extraUsable");
                }
            }
        }
        assert_eq!(meters(&with_extra), meters(&without_extra));
    }

    #[test]
    fn prorated_first_period_uses_the_prorated_allowance() {
        // On the first period the account only has a fraction of the plan, so the payload
        // prorates `cap`: that prorated value is the allowance of the period.
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "glm5.3", "tokensUsed": 100_000_000u64, "cap": 333_333_333u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let m = meters(&v);
        assert_eq!(m[0].limit, Some(333_333_333.0));
        assert!((m[0].percent.unwrap() - 30.0).abs() < 0.01);
    }

    #[test]
    fn without_quota_fields_there_is_no_meter() {
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 123_456u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        assert!(meters(&v).is_empty());
    }

    #[test]
    fn each_account_gets_its_own_allowance() {
        let payload = |cap: u64| {
            json!({"periodStart": "2026-10-01", "models": [
                {"model": "deepseek-v4-flash", "tokensUsed": 100_000_000u64, "cap": cap, "periodEnd": "2026-11-01T00:00:00Z"}
            ]})
        };
        let a = meters(&payload(1_000_000_000));
        let b = meters(&payload(500_000_000));
        assert_eq!(a[0].limit, Some(1e9));
        assert_eq!(b[0].limit, Some(5e8));
    }

    #[test]
    fn billing_period_window_is_one_month() {
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "glm5.3", "tokensUsed": 1000, "cap": 3000000000u64, "periodEnd": "2026-10-17T05:53:20Z", "windowHours": 4}
        ]});
        assert_eq!(meters(&v)[0].window_seconds, Some(30 * 86400));
    }

    #[test]
    fn a_null_window_hours_is_the_same_as_no_window_at_all() {
        // `windowHours` con valor `null` no es una ventana: la clave llega pero sin
        // número. El periodo es el de la cuenta (`periodStart` con la hora del
        // `periodEnd`), no "el fin menos un mes": con inicio el 20/11 y fin el 05/12 son
        // 15 días, no 30.
        let v = json!({"periodStart": "2026-11-20", "models": [
            {"model": "glm5.3-flash", "tokensUsed": 1000, "cap": 500000000u64, "periodEnd": "2026-12-05T00:00:00Z", "windowHours": null}
        ]});
        assert_eq!(meters(&v)[0].window_seconds, Some(15 * 86400));

        // Lo mismo sin la clave: el resultado no depende de cómo venga el `null`.
        let v = json!({"periodStart": "2026-11-20", "models": [
            {"model": "glm5.3-flash", "tokensUsed": 1000, "cap": 500000000u64, "periodEnd": "2026-12-05T00:00:00Z"}
        ]});
        assert_eq!(meters(&v)[0].window_seconds, Some(15 * 86400));
    }

    #[test]
    fn a_malformed_model_is_reported_with_its_reason() {
        // Un modelo malformado no se pierde en silencio: se declara con el motivo, para
        // que el informe pueda degradarse y nombrarlo.
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 1000, "cap": 1000000000u64, "periodEnd": "2026-11-01T00:00:00Z"},
            {"model": "glm5.3-flash", "tokensUsed": 1000, "periodEnd": "2026-11-01T00:00:00Z"},
            {"model": "qwen3.8-flash", "cap": 500000000u64, "periodEnd": "2026-11-01T00:00:00Z"},
            {"model": "mimo-v2.6-flash", "tokensUsed": 1000, "cap": 0u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let parsed = parse_quota(&v);
        // El modelo bien formado se declara igual: el descarte no se come al resto.
        assert_eq!(parsed.meters.len(), 1);
        assert_eq!(parsed.meters[0].id, "model:deepseek-v4-flash");
        assert_eq!(parsed.dropped.len(), 3);
        assert_eq!(parsed.dropped[0].model, "glm5.3-flash");
        assert_eq!(parsed.dropped[0].reason, NO_CAP);
        assert_eq!(parsed.dropped[1].model, "qwen3.8-flash");
        assert_eq!(parsed.dropped[1].reason, NO_TOKENS_USED);
        assert_eq!(parsed.dropped[2].model, "mimo-v2.6-flash");
        assert_eq!(parsed.dropped[2].reason, CAP_NOT_POSITIVE);
    }

    #[test]
    fn a_model_without_a_name_is_reported_and_not_lost() {
        // Un modelo sin `model` no se pierde en silencio: entra en la lista de los
        // descartados con su motivo, para que el informe degrade y lo nombre.
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"tokensUsed": 1000, "cap": 1000000000u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let parsed = parse_quota(&v);
        assert!(parsed.meters.is_empty());
        assert_eq!(parsed.dropped.len(), 1);
        assert_eq!(parsed.dropped[0].reason, "sin model");
    }

    #[test]
    fn a_model_with_an_invalid_period_end_is_reported() {
        // Un `periodEnd` ilegible deja el medidor sin reinicio ni ventana: eso no es un
        // tope con periodo, así que se descarta con su motivo (y el informe degrada).
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 1000, "cap": 1000000000u64, "periodEnd": "no es una fecha"}
        ]});
        let parsed = parse_quota(&v);
        assert!(parsed.meters.is_empty());
        assert_eq!(parsed.dropped.len(), 1);
        assert_eq!(parsed.dropped[0].model, "deepseek-v4-flash");
        assert_eq!(parsed.dropped[0].reason, "periodEnd inválido");
    }

    #[test]
    fn a_numeric_string_is_a_valid_consumption() {
        // `"tokensUsed": "1000"` es el número escrito como texto: el payload SÍ trae el
        // consumo, así que el modelo no se descarta (el motivo "sin tokensUsed" era
        // incorrecto: el dato estaba).
        let v = json!({"periodStart": "2026-10-01", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": "1000", "cap": 1000000000u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let parsed = parse_quota(&v);
        assert!(parsed.dropped.is_empty());
        assert_eq!(parsed.meters.len(), 1);
        assert_eq!(parsed.meters[0].used, Some(1000.0));
        assert!((parsed.meters[0].percent.unwrap() - 0.0001).abs() < 0.00001);
    }

    #[test]
    fn the_period_start_can_bring_its_own_time() {
        // `periodStart` con fecha Y hora es el instante del inicio del periodo. Con
        // inicio el 20/11 y fin el 05/12 la ventana son 15 días, no los 30 que salían
        // de "fin menos un mes" (el `NaiveDate` no leía la hora).
        let v = json!({"periodStart": "2026-11-20T00:00:00Z", "models": [
            {"model": "glm5.3-flash", "tokensUsed": 1000, "cap": 500000000u64, "periodEnd": "2026-12-05T00:00:00Z"}
        ]});
        let m = meters(&v);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].window_seconds, Some(15 * 86400));
        assert_eq!(m[0].resets_at.as_deref(), Some("2026-12-05T00:00:00+00:00"));
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

    #[test]
    fn the_account_quota_request_carries_the_api_key_as_bearer() {
        let http = reqwest::Client::new();
        let req = quota_request(&http, Auth::Bearer("nan-key"), API)
            .build()
            .expect("the request builds without network");
        assert_eq!(
            req.url().as_str(),
            "https://cloud-api.nan.builders/api/usage/quota"
        );
        assert_eq!(
            req.headers()
                .get(reqwest::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok()),
            Some("Bearer nan-key")
        );
        assert_eq!(
            req.headers()
                .get(reqwest::header::ACCEPT)
                .and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        assert!(req.headers().get(reqwest::header::COOKIE).is_none());
    }

    #[test]
    fn the_session_quota_request_carries_the_cookie_and_no_authorization() {
        let http = reqwest::Client::new();
        let req = quota_request(&http, Auth::Cookie("session=abc"), API)
            .build()
            .expect("the request builds without network");
        assert_eq!(
            req.url().as_str(),
            "https://cloud-api.nan.builders/api/usage/quota"
        );
        assert_eq!(
            req.headers()
                .get(reqwest::header::COOKIE)
                .and_then(|v| v.to_str().ok()),
            Some("session=abc")
        );
        assert!(req.headers().get(reqwest::header::AUTHORIZATION).is_none());
    }
}
