//! Gemini (Google AI Pro / Gemini CLI / Code Assist) — cuotas diarias por modelo.
//!
//! Igual que Claude y Codex: no hay API pública. Se reutiliza la sesión que guarda
//! Gemini CLI al iniciar sesión con Google (`~/.gemini/oauth_creds.json`) y se
//! consultan los mismos endpoints que usa `/stats` (NO OFICIALES):
//!   · `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`   → proyecto y plan
//!   · `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` → cubos por modelo
//!
//! El token de acceso de Google dura ~1 h. Si ha caducado lo renovamos en memoria con
//! el refresh token y el cliente OAuth público de Gemini CLI (app instalada); no se
//! escribe nada en el fichero de la CLI y Google no rota el refresh token.

use super::{home, net_error, read_json, resolve_path, Who};
use crate::config::SubscriptionConfig;
use crate::model::{Kind, Meter, Status, UsageReport};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

const API: &str = "https://cloudcode-pa.googleapis.com/v1internal";
// Cliente OAuth de app instalada publicado en el código abierto de Gemini CLI.
const CLIENT_ID: &str = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET: &str = "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";

/// Tokens renovados en memoria por cuenta (clave: refresh token): (access_token, caduca_en_ms).
static CACHED: Mutex<BTreeMap<String, (String, i64)>> = Mutex::new(BTreeMap::new());

pub async fn fetch(cfg: &SubscriptionConfig, who: Who<'_>, http: &reqwest::Client) -> UsageReport {
    let report = who.report("Gemini", Kind::Subscription);
    let candidates = vec![home().join(".gemini").join("oauth_creds.json")];
    let path = match resolve_path(cfg.credentials_path.as_deref(), &candidates) {
        Ok(p) => p,
        Err(e) => {
            return report.fail(
                Status::NeedsLogin,
                format!("{e}. Inicia sesión en Gemini CLI con tu cuenta de Google."),
            )
        }
    };
    let creds = match read_json(&path) {
        Ok(v) => v,
        Err(e) => return report.fail(Status::Error, e),
    };
    let token = match access_token(&creds, http).await {
        Ok(t) => t,
        Err(e) => return report.fail(Status::NeedsLogin, e),
    };

    // 1. Proyecto y plan
    let load = post(http, &token, "loadCodeAssist", &json!({
        "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" }
    }))
    .await;
    let load = match load {
        Ok(v) => v,
        Err(e) => return report.fail(e.0, e.1),
    };
    let project = project_id(&load);
    let mut report = report;
    report.plan = tier_name(&load);

    // 2. Cuotas
    let body = match &project {
        Some(p) => json!({ "project": p }),
        None => json!({}),
    };
    let quota = match post(http, &token, "retrieveUserQuota", &body).await {
        Ok(v) => v,
        Err(e) => return report.fail(e.0, e.1),
    };
    report.meters = parse_quota(&quota);
    if report.meters.is_empty() {
        report.message = Some("Sin cuotas por modelo en la respuesta (¿cuenta con API key en vez de login de Google?)".into());
    }
    report
}

/// ¿El token del archivo aún es usable, o hay que refrescar?
/// Pura y testeable sin HTTP (mismo patrón que `is_expired`/`parse_validity`).
fn token_needs_refresh(creds: &Value, now_ms: i64) -> bool {
    let usable = creds
        .get("access_token")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if !usable {
        return true;
    }
    let expiry = creds
        .get("expiry_date")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    expiry - 60_000 <= now_ms
}

async fn access_token(creds: &Value, http: &reqwest::Client) -> Result<String, String> {
    let now = chrono::Utc::now().timestamp_millis();
    if !token_needs_refresh(creds, now) {
        return Ok(creds
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap()
            .to_string());
    }
    let refresh = creds
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or("La sesión de Gemini CLI ha caducado. Ábrelo para renovarla.")?;
    let cached = CACHED.lock().unwrap().get(refresh).cloned();
    if let Some((t, exp)) = cached {
        if exp - 60_000 > now {
            return Ok(t);
        }
    }
    let res = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(net_error)?;
    if !res.status().is_success() {
        return Err(
            "Google no ha renovado la sesión de Gemini CLI. Ábrelo e inicia sesión de nuevo."
                .into(),
        );
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    let t = v
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Respuesta de Google sin access_token")?
        .to_string();
    let exp = now + v.get("expires_in").and_then(Value::as_i64).unwrap_or(3600) * 1000;
    CACHED
        .lock()
        .unwrap()
        .insert(refresh.to_string(), (t.clone(), exp));
    Ok(t)
}

async fn post(
    http: &reqwest::Client,
    token: &str,
    method: &str,
    body: &Value,
) -> Result<Value, (Status, String)> {
    let res = http
        .post(format!("{API}:{method}"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| (Status::Error, net_error(e)))?;
    match res.status().as_u16() {
        200 => res
            .json()
            .await
            .map_err(|e| (Status::Error, format!("Respuesta inesperada: {e}"))),
        401 => {
            CACHED.lock().unwrap().clear();
            Err((
                Status::NeedsLogin,
                "Sesión de Gemini rechazada. Abre Gemini CLI para renovarla.".into(),
            ))
        }
        429 => Err((
            Status::Warning,
            "El endpoint de cuotas está limitando peticiones.".into(),
        )),
        code => Err((Status::Error, format!("HTTP {code} en {method}"))),
    }
}

pub(crate) fn project_id(v: &Value) -> Option<String> {
    let p = v.get("cloudaicompanionProject")?;
    p.as_str()
        .map(str::to_string)
        .or_else(|| p.get("id").and_then(Value::as_str).map(str::to_string))
}

pub(crate) fn tier_name(v: &Value) -> Option<String> {
    let t = v
        .get("paidTier")
        .filter(|t| t.is_object())
        .or_else(|| v.get("currentTier"))?;
    t.get("name")
        .or_else(|| t.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Un medidor por modelo (el % gastado es 1 − remainingFraction), el más gastado primero.
pub(crate) fn parse_quota(v: &Value) -> Vec<Meter> {
    let mut by_model: BTreeMap<String, Meter> = BTreeMap::new();
    for b in v
        .get("buckets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(model) = b.get("modelId").and_then(Value::as_str) else {
            continue;
        };
        let Some(remaining) = b.get("remainingFraction").and_then(Value::as_f64) else {
            continue;
        };
        // Variantes «_vertex» y similares: nos quedamos con la más gastada de cada modelo.
        let name = model.split("_vertex").next().unwrap_or(model).to_string();
        let pct = ((1.0 - remaining) * 100.0).clamp(0.0, 100.0);
        let meter = Meter {
            id: format!("model:{name}"),
            label: name.clone(),
            percent: Some(pct),
            used: None,
            limit: None,
            unit: None,
            resets_at: b
                .get("resetTime")
                .and_then(Value::as_str)
                .map(str::to_string),
            window_seconds: Some(86_400),
        };
        let keep = by_model
            .get(&name)
            .map(|m| m.percent < meter.percent)
            .unwrap_or(true);
        if keep {
            by_model.insert(name, meter);
        }
    }
    let mut out: Vec<Meter> = by_model.into_values().collect();
    out.sort_by(|a, b| {
        b.percent
            .partial_cmp(&a.percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quota_buckets() {
        let v = json!({"buckets": [
            {"modelId": "gemini-2.5-pro", "remainingFraction": 0.25, "resetTime": "2026-10-07T07:00:00Z", "tokenType": "REQUESTS"},
            {"modelId": "gemini-2.5-pro_vertex", "remainingFraction": 0.9, "resetTime": "2026-10-07T07:00:00Z"},
            {"modelId": "gemini-2.5-flash", "remainingFraction": 1.0, "resetTime": "2026-10-07T07:00:00Z"}
        ]});
        let m = parse_quota(&v);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].label, "gemini-2.5-pro");
        assert_eq!(m[0].id, "model:gemini-2.5-pro");
        assert_eq!(m[1].id, "model:gemini-2.5-flash");
        assert_eq!(m[0].percent, Some(75.0));
        assert_eq!(m[0].window_seconds, Some(86_400));
        assert_eq!(m[1].percent, Some(0.0));
    }

    #[test]
    fn reads_project_and_tier() {
        let v = json!({"cloudaicompanionProject": "my-proj-123", "currentTier": {"id": "standard-tier", "name": "Gemini Code Assist"},
            "paidTier": {"id": "g1-pro-tier", "name": "Google AI Pro"}});
        assert_eq!(project_id(&v).as_deref(), Some("my-proj-123"));
        assert_eq!(tier_name(&v).as_deref(), Some("Google AI Pro"));
        assert_eq!(
            project_id(&json!({"cloudaicompanionProject": {"id": "p2"}})).as_deref(),
            Some("p2")
        );
    }

    /// Sesión real de Gemini CLI: el fixture es la estructura que escribe
    /// `~/.gemini/oauth_creds.json` tras `gemini` (login con Google).
    /// `token_needs_refresh` decide sin HTTP (función pura) que el token del
    /// archivo sigue válido → no dispara el refresh de red. El camino de
    /// refresh real (expirado) depende de `reqwest` y queda fuera (gap
    /// documentado); aquí se verifica la decisión, no la llamada HTTP.
    #[test]
    fn parses_real_session_fixture_returns_valid_token_without_http() {
        let raw = include_str!("fixtures/gemini-oauth_creds.json");
        let v: Value = serde_json::from_str(raw).expect("fixture gemini válido");
        assert_eq!(
            v.get("access_token").and_then(Value::as_str),
            Some("example-access-token-gemini")
        );
        // Ahora (2026) muy por debajo de expiry_date: NO necesita refresh.
        let now = 1_800_000_000_000;
        assert!(
            !token_needs_refresh(&v, now),
            "token del fixture sigue vigente"
        );
        // Si ya pasó la expiry, el fixture obliga a refrescar (no usa el token).
        assert!(
            token_needs_refresh(&v, 2_100_000_000_000),
            "token expirado exige refresh"
        );
        // Sin access_token → siempre hay que refrescar.
        assert!(
            token_needs_refresh(&json!({"refresh_token": "r"}), now),
            "sin token, hay que refrescar"
        );
    }
}
