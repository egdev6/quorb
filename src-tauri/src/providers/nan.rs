//! NaN Builders — cluster de modelos abiertos con API compatible OpenAI.
//!
//! Fuentes (docs públicas, oct 2026):
//!   · `GET /v1/usage?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` → tu uso de tokens
//!     por día y por modelo, con totales; paginado con `cursor` / `next_cursor`.
//!     En la raíz trae además el bloque `credits`: es `null` si la cuenta NO se factura
//!     en créditos. Ese `null` es lo que decide el régimen de facturación, y lo decide
//!     el backend (el frente recibe el dato, no el concepto). Si la clave `credits` no
//!     viene, o viene con otra forma, el payload ya no coincide con el contrato y el
//!     régimen queda desconocido: el informe no afirma el tipo de la cuenta.
//!   · `GET /v1/models` → modelos disponibles para tu key (y sus límites, si los expone).
//!   · `GET https://cloud-api.nan.builders/api/usage/quota` → la cuota **de la cuenta**:
//!     por modelo, el consumo (`tokensUsed`), la asignación (`cap`) y las fechas del
//!     mismo periodo. Es el payload que enseña el panel de NaN.
//!   · Cuotas por modelo (docs › Models): contador mensual (vuelve a 0 el día 1),
//!     por periodo de facturación (solo `glm5.3`) o sin contador.
//!   · Al agotar una cuota la API responde 402 o 429.
//!
//! La forma exacta de la respuesta de `/v1/usage` no está documentada, así que el
//! parser es tolerante: busca objetos con modelo + tokens (y fecha si la hay).
//! `nan_probe` (comando Tauri) devuelve la respuesta en crudo para ajustarlo.

use super::nan_cloud;
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

/// De dónde sale la cuota que se declaró en el informe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuotaSource {
    /// La asignación real de la cuenta: la que declara el panel de NaN.
    Account,
    /// Las cuotas publicadas (la tabla de la documentación o `/v1/models`): un respaldo,
    /// no la asignación de la cuenta.
    Published,
    /// Ninguna: no hay ningún modelo con contador.
    None,
}

// ───────────────────────── el régimen de facturación ─────────────────────────

/// El bloque `credits` del contrato público del proveedor (`GET /v1/usage`): es `null`
/// cuando la cuenta NO se factura en créditos, y ese `null` es lo que decide el
/// régimen. La decisión vive en el backend: el frente recibe los datos, no el concepto.
///
/// El contrato publica estos campos (`https://nan.builders/openapi.json`):
/// `period_start`, `period_end`, `allowance`, `used`, `remaining`, `pack_credits`,
/// `pack_expires_at` y `frozen`. Con el corte de alcance (#261 = detección y
/// supresión), de este bloque sólo se lee `frozen` («la suscripción no está activa»):
/// la asignación del periodo, el saldo de packs y el desglose por modelo son de la
/// otra mitad del alcance (#268).
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Credits {
    /// `true` mientras la suscripción no está activa: las peticiones se rechazan.
    pub frozen: bool,
}

impl Credits {
    /// El régimen que declara este bloque: la cuenta se factura en créditos.
    pub fn regime(&self) -> BillingRegime {
        BillingRegime::Credits {
            frozen: self.frozen,
        }
    }
}

/// Lo que dice el bloque `credits` de la raíz de `/v1/usage`.
///
/// Un `Option<Credits>` no alcanza: el contrato declara `credits` como
/// `UsageCredits | null`, y ese `null` explícito ES una declaración del proveedor
/// («la cuenta no se factura en créditos»). Una clave ausente —o un bloque con otra
/// forma— es otra cosa: el payload ya no coincide con el contrato, y de él no se puede
/// deducir el tipo de la cuenta. Por eso el bloque se lee con una forma que distingue
/// las tres cosas, en vez de con un `Option` que las mezcla.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CreditsBlock {
    /// El bloque vino `null`: el contrato dice que la cuenta NO se factura en créditos.
    Null,
    /// El bloque vino con contenido: la cuenta se factura en créditos.
    Object(Credits),
    /// La clave no vino, o vino con otra forma: el régimen no se puede determinar.
    Undetermined,
}

impl CreditsBlock {
    /// El régimen que declara el bloque.
    ///
    /// Sólo el `null` explícito declara el tipo de la cuenta. Un bloque ausente (o con
    /// otra forma) no declara nada: el informe queda sin régimen, que es lo que hace
    /// que no afirme el tipo de la cuenta sin poder comprobarlo.
    pub fn regime(&self) -> BillingRegime {
        match self {
            CreditsBlock::Null => BillingRegime::ModelQuota,
            CreditsBlock::Object(c) => c.regime(),
            CreditsBlock::Undetermined => BillingRegime::Unknown,
        }
    }
}

/// El régimen de facturación de la cuenta, tal y como lo declara el payload del
/// proveedor. El frente lo trata como **texto opaco**: no sabe qué significa, sólo
/// compara si cambió entre dos informes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BillingRegime {
    /// La cuenta se factura en créditos: lo dice el bloque `credits` del payload.
    Credits { frozen: bool },
    /// La cuenta se factura con una asignación por modelo (el bloque `credits` vino
    /// `null`).
    ModelQuota,
    /// No se pudo leer el dato que lo decide: el informe no declara régimen y no
    /// afirma el tipo de cuenta.
    Unknown,
}

impl BillingRegime {
    /// El texto opaco que viaja en el informe (el frente no lo interpreta).
    pub fn label(self) -> Option<&'static str> {
        match self {
            BillingRegime::Credits { .. } => Some(CREDITS_REGIME),
            BillingRegime::ModelQuota => Some(MODEL_QUOTA_REGIME),
            BillingRegime::Unknown => None,
        }
    }
}

/// Los literales del régimen: texto opaco y estable. No nombran al proveedor ni al
/// plan (el frente no puede deducir nada de ellos).
pub(crate) const CREDITS_REGIME: &str = "credits";
pub(crate) const MODEL_QUOTA_REGIME: &str = "model-quota";

/// Lo que se dice cuando no se pudo determinar el tipo de cuenta: el informe no
/// afirma que la cuota de la cuenta sea por modelo, porque no se pudo comprobar.
const UNKNOWN_REGIME_NOTE: &str =
    "no se pudo determinar el tipo de cuenta: los topes por modelo pueden no aplicarle";

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
    // Las credenciales salen del almacén seguro. El cuerpo del refresco las recibe ya
    // resueltas: el llavero no es inyectable y un test no puede escribir en el
    // almacén seguro de la persona, así que el camino con API key se ejercita con las
    // credenciales fijadas en memoria.
    let key = who.secret(secrets::NAN_API_KEY);
    let cookie = who.secret(secrets::NAN_SESSION);
    refresh_with_credentials(
        cfg,
        who,
        http,
        key.as_deref(),
        cookie.as_deref(),
        nan_cloud::API,
    )
    .await
}

/// El cuerpo del refresco, con las credenciales ya resueltas.
///
/// Es **el mismo camino que `fetch`** (mismos pasos, mismas peticiones, misma
/// declaración): lo único que cambia es de dónde salen la API key y la cookie. El
/// seam está aquí para que el test pueda recorrer el camino con API key de punta a
/// punta contra un servidor local, sin tocar el llavero.
///
/// La base del panel de NaN Cloud también es un parámetro: en producción es
/// `nan_cloud::API` (fija, la misma que usa `whoami`) y los tests pasan la de su
/// servidor local. No vive en la configuración del usuario.
pub(crate) async fn refresh_with_credentials(
    cfg: &NanConfig,
    who: Who<'_>,
    http: &reqwest::Client,
    key: Option<&str>,
    cookie: Option<&str>,
    base: &str,
) -> UsageReport {
    let mut report = who.report("NaN Builders", Kind::Subscription);
    report.plan = Some(plan_name(&cfg.plan).into());

    let now = Utc::now();
    let period_start = billing_period_start(now, cfg.billing_day);
    let from = month_start(now).min(period_start);

    // EL RÉGIMEN, en un solo sitio. La única fuente documentada del bloque `credits`
    // es la raíz de `GET /v1/usage` (el panel de Cloud no lo publica), así que la
    // lectura de esa página es la que lo decide — y sólo si hay API key: sin key no
    // hay forma de leerla y el régimen queda desconocido.
    let (regime, first_page) = match key {
        Some(k) => match usage_page(cfg, http, k, from, now, None).await {
            Ok(page) => (regime_of(&page), Some(page)),
            // Sin lectura no se sabe el régimen: no se inventa ninguno.
            Err(_) => (BillingRegime::Unknown, None),
        },
        None => (BillingRegime::Unknown, None),
    };

    // A. Sesión de NaN Cloud: los mismos datos que el dashboard (preferente).
    let mut note: Option<String> = None;
    if let Some(cookie) = cookie {
        match nan_cloud::fetch(http, cookie, base).await {
            Ok(u) => {
                report.daily = u.daily;
                // La supresión de los medidores por modelo de una cuenta facturada en
                // créditos vive en UN solo sitio (`credits_declaration`), que usan los
                // dos caminos: esos topes no existen para esa cuenta, tampoco en la
                // sesión.
                if let Some(declared) = credits_declaration(regime) {
                    declared.apply_to_report(&mut report);
                    return report;
                }
                report.meters = session_meters_with_basis(u.meters);
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
                // El payload trajo modelos que no se pudieron declarar: el informe
                // degrada a aviso y los nombra (un total incompleto no puede
                // presentarse como completo).
                if !u.dropped.is_empty() {
                    report.status = Status::Warning;
                    report.message = Some(join_message(
                        report.message.take(),
                        &dropped_note(&u.dropped),
                    ));
                }
                // El régimen sólo se declara si se pudo determinar: el frente lo trata
                // como texto opaco y un régimen desconocido no se inventa.
                report.billing_regime = regime.label();
                // Con API key, un régimen desconocido SÓLO puede significar que la
                // lectura de `/v1/usage` falló (con key la lectura o acierta y el
                // régimen es `credits`/`model-quota`, o falla y queda desconocido): el
                // informe no afirma el tipo de cuenta y degrada a aviso, con la nota
                // que lo dice. Sin API key no hay lectura que haya fallado (el régimen
                // queda desconocido sin más) y el `ok` se queda como estaba.
                if key.is_some() && regime == BillingRegime::Unknown {
                    report.status = Status::Warning;
                    // `join_message` une las dos partes; si el mensaje de la sesión
                    // está vacío (las métricas del panel no respondieron), la nota
                    // queda sola en vez de dejar un separador suelto delante.
                    let previous = report.message.take().filter(|m| !m.trim().is_empty());
                    report.message = Some(join_message(previous, UNKNOWN_REGIME_NOTE));
                }
                return report;
            }
            Err(nan_cloud::CloudError::Expired) => {
                note = Some(
                    "La sesión de NaN ha caducado: vuelve a conectar tu cuenta en Ajustes.".into(),
                );
            }
            Err(nan_cloud::CloudError::Other(e)) => {
                note = Some(format!("NaN Cloud no responde ({e})."));
            }
        }
    }

    // B. API key: la cuota de la cuenta (el mismo payload que el panel) y, si no
    //    responde, el consumo de `/v1/usage` con la cuota publicada.
    let Some(key) = key else {
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
        .bearer_auth(key)
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

    // Los medidores de CUOTA del informe: van aparte porque el informe puede ser MIXTO
    // (los medidores extra y los de rate limit, sin los de cuota).
    let mut quota: Vec<Meter> = Vec::new();
    if let Some(declared) = credits_declaration(regime) {
        // Una cuenta facturada en créditos NO tiene topes por modelo: esos topes no
        // existen para esa cuenta. No se declaran medidores por modelo ni se recurre a la
        // cuota publicada (`known_quotas()`), y ni se lee la cuota de la cuenta. Lo
        // decide el backend; el frente no lo repite.
        declared.apply(&mut report, &mut quota);
    } else {
        // 2. La cuota de la cuenta: `GET /api/usage/quota` del panel de NaN con la MISMA API
        //    key. `cap` es la asignación de la cuenta para el periodo en curso (el mismo
        //    número que el panel muestra como "Allowance per billing period"), así que cuota,
        //    consumo y fechas salen del mismo payload: la cabecera y los medidores no
        //    muestran periodos distintos.
        //    `Some` (el panel respondió) y `None` (el panel no respondió) son dos cosas: un
        //    payload válido SIN modelos no es un endpoint caído. El motivo de la caída se
        //    guarda: no es lo mismo un 401 que un timeout, y el mensaje lo dice.
        let (account_meters, dropped, account_failure) =
            match nan_cloud::fetch_account_quota(http, key, base).await {
                Ok(payload) => {
                    let parsed = nan_cloud::parse_quota(&payload);
                    (Some(parsed.meters), parsed.dropped, None)
                }
                Err(e) => (None, Vec::new(), Some(cloud_failure(e))),
            };

        if let Some(meters) = account_meters {
            // 3. La cuota de la cuenta manda: no se lee `/v1/usage` (mide el consumo de esta
            //    key, de otro periodo) ni se usa `billing_day` (el periodo es el del payload).
            let declared = declare(
                regime,
                Some(meters),
                &dropped,
                None,
                &quotas,
                now,
                cfg.billing_day,
            );
            declared.apply(&mut report, &mut quota);
        } else {
            // 4. Consumo del periodo (el camino de respaldo: la cuota publicada, señalada).
            match fetch_usage(cfg, http, key, from, now, first_page).await {
                Ok(pages) => {
                    let declared = declare_usage(&pages, &dropped, &quotas, now, cfg.billing_day);
                    declared.apply(&mut report, &mut quota);
                    // El motivo por el que se cayó la cuota de la cuenta va en el mensaje:
                    // no es lo mismo un 401 que un timeout.
                    if let Some(reason) = &account_failure {
                        report.message = Some(join_message(
                            report.message.take(),
                            &format!("la cuota de la cuenta no respondió ({reason})"),
                        ));
                    }
                }
                Err(e) => {
                    report.status = Status::Warning;
                    let mut message =
                        format!("No pude leer /v1/usage ({e}). {}", plan_quota(&cfg.plan));
                    if let Some(reason) = &account_failure {
                        message =
                            format!("{message} · la cuota de la cuenta no respondió ({reason})");
                    }
                    if !dropped.is_empty() {
                        message = format!("{message} · {}", dropped_note(&dropped));
                    }
                    report.message = Some(message);
                    // El régimen ya se conoce si la lectura tuvo éxito.
                    report.billing_regime = regime.label();
                }
            }
        }
    }

    // 5. Endpoint propio opcional (avanzado) + cabeceras de rate limit
    let own = custom_usage(cfg, http, key).await;
    report.meters = compose_meters(quota, own, rate_meters);
    if let Some(n) = note {
        report.status = Status::Warning;
        report.message = Some(match report.message.take() {
            Some(m) => format!("{n} {m}"),
            None => n,
        });
    }
    report
}

/// Compone los medidores del informe en un solo sitio: primero el propio, después los de
/// cuota y al final los de rate limit. Es el único camino de verdad del orden, para que el
/// frente siempre reciba la misma lista (aunque el informe salga MIXTO, sin medidores de
/// cuota, cuando el periodo no se pudo leer).
pub(crate) fn compose_meters(
    quota: Vec<Meter>,
    own: Option<Meter>,
    rate: Vec<Meter>,
) -> Vec<Meter> {
    let mut out = Vec::with_capacity(quota.len() + rate.len() + usize::from(own.is_some()));
    out.extend(own);
    out.extend(quota);
    out.extend(rate);
    out
}

/// Una página de `/v1/usage` para la ventana pedida (con su cursor, si lo hay).
///
/// La primera página es también la que trae el bloque `credits` de la raíz: el que
/// decide el régimen de facturación.
async fn usage_page(
    cfg: &NanConfig,
    http: &reqwest::Client,
    key: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    cursor: Option<&str>,
) -> Result<Value, String> {
    let mut q = vec![
        ("start_date", from.format("%Y-%m-%d").to_string()),
        ("end_date", to.format("%Y-%m-%d").to_string()),
    ];
    if let Some(c) = cursor {
        q.push(("cursor", c.to_string()));
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
    res.json::<Value>()
        .await
        .map_err(|e| format!("respuesta no JSON: {e}"))
}

/// El número máximo de páginas de `/v1/usage` que se leen en un ciclo.
const MAX_PAGES: usize = 10;

/// Llama a `/v1/usage` siguiendo `next_cursor` (máx. 10 páginas). La primera página
/// puede venir ya leída (la misma que se leyó para decidir el régimen), así que el
/// ciclo no la pide dos veces.
///
/// El corte es ANTES de pedir la página siguiente: en la última vuelta ya no se pide
/// la que se descartaría.
async fn fetch_usage(
    cfg: &NanConfig,
    http: &reqwest::Client,
    key: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    first: Option<Value>,
) -> Result<Vec<Value>, String> {
    let mut pages = vec![];
    let mut body = match first {
        Some(page) => page,
        None => usage_page(cfg, http, key, from, to, None).await?,
    };
    for page in 0..MAX_PAGES {
        let cursor = body
            .get("next_cursor")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_string);
        pages.push(body);
        let Some(c) = cursor else { break };
        // Ya se han leído las 10 páginas: la siguiente se descartaría, así que no se pide.
        if page + 1 == MAX_PAGES {
            break;
        }
        body = usage_page(cfg, http, key, from, to, Some(&c)).await?;
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
                        .and_then(|v| v.as_object())
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
                quota_source: None,
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

// ───────────────────────── lo que declara el backend ─────────────────────────

/// Meters of the account: the account quota wins; published quotas are only the fallback.
///
/// The account payload carries quota, usage and period dates together, so when it arrives
/// the report describes that very period: the header and the meters never mix periods.
/// `usage` is the aggregated consumption of the API key (`/v1/usage`), used only when the
/// account payload does not answer.
pub(crate) fn nan_meters(
    regime: BillingRegime,
    account_meters: Option<Vec<Meter>>,
    usage: Option<(&UsageSummary, &UsageSummary)>,
    published: &BTreeMap<String, Quota>,
    now: DateTime<Utc>,
    billing_day: u32,
) -> (Vec<Meter>, QuotaSource, String) {
    // The account quota carries quota, usage and period dates in the same payload.
    // `Some` means the panel answered: an account payload WITHOUT models is not a
    // failed endpoint, so the published quotas are not used as a fallback (those
    // allowances may not exist for this account).
    if let Some(meters) = account_meters {
        if meters.is_empty() {
            return (Vec::new(), QuotaSource::Account, NO_ACCOUNT_MODELS.into());
        }
        let total: f64 = meters.iter().filter_map(|m| m.used).sum();
        let header = usage_message(total, QuotaSource::Account, regime);
        return (
            declare_basis(meters, QuotaSource::Account),
            QuotaSource::Account,
            header,
        );
    }
    let Some((month, period)) = usage else {
        // Sin lectura de `/v1/usage` no hay nada que medir; el error lo arma quien lo sabe.
        return (Vec::new(), QuotaSource::None, String::new());
    };
    let meters = quota_meters(month, period, published, now, billing_day);
    if meters.is_empty() {
        let header = usage_message(month.total(), QuotaSource::None, regime);
        (Vec::new(), QuotaSource::None, header)
    } else {
        let header = usage_message(month.total(), QuotaSource::Published, regime);
        (
            declare_basis(meters, QuotaSource::Published),
            QuotaSource::Published,
            header,
        )
    }
}

/// El camino de respaldo: el consumo del periodo, cuando la cuota de la cuenta no
/// respondió. La cuota es la publicada y el informe lo dice.
pub(crate) fn declare_usage(
    pages: &[Value],
    dropped: &[nan_cloud::Dropped],
    published: &BTreeMap<String, Quota>,
    now: DateTime<Utc>,
    billing_day: u32,
) -> Declared {
    // La misma respuesta que trae el consumo decide el régimen: si el bloque `credits`
    // viene con contenido, la cuenta se factura en créditos y NO se declaran los
    // medidores por modelo ni se recurre a la cuota publicada (esos topes no existen
    // para una cuenta facturada en créditos). Sin lectura extra a la red.
    let regime = pages
        .first()
        .map(regime_of)
        .unwrap_or(BillingRegime::Unknown);
    // Para el mes natural solo contamos días del mes; para glm5.3, desde el inicio del periodo.
    let month = summarize(pages, Some(month_start(now)));
    let period = summarize(pages, Some(billing_period_start(now, billing_day)));
    declare(
        regime,
        None,
        dropped,
        Some((&month, &period)),
        published,
        now,
        billing_day,
    )
}

/// Lo que declara el backend: los medidores, la cabecera y el estado.
pub(crate) struct Declared {
    pub meters: Vec<Meter>,
    pub header: String,
    pub status: Status,
    /// El régimen de facturación que declara el backend: viaja en el informe como texto
    /// opaco (el frente sólo compara si cambió).
    pub regime: BillingRegime,
}

impl Declared {
    /// Aplica lo declarado al informe: estado, cabecera y régimen. Los medidores de
    /// cuota se componen aparte (con los propios y los de rate limit).
    pub fn apply(self, report: &mut UsageReport, quota: &mut Vec<Meter>) {
        let Declared {
            meters,
            header,
            status,
            regime,
        } = self;
        *quota = meters;
        report.message = Some(header);
        report.status = status;
        report.billing_regime = regime.label();
    }

    /// Aplica lo declarado al informe (estado, cabecera y régimen) SIN los medidores:
    /// lo usa el camino de sesión, que compone sus medidores aparte (y con créditos
    /// no hay medidores por modelo que componer).
    pub fn apply_to_report(self, report: &mut UsageReport) {
        let Declared {
            header,
            status,
            regime,
            ..
        } = self;
        report.message = Some(header);
        report.status = status;
        report.billing_regime = regime.label();
    }
}

/// Lo que declara el backend cuando la cuenta se factura en créditos: NINGÚN medidor
/// por modelo (esos topes no existen para una cuenta facturada en créditos) ni cuota
/// publicada, y la cabecera que lo dice.
///
/// Es el **único** sitio de la supresión: los dos caminos (sesión y API key) lo usan,
/// para que las dos copias no puedan divergir. La asignación del periodo, el saldo de
/// packs y el desglose por modelo son de la otra mitad del alcance (#268).
///
/// `frozen` es «la suscripción no está activa» (las peticiones se rechazan): algo que
/// merece atención, aunque no haya datos.
fn credits_declaration(regime: BillingRegime) -> Option<Declared> {
    let BillingRegime::Credits { frozen } = regime else {
        return None;
    };
    Some(Declared {
        meters: Vec::new(),
        header: credits_message(frozen),
        status: if frozen { Status::Warning } else { Status::Ok },
        regime,
    })
}

/// Lo que declara el backend, según de dónde sale la cuota: la de la cuenta manda y la
/// publicada queda de respaldo.
///
/// `regime` es lo que declara el proveedor (el bloque `credits` de `/v1/usage`): con
/// créditos NO hay medidores por modelo ni cuota publicada, porque esos topes no
/// existen para una cuenta facturada en créditos. La decisión no llega al frente: sólo
/// llegan los datos.
///
/// `dropped` son los modelos que el payload trajo y no se pudieron declarar: si hay
/// alguno, el informe degrada a aviso y los nombra (un total incompleto no puede
/// presentarse como completo).
pub(crate) fn declare(
    regime: BillingRegime,
    account_meters: Option<Vec<Meter>>,
    dropped: &[nan_cloud::Dropped],
    usage: Option<(&UsageSummary, &UsageSummary)>,
    published: &BTreeMap<String, Quota>,
    now: DateTime<Utc>,
    billing_day: u32,
) -> Declared {
    if let Some(declared) = credits_declaration(regime) {
        return declared;
    }
    let (meters, source, header) =
        nan_meters(regime, account_meters, usage, published, now, billing_day);
    let mut declared = Declared {
        meters,
        header,
        status: status_for(source),
        regime,
    };
    if regime == BillingRegime::Unknown {
        // No se pudo determinar el tipo de cuenta: el informe no lo afirma y degrada de
        // forma visible, en vez de salir `ok` como si los medidores por modelo fueran la
        // cuota de la cuenta.
        declared.status = Status::Warning;
    }
    if !dropped.is_empty() {
        declared.status = Status::Warning;
        declared.header = format!("{} · {}", declared.header, dropped_note(dropped));
    }
    // Nunca `ok` sin medidores: así los datos anteriores quedan como desactualizados en
    // vez de borrarse en silencio.
    if declared.meters.is_empty() && declared.status == Status::Ok {
        declared.status = Status::Warning;
    }
    declared
}

/// El régimen que declara el payload: el bloque `credits` de la raíz de `/v1/usage` es
/// `null` si la cuenta NO se factura en créditos. Éste es el **único** sitio que decide
/// el régimen: los dos caminos (sesión y API key) llegan aquí con la página leída.
pub(crate) fn regime_of(page: &Value) -> BillingRegime {
    parse_credits(page).regime()
}

/// Lee el bloque `credits` de la raíz de `/v1/usage`.
///
/// El contrato (`https://nan.builders/openapi.json`) lo declara como
/// `UsageCredits | null`, y ese `null` es lo que significa «la cuenta NO se factura en
/// créditos». La clave ausente —o un bloque con otra forma— NO es ese `null`: es un
/// payload que ya no coincide con el contrato, así que no se puede afirmar el tipo de
/// la cuenta (y el informe no lo afirma).
pub(crate) fn parse_credits(page: &Value) -> CreditsBlock {
    match page.get("credits") {
        None => CreditsBlock::Undetermined,
        Some(Value::Null) => CreditsBlock::Null,
        Some(Value::Object(block)) => CreditsBlock::Object(Credits {
            frozen: block
                .get("frozen")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        Some(_) => CreditsBlock::Undetermined,
    }
}

/// La cabecera del informe cuando la cuenta se factura en créditos: la indicación de
/// que la cuenta se factura en créditos (y el aviso de suscripción inactiva, si la
/// hay). El texto lo arma el backend (el frente no interpreta nada).
fn credits_message(frozen: bool) -> String {
    let mut parts: Vec<String> = vec!["la cuenta se factura en créditos".into()];
    if frozen {
        parts.push("suscripción inactiva: las peticiones se rechazan".into());
    }
    parts.join(" · ")
}

/// Header of the report: it names the period the numbers come from. The published quota is
/// flagged as a fallback, not as the account one. In the fallback path two windows live
/// together (the month's figures follow the natural month, the `glm5.3` meter follows the
/// billing period) and the header says so.
///
/// With an unknown regime the header does not claim the account type: it says it could
/// not be determined.
fn usage_message(total: f64, source: QuotaSource, regime: BillingRegime) -> String {
    match source {
        QuotaSource::Account => {
            if regime == BillingRegime::Unknown {
                return format!(
                    "{} tokens del periodo de la cuenta · {UNKNOWN_REGIME_NOTE}",
                    compact(total)
                );
            }
            format!("{} tokens del periodo de la cuenta · cuotas por modelo", compact(total))
        }
        QuotaSource::Published => format!(
            "{} tokens este mes · cuotas por modelo · cuota publicada (no es la asignación de tu cuenta) · el total del mes sigue el mes natural y el medidor de glm5.3 sigue el periodo de facturación",
            compact(total)
        ),
        // Hay cuotas, pero el proveedor no devolvió consumo para ellas: el mensaje dice
        // que no hay datos, no que no haya cuotas con contador.
        QuotaSource::None => {
            "No hay datos de consumo disponibles para los modelos con cuota.".into()
        }
    }
}

/// Los modelos que el payload trajo y no se pudieron declarar, nombrados con su motivo:
/// el informe degrada a aviso y los nombra, para que un total incompleto no se presente
/// como completo.
fn dropped_note(dropped: &[nan_cloud::Dropped]) -> String {
    let names: Vec<String> = dropped
        .iter()
        .map(|d| {
            if d.model.is_empty() {
                format!("({})", d.reason)
            } else {
                format!("{} ({})", d.model, d.reason)
            }
        })
        .collect();
    format!(
        "el payload trajo {} modelo(s) sin datos completos: {}",
        dropped.len(),
        names.join(", ")
    )
}

/// La base de medición viaja en cada medidor de cuota: el proveedor la declara y el
/// frente la trata como texto opaco (no sabe qué significa, solo si cambió).
fn quota_source_name(source: QuotaSource) -> Option<&'static str> {
    match source {
        QuotaSource::Account => Some("account"),
        QuotaSource::Published => Some("published"),
        QuotaSource::None => None,
    }
}

/// Declara en cada medidor la base contra la que se midió.
fn declare_basis(mut meters: Vec<Meter>, source: QuotaSource) -> Vec<Meter> {
    let basis = quota_source_name(source);
    for m in &mut meters {
        m.quota_source = basis;
    }
    meters
}

/// La cuota de la sesión es la asignación de la cuenta: sus medidores declaran esa base.
/// Los medidores que no son de cuota (el propio, las cabeceras de rate limit) no la
/// declaran: sin base, el frente los compara siempre.
fn session_meters_with_basis(meters: Vec<Meter>) -> Vec<Meter> {
    declare_basis(meters, QuotaSource::Account)
}

/// El motivo por el que se cayó la cuota de la cuenta: no es lo mismo un 401 que un
/// timeout, y el mensaje del informe lo dice.
fn cloud_failure(e: nan_cloud::CloudError) -> String {
    match e {
        nan_cloud::CloudError::Expired => "el panel de NaN rechazó la API key (401)".into(),
        nan_cloud::CloudError::Other(e) => e,
    }
}

/// Une dos partes del mensaje del informe.
fn join_message(first: Option<String>, second: &str) -> String {
    match first {
        Some(m) => format!("{m} · {second}"),
        None => second.to_string(),
    }
}

/// Estado del informe según de dónde salió la cuota: la de la cuenta va en `ok`; una cuota
/// publicada o ninguna cuota son avisos. Nunca `ok` sin medidores: así los datos anteriores
/// quedan como desactualizados en vez de borrarse en silencio.
///
/// OJO: el aviso de `QuotaSource::None` es un estado NUEVO (antes ese caso salía en
/// `ok`): cambia lo que se ve cuando el proveedor no da datos de consumo, y por eso el
/// mensaje lo explica en vez de dejar un informe vacío y limpio.
fn status_for(source: QuotaSource) -> Status {
    match source {
        QuotaSource::Account => Status::Ok,
        QuotaSource::Published | QuotaSource::None => Status::Warning,
    }
}

/// El payload de la cuenta respondió y no declaró ningún modelo con cuota: no es un
/// endpoint caído (no se recurre a la cuota publicada), es una cuenta sin topes por
/// modelo que mostrar.
const NO_ACCOUNT_MODELS: &str = "La cuenta no declara cuotas por modelo.";

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
        // El cluster de DeepSeek tiene tope por modelo en la cuenta (1 B en la cuenta
        // real): el texto no puede decir que ese modelo no tiene contador.
        _ => "Plan: cluster con cuota por modelo · DeepSeek V4-Flash.",
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
            quota_source: None,
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
        quota_source: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

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
            BillingRegime::ModelQuota,
            Some(nan_cloud::parse_quota(&payload).meters),
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
        let msg = usage_message(
            1_452_206_378.0,
            QuotaSource::Account,
            BillingRegime::ModelQuota,
        );
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
            BillingRegime::ModelQuota,
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
        let payload = nan_cloud::real_account_payload();
        let (meters, source, header) = nan_meters(
            BillingRegime::ModelQuota,
            Some(nan_cloud::parse_quota(&payload).meters),
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
        assert_eq!(meters[0].window_seconds, Some(30 * 86400));
        assert!(header.contains("periodo de la cuenta"), "{header}");
        assert!(!header.contains("este mes"), "{header}");
    }

    #[test]
    fn the_api_key_path_divides_by_the_allowance_of_the_account() {
        // The API key path reads the same account payload: the denominator is the
        // allowance of the account (`cap`), not the published table.
        let payload = nan_cloud::real_account_payload();
        let (meters, source, _header) = nan_meters(
            BillingRegime::ModelQuota,
            Some(nan_cloud::parse_quota(&payload).meters),
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
        let mut payload = nan_cloud::real_account_payload();
        if let Some(models) = payload["models"].as_array_mut() {
            for model in models {
                model["tokensUsed"] = json!(0);
            }
        }
        let (meters, source, _header) = nan_meters(
            BillingRegime::ModelQuota,
            Some(nan_cloud::parse_quota(&payload).meters),
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
    fn an_account_payload_without_models_is_not_the_published_fallback() {
        // Un payload válido SIN modelos no es un endpoint caído: la cuota publicada no
        // se usa (esos topes pueden no existir para esta cuenta). `Some(vacío)` y
        // `None` son dos cosas distintas.
        let (meters, source, header) = nan_meters(
            BillingRegime::Unknown,
            Some(Vec::new()),
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(source, QuotaSource::Account);
        assert!(meters.is_empty());
        assert!(
            header.contains("no declara cuotas por modelo"),
            "el mensaje dice que la cuenta no declara cuotas: {header}"
        );
    }

    #[test]
    fn an_account_payload_without_models_degrades_the_report() {
        // Sin medidores de cuota el informe no va en `ok`: nunca `ok` sin medidores,
        // para que los datos anteriores no se borren en silencio.
        let declared = declare(
            BillingRegime::Unknown,
            Some(Vec::new()),
            &[],
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(declared.status, Status::Warning);
        assert!(declared.meters.is_empty());
    }

    #[test]
    fn the_failure_reason_names_what_happened() {
        // No es lo mismo un 401 que un timeout: el motivo de la caída va en el mensaje.
        assert!(
            cloud_failure(nan_cloud::CloudError::Expired).contains("401"),
            "el 401 se dice"
        );
        assert_eq!(
            cloud_failure(nan_cloud::CloudError::Other(
                "HTTP 500 en /api/usage/quota".into()
            )),
            "HTTP 500 en /api/usage/quota"
        );
    }

    #[test]
    fn the_plan_text_does_not_claim_that_deepseek_has_no_counter() {
        // La cuenta trae un tope de 1 B para DeepSeek: el texto del plan no puede
        // decir que ese modelo no tiene contador.
        let text = plan_quota("member");
        assert!(!text.contains("sin contador"), "{text}");
        assert!(text.contains("DeepSeek V4-Flash"), "{text}");
    }

    #[test]
    fn the_report_says_when_there_is_no_consumption_data() {
        // Hay cuotas, pero el proveedor no devolvió consumo para ellas: el mensaje dice
        // que no hay datos, no que no haya cuotas con contador.
        let msg = usage_message(0.0, QuotaSource::None, BillingRegime::ModelQuota);
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
    fn the_fallback_header_explains_the_mix_of_windows() {
        // En el camino de fallback conviven dos ventanas: las cifras del mes siguen el
        // mes natural y el medidor de glm5.3 sigue el periodo de facturación. El
        // mensaje del informe lo explica (el texto de `billingDay` explica cuándo se
        // usa, no esta mezcla).
        let header = usage_message(
            1_452_206_378.0,
            QuotaSource::Published,
            BillingRegime::ModelQuota,
        );
        assert!(header.contains("mes natural"), "{header}");
        assert!(header.contains("periodo de facturación"), "{header}");
        assert!(header.contains("glm5.3"), "{header}");
    }

    #[test]
    fn the_header_text_does_not_change_for_the_sources_with_data() {
        // El texto de la cuenta se mantiene byte a byte; el de la cuota publicada
        // explica además la mezcla de ventanas (mes natural y periodo de facturación).
        assert_eq!(
            usage_message(
                1_452_206_378.0,
                QuotaSource::Account,
                BillingRegime::ModelQuota
            ),
            "1.5B tokens del periodo de la cuenta · cuotas por modelo"
        );
        assert_eq!(
            usage_message(1_452_206_378.0, QuotaSource::Published, BillingRegime::ModelQuota),
            "1.5B tokens este mes · cuotas por modelo · cuota publicada (no es la asignación de tu cuenta) · el total del mes sigue el mes natural y el medidor de glm5.3 sigue el periodo de facturación"
        );
    }

    #[test]
    fn the_quota_source_names_are_the_providers_own_words() {
        assert_eq!(quota_source_name(QuotaSource::Account), Some("account"));
        assert_eq!(quota_source_name(QuotaSource::Published), Some("published"));
        assert_eq!(quota_source_name(QuotaSource::None), None);
    }

    #[test]
    fn the_quota_meters_declare_the_basis_they_were_measured_against() {
        // La base viaja en cada medidor: la de la cuenta y la publicada son bases
        // distintas, y el frente solo las compara como texto.
        let payload = nan_cloud::real_account_payload();
        let (account, source, _header) = nan_meters(
            BillingRegime::ModelQuota,
            Some(nan_cloud::parse_quota(&payload).meters),
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(source, QuotaSource::Account);
        assert!(!account.is_empty());
        assert!(
            account.iter().all(|m| m.quota_source == Some("account")),
            "los medidores de la cuenta declaran su base: {:?}",
            account.iter().map(|m| m.quota_source).collect::<Vec<_>>()
        );

        let month = UsageSummary {
            per_model: BTreeMap::from([("deepseek-v4-flash".to_string(), 600_000_000.0)]),
            per_day: BTreeMap::new(),
        };
        let (published, source, _header) = nan_meters(
            BillingRegime::ModelQuota,
            None,
            Some((&month, &UsageSummary::default())),
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(source, QuotaSource::Published);
        assert!(
            published
                .iter()
                .all(|m| m.quota_source == Some("published")),
            "los medidores de la cuota publicada declaran su base: {:?}",
            published.iter().map(|m| m.quota_source).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_session_meters_declare_the_account_basis() {
        // La cuota de la sesión es la asignación de la cuenta: sus medidores lo dicen.
        let meters = session_meters_with_basis(vec![Meter::default()]);
        assert_eq!(meters[0].quota_source, Some("account"));
        // Sin medidores no hay cuota que nombrar.
        assert!(session_meters_with_basis(vec![]).is_empty());
    }

    #[test]
    fn the_meters_without_a_quota_declare_no_basis() {
        // El medidor propio y los de las cabeceras de rate limit no se miden contra
        // una cuota: no declaran base, así que el frente los compara como siempre.
        let cfg = NanConfig {
            used_pointer: Some("/u".into()),
            ..Default::default()
        };
        let custom = pointer_meter(&json!({"u": 1}), &cfg).unwrap();
        assert_eq!(custom.quota_source, None);
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-limit-requests", HeaderValue::from_static("60"));
        h.insert(
            "x-ratelimit-remaining-requests",
            HeaderValue::from_static("45"),
        );
        let rate = rate_limit_meters(&h);
        assert_eq!(rate[0].quota_source, None);
    }

    #[test]
    fn a_partial_payload_degrades_the_report_and_names_the_model() {
        // Un payload parcial no pierde medidores en silencio: el modelo que sí se puede
        // declarar se declara, el estado degrada a aviso y el mensaje nombra el modelo
        // que falta y por qué.
        let payload = json!({"periodStart": "2026-10-01", "models": [
            {"model": "deepseek-v4-flash", "tokensUsed": 200_000_000u64, "cap": 1_000_000_000u64, "periodEnd": "2026-11-01T00:00:00Z"},
            {"model": "glm5.3-flash", "tokensUsed": 100_000_000u64, "periodEnd": "2026-11-01T00:00:00Z"}
        ]});
        let parsed = nan_cloud::parse_quota(&payload);
        assert_eq!(parsed.meters.len(), 1);
        assert_eq!(parsed.meters[0].id, "model:deepseek-v4-flash");
        assert_eq!(parsed.dropped.len(), 1);
        assert_eq!(parsed.dropped[0].model, "glm5.3-flash");

        let declared = declare(
            BillingRegime::ModelQuota,
            Some(parsed.meters),
            &parsed.dropped,
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(declared.status, Status::Warning);
        assert!(
            declared.header.contains("glm5.3-flash"),
            "el mensaje nombra el modelo que falta: {}",
            declared.header
        );
        assert!(
            declared.header.contains("sin cap"),
            "el mensaje dice por qué: {}",
            declared.header
        );
        // El modelo que sí se pudo declarar sigue en el informe.
        assert_eq!(declared.meters.len(), 1);
        assert_eq!(declared.meters[0].id, "model:deepseek-v4-flash");
    }

    #[test]
    fn a_complete_payload_does_not_degrade_the_report() {
        // Sin modelos descartados no hay nada que avisar: el informe de la cuenta va en
        // `ok` y su mensaje no menciona ningún modelo.
        let payload = nan_cloud::real_account_payload();
        let parsed = nan_cloud::parse_quota(&payload);
        let declared = declare(
            BillingRegime::ModelQuota,
            Some(parsed.meters),
            &parsed.dropped,
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(declared.status, Status::Ok);
        assert!(
            !declared.header.contains("sin datos completos"),
            "{}",
            declared.header
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
    fn the_report_composes_the_own_meter_first_and_then_the_quota_and_the_rate_ones() {
        // El informe se arma siempre igual: primero el medidor propio, después los de
        // cuota y al final los de rate limit.
        let quota = vec![
            Meter {
                id: "model:glm5.3".into(),
                ..Default::default()
            },
            Meter {
                id: "model:deepseek-v4-flash".into(),
                ..Default::default()
            },
        ];
        let own = Meter {
            id: "custom".into(),
            ..Default::default()
        };
        let rate = vec![Meter {
            id: "rate_requests".into(),
            ..Default::default()
        }];
        let meters = compose_meters(quota, Some(own), rate);
        assert_eq!(
            meters.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec![
                "custom",
                "model:glm5.3",
                "model:deepseek-v4-flash",
                "rate_requests"
            ]
        );
    }

    #[test]
    fn without_quota_meters_the_report_keeps_the_own_and_the_rate_ones() {
        // El caso MIXTO: sin medidores de cuota (el periodo no se pudo leer) el informe
        // lleva solo los medidores extra. El frente tiene que saber distinguirlos.
        let own = Meter {
            id: "custom".into(),
            ..Default::default()
        };
        let rate = vec![Meter {
            id: "rate_tokens".into(),
            ..Default::default()
        }];
        let meters = compose_meters(Vec::new(), Some(own), rate);
        assert_eq!(
            meters.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["custom", "rate_tokens"]
        );
        // Y sin medidor propio tampoco: los de cuota y los de rate limit, en ese orden.
        let meters = compose_meters(
            vec![Meter {
                id: "model:glm5.3".into(),
                ..Default::default()
            }],
            None,
            vec![Meter {
                id: "rate_requests".into(),
                ..Default::default()
            }],
        );
        assert_eq!(
            meters.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["model:glm5.3", "rate_requests"]
        );
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

    // ───────────── el régimen de facturación ─────────────

    /// Ejemplo publicado por el proveedor en su OpenAPI (`GET /v1/usage`): el bloque
    /// `credits` de una cuenta facturada en créditos, con los nombres EXACTOS del
    /// contrato público (`period_start`, `period_end`, `allowance`, `used`,
    /// `remaining`, `pack_credits`, `pack_expires_at`, `frozen`).
    /// NO es una captura real: la captura de una cuenta de Inference o Premium sigue
    /// pendiente (S18) y el trabajo se hace contra el contrato público.
    fn published_credits_page() -> Value {
        json!({
            "object": "list",
            "data": [],
            "credits": {
                "period_start": "2026-11-01T00:00:00Z",
                "period_end": "2026-12-01T00:00:00Z",
                "allowance": 7000,
                "used": 24.3,
                "remaining": 6975.7,
                "pack_credits": 0,
                "pack_expires_at": null,
                "frozen": false
            }
        })
    }

    #[test]
    fn the_credits_block_decides_the_billing_regime() {
        // El bloque `credits` de la raíz de `/v1/usage` es `null` cuando la cuenta
        // NO se factura en créditos: el régimen lo decide el payload, no el nombre del
        // plan, y lo decide el backend (no el frente).
        assert_eq!(
            regime_of(&published_credits_page()),
            BillingRegime::Credits { frozen: false }
        );
        assert_eq!(
            regime_of(&json!({"credits": null})),
            BillingRegime::ModelQuota
        );
    }

    #[test]
    fn a_missing_or_malformed_credits_block_leaves_the_regime_unknown() {
        // El contrato (`https://nan.builders/openapi.json`) declara `credits` como
        // `UsageCredits | null`, y ese `null` es lo que significa «la cuenta NO se
        // factura en créditos». Una clave AUSENTE —o un bloque con otra forma— no es
        // ese `null`: es un payload que ya no coincide con el contrato, así que el
        // informe no puede afirmar el tipo de la cuenta.
        assert_eq!(regime_of(&json!({})), BillingRegime::Unknown);
        assert_eq!(regime_of(&json!({"credits": "x"})), BillingRegime::Unknown);
        assert_eq!(regime_of(&json!({"credits": []})), BillingRegime::Unknown);
        assert_eq!(regime_of(&json!({"credits": 42})), BillingRegime::Unknown);
        assert_eq!(regime_of(&json!({"credits": true})), BillingRegime::Unknown);
    }

    #[test]
    fn the_credits_block_is_read_for_the_frozen_flag() {
        // Con el corte de alcance, del bloque `credits` sólo se lee `frozen`: el resto
        // del contrato es de la otra mitad del alcance (#268).
        let CreditsBlock::Object(c) = parse_credits(&published_credits_page()) else {
            panic!("the credits block");
        };
        assert!(!c.frozen);
        let mut frozen = published_credits_page();
        frozen["credits"]["frozen"] = json!(true);
        let CreditsBlock::Object(c) = parse_credits(&frozen) else {
            panic!("the credits block");
        };
        assert!(c.frozen);
    }

    #[test]
    fn a_credits_account_declares_no_meter_at_all() {
        // Con el corte de alcance, una cuenta facturada en créditos NO declara
        // medidores: ni la asignación del periodo ni el saldo de packs (eso vive en
        // la otra mitad del alcance, #268). Lo que queda es la indicación de que la
        // cuenta se factura en créditos.
        let c = parse_credits(&published_credits_page());
        let account = nan_cloud::parse_quota(&nan_cloud::real_account_payload());
        let declared = declare(
            c.regime(),
            Some(account.meters),
            &[],
            Some((&UsageSummary::default(), &UsageSummary::default())),
            &published_quotas(),
            now(),
            1,
        );
        assert!(
            declared.meters.is_empty(),
            "una cuenta de créditos no declara medidores: {:?}",
            declared.meters.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert!(
            declared.header.contains("se factura en créditos"),
            "{}",
            declared.header
        );
    }

    #[test]
    fn a_credits_account_does_not_declare_the_model_quotas() {
        // Con créditos NO se declaran los medidores por modelo ni se recurre a la
        // cuota publicada: esos topes no existen para una cuenta facturada en
        // créditos. La decisión es del backend; el frente no la repite.
        let c = parse_credits(&published_credits_page());
        let account = nan_cloud::parse_quota(&nan_cloud::real_account_payload());
        let declared = declare(
            c.regime(),
            Some(account.meters),
            &[],
            Some((&UsageSummary::default(), &UsageSummary::default())),
            &published_quotas(),
            now(),
            1,
        );
        assert!(
            declared.meters.is_empty(),
            "con créditos no hay medidores por modelo: {:?}",
            declared.meters.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn an_account_without_credits_keeps_the_model_quotas() {
        // Con el régimen `model-quota` declarado (el bloque `credits` vino `null`), la
        // cuenta conserva los medidores por modelo: lo de siempre.
        let account = nan_cloud::parse_quota(&nan_cloud::real_account_payload());
        let declared = declare(
            BillingRegime::ModelQuota,
            Some(account.meters),
            &[],
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(declared.status, Status::Ok);
        assert!(declared
            .meters
            .iter()
            .any(|m| m.id == "model:deepseek-v4-flash"));
    }

    #[test]
    fn a_frozen_subscription_is_reported_as_a_warning() {
        // `frozen` es «la suscripción no está activa», no «sin créditos».
        let mut page = published_credits_page();
        page["credits"]["frozen"] = json!(true);
        let c = parse_credits(&page);
        let declared = declare(c.regime(), None, &[], None, &published_quotas(), now(), 1);
        assert_eq!(declared.status, Status::Warning);
        assert!(declared.header.contains("inactiva"), "{}", declared.header);
    }

    #[test]
    fn the_fallback_path_reclassifies_the_regime_when_its_read_brings_credits() {
        // La primera lectura de `/v1/usage` falló (régimen desconocido) y esta, la del
        // camino de fallback, trae `credits`: la cuenta se factura en créditos, así que
        // NO se declaran los medidores por modelo ni se recurre a la cuota publicada
        // (esos topes no existen para una cuenta facturada en créditos). La
        // reclasificación no cuesta una lectura extra: usa la misma respuesta.
        let pages = vec![json!({
            "credits": {"frozen": false},
            "data": [
                {"date": "2026-10-06", "model": "deepseek-v4-flash", "total_tokens": 600_000_000u64}
            ]
        })];
        let declared = declare_usage(&pages, &[], &published_quotas(), now(), 1);
        assert!(
            declared.meters.is_empty(),
            "una cuenta de créditos no declara medidores por modelo: {:?}",
            declared.meters.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert!(
            declared.header.contains("se factura en créditos"),
            "{}",
            declared.header
        );
        assert!(
            !declared.header.contains("cuota publicada"),
            "una cuenta de créditos no cae a la cuota publicada: {}",
            declared.header
        );
        assert_eq!(declared.regime.label(), Some("credits"));
    }

    #[test]
    fn the_fallback_path_keeps_the_published_quota_when_the_credits_block_is_missing() {
        // Sin bloque `credits` en la respuesta, el camino de fallback es el de siempre:
        // la cuota publicada, señalada como tal. Pero el régimen NO se afirma: sin el
        // bloque no se puede saber si la cuenta se factura en créditos, así que el
        // informe no declara régimen y degrada a aviso.
        let pages = vec![json!({
            "data": [
                {"date": "2026-10-06", "model": "deepseek-v4-flash", "total_tokens": 600_000_000u64}
            ]
        })];
        let declared = declare_usage(&pages, &[], &published_quotas(), now(), 1);
        assert!(
            declared
                .meters
                .iter()
                .any(|m| m.id == "model:deepseek-v4-flash"),
            "sin créditos el camino de fallback declara los medidores por modelo: {:?}",
            declared.meters.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert!(
            declared.header.contains("cuota publicada"),
            "{}",
            declared.header
        );
        assert_eq!(declared.regime.label(), None);
        assert_eq!(declared.status, Status::Warning);
    }

    #[test]
    fn the_fallback_path_declares_the_model_quota_with_an_explicit_null() {
        // El `null` explícito SÍ declara el régimen: el contrato dice que la cuenta no
        // se factura en créditos, así que el camino de fallback puede afirmar el tipo
        // de la cuenta.
        let pages = vec![json!({
            "credits": null,
            "data": [
                {"date": "2026-10-06", "model": "deepseek-v4-flash", "total_tokens": 600_000_000u64}
            ]
        })];
        let declared = declare_usage(&pages, &[], &published_quotas(), now(), 1);
        assert!(
            declared
                .meters
                .iter()
                .any(|m| m.id == "model:deepseek-v4-flash"),
            "sin créditos el camino de fallback declara los medidores por modelo: {:?}",
            declared.meters.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert_eq!(declared.regime.label(), Some("model-quota"));
    }

    #[test]
    fn the_credits_account_declares_the_credits_regime() {
        // El backend declara el régimen de facturación en el informe y el frente lo
        // trata como texto opaco (no sabe qué significa): una cuenta facturada en
        // créditos lo dice en su informe.
        let c = parse_credits(&published_credits_page());
        let declared = declare(c.regime(), None, &[], None, &published_quotas(), now(), 1);
        let mut report = UsageReport::new("nan", "NaN Builders", Kind::Subscription);
        let mut quota = Vec::new();
        declared.apply(&mut report, &mut quota);
        assert_eq!(
            serde_json::to_value(&report).unwrap()["billingRegime"],
            "credits"
        );
    }

    #[test]
    fn the_model_quota_account_declares_its_own_regime() {
        // La otra rama: una cuenta con asignación por modelo declara OTRO régimen,
        // distinto y estable.
        let account = nan_cloud::parse_quota(&nan_cloud::real_account_payload());
        let declared = declare(
            BillingRegime::ModelQuota,
            Some(account.meters),
            &[],
            None,
            &published_quotas(),
            now(),
            1,
        );
        let mut report = UsageReport::new("nan", "NaN Builders", Kind::Subscription);
        let mut quota = Vec::new();
        declared.apply(&mut report, &mut quota);
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["billingRegime"], "model-quota");
        assert_ne!(v["billingRegime"], "credits");
    }

    #[test]
    fn the_regime_names_do_not_mention_the_provider_nor_the_plan() {
        // Los literales son texto opaco y estable: no nombran al proveedor ni al plan
        // (el frente no puede deducir nada de ellos).
        for name in [CREDITS_REGIME, MODEL_QUOTA_REGIME] {
            let lower = name.to_lowercase();
            for forbidden in ["nan", "gentle", "inference", "premium", "community"] {
                assert!(
                    !lower.contains(forbidden),
                    "el régimen {name} nombra {forbidden}"
                );
            }
        }
    }

    #[test]
    fn an_unknown_regime_does_not_claim_the_account_type() {
        // Sin lectura de `/v1/usage` no se sabe el régimen: el informe NO declara
        // régimen, NO afirma que la cuenta se facture por modelo y degrada de forma
        // visible (nunca `ok` como si los medidores por modelo fueran la cuota de la
        // cuenta).
        let account = nan_cloud::parse_quota(&nan_cloud::real_account_payload());
        let declared = declare(
            BillingRegime::Unknown,
            Some(account.meters),
            &[],
            None,
            &published_quotas(),
            now(),
            1,
        );
        assert_eq!(declared.status, Status::Warning);
        assert_eq!(declared.regime.label(), None);
        assert!(
            declared
                .header
                .contains("no se pudo determinar el tipo de cuenta"),
            "{}",
            declared.header
        );
        assert!(
            !declared.header.contains("cuotas por modelo"),
            "el texto no afirma el tipo de cuenta: {}",
            declared.header
        );
    }

    #[test]
    fn the_report_does_not_declare_an_unknown_regime() {
        // Un informe sin régimen no pone la clave: el frente conserva los datos
        // anteriores como siempre, porque no se inventa un régimen.
        let mut report = UsageReport::new("nan", "NaN Builders", Kind::Subscription);
        report.billing_regime = BillingRegime::Unknown.label();
        assert!(serde_json::to_value(&report)
            .unwrap()
            .get("billingRegime")
            .is_none());
    }

    // ───────────── el camino completo contra un servidor local ─────────────

    /// Servidor HTTP mínimo para el camino con API key: atiende `/v1/models`,
    /// `/v1/usage` y `/api/usage/quota` con el cuerpo que le corresponde; una ruta
    /// que no está en la lista responde 500 (como un endpoint caído). El puerto es
    /// dinámico (`127.0.0.1:0`), así que dos tests en paralelo no chocan.
    struct MockServer {
        port: u16,
        /// Las rutas pedidas, en orden: para comprobar qué pide cada camino.
        requests: Arc<std::sync::Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl MockServer {
        fn new(routes: Vec<(&'static str, String)>) -> Self {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).unwrap();
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let seen = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let thread = std::thread::spawn(move || {
                while !stopping.load(Ordering::Acquire) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut head = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = stream.read(&mut buf).unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        head.extend_from_slice(&buf[..n]);
                    }
                    let request = String::from_utf8_lossy(&head).to_string();
                    let path = request
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("")
                        .split('?')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    seen.lock().unwrap().push(path.clone());
                    let response = match routes.iter().find(|(p, _)| path == *p) {
                        Some((_, body)) => format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        ),
                        None => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                    };
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
            });
            MockServer {
                port,
                requests,
                stop,
                thread: Some(thread),
            }
        }

        fn base(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        /// Las rutas que se han pedido, en orden.
        fn requested(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// Cliente local: sin proxy (el servidor de pruebas está en loopback).
    fn local_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("the client builds")
    }

    /// La configuración de NaN apuntando al servidor local: la API del proveedor
    /// (`/v1/...`) sale del mismo servidor. El panel de Cloud no vive en la
    /// configuración: se pasa como parámetro (`mock.base()`).
    fn local_config(mock: &MockServer) -> NanConfig {
        NanConfig {
            base_url: format!("{}/v1", mock.base()),
            ..Default::default()
        }
    }

    #[test]
    fn the_api_key_path_classifies_a_credits_account() {
        // El camino con API key, de punta a punta (el `fetch` de verdad, contra un
        // servidor local): el ejemplo publicado por el proveedor dice que la cuenta se
        // factura en créditos, así que el informe NO declara medidores por modelo y SÍ
        // declara el régimen.
        let mock = MockServer::new(vec![
            ("/v1/models", r#"{"data":[]}"#.to_string()),
            ("/v1/usage", published_credits_page().to_string()),
            (
                "/api/usage/quota",
                nan_cloud::real_account_payload().to_string(),
            ),
        ]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            Some("nan-key"),
            None,
            &mock.base(),
        ));
        assert_eq!(report.billing_regime, Some("credits"));
        assert_eq!(report.status, Status::Ok);
        assert!(
            report.meters.is_empty(),
            "una cuenta de créditos no declara medidores por modelo: {:?}",
            report.meters.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert_eq!(
            report.message.as_deref(),
            Some("la cuenta se factura en créditos")
        );
        // Con créditos no se lee la cuota de la cuenta: esos topes no existen para una
        // cuenta facturada en créditos.
        assert!(
            !mock.requested().iter().any(|p| p == "/api/usage/quota"),
            "se pidió la cuota de la cuenta: {:?}",
            mock.requested()
        );
        assert!(
            mock.requested().iter().any(|p| p == "/v1/usage"),
            "el régimen se decide con /v1/usage: {:?}",
            mock.requested()
        );
    }

    #[test]
    fn the_api_key_path_declares_the_model_quota_regime() {
        // La otra rama del mismo camino: `credits` es `null` (la cuenta se factura con
        // una asignación por modelo), así que el informe declara el otro régimen y los
        // medidores de la cuenta.
        let mock = MockServer::new(vec![
            ("/v1/models", r#"{"data":[]}"#.to_string()),
            (
                "/v1/usage",
                r#"{"object":"list","data":[],"credits":null}"#.to_string(),
            ),
            (
                "/api/usage/quota",
                nan_cloud::real_account_payload().to_string(),
            ),
        ]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            Some("nan-key"),
            None,
            &mock.base(),
        ));
        assert_eq!(report.billing_regime, Some("model-quota"));
        assert_eq!(report.status, Status::Ok);
        assert_eq!(report.meters.len(), 2);
        assert_eq!(report.meters[0].quota_source, Some("account"));
    }

    #[test]
    fn the_api_key_path_does_not_claim_the_account_type_without_the_credits_block() {
        // `/v1/usage` responde SIN el bloque `credits`: el payload ya no coincide con
        // el contrato, así que el informe NO declara régimen, NO afirma que la cuenta
        // se facture por modelo y degrada a aviso (nunca `ok` con los topes por modelo
        // como si fueran la cuota de la cuenta).
        let mock = MockServer::new(vec![
            ("/v1/models", r#"{"data":[]}"#.to_string()),
            ("/v1/usage", r#"{"object":"list","data":[]}"#.to_string()),
            (
                "/api/usage/quota",
                nan_cloud::real_account_payload().to_string(),
            ),
        ]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            Some("nan-key"),
            None,
            &mock.base(),
        ));
        assert_eq!(report.billing_regime, None);
        assert_eq!(report.status, Status::Warning);
        let message = report.message.as_deref().unwrap_or_default();
        assert!(
            message.contains("no se pudo determinar el tipo de cuenta"),
            "{message}"
        );
        assert!(
            !message.contains("cuotas por modelo"),
            "el texto no afirma el tipo de cuenta: {message}"
        );
    }

    #[test]
    fn an_unreadable_usage_leaves_the_regime_unknown() {
        // Si `/v1/usage` no se puede leer, el régimen queda desconocido: el informe no
        // declara régimen, no afirma el tipo de cuenta y degrada de forma visible.
        let mock = MockServer::new(vec![
            ("/v1/models", r#"{"data":[]}"#.to_string()),
            (
                "/api/usage/quota",
                nan_cloud::real_account_payload().to_string(),
            ),
        ]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            Some("nan-key"),
            None,
            &mock.base(),
        ));
        assert_eq!(report.billing_regime, None);
        assert_eq!(report.status, Status::Warning);
        assert!(
            report
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("no se pudo determinar el tipo de cuenta"),
            "{:?}",
            report.message
        );
        assert!(
            !report
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("cuotas por modelo"),
            "{:?}",
            report.message
        );
    }

    #[test]
    fn the_session_path_classifies_the_regime_when_there_is_an_api_key() {
        // La sesión también clasifica el régimen: el panel de Cloud no publica el
        // bloque `credits`, así que se lee `/v1/usage` (la única fuente documentada).
        let mock = MockServer::new(vec![
            ("/v1/models", r#"{"data":[]}"#.to_string()),
            ("/v1/usage", published_credits_page().to_string()),
            (
                "/api/usage/quota",
                nan_cloud::real_account_payload().to_string(),
            ),
        ]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            Some("nan-key"),
            Some("session=abc"),
            &mock.base(),
        ));
        assert_eq!(report.billing_regime, Some("credits"));
        assert!(
            report.meters.is_empty(),
            "una cuenta de créditos no muestra los topes por modelo: {:?}",
            report.meters.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert_eq!(
            report.message.as_deref(),
            Some("la cuenta se factura en créditos")
        );
    }

    #[test]
    fn without_an_api_key_the_session_leaves_the_regime_unknown() {
        // Sin API key no hay forma de leer el bloque `credits`: el régimen queda
        // desconocido y el informe no lo declara. Los datos de la sesión (los del
        // panel) no se tocan.
        let mock = MockServer::new(vec![(
            "/api/usage/quota",
            nan_cloud::real_account_payload().to_string(),
        )]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            None,
            Some("session=abc"),
            &mock.base(),
        ));
        assert_eq!(report.billing_regime, None);
        assert_eq!(report.status, Status::Ok);
        assert_eq!(report.meters.len(), 2);
        assert_eq!(report.meters[0].quota_source, Some("account"));
        // Sin API key no hay lectura que haya fallado: el régimen queda desconocido,
        // pero el informe no lleva la nota del régimen desconocido.
        assert!(
            !report
                .message
                .as_deref()
                .unwrap_or_default()
                .contains(UNKNOWN_REGIME_NOTE),
            "sin API key el informe no lleva la nota: {:?}",
            report.message
        );
    }

    #[test]
    fn the_session_path_with_an_api_key_warns_when_the_regime_is_unknown() {
        // Con cookie y API key, si `/v1/usage` falla (500), el régimen queda
        // desconocido y el informe de sesión degrada a aviso: no afirma el tipo de
        // cuenta y lo dice en el mensaje. Antes salía en `ok` con los topes por
        // modelo, como si fueran la cuota de la cuenta.
        let mock = MockServer::new(vec![
            (
                "/api/usage/quota",
                nan_cloud::real_account_payload().to_string(),
            ),
            (
                "/api/metrics/usage",
                r#"{"monthToDate":{"totalTokens":955581032},"last24h":{"totalTokens":496625346}}"#
                    .to_string(),
            ),
        ]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            Some("nan-key"),
            Some("session=abc"),
            &mock.base(),
        ));
        assert_eq!(
            report.status,
            Status::Warning,
            "un régimen desconocido degrada el informe de sesión a aviso: {:?}",
            report.message
        );
        assert!(
            report
                .message
                .as_deref()
                .unwrap_or_default()
                .contains(UNKNOWN_REGIME_NOTE),
            "el mensaje dice que no se pudo determinar el tipo de cuenta: {:?}",
            report.message
        );
        // El informe no declara régimen (el frente lo trata como texto opaco).
        assert_eq!(report.billing_regime, None);
        assert!(
            mock.requested().iter().any(|p| p == "/v1/usage"),
            "el régimen se decide con /v1/usage: {:?}",
            mock.requested()
        );
    }

    #[test]
    fn the_cycle_reads_the_usage_page_only_once() {
        // La lectura de `/v1/usage` que decide el régimen se reutiliza en el camino de
        // respaldo: el ciclo no pide una segunda página. Con la cuota de la cuenta
        // caída (500) el camino de respaldo lee el consumo de la MISMA respuesta.
        let mock = MockServer::new(vec![
            ("/v1/models", r#"{"data":[]}"#.to_string()),
            (
                "/v1/usage",
                r#"{"object":"list","data":[],"credits":null}"#.to_string(),
            ),
        ]);
        let cfg = local_config(&mock);
        let http = local_client();
        let _report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            Some("nan-key"),
            None,
            &mock.base(),
        ));
        let usage_calls = mock
            .requested()
            .iter()
            .filter(|p| p.as_str() == "/v1/usage")
            .count();
        assert_eq!(
            usage_calls,
            1,
            "el ciclo pide /v1/usage una sola vez: {:?}",
            mock.requested()
        );
    }

    #[test]
    fn the_usage_pagination_does_not_ask_for_one_page_too_many() {
        // `fetch_usage` sigue el cursor hasta 10 páginas. En la décima vuelta pedía la
        // undécima y la descartaba: ahora corta ANTES de pedirla.
        let mock = MockServer::new(vec![(
            "/v1/usage",
            r#"{"object":"list","data":[],"credits":null,"next_cursor":"c2"}"#.to_string(),
        )]);
        let cfg = local_config(&mock);
        let http = local_client();
        let pages = block_on(fetch_usage(
            &cfg,
            &http,
            "nan-key",
            now() - chrono::Duration::days(30),
            now(),
            None,
        ))
        .expect("la lectura de /v1/usage funciona");
        let usage_calls = mock
            .requested()
            .iter()
            .filter(|p| p.as_str() == "/v1/usage")
            .count();
        assert_eq!(pages.len(), 10, "se leen 10 páginas como máximo");
        assert_eq!(
            usage_calls,
            10,
            "no se pide la undécima página (se descartaría): {:?}",
            mock.requested()
        );
    }

    #[test]
    fn without_an_api_key_the_session_does_not_read_the_usage_page() {
        // Sin API key no hay forma de leer el bloque `credits`: la sesión no pide
        // `/v1/usage` y el informe no declara régimen.
        let mock = MockServer::new(vec![(
            "/api/usage/quota",
            nan_cloud::real_account_payload().to_string(),
        )]);
        let cfg = local_config(&mock);
        let http = local_client();
        let report = block_on(refresh_with_credentials(
            &cfg,
            Who::main("nan"),
            &http,
            None,
            Some("session=abc"),
            &mock.base(),
        ));
        assert!(
            !mock.requested().iter().any(|p| p == "/v1/usage"),
            "sin API key no se lee /v1/usage: {:?}",
            mock.requested()
        );
        assert_eq!(report.billing_regime, None);
        assert!(
            serde_json::to_value(&report)
                .unwrap()
                .get("billingRegime")
                .is_none(),
            "un informe sin régimen no pone la clave"
        );
    }
}
