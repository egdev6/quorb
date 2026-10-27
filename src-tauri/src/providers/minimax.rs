//! MiniMax — API oficial.
//!   · `GET {base}/v1/token_plan/remains` → cuota del plan (Subscription Key del plan M/Token)
//!   · `GET {base}/account/query_balance` → saldo PAYG (API key de pago por uso, best-effort)
//!
//! Son **dos credenciales distintas** en la consola de MiniMax: la Subscription Key
//! del plan y la API key de pago por uso. Cada medidor usa la suya.
//!
//! MiniMax **responde HTTP 200 incluso cuando la operación falla**: el estado real
//! viaja en el sobre `base_resp`. Ver [[envelope]].

use super::{net_error, Who};
use crate::config::MiniMaxConfig;
use crate::model::{Kind, Meter, Status, UsageReport};
use crate::secrets;
use serde_json::Value;

pub async fn fetch(cfg: &MiniMaxConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("MiniMax", Kind::Subscription);
    let Some(key) = who.secret(secrets::MINIMAX_SUBSCRIPTION_KEY) else {
        return report.fail(
            Status::Unconfigured,
            "Añade tu Subscription Key de MiniMax en Ajustes.",
        );
    };
    let base = cfg.base_url.trim_end_matches('/');

    let res = match http
        .get(format!("{base}/v1/token_plan/remains"))
        .bearer_auth(&key)
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
                "Subscription Key de MiniMax rechazada.",
            )
        }
        code => {
            return report.fail(
                Status::Error,
                format!("HTTP {code} en /v1/token_plan/remains"),
            )
        }
    }
    let plan: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
    };
    if let Err(msg) = envelope(&plan) {
        return report.fail(Status::Error, msg);
    }

    // El saldo PAYG va con otra clave y es un endpoint que no está en la
    // documentación pública oficial: si falla, el informe del plan sigue válido.
    // Guardamos si había clave para poder distinguir «no configuré el saldo» de
    // «lo configuré y falló»: sin eso el usuario no tiene forma de saberlo.
    let payg_key = who.secret(secrets::MINIMAX_API_KEY);
    let balance = match payg_key.as_deref() {
        Some(api_key) => balance(http, base, api_key).await,
        None => None,
    };

    let mut report = report;
    let parsed = parse(&plan, balance.as_ref(), payg_key.is_some());
    // Un informe sin medidores y sin mensaje no dice nada: sería un orbe en cero
    // que el usuario lee como «no he consumido». Si MiniMax renombra los campos,
    // esto lo delata en vez de fallar en silencio.
    if parsed.meters.is_empty() && parsed.message.is_none() {
        return report.fail(
            Status::Warning,
            "MiniMax respondió bien pero su formato no coincide con el que se espera; puede haber cambiado el contrato.",
        );
    }
    report.meters = parsed.meters;
    report.message = parsed.message;
    report
}

pub(crate) struct Parsed {
    pub meters: Vec<Meter>,
    pub message: Option<String>,
}

/// Lectura **best-effort** del saldo: cualquier fallo devuelve `None` y deja el
/// informe del plan intacto. No reintenta ni distingue causas, porque ninguna
/// cambia lo que el usuario ve.
async fn balance(http: &reqwest::Client, base: &str, api_key: &str) -> Option<Value> {
    let res = http
        .get(format!("{base}/account/query_balance"))
        .bearer_auth(api_key)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let value: Value = res.json().await.ok()?;
    envelope(&value).ok()?;
    Some(value)
}

/// MiniMax devuelve **HTTP 200 con el fallo dentro de `base_resp`**. Sin este
/// chequeo, una clave caducada o un plan inexistente producen un informe vacío
/// que parece correcto, que es peor que un fallo visible.
///
/// Estricto con el sobre ausente: un `token_plan/remains` que no lo trae no es un
/// payload que sabemos leer, así que se reporta como error en vez de devolver
/// cero medidores en silencio.
fn envelope(v: &Value) -> Result<(), String> {
    let Some(base) = v.get("base_resp") else {
        return Err("MiniMax devolvió una respuesta sin base_resp".into());
    };
    if base.is_null() {
        return Err("MiniMax devolvió una respuesta con base_resp vacío".into());
    }
    match num(base.get("status_code")) {
        Some(0.0) => Ok(()),
        Some(code) => Err(base
            .get("status_msg")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .map_or_else(
                || format!("MiniMax rechazó la consulta (status_code {code})"),
                |m| format!("MiniMax: {m}"),
            )),
        // Sin código no hay veredicto: no se inventa un fallo ni un éxito.
        None => Ok(()),
    }
}

/// Los importes de MiniMax llegan como cadenas decimales en varios endpoints y
/// como números en otros. Aceptamos ambos sin adivinar.
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| {
        x.as_f64()
            .or_else(|| x.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

/// Las dos ventanas del Token Plan.
///
/// Campos **del payload real** (GET `/v1/token_plan/remains`), no de documentación:
/// los contadores vienen dentro de `model_remains[]`, uno por categoría de modelo
/// (`general`, `video`…), y el campo fiable es `current_*_remaining_percent`, un
/// porcentaje **restante**. Los contadores `_usage_count` / `_total_count` no sirven:
/// en `general` vienen a 0 mientras el porcentaje restante dice 81, así que dividir
/// uno por otro daría 0 % con el 19 % consumido.
struct Window {
    id: &'static str,
    label: &'static str,
    remaining: &'static str,
    start: &'static str,
    end: &'static str,
}

const WINDOWS: [Window; 2] = [
    Window {
        id: "5h",
        label: "5 h",
        remaining: "current_interval_remaining_percent",
        start: "start_time",
        end: "end_time",
    },
    Window {
        id: "weekly",
        label: "semanal",
        remaining: "current_weekly_remaining_percent",
        start: "weekly_start_time",
        end: "weekly_end_time",
    },
];

/// MiniMax manda los tiempos en **milisegundos** desde epoch. Con segundos, una
/// ventana de 2026 caería en el año 58.000.
fn millis(v: Option<&Value>) -> Option<i64> {
    num(v).map(|n| (n / 1000.0) as i64)
}

pub(crate) fn parse(plan: &Value, balance: Option<&Value>, payg_configured: bool) -> Parsed {
    let mut meters = vec![];

    // El payload real trae `model_remains[]`: **una entrada por categoría de
    // modelo**, no una barra compartida. Por eso el id del medidor lleva el
    // nombre del modelo: `general` y `video` consumen cuotas distintas y hay que
    // poder distinguirlos en el popup y en el historial.
    //
    // El porcentaje sale de `100 - current_*_remaining_percent`, que es un
    // **restante**. Los contadores `_usage_count` / `_total_count` existen pero no
    // son fiables (en `general` vienen a 0 con el 81 % restante), así que
    // dividirlos daría un anillo en cero con la cuota realmente consumida.
    for entry in plan
        .get("model_remains")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(model) = entry.get("model_name").and_then(Value::as_str) else {
            continue;
        };
        let slug: String = model
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect();
        for window in WINDOWS {
            let Some(remaining) = num(entry.get(window.remaining)) else {
                continue;
            };
            let start = millis(entry.get(window.start));
            let end = millis(entry.get(window.end));
            meters.push(Meter {
                id: format!("token_plan_{slug}_{}", window.id),
                label: format!("{model} · {label}", label = window.label),
                percent: Some((100.0 - remaining).clamp(0.0, 100.0)),
                // El payload no trae totales en unidades utilizables, así que no
                // se inventan `used`/`limit`: solo el porcentaje es verificable.
                used: None,
                limit: None,
                unit: None,
                resets_at: end
                    .and_then(|at| chrono::DateTime::from_timestamp(at, 0))
                    .map(|at| at.to_rfc3339()),
                window_seconds: start.zip(end).map(|(s, e)| e - s),
            });
        }
    }

    // El saldo PAYG no es un porcentaje: no hay «total» contra el que medirlo.
    // Va como medidor sin `percent`, que la UI ya sabe mostrar sin añadir un anillo.
    let available = balance.and_then(|b| num(b.get("available_amount")));
    if let Some(amount) = available {
        meters.push(Meter {
            id: "payg_balance".into(),
            label: "Saldo PAYG".into(),
            percent: None,
            used: Some(amount),
            limit: None,
            unit: Some("USD".into()),
            resets_at: None,
            window_seconds: None,
        });
    }

    // El mensaje resume el **peor** medidor del plan, no el primero: con varias
    // categorías de modelo y dos ventanas cada una, decir solo el primero esconde
    // el que está al límite.
    let worst = meters
        .iter()
        .filter(|m| m.percent.is_some())
        .max_by(|a, b| {
            a.percent
                .partial_cmp(&b.percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    let plan = worst.map(|m| format!("{} {:.0}%", m.label, m.percent.unwrap_or(0.0)));
    // Con la API key puesta y el saldo sin llegar, el usuario no puede
    // distinguir «no lo configuré» de «lo configuré y falla». Decírselo es la
    // diferencia entre depurar una clave y pensar que MiniMax no publica el saldo.
    let saldo = match available {
        Some(balance) => Some(format!("saldo {balance:.2} $")),
        None if payg_configured => Some("saldo no disponible".to_string()),
        None => None,
    };
    let message = match (plan, saldo) {
        (Some(plan), Some(saldo)) => Some(format!("{plan} · {saldo}")),
        (Some(plan), None) => Some(plan),
        (None, Some(saldo)) => Some(saldo),
        (None, None) => None,
    };
    Parsed { meters, message }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Envuelve un cuerpo **en el mismo nivel** que `base_resp`, como lo hace
    /// MiniMax: `model_remains` y el sobre son hermanos.
    fn ok(mut body: Value) -> Value {
        body.as_object_mut()
            .expect("el fixture debe ser un objeto")
            .insert(
                "base_resp".into(),
                json!({"status_code": 0, "status_msg": "success"}),
            );
        body
    }

    /// **Payload real** de `GET /v1/token_plan/remains` con una Subscription Key
    /// válida,recortado a los campos que el parser usa. Reproduce los tres rasgos
    /// que rompían el parser anterior: los datos viven en `model_remains[]`, hay
    /// una entrada por categoría de modelo, y los contadores vienen a 0 mientras
    /// el porcentaje restante dice otra cosa.
    fn real() -> Value {
        json!({
            "model_remains": [
                {
                    "start_time": 1_792_681_200_000i64, "end_time": 1_792_699_200_000i64,
                    "remains_time": 4_587_190,
                    "current_interval_total_count": 0, "current_interval_usage_count": 0,
                    "model_name": "general",
                    "current_weekly_total_count": 0, "current_weekly_usage_count": 0,
                    "weekly_start_time": 1_792_368_000_000i64, "weekly_end_time": 1_792_972_800_000i64,
                    "current_interval_status": 1, "current_interval_remaining_percent": 81,
                    "current_weekly_status": 1, "current_weekly_remaining_percent": 95
                },
                {
                    "start_time": 1_792_627_200_000i64, "end_time": 1_792_713_600_000i64,
                    "current_interval_total_count": 3, "current_interval_usage_count": 0,
                    "model_name": "video",
                    "current_weekly_total_count": 21, "current_weekly_usage_count": 0,
                    "current_interval_remaining_percent": 100,
                    "current_weekly_remaining_percent": 100
                }
            ],
            "base_resp": { "status_code": 0, "status_msg": "success" }
        })
    }

    #[test]
    fn lee_el_porcentaje_del_payload_real_y_no_de_los_contadores_a_cero() {
        let p = parse(&real(), None, false);
        // Los contadores de `general` valen 0/0; si el parser los usara daría 0 %.
        let general = p
            .meters
            .iter()
            .find(|m| m.id == "token_plan_general_5h")
            .expect("medidor de general");
        assert_eq!(
            general.percent,
            Some(19.0),
            "81 % restante = 19 % consumido"
        );
        assert_eq!(
            general.used, None,
            "el payload no da totales en unidades utilizables"
        );
        assert_eq!(general.limit, None);
        // 5 h y semanal, por cada categoría.
        assert_eq!(
            p.meters.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            [
                "token_plan_general_5h",
                "token_plan_general_weekly",
                "token_plan_video_5h",
                "token_plan_video_weekly"
            ]
        );
        assert_eq!(
            p.meters
                .iter()
                .find(|m| m.id == "token_plan_general_weekly")
                .unwrap()
                .percent,
            Some(5.0)
        );
        assert_eq!(
            p.meters
                .iter()
                .find(|m| m.id == "token_plan_video_5h")
                .unwrap()
                .percent,
            Some(0.0)
        );
        // El peor medidor manda en el mensaje: general 5 h al 19 %, no video al 0 %.
        assert_eq!(p.message.as_deref(), Some("general · 5 h 19%"));
    }

    #[test]
    fn interpreta_los_tiempos_como_milisegundos() {
        let p = parse(&real(), None, false);
        let general = &p.meters[0];
        assert_eq!(
            general.resets_at.as_deref(),
            Some("2026-10-22T20:00:00+00:00")
        );
        assert_eq!(
            general.window_seconds,
            Some(18_000),
            "la ventana de 5 h son 5 horas, no 5 millones"
        );
        assert_eq!(
            p.meters[1].resets_at.as_deref(),
            Some("2026-10-26T00:00:00+00:00")
        );
    }

    #[test]
    fn un_solo_modelo_no_inventa_los_demas() {
        let p = parse(&real(), None, false);
        // 4 medidores: 2 categorías x 2 ventanas. Ni uno de más.
        assert_eq!(p.meters.len(), 4);
        let vacio = parse(
            &json!({"model_remains": [], "base_resp": {"status_code": 0}}),
            None,
            false,
        );
        assert!(vacio.meters.is_empty());
        let sin_array = parse(&ok(json!({})), None, false);
        assert!(sin_array.meters.is_empty() && sin_array.message.is_none());
    }

    #[test]
    fn rejects_a_200_carrying_a_failed_base_resp() {
        let v = json!({"base_resp": {"status_code": 1004, "status_msg": "invalid api key"}});
        assert_eq!(envelope(&v).unwrap_err(), "MiniMax: invalid api key");
        let sin_mensaje = json!({"base_resp": {"status_code": 1008}});
        assert_eq!(
            envelope(&sin_mensaje).unwrap_err(),
            "MiniMax rechazó la consulta (status_code 1008)"
        );
        assert!(
            envelope(&real()).is_ok(),
            "una respuesta real de éxito trae base_resp con status_code 0"
        );
        assert!(
            envelope(&json!({"model_remains": []})).is_err(),
            "sin sobre no se afirma un éxito sin verificar"
        );
        assert!(envelope(&json!({"base_resp": null})).is_err());
        assert!(
            envelope(&json!({"base_resp": {}})).is_ok(),
            "sin código no hay veredicto en ninguna dirección"
        );
    }

    #[test]
    fn saldo_payg_es_un_valor_y_nunca_una_anillo() {
        let p = parse(
            &real(),
            Some(&ok(
                json!({"available_amount": "12.50", "cash_balance": "10.00", "voucher_balance": "2.50"}),
            )),
            true,
        );
        let balance = p
            .meters
            .iter()
            .find(|m| m.id == "payg_balance")
            .expect("medidor de saldo");
        assert_eq!(
            balance.percent, None,
            "un saldo no es un porcentaje consumido"
        );
        assert_eq!(balance.used, Some(12.50));
        assert_eq!(balance.unit.as_deref(), Some("USD"));
        assert_eq!(
            p.message.as_deref(),
            Some("general · 5 h 19% · saldo 12.50 $")
        );
    }

    #[test]
    fn distingue_saldo_sin_configurar_de_configurado_y_fallido() {
        assert_eq!(
            parse(&real(), None, false).message.as_deref(),
            Some("general · 5 h 19%")
        );
        assert_eq!(
            parse(&real(), None, true).message.as_deref(),
            Some("general · 5 h 19% · saldo no disponible")
        );
        assert_eq!(
            parse(&ok(json!({"model_remains": []})), None, true)
                .message
                .as_deref(),
            Some("saldo no disponible")
        );
    }

    #[test]
    fn satura_un_porcentaje_que_supera_el_rango() {
        // Porcentaje restante negativo o > 100: el payload viene sucio.
        let sucio = json!({"model_remains": [
            {"model_name": "general", "current_interval_remaining_percent": -20, "current_weekly_remaining_percent": 140}
        ], "base_resp": {"status_code": 0}});
        let p = parse(&sucio, None, false);
        assert_eq!(
            p.meters[0].percent,
            Some(100.0),
            "restante negativo satura a 100 % consumido"
        );
        assert_eq!(
            p.meters[1].percent,
            Some(0.0),
            "restante > 100 no produce un negativo"
        );
    }
}
