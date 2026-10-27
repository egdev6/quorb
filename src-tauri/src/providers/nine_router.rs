//! 9Router — pasarela local que enruta hacia 40+ proveedores y ya lleva su
//! propio registro de uso/coste. Quorb lo lee como un proveedor agregador.
//!
//! Endpoints (servidor local, por defecto `http://localhost:20128`):
//!   · `POST /api/auth/login`       → inicia sesión con la contraseña del dashboard
//!   · `GET  /api/usage/stats`      → totales, gasto y desglose por proveedor/modelo
//!   · `GET  /api/usage/providers`  → sub-proveedores vistos (Claude, Kiro, GLM…)
//!   · `GET  /api/usage/chart`      → serie temporal (tokens/coste) para el historial
//!
//! Las rutas `/api/usage/*` están tras el guard del dashboard: exigen la cookie
//! `auth_token` (JWT, 24 h) o, si el usuario desactivó el login, ninguna. Obtenemos
//! la cookie con el mismo login que usa el dashboard y la guardamos en el almacén
//! seguro del sistema; se renueva sola cuando caduca.

use super::{net_error, Who};
use crate::config::NineRouterConfig;
use crate::model::{Daily, Kind, Meter, Spend, Status, UsageReport};
use serde_json::Value;
use std::collections::BTreeMap;

/// Error al leer 9Router: hay que volver a iniciar sesión, o es otra cosa.
#[derive(Debug, PartialEq)]
pub enum RouterError {
    Expired,
    Other(String),
}

impl RouterError {
    fn message(self) -> String {
        match self {
            RouterError::Expired => {
                "La sesión de 9Router ha caducado. Vuelve a introducir la contraseña en Ajustes."
                    .into()
            }
            RouterError::Other(m) => m,
        }
    }
}

pub use super::nine_router_creds::normalize_base;

/// ¿El destino del borrador coincide con el persistido? Compara ignorando la
/// barra final. `None` (sin borrador) se considera el persistido. Cuando NO
/// coinciden, «Guardar y probar» debe usar una sesión temporal aislada para no
/// guardar las credenciales de otro servidor (ver `nine_router_login`).
pub fn same_destination(saved: &str, draft: Option<&str>) -> bool {
    match draft {
        None => true,
        Some(d) => normalize_base(d) == normalize_base(saved),
    }
}

/// Inicia sesión en el dashboard local y devuelve la cabecera `Cookie` resultante.
/// `POST /api/auth/login { "password": … }` → `Set-Cookie: auth_token=…`.
pub async fn login(
    http: &reqwest::Client,
    base_url: &str,
    password: &str,
) -> Result<String, String> {
    if password.trim().is_empty() {
        return Err("Escribe la contraseña del dashboard de 9Router".into());
    }
    let res = http
        .post(format!("{}/api/auth/login", base_url.trim_end_matches('/')))
        .json(&serde_json::json!({ "password": password }))
        .send()
        .await
        .map_err(net_error)?;
    match res.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err("9Router rechazó la contraseña.".into()),
        429 => return Err("Demasiados intentos en 9Router; espera unos minutos.".into()),
        code => return Err(format!("9Router respondió HTTP {code} al iniciar sesión")),
    }
    let mut jar: BTreeMap<String, String> = BTreeMap::new();
    for v in res.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Some((k, val)) = v.to_str().ok().and_then(super::nan_cloud::parse_set_cookie) {
            if !val.is_empty() {
                jar.insert(k, val);
            }
        }
    }
    let cookie = super::nan_cloud::cookie_header(&jar);
    if cookie.is_empty() {
        return Err("9Router no devolvió una sesión. Comprueba la contraseña.".into());
    }
    Ok(cookie)
}

/// Inicia sesión con la contraseña guardada y guarda la cookie resultante.
/// `None` si no hay contraseña, otro destino, o las credenciales cambiaron durante el `.await`.
pub async fn login_with_saved(
    http: &reqwest::Client,
    base_url: &str,
) -> Result<Option<String>, String> {
    use super::nine_router_creds::{password_ticket_for_base, persist_if_generation, PersistError};
    let Some((generation, password)) = password_ticket_for_base(base_url) else {
        return Ok(None);
    };
    let cookie = login(http, base_url, &password).await?;
    match persist_if_generation(base_url, &password, &cookie, generation) {
        Ok(()) => Ok(Some(cookie)),
        Err(PersistError::Stale) => Ok(None),
        Err(PersistError::Store(e)) => Err(e),
    }
}

/// `GET` con la cookie de sesión; `Expired` si 401/403. Sin cookie (login del
/// dashboard desactivado) se omite la cabecera.
async fn get_json(
    http: &reqwest::Client,
    base_url: &str,
    path: &str,
    cookie: &str,
) -> Result<Value, RouterError> {
    let mut req = http
        .get(format!("{}{}", base_url.trim_end_matches('/'), path))
        .header(reqwest::header::ACCEPT, "application/json");
    if !cookie.trim().is_empty() {
        req = req.header(reqwest::header::COOKIE, cookie);
    }
    let res = req
        .send()
        .await
        .map_err(|e| RouterError::Other(net_error(e)))?;
    match res.status().as_u16() {
        200 => res
            .json()
            .await
            .map_err(|e| RouterError::Other(format!("respuesta no JSON: {e}"))),
        401 | 403 => Err(RouterError::Expired),
        code => Err(RouterError::Other(format!("HTTP {code} en {path}"))),
    }
}

/// Comprueba que el 9Router responde y hay sesión; devuelve el JSON de stats en crudo
/// (para el botón «Probar» de Ajustes). Reintenta con la contraseña si la sesión caducó.
/// `base_override` permite probar contra la URL del borrador de Ajustes sin guardarla.
pub async fn probe(
    http: &reqwest::Client,
    cfg: &NineRouterConfig,
    base_override: Option<&str>,
) -> Result<String, String> {
    let base = base_override
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or(&cfg.base_url)
        .trim_end_matches('/');
    // ¿Está vivo? (endpoint público, con CORS abierto)
    http.get(format!("{base}/api/health"))
        .send()
        .await
        .map_err(|e| format!("No encuentro 9Router en {base}: {}", net_error(e)))?;

    let cookie = match super::nine_router_creds::snapshot_for_base(base) {
        Some(snap) => match snap.session {
            Some(c) => c,
            None => match login_with_saved(http, base).await? {
                Some(c) => c,
                None => return Err("Configura la contraseña del dashboard de 9Router.".into()),
            },
        },
        None => match login_with_saved(http, base).await? {
            Some(c) => c,
            None => return Err("Configura la contraseña del dashboard de 9Router.".into()),
        },
    };
    match get_stats(http, base, &cfg.period, &cookie).await {
        Ok(v) => Ok(serde_json::to_string_pretty(&v).unwrap_or_default()),
        Err(RouterError::Expired) => match login_with_saved(http, base).await? {
            Some(c) => get_stats(http, base, &cfg.period, &c)
                .await
                .map(|v| serde_json::to_string_pretty(&v).unwrap_or_default())
                .map_err(RouterError::message),
            None => Err("La sesión de 9Router caducó y no hay contraseña guardada.".into()),
        },
        Err(e) => Err(e.message()),
    }
}

/// Prueba el destino indicado con una contraseña dada, **sin persistir nada**:
/// usa una cookie temporal en memoria. Para «Guardar y probar» contra la URL del
/// borrador cuando difiere de la persistida: así una prueba contra otro servidor
/// no deja sus credenciales guardadas (que luego A usaría contra su propio
/// destino). No lee ni escribe los secretos globales.
pub async fn probe_with_password(
    http: &reqwest::Client,
    cfg: &NineRouterConfig,
    base: &str,
    password: &str,
) -> Result<String, String> {
    let base = base.trim_end_matches('/');
    // ¿Está vivo? (endpoint público, con CORS abierto)
    http.get(format!("{base}/api/health"))
        .send()
        .await
        .map_err(|e| format!("No encuentro 9Router en {base}: {}", net_error(e)))?;

    let cookie = login(http, base, password).await?;
    get_stats(http, base, &cfg.period, &cookie)
        .await
        .map(|v| serde_json::to_string_pretty(&v).unwrap_or_default())
        .map_err(RouterError::message)
}

async fn get_stats(
    http: &reqwest::Client,
    base: &str,
    period: &str,
    cookie: &str,
) -> Result<Value, RouterError> {
    get_json(
        http,
        base,
        &format!("/api/usage/stats?period={period}"),
        cookie,
    )
    .await
}

/// Fallo al obtener las stats, ya resuelto el tema de la sesión.
#[derive(Debug, PartialEq)]
enum StatsError {
    /// El dashboard exige sesión y no hay contraseña guardada para renovarla.
    NeedsLogin,
    /// Otro error de red/servidor.
    Other(RouterError),
}

impl StatsError {
    /// Estado del orbe cuando falla la lectura de stats.
    fn status(&self) -> Status {
        match self {
            StatsError::NeedsLogin => Status::NeedsLogin,
            StatsError::Other(e) => status_for(e),
        }
    }
}

/// Lee las stats resolviendo la sesión: usa la cookie actual; si el dashboard no
/// tiene login (sin cookie) o la sesión caducó pero hay contraseña, reintenta tras
/// iniciar sesión. Si el servidor rechaza y no hay credenciales, pide configurarlas.
async fn read_stats(
    http: &reqwest::Client,
    base: &str,
    period: &str,
    cookie: &mut Option<String>,
) -> Result<Value, StatsError> {
    // Primero con la cookie que tengamos (o sin ninguna: login desactivado).
    let first = get_stats(http, base, period, cookie.as_deref().unwrap_or("")).await;
    match first {
        Ok(v) => Ok(v),
        // El servidor exige sesión: si tenemos contraseña, iniciamos y reintentamos.
        Err(RouterError::Expired) => match login_with_saved(http, base).await {
            Ok(Some(c)) => {
                *cookie = Some(c.clone());
                get_stats(http, base, period, &c)
                    .await
                    .map_err(StatsError::Other)
            }
            Ok(None) => Err(StatsError::NeedsLogin),
            Err(e) => Err(StatsError::Other(RouterError::Other(e))),
        },
        Err(e) => Err(StatsError::Other(e)),
    }
}

/// Sub-proveedor descubierto en `byProvider`.
pub(crate) struct SubProvider {
    /// Clave tal como la devuelve 9Router en `byProvider`: `Kiro`, `claude` o el id
    /// técnico de un nodo personalizado (`openai-compatible-responses-<uuid>`). Se
    /// usa para volver a buscar en `byProvider`, que distingue mayúsculas.
    pub key: String,
    /// id de cuenta (`nine_router:<normalizado>`): minúsculas, dígitos y guiones,
    /// para casar con `is_account_id` y ser estable como sufijo.
    pub account_id: String,
    /// Nombre visible: el de un nodo personalizado («Zhipu», «QWEN - Alibaba») o,
    /// si no consta, la propia clave.
    pub label: String,
}

/// Sub-proveedores con gasto por encima del umbral, de mayor a menor coste.
/// Se omiten los que no llegan al mínimo (por defecto 0 $, o sea gasto > 0): la
/// tira se llenaría de ceros. Se conserva la clave original para poder buscar en
/// `byProvider` (que distingue mayúsculas: `Kiro` ≠ `kiro`). `node_names` traduce
/// el id técnico de un nodo personalizado a su nombre visible.
fn sub_providers_from(
    stats: &Value,
    min_spend: f64,
    node_names: &BTreeMap<String, String>,
) -> Vec<SubProvider> {
    let threshold = if min_spend.is_finite() {
        min_spend.max(0.0)
    } else {
        0.0
    };
    let mut entries: Vec<(String, f64)> = stats
        .get("byProvider")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(id, v)| {
                    (
                        id.trim().to_string(),
                        v.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    entries.retain(|(key, cost)| {
        // Estrictamente por encima del umbral: con 0 se exige algo de gasto.
        let account_id = format!("nine_router:{}", normalize_sub_id(key));
        *cost > threshold && !key.is_empty() && crate::config::is_account_id(&account_id)
    });
    entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    entries
        .into_iter()
        .map(|(key, _)| {
            let account_id = format!("nine_router:{}", normalize_sub_id(&key));
            let label = node_names
                .get(&key)
                .cloned()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| key.clone());
            SubProvider {
                key,
                account_id,
                label,
            }
        })
        .collect()
}

/// Sufijo de cuenta para un sub-proveedor: minúsculas, y todo lo que no sea
/// `[a-z0-9-]` pasa a guion (p. ej. nodos personalizados con espacios).
fn normalize_sub_id(key: &str) -> String {
    key.trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Nombres de los nodos personalizados de 9Router: id técnico → nombre visible
/// (`openai-compatible-responses-<uuid>` → «QWEN - Alibaba»). `byProvider` los
/// etiqueta con el id técnico; este endpoint da el nombre con el que el usuario
/// los creó. Si falla, se devuelve un mapa vacío y se muestra la clave tal cual.
async fn fetch_node_names(
    http: &reqwest::Client,
    base: &str,
    cookie: &str,
) -> BTreeMap<String, String> {
    let Ok(v) = get_json(http, base, "/api/provider-nodes", cookie).await else {
        return BTreeMap::new();
    };
    let mut map = BTreeMap::new();
    for node in v
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(id), Some(name)) = (
            node.get("id").and_then(Value::as_str),
            node.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        let name = name.trim();
        if !id.trim().is_empty() && !name.is_empty() {
            map.insert(id.trim().to_string(), name.to_string());
        }
    }
    map
}

/// Informe del proveedor agregador (o de uno de sus sub-proveedores si `who` es extra).
pub async fn fetch(cfg: &NineRouterConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    // El orbe agregado + sus sub-proveedores comparten una única lectura de stats;
    // aquí solo devolvemos el report que pida `who` (la cuenta extra es del fetch_all).
    match who.label {
        None => fetch_all(cfg, http)
            .await
            .into_iter()
            .next()
            .unwrap_or_else(|| {
                Who::main("nine_router")
                    .report("9Router", Kind::Api)
                    .fail(Status::Error, "Sin datos de 9Router")
            }),
        Some(_) => fetch_all(cfg, http)
            .await
            .into_iter()
            .find(|r| r.id == who.id)
            .unwrap_or_else(|| {
                who.report("9Router", Kind::Api).fail(
                    Status::Warning,
                    "9Router aún no ha registrado uso de este proveedor en el periodo.",
                )
            }),
    }
}

/// Lee las stats una sola vez y devuelve el orbe agregado seguido de un informe
/// por cada sub-proveedor visto (`nine_router:<id>`). Es la entrada que usa
/// `fetch_all` para no pedir las stats una vez por cuenta.
pub async fn fetch_all(cfg: &NineRouterConfig, http: &reqwest::Client) -> Vec<UsageReport> {
    let main_who = Who::main("nine_router");
    let main_report = main_who.report("9Router", Kind::Api);
    let base = cfg.base_url.trim_end_matches('/');

    // Sesión: snapshot coherente (bound + cookie + generación). Evita validar A y
    // leer la cookie de B si otro hilo guardó/conectó entretanto.
    let mut cookie = match super::nine_router_creds::snapshot_for_base(base) {
        Some(snap) => match snap.session {
            Some(c) => Some(c),
            None => match login_with_saved(http, base).await {
                Ok(c) => c,
                Err(e) => return vec![main_report.fail(Status::Error, e)],
            },
        },
        None => match login_with_saved(http, base).await {
            Ok(c) => c,
            Err(e) => return vec![main_report.fail(Status::Error, e)],
        },
    };

    let stats = match read_stats(http, base, &cfg.period, &mut cookie).await {
        Ok(v) => v,
        Err(e) => {
            let status = e.status();
            let message = match e {
                StatsError::NeedsLogin => {
                    "La sesión de 9Router caducó y no hay contraseña guardada.".to_string()
                }
                StatsError::Other(err) => err.message(),
            };
            return vec![main_report.fail(status, message)];
        }
    };

    // Serie opcional para el historial; si falla, seguimos sin ella.
    let chart = get_json(
        http,
        base,
        &format!("/api/usage/chart?period={}", cfg.period),
        cookie.as_deref().unwrap_or(""),
    )
    .await
    .ok();

    // Instante de referencia: se inyecta en el parseo de la serie para que cada
    // bucket se feche según la ventana real del período (24h cruza medianoche,
    // 60d/all pueden cruzar el año).
    let now = chrono::Local::now();
    let mut out = vec![build_main(cfg, &main_report, &stats, chart.as_ref(), now)];
    if cfg.show_sub_providers {
        let cookie = cookie.as_deref().unwrap_or("");
        let node_names = fetch_node_names(http, base, cookie).await;
        for sub in sub_providers_from(&stats, cfg.min_spend_usd, &node_names) {
            let account = crate::config::Account {
                id: sub.account_id.clone(),
                provider: "nine_router".into(),
                label: sub.label.clone(),
                enabled: true,
                ..Default::default()
            };
            out.push(build_sub(
                &Who::extra(&account).report("9Router", Kind::Api),
                &stats,
                &sub.key,
                chart.as_ref(),
                &cfg.period,
                now,
            ));
        }
    }
    out
}

fn status_for(e: &RouterError) -> Status {
    match e {
        RouterError::Expired => Status::NeedsLogin,
        RouterError::Other(_) => Status::Error,
    }
}

/// Sub-proveedor concreto de 9Router (cuenta adicional `nine_router:<id>`).
fn build_sub(
    report: &UsageReport,
    stats: &Value,
    provider: &str,
    chart: Option<&Value>,
    period: &str,
    now: chrono::DateTime<chrono::Local>,
) -> UsageReport {
    let mut report = report.clone();

    let Some(entry) = stats
        .get("byProvider")
        .and_then(|b| b.get(provider))
        .cloned()
    else {
        return report.fail(
            Status::Warning,
            format!("9Router aún no ha registrado uso de «{provider}» en este periodo."),
        );
    };
    let p = parse_provider(&entry);
    report.plan = Some("Vía 9Router".into());
    report.meters = p.meters;
    report.spend = p.spend;
    // La serie `/api/usage/chart` es agregada (todos los proveedores): no se puede
    // atribuir a un sub-proveedor sin un desglose por proveedor. Antes de exponer
    // datos de otros, se omite; si la chart trae un campo por proveedor, se usa.
    report.daily = chart
        .map(|c| parse_daily_for(c, Some(provider), period, now))
        .unwrap_or_default();
    report.message = p.message;
    report
}

/// Orbe agregador: totales del periodo + sub-proveedores activos.
fn build_main(
    cfg: &NineRouterConfig,
    report: &UsageReport,
    stats: &Value,
    chart: Option<&Value>,
    now: chrono::DateTime<chrono::Local>,
) -> UsageReport {
    let mut report = report.clone();
    let totals = parse_totals(stats);

    let mut meters = vec![];
    if let Some(budget) = cfg.monthly_budget_usd.filter(|b| *b > 0.0) {
        meters.push(Meter {
            id: "spend_period".into(),
            label: "Gasto (periodo)".into(),
            percent: Some(totals.cost / budget * 100.0),
            used: Some(totals.cost),
            limit: Some(budget),
            unit: Some("USD".into()),
            resets_at: None,
            window_seconds: None,
        });
    }
    meters.push(Meter {
        id: "tokens".into(),
        label: "Tokens".into(),
        percent: None,
        used: Some(totals.tokens as f64),
        limit: None,
        unit: Some("tokens".into()),
        resets_at: None,
        window_seconds: None,
    });

    let providers = stats
        .get("byProvider")
        .and_then(Value::as_object)
        .map(|m| m.len())
        .unwrap_or(0);
    report.plan = Some(format!(
        "{providers} proveedor{}",
        if providers == 1 { "" } else { "es" }
    ));
    report.meters = meters;
    report.spend = Some(Spend {
        amount: totals.cost,
        currency: "USD".into(),
        period_label: period_label(&cfg.period),
        budget: cfg.monthly_budget_usd,
    });
    report.daily = chart
        .map(|c| parse_daily(c, &cfg.period, now))
        .unwrap_or_default();
    report.message = Some(format!(
        "{} peticiones · {} tokens · {:.2} $",
        totals.requests, totals.tokens, totals.cost
    ));
    report
}

struct Totals {
    requests: u64,
    tokens: u64,
    cost: f64,
}

fn parse_totals(v: &Value) -> Totals {
    let num = |k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    Totals {
        requests: num("totalRequests") as u64,
        tokens: (num("totalPromptTokens") + num("totalCompletionTokens")) as u64,
        cost: num("totalCost"),
    }
}

struct Parsed {
    meters: Vec<Meter>,
    spend: Option<Spend>,
    message: Option<String>,
}

/// Desglose por proveedor de `byProvider` en un medidor + gasto.
fn parse_provider(entry: &Value) -> Parsed {
    let num = |k: &str| entry.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let requests = num("requests") as u64;
    let tokens = (num("promptTokens") + num("completionTokens")) as u64;
    let cost = num("cost");

    let meters = vec![Meter {
        id: "tokens_period".into(),
        label: "Tokens (periodo)".into(),
        percent: None,
        used: Some(tokens as f64),
        limit: None,
        unit: Some("tokens".into()),
        resets_at: None,
        window_seconds: None,
    }];
    let spend = Some(Spend {
        amount: cost,
        currency: "USD".into(),
        period_label: "Periodo".into(),
        budget: None,
    });
    Parsed {
        meters,
        spend,
        message: Some(format!("{requests} peticiones · {:.2} $", cost)),
    }
}

/// Serie `[{label,tokens,cost,requests}]` de la chart → `Daily` (fecha + tokens).
/// 9Router construye la chart **posicionalmente**: el bucket `i` es un instante
/// concreto (`getChartData` genera `startTime + i·intervalo`), y el `label` es
/// solo su presentación. Por eso la fecha fiable sale del índice + la ventana del
/// período + el instante de referencia `now`, no del label: en `24h` las horas
/// anteriores a la actual son de *ayer* (`18:00` de la víspera) y en `60d`/`all`
/// los días de mes/día (`Dec 31`) pueden ser del *año anterior*. Sin esto, ambos
/// acababan en el día/año de `now` y varios buckets colapsaban en una fecha falsa.
/// Se agrupa por día sumando tokens. `now` se inyecta para que el test sea
/// determinista y para que todos los buckets compartan la misma referencia.
fn parse_daily(chart: &Value, period: &str, now: chrono::DateTime<chrono::Local>) -> Vec<Daily> {
    parse_daily_for(chart, None, period, now)
}

/// Igual que `parse_daily`, pero para un sub-proveedor: si la chart trae un
/// desglose por proveedor, se usa el del indicado; si no, se devuelve vacío en
/// vez de exponer la serie agregada (que incluiría a los demás).
fn parse_daily_for(
    chart: &Value,
    provider: Option<&str>,
    period: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Vec<Daily> {
    let entries: Vec<&Value> = chart.as_array().into_iter().flatten().collect();
    let mut by_day: BTreeMap<String, f64> = BTreeMap::new();
    for (i, e) in entries.iter().enumerate() {
        // La fecha sale de la posición del bucket (ventana del período + `now`).
        // El label solo se usa como último recurso si el índice no da fecha.
        let date = bucket_date(period, i, entries.len(), now).or_else(|| {
            e.get("label")
                .and_then(Value::as_str)
                .and_then(normalize_iso_day)
        });
        let Some(date) = date else { continue };
        let value = match provider {
            None => e.get("tokens").and_then(Value::as_f64).unwrap_or(0.0),
            Some(p) => match e.get("provider").and_then(Value::as_str) {
                Some(name) if name == p => e.get("tokens").and_then(Value::as_f64).unwrap_or(0.0),
                _ => continue,
            },
        };
        *by_day.entry(date).or_insert(0.0) += value;
    }
    by_day
        .into_iter()
        .map(|(date, value)| Daily { date, value })
        .collect()
}

/// Fecha `YYYY-MM-DD` del bucket `i` de `n` de la chart, replicando la
/// construcción posicional de `getChartData` de 9Router:
///   · `today` → 24 buckets horarios del día de `now` (todos hoy).
///   · `24h`   → 24 buckets horarios hacia atrás desde `now` (cruza medianoche).
///   · `7d`/`30d`/`60d` → `n` días consecutivos que acaban hoy.
///   · `all`   → `n` días consecutivos que acaban hoy (9Router arranca en la
///     primera lectura; mantener la misma cadencia día a día es lo correcto).
/// Devuelve `None` si el período no describe una serie posicional conocida.
fn bucket_date(
    period: &str,
    i: usize,
    n: usize,
    now: chrono::DateTime<chrono::Local>,
) -> Option<String> {
    use chrono::Duration;
    match period {
        // 24 buckets horarios desde la medianoche de hoy.
        "today" => Some(now.date_naive().format("%Y-%m-%d").to_string()),
        // 24 buckets horarios hacia atrás: el bucket final es la hora actual.
        "24h" => {
            let hours_ago = (n.saturating_sub(1).saturating_sub(i)) as i64;
            Some(
                (now - Duration::hours(hours_ago))
                    .date_naive()
                    .format("%Y-%m-%d")
                    .to_string(),
            )
        }
        // `n` días consecutivos que acaban hoy (el último bucket es hoy).
        "7d" | "30d" | "60d" | "all" => {
            let days_ago = (n.saturating_sub(1).saturating_sub(i)) as i64;
            Some(
                (now.date_naive() - Duration::days(days_ago))
                    .format("%Y-%m-%d")
                    .to_string(),
            )
        }
        _ => None,
    }
}

/// Normaliza una fecha **ya completa** (`YYYY-MM-DD`, con `T` u hora) a
/// `YYYY-MM-DD`. Se usa solo como respaldo cuando el índice no aporta fecha; no
/// interpreta etiquetas sin año (mes/día u hora), que son ambiguas por sí solas.
fn normalize_iso_day(label: &str) -> Option<String> {
    let label = label.trim();
    if label.get(..10).filter(|s| is_iso_date(s)).is_some() {
        return Some(label[..10].to_string());
    }
    if label.len() >= 10 && is_iso_date(&label[..10]) {
        return Some(label[..10].to_string());
    }
    None
}

/// ¿Es `s` exactamente `YYYY-MM-DD`?
fn is_iso_date(s: &str) -> bool {
    s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s.chars()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn period_label(period: &str) -> String {
    match period {
        "today" => "Hoy",
        "24h" => "Últimas 24 h",
        "7d" => "Últimos 7 días",
        "30d" => "Últimos 30 días",
        "60d" => "Últimos 60 días",
        _ => "Total",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    #[test]
    fn totals_are_summed() {
        let v = json!({"totalRequests": 1662, "totalPromptTokens": 40_000_000u64,
            "totalCompletionTokens": 7_000_000u64, "totalCost": 290.5});
        let t = parse_totals(&v);
        assert_eq!(t.requests, 1662);
        assert_eq!(t.tokens, 47_000_000);
        assert!((t.cost - 290.5).abs() < 1e-6);
    }

    #[test]
    fn provider_breakdown_maps_to_meter_and_spend() {
        let entry =
            json!({"requests": 100, "promptTokens": 1000, "completionTokens": 500, "cost": 1.25});
        let p = parse_provider(&entry);
        assert_eq!(p.meters[0].used, Some(1500.0));
        assert_eq!(p.meters[0].unit.as_deref(), Some("tokens"));
        assert_eq!(p.meters[0].id, "tokens_period");
        assert_eq!(p.spend.as_ref().map(|s| s.amount), Some(1.25));
        assert_eq!(p.message.as_deref(), Some("100 peticiones · 1.25 $"));
    }

    #[test]
    fn chart_becomes_daily_series_with_normalized_dates() {
        // La fecha de cada bucket sale de su posición en la serie (ventana del
        // período), no del label: con 4 buckets y `7d`, los índices 0..3 son los
        // días now-3, now-2, now-1 y now (17, 18, 19 y 20). Todos los tokens
        // cuentan; el label no decide la fecha.
        let now = chrono::Local
            .with_ymd_and_hms(2026, 10, 20, 12, 0, 0)
            .unwrap();
        let chart = json!([
            {"label": "Oct 14", "tokens": 120},
            {"label": "Oct 19", "tokens": 30},
            {"label": "2026-10-20", "tokens": 5},
            {"label": "vaya", "tokens": 999}
        ]);
        let d = parse_daily(&chart, "7d", now);
        // Todas las claves son YYYY-MM-DD y cada índice cae en su día.
        assert!(d
            .iter()
            .all(|x| x.date.len() == 10 && x.date.as_bytes()[4] == b'-'));
        let total: f64 = d.iter().map(|x| x.value).sum();
        assert!((total - 1154.0).abs() < 1e-6, "total inesperado: {total}");
        assert!(d
            .iter()
            .any(|x| x.date == "2026-10-20" && (x.value - 999.0).abs() < 1e-6));
        assert!(d
            .iter()
            .any(|x| x.date == "2026-10-19" && (x.value - 5.0).abs() < 1e-6));
        assert!(d
            .iter()
            .any(|x| x.date == "2026-10-18" && (x.value - 30.0).abs() < 1e-6));
        assert!(d
            .iter()
            .any(|x| x.date == "2026-10-17" && (x.value - 120.0).abs() < 1e-6));
    }

    #[test]
    fn chart_24h_places_each_bucket_on_its_real_day() {
        // Regresión del punto 2 (P2): con la referencia 2026-01-02 15:00, la serie
        // de 24 h arranca ayer 16:00. El bucket «18:00» es del 1 de enero, no del
        // 2; la hora actual (último bucket) sí es de hoy.
        let now = chrono::Local
            .with_ymd_and_hms(2026, 1, 2, 15, 0, 0)
            .unwrap();
        let mut buckets: Vec<serde_json::Value> = Vec::new();
        for h in 0..24 {
            // Etiquetas tal cual las emite 9Router (hora local del bucket).
            let bucket = now - chrono::Duration::hours((23 - h) as i64);
            buckets.push(json!({"label": bucket.format("%H:%M").to_string(), "tokens": 1}));
        }
        let chart = serde_json::Value::Array(buckets);
        let d = parse_daily(&chart, "24h", now);
        // El bucket de las 18:00 pertenece al 1 de enero (ayer), no al 2.
        assert!(
            d.iter().any(|x| x.date == "2026-01-01"),
            "falta el 2026-01-01: {d:?}"
        );
        assert!(
            d.iter().any(|x| x.date == "2026-01-02"),
            "falta el 2026-01-02: {d:?}"
        );
        // Y no colapsa todo en el día de referencia.
        assert_eq!(
            d.len(),
            2,
            "la serie 24 h debe repartirse en dos días: {d:?}"
        );
    }

    #[test]
    fn chart_60d_keeps_year_boundary_buckets() {
        // Regresión del punto 2 (P2): con referencia 2026-01-02, la ventana de 60 d
        // incluye días de finales de 2025. Un bucket «Dec 31» debe ser 2025-12-31,
        // no 2026-12-31.
        let now = chrono::Local.with_ymd_and_hms(2026, 1, 2, 9, 0, 0).unwrap();
        let mut buckets: Vec<serde_json::Value> = Vec::new();
        for i in 0..60 {
            let day = now.date_naive() - chrono::Duration::days((59 - i) as i64);
            buckets.push(json!({"label": day.format("%b %-d").to_string(), "tokens": 1}));
        }
        let chart = serde_json::Value::Array(buckets);
        let d = parse_daily(&chart, "60d", now);
        assert!(
            d.iter().any(|x| x.date == "2025-12-31"),
            "falta el 2025-12-31: {d:?}"
        );
        assert!(
            d.iter().any(|x| x.date == "2026-01-02"),
            "falta el 2026-01-02: {d:?}"
        );
        // 60 días consecutivos, sin colisión de año.
        assert_eq!(d.len(), 60, "la serie 60 d debe tener 60 días distintos");
        assert!(
            !d.iter().any(|x| x.date == "2026-12-31"),
            "bucket mal asignado a 2026-12-31"
        );
    }

    #[test]
    fn chart_today_buckets_stay_on_reference_day() {
        // `today` son 24 horas del mismo día: todos los buckets van a `now`.
        let now = chrono::Local
            .with_ymd_and_hms(2026, 1, 2, 15, 0, 0)
            .unwrap();
        let chart = json!([{"label": "00:00", "tokens": 1}, {"label": "23:00", "tokens": 2}]);
        let d = parse_daily(&chart, "today", now);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].date, "2026-01-02");
        assert!((d[0].value - 3.0).abs() < 1e-6);
    }

    #[test]
    fn iso_labels_are_kept_when_index_gives_no_date() {
        // Con un período desconocido (sin serie posicional) se conserva una fecha
        // ISO explícita; las etiquetas ambiguas (hora, mes/día) se descartan.
        let now = chrono::Local
            .with_ymd_and_hms(2026, 10, 20, 12, 0, 0)
            .unwrap();
        assert_eq!(
            normalize_iso_day("2025-12-31 23:59").as_deref(),
            Some("2025-12-31")
        );
        assert_eq!(
            normalize_iso_day("2026-10-05").as_deref(),
            Some("2026-10-05")
        );
        assert_eq!(normalize_iso_day("14:00"), None);
        assert_eq!(normalize_iso_day("Oct 5"), None);
        assert_eq!(normalize_iso_day("vaya"), None);
        // Un período desconocido no inventa fecha; solo acepta las ISO presentes.
        let chart = json!([{"label": "2026-10-05", "tokens": 7}, {"label": "Oct 5", "tokens": 9}]);
        let d = parse_daily(&chart, "raro", now);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].date, "2026-10-05");
    }

    #[test]
    fn sub_series_is_empty_without_per_provider_breakdown() {
        // La chart es agregada: un sub-proveedor no debe mostrar tokens de otros.
        let now = chrono::Local
            .with_ymd_and_hms(2026, 10, 20, 12, 0, 0)
            .unwrap();
        let chart = json!([{"label": "Oct 5", "tokens": 120}]);
        assert!(parse_daily_for(&chart, Some("claude"), "7d", now).is_empty());
    }

    #[test]
    fn sub_series_uses_per_provider_field_when_present() {
        let now = chrono::Local
            .with_ymd_and_hms(2026, 10, 20, 12, 0, 0)
            .unwrap();
        let chart = json!([
            {"label": "Oct 20", "tokens": 120, "provider": "claude"},
            {"label": "Oct 20", "tokens": 80, "provider": "kiro"}
        ]);
        let d = parse_daily_for(&chart, Some("claude"), "7d", now);
        assert_eq!(d.len(), 1);
        assert!((d[0].value - 120.0).abs() < 1e-6);
    }

    #[test]
    fn same_destination_matches_saved_url_only() {
        // Regresión del punto 1 (P1): «Guardar y probar» solo persiste credenciales
        // cuando el destino del borrador coincide con el persistido. Con A guardada
        // y B en el borrador la prueba es aislada y no deja las credenciales de B.
        let saved = "http://localhost:20128";
        // Sin borrador o igual (con/sin barra final) → mismo destino: se puede guardar.
        assert!(same_destination(saved, None));
        assert!(same_destination(saved, Some(saved)));
        assert!(same_destination(saved, Some("http://localhost:20128/")));
        assert!(same_destination("http://localhost:20128/", Some(saved)));
        assert!(same_destination(saved, Some("  http://localhost:20128  ")));
        // Otro servidor (B) → destino distinto: prueba aislada, sin persistir.
        assert!(!same_destination(saved, Some("http://localhost:3000")));
        assert!(!same_destination(saved, Some("http://otro-host:20128")));
        assert!(!same_destination(
            "http://localhost:20128",
            Some("https://localhost:20128")
        ));
    }

    #[test]
    fn snapshot_for_base_rejects_cross_destination() {
        // P1 (6º feedback): lectura coherente — la normalización de destino se
        // prueba aquí; interleavings en nine_router_creds::tests.
        assert_eq!(normalize_base("  http://a:1/  "), "http://a:1");
        assert_eq!(normalize_base("http://a:1"), normalize_base("http://a:1/"));
        assert_ne!(normalize_base("http://a:1"), normalize_base("http://b:1"));
        assert!(same_destination("http://a:1/", Some("http://a:1")));
        assert!(!same_destination("http://a:1", Some("http://b:1")));
    }

    #[test]
    fn stats_error_maps_to_status() {
        // Regresión del punto 3: sin credenciales y con el servidor exigiendo
        // sesión, el orbe pide login (no «falta configurar»); un fallo de red es Error.
        assert_eq!(StatsError::NeedsLogin.status(), Status::NeedsLogin);
        assert_eq!(
            StatsError::Other(RouterError::Other("x".into())).status(),
            Status::Error
        );
    }

    #[test]
    fn periods_have_labels() {
        assert_eq!(period_label("7d"), "Últimos 7 días");
        assert_eq!(period_label("all"), "Total");
    }

    #[test]
    fn main_meter_uses_budget_when_set() {
        let cfg = NineRouterConfig {
            monthly_budget_usd: Some(100.0),
            ..Default::default()
        };
        let stats = json!({"totalRequests": 10, "totalPromptTokens": 400, "totalCompletionTokens": 100, "totalCost": 50.0,
            "byProvider": {"claude": {}, "kiro": {}}});
        let r = build_main(
            &cfg,
            &UsageReport::new("nine_router", "9Router", Kind::Api),
            &stats,
            None,
            chrono::Local::now(),
        );
        assert_eq!(r.meters[0].label, "Gasto (periodo)");
        assert_eq!(
            r.meters.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["spend_period", "tokens"]
        );
        assert_eq!(r.meters[0].percent, Some(50.0));
        assert_eq!(r.plan.as_deref(), Some("2 proveedores"));
    }

    #[test]
    fn parse_set_cookie_reused_from_nan_cloud() {
        // La cookie de 9Router usa el mismo formato que la de NaN.
        assert_eq!(
            super::super::nan_cloud::parse_set_cookie("auth_token=abc.def; Path=/; HttpOnly"),
            Some(("auth_token".into(), "abc.def".into()))
        );
    }

    fn account_ids(subs: &[SubProvider]) -> Vec<String> {
        subs.iter().map(|s| s.account_id.clone()).collect()
    }

    #[test]
    fn discovered_providers_are_valid_account_ids() {
        let stats = json!({"byProvider": {
            "claude": {"cost": 1.5},
            "Kiro": {"cost": 0.5},
            "zz-free": {"cost": 0.0},
            "bad id!": {"cost": 9.0},
            "": {"cost": 9.0}
        }});
        // Solo los que gastan, con id de cuenta saneado (minúsculas, `-`) y
        // ordenados por coste. `bad id!` → `bad-id-`; la clave vacía se omite.
        let subs = sub_providers_from(&stats, 0.0, &BTreeMap::new());
        assert_eq!(
            account_ids(&subs),
            vec![
                "nine_router:bad-id-".to_string(),
                "nine_router:claude".to_string(),
                "nine_router:kiro".to_string()
            ]
        );
    }

    #[test]
    fn discovered_provider_keeps_original_key_for_lookup() {
        // Regresión del punto 6: la clave original (`Kiro`) debe conservarse para
        // buscar en `byProvider` (distingue mayúsculas); el id va en minúsculas.
        let stats = json!({"byProvider": {
            "Kiro": {"cost": 0.5, "requests": 3},
            "nodO Personal": {"cost": 1.0}
        }});
        let subs = sub_providers_from(&stats, 0.0, &BTreeMap::new());
        let kiro = subs
            .iter()
            .find(|s| s.account_id == "nine_router:kiro")
            .expect("kiro descubierto");
        assert_eq!(kiro.key, "Kiro");
        assert_eq!(kiro.label, "Kiro");
        // `build_sub` con la clave original encuentra el desglose (no cae en Warning).
        let base = UsageReport::new("nine_router:kiro", "9Router · Kiro", Kind::Api);
        let r = build_sub(&base, &stats, &kiro.key, None, "7d", chrono::Local::now());
        assert_eq!(r.status, Status::Ok);
        assert_eq!(r.spend.as_ref().map(|s| s.amount), Some(0.5));
    }

    #[test]
    fn discovered_provider_sanitizes_account_id_but_keeps_key() {
        let stats = json!({"byProvider": {"nodO Personal": {"cost": 1.0}}});
        let subs = sub_providers_from(&stats, 0.0, &BTreeMap::new());
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].account_id, "nine_router:nodo-personal");
        assert_eq!(subs[0].key, "nodO Personal");
    }

    #[test]
    fn custom_node_uses_its_name_as_label() {
        // Los nodos personalizados se etiquetan con su id técnico en byProvider;
        // el nombre visible sale del mapa de /api/provider-nodes.
        let id = "openai-compatible-responses-1855f0b7-4442-4046-8368-4d11dda27b96";
        let stats = json!({"byProvider": { id: {"cost": 6.72, "requests": 314} }});
        let mut names = BTreeMap::new();
        names.insert(id.to_string(), "QWEN - Alibaba".to_string());
        let subs = sub_providers_from(&stats, 0.0, &names);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].key, id);
        assert_eq!(subs[0].label, "QWEN - Alibaba");
        // El id de cuenta se sanea (minúsculas y guiones), pero sigue buscando por el id real.
        assert_eq!(
            subs[0].account_id,
            format!(
                "nine_router:{}",
                "openai-compatible-responses-1855f0b7-4442-4046-8368-4d11dda27b96"
            )
        );
        let base = UsageReport::new(&subs[0].account_id, "9Router · QWEN", Kind::Api);
        let r = build_sub(
            &base,
            &stats,
            &subs[0].key,
            None,
            "7d",
            chrono::Local::now(),
        );
        assert_eq!(r.status, Status::Ok);
        assert_eq!(r.spend.as_ref().map(|s| s.amount), Some(6.72));
    }

    #[test]
    fn custom_node_without_name_falls_back_to_key() {
        let id = "anthropic-compatible-0c354d0a-4d67-4c4e-a6ff-1360bc9c9344";
        let stats = json!({"byProvider": { id: {"cost": 6.22} }});
        let subs = sub_providers_from(&stats, 0.0, &BTreeMap::new());
        assert_eq!(subs[0].label, id); // sin nombre conocido, la propia clave
    }

    #[test]
    fn providers_without_spend_are_skipped() {
        let stats = json!({"byProvider": {"free-a": {"cost": 0}, "free-b": {"requests": 100}}});
        assert!(sub_providers_from(&stats, 0.0, &BTreeMap::new()).is_empty());
    }

    #[test]
    fn min_spend_filters_low_cost_providers() {
        let stats = json!({"byProvider": {
            "caro": {"cost": 10.0},
            "barato": {"cost": 0.5},
            "gratis": {"cost": 0.0}
        }});
        assert_eq!(
            account_ids(&sub_providers_from(&stats, 1.0, &BTreeMap::new())),
            vec!["nine_router:caro".to_string()]
        );
        assert_eq!(
            account_ids(&sub_providers_from(&stats, 0.0, &BTreeMap::new())),
            vec![
                "nine_router:caro".to_string(),
                "nine_router:barato".to_string()
            ]
        );
    }
}
