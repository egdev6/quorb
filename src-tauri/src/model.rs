//! Modelo común que reciben las vistas, sea cual sea el proveedor.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Ok,
    /// Hay datos pero algo merece atención (rate limit del endpoint, etc.).
    Warning,
    Error,
    /// No hay sesión o ha caducado: hay que pasar por el login oficial.
    NeedsLogin,
    /// Falta configurar una key.
    Unconfigured,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Subscription,
    Api,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    /// Identificador estable **y obligatorio** (snake_case) del medidor: la lógica
    /// de la UI y el historial se apoyan en él, no en `label`, que es solo texto
    /// visible y cambia con el idioma. Todo medidor nuevo debe traer id (se
    /// vigila con `debug_assert!` al grabar en el historial); solo los medidores
    /// legacy pueden llegar sin él, y entonces `history::sample_key` respalda
    /// en `label`.
    pub id: String,
    pub label: String,
    /// 0–100
    pub percent: Option<f64>,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub unit: Option<String>,
    /// RFC 3339
    pub resets_at: Option<String>,
    /// Duración de la ventana en segundos (5 h, 7 días, mes…), para calcular el ritmo de consumo.
    pub window_seconds: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub amount: f64,
    pub currency: String,
    pub period_label: String,
    pub budget: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Daily {
    /// YYYY-MM-DD
    pub date: String,
    pub value: f64,
}

/// Explicit provider metadata, never an estimated cancellation date.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ValidityKind {
    Period,
    Key,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Validity {
    pub at: String,
    pub kind: ValidityKind,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub status: Status,
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validity: Option<Validity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_resets: Option<u32>,
    pub meters: Vec<Meter>,
    pub spend: Option<Spend>,
    pub message: Option<String>,
    /// `login` | `settings`
    pub action: Option<String>,
    /// Tokens por día (si el proveedor los da), para el historial del panel.
    pub daily: Vec<Daily>,
    pub fetched_at: String,
}

impl UsageReport {
    pub fn new(id: &str, name: &str, kind: Kind) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind,
            status: Status::Ok,
            plan: None,
            validity: None,
            available_resets: None,
            meters: vec![],
            spend: None,
            message: None,
            action: None,
            daily: vec![],
            fetched_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    pub fn fail(mut self, status: Status, message: impl Into<String>) -> Self {
        self.action = match status {
            Status::NeedsLogin => Some("login".into()),
            Status::Unconfigured => Some("settings".into()),
            _ => self.action,
        };
        self.validity = None;
        self.available_resets = None;
        self.status = status;
        self.message = Some(message.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_credits_serialization_omits_unknown_but_preserves_zero() {
        let mut report = UsageReport::new("codex", "Codex", Kind::Subscription);
        assert_eq!(report.available_resets, None);
        assert!(serde_json::to_value(&report)
            .unwrap()
            .get("availableResets")
            .is_none());
        report.available_resets = Some(0);
        assert_eq!(serde_json::to_value(&report).unwrap()["availableResets"], 0);
    }

    #[test]
    fn meter_serializes_its_stable_id_next_to_the_label() {
        let m = Meter {
            id: "weekly".into(),
            label: "Semana".into(),
            ..Default::default()
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["id"], "weekly");
        assert_eq!(v["label"], "Semana");
        assert_eq!(serde_json::to_value(Meter::default()).unwrap()["id"], "");
    }

    #[test]
    fn reset_credits_failure_clears_available_metadata() {
        for status in [
            Status::Warning,
            Status::Error,
            Status::NeedsLogin,
            Status::Unconfigured,
        ] {
            let mut report = UsageReport::new("codex", "Codex", Kind::Subscription);
            report.available_resets = Some(2);
            let failed = report.fail(status.clone(), "synthetic failure");
            assert_eq!(failed.status, status);
            assert_eq!(failed.available_resets, None);
            assert!(serde_json::to_value(&failed)
                .unwrap()
                .get("availableResets")
                .is_none());
        }
    }
}
