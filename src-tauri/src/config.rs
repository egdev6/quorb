//! Configuración persistente (sin secretos). Los tokens/keys viven en `secrets`.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const ORB_SIZE_MIN: u32 = 32;
pub const ORB_SIZE_MAX: u32 = 80;
pub const ORB_SIZE_DEFAULT: u32 = 48;
pub const ACCENT_DEFAULT: &str = "#ff0036";
/// Idiomas de la interfaz. Cualquier otro valor se sanea a `LOCALE_DEFAULT`.
/// Contrato duplicado en `src/lib/types.ts` › `Locale`: si cambias uno, cambia el otro
/// (la paridad se cubrirá con test junto a los catálogos de L2, #66).
pub const LOCALES: [&str; 2] = ["es", "en"];
pub const LOCALE_DEFAULT: &str = "es";

/// Un `locale` con tipo inesperado (null, número, lista…) no puede tirar el
/// parseo de todo config.json: se lee como vacío y `sanitized` lo lleva a `es`.
fn lenient_locale<'de, D>(de: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match serde_json::Value::deserialize(de)? {
        serde_json::Value::String(s) => s,
        _ => String::new(),
    })
}

/// Acepta `#rgb` o `#rrggbb` (con o sin `#`) y lo devuelve como `#rrggbb` en minúsculas.
fn normalize_hex(s: &str) -> Option<String> {
    let h = s.trim().trim_start_matches('#');
    if !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match h.len() {
        6 => Some(format!("#{}", h.to_ascii_lowercase())),
        3 => Some(format!("#{}", h.chars().flat_map(|c| [c, c]).collect::<String>().to_ascii_lowercase())),
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    /// Idioma de la interfaz: es | en (por defecto `es`).
    #[serde(deserialize_with = "lenient_locale")]
    pub locale: String,
    /// Cada cuántos minutos se refrescan los datos (mínimo 1).
    pub refresh_minutes: u32,
    /// Opacidad del widget (0.3 – 1.0).
    pub opacity: f32,
    /// Círculos pequeños: un solo anillo por proveedor.
    pub compact: bool,
    /// Saldo de resets visible en los círculos; el popup siempre lo conserva.
    pub show_resets: bool,
    /// Diámetro de los círculos de la tira, en px (ORB_SIZE_MIN–ORB_SIZE_MAX).
    pub orb_size: u32,
    /// Color base (#rrggbb) de anillos y barras; los otros dos tonos se derivan en el frontend.
    pub accent_color: String,
    pub always_on_top: bool,
    /// Borde de la pantalla al que va pegada la tira: top | bottom | left | right
    pub dock_edge: String,
    /// Posición a lo largo del borde (0 = inicio, 1 = final).
    pub dock_offset: f64,
    /// Nombre del monitor (None = el actual / principal).
    pub dock_monitor: Option<String>,
    /// Ocultar la tira dejando solo una franja en el borde; aparece al acercar el ratón.
    pub auto_hide: bool,
    /// Buscar actualizaciones en GitHub Releases al arrancar y cada pocas horas.
    pub auto_update: bool,
    /// Orden de los círculos (ids de proveedor). Los que falten van al final.
    pub provider_order: Vec<String>,
    /// Círculos ocultos en la tira (se siguen consultando y avisando).
    pub hidden_providers: Vec<String>,
    pub alerts: AlertsConfig,
    pub shortcuts: ShortcutsConfig,
    pub claude: SubscriptionConfig,
    pub codex: SubscriptionConfig,
    pub gemini: SubscriptionConfig,
    pub cursor: SubscriptionConfig,
    pub grok: SubscriptionConfig,
    pub copilot: CopilotConfig,
    pub openrouter: OpenRouterConfig,
    pub anthropic_api: ApiCostConfig,
    pub openai_api: ApiCostConfig,
    pub nan: NanConfig,
    pub minimax: MiniMaxConfig,
    pub nine_router: NineRouterConfig,
    /// Cuentas adicionales de un proveedor (la principal es la de arriba).
    pub accounts: Vec<Account>,
}

/// Campos que el widget puede cambiar por su cuenta. Deliberadamente no incluye
/// cuentas ni secretos: un snapshot obsoleto del widget no puede borrar cuentas.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WidgetPatch {
    pub dock_edge: Option<String>,
    pub dock_offset: Option<f64>,
    /// `null` explícito = sin monitor concreto; ausente = no cambiar.
    #[serde(default, deserialize_with = "double_option")]
    pub dock_monitor: Option<Option<String>>,
    pub provider_order: Option<Vec<String>>,
    pub hidden_providers: Option<Vec<String>>,
    /// Personalización inmediata (#97): se aplica al momento y se persiste por
    /// este mismo merge atómico. El backend sigue siendo la autoridad que
    /// normaliza (`sanitized`) y nunca toca cuentas, secretos ni atajos.
    pub opacity: Option<f32>,
    pub compact: Option<bool>,
    pub show_resets: Option<bool>,
    pub auto_hide: Option<bool>,
    pub always_on_top: Option<bool>,
    pub orb_size: Option<u32>,
    pub accent_color: Option<String>,
}

/// Distingue un campo ausente (`None`) de un `null` explícito (`Some(None)`).
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

impl AppConfig {
    /// Aplica solo los campos del widget sobre la config actual. Los campos
    /// ausentes se conservan y el resto (cuentas, atajos, avisos…) no se toca.
    pub fn apply_widget_patch(&mut self, patch: WidgetPatch) {
        if let Some(edge) = patch.dock_edge {
            self.dock_edge = edge;
        }
        if let Some(offset) = patch.dock_offset {
            self.dock_offset = offset;
        }
        if let Some(monitor) = patch.dock_monitor {
            self.dock_monitor = monitor;
        }
        if let Some(order) = patch.provider_order {
            self.provider_order = order;
        }
        if let Some(hidden) = patch.hidden_providers {
            self.hidden_providers = hidden;
        }
        if let Some(opacity) = patch.opacity {
            self.opacity = opacity;
        }
        if let Some(compact) = patch.compact {
            self.compact = compact;
        }
        if let Some(show_resets) = patch.show_resets {
            self.show_resets = show_resets;
        }
        if let Some(auto_hide) = patch.auto_hide {
            self.auto_hide = auto_hide;
        }
        if let Some(always_on_top) = patch.always_on_top {
            self.always_on_top = always_on_top;
        }
        if let Some(orb_size) = patch.orb_size {
            self.orb_size = orb_size;
        }
        if let Some(accent_color) = patch.accent_color {
            self.accent_color = accent_color;
        }
    }
}

/// Proveedores que admiten cuentas adicionales (todos).
/// En 9Router las «cuentas» son sus sub-proveedores (`nine_router:claude`…); el
/// backend las descubre solo, pero el id debe validar como cuenta.
pub const ACCOUNT_PROVIDERS: [&str; 10] = [
    "claude",
    "codex",
    "gemini",
    "cursor",
    "copilot",
    "nan",
    "openrouter",
    "anthropic_api",
    "openai_api",
    "nine_router",
];

/// `<proveedor>:<sufijo>`, con sufijo de 1–64 caracteres `[a-z0-9-]`.
/// El límite cubre los nodos personalizados de 9Router, cuyo id es un UUID.
pub fn is_account_id(id: &str) -> bool {
    match id.split_once(':') {
        Some((provider, suffix)) => {
            ACCOUNT_PROVIDERS.contains(&provider)
                && (1..=64).contains(&suffix.len())
                && suffix.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        }
        None => false,
    }
}

/// Cuenta adicional de un proveedor. Su `id` es estable: el historial, el orden
/// de la tira y sus secretos (`<secreto>@<id>`) cuelgan de él.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: String,
    /// Nombre que se ve en la tira: «Claude · Trabajo».
    pub label: String,
    pub enabled: bool,
    /// Claude, Codex y Gemini: carpeta de sesión propia del CLI
    /// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`). `None` = la de Quorb.
    pub config_dir: Option<String>,
    /// Copilot: usuario de GitHub.
    pub username: String,
    /// Copilot (`pro`, `custom`…) o NaN (`member`…).
    pub plan: String,
    /// Copilot con plan `custom`.
    pub custom_allowance: Option<u32>,
    /// Anthropic / OpenAI API.
    pub monthly_budget_usd: Option<f64>,
}

impl Account {
    pub fn suffix(&self) -> &str {
        self.id.split_once(':').map(|(_, s)| s).unwrap_or(&self.id)
    }

    /// Carpeta de sesión del CLI: la elegida o `~/.quorb/accounts/<proveedor>-<sufijo>`.
    pub fn session_dir(&self, home: &Path) -> std::path::PathBuf {
        match self.config_dir.as_deref() {
            Some(d) => std::path::PathBuf::from(d),
            None => crate::channel::home_root(home).join("accounts").join(format!("{}-{}", self.provider, self.suffix())),
        }
    }

    /// Variable de entorno con la que el CLI oficial usa esa carpeta.
    pub fn session_env(&self) -> Option<&'static str> {
        match self.provider.as_str() {
            "claude" => Some("CLAUDE_CONFIG_DIR"),
            "codex" => Some("CODEX_HOME"),
            "gemini" => Some("GEMINI_CLI_HOME"),
            "grok" => Some("GROK_HOME"),
            _ => None,
        }
    }

    /// Fichero de sesión que deja el CLI dentro de su carpeta.
    pub fn credentials_file(&self, home: &Path) -> Option<std::path::PathBuf> {
        let dir = self.session_dir(home);
        match self.provider.as_str() {
            "claude" => Some(dir.join(".credentials.json")),
            "codex" => Some(dir.join("auth.json")),
            "gemini" => Some(dir.join(".gemini").join("oauth_creds.json")),
            "grok" => Some(dir.join("auth.json")),
            _ => None,
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            locale: LOCALE_DEFAULT.into(),
            refresh_minutes: 5,
            opacity: 0.94,
            compact: false,
            show_resets: true,
            orb_size: ORB_SIZE_DEFAULT,
            accent_color: ACCENT_DEFAULT.into(),
            always_on_top: true,
            dock_edge: "top".into(),
            dock_offset: 0.5,
            dock_monitor: None,
            auto_hide: false,
            auto_update: true,
            provider_order: vec![],
            hidden_providers: vec![],
            alerts: AlertsConfig::default(),
            claude: SubscriptionConfig {
                enabled: true,
                credentials_path: None,
                login_command: "claude".into(),
            },
            codex: SubscriptionConfig {
                enabled: true,
                credentials_path: None,
                login_command: "codex login".into(),
            },
            gemini: SubscriptionConfig {
                enabled: false,
                credentials_path: None,
                login_command: "gemini".into(),
            },
            cursor: SubscriptionConfig {
                enabled: false,
                credentials_path: None,
                login_command: "cursor".into(),
            },
            grok: SubscriptionConfig {
                enabled: false,
                credentials_path: None,
                login_command: "grok login".into(),
            },
            copilot: CopilotConfig::default(),
            openrouter: OpenRouterConfig::default(),
            shortcuts: ShortcutsConfig::default(),
            anthropic_api: ApiCostConfig::default(),
            openai_api: ApiCostConfig::default(),
            nan: NanConfig::default(),
            minimax: MiniMaxConfig::default(),
            nine_router: NineRouterConfig::default(),
            accounts: vec![],
        }
    }
}

/// Atajos de teclado globales (formato «Ctrl+Alt+U»). Vacío = sin atajo.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ShortcutsConfig {
    pub enabled: bool,
    /// Mostrar / ocultar la tira.
    pub toggle: String,
    /// Abrir el detalle de la suscripción más cargada.
    pub open_peak: String,
    /// Actualizar ahora.
    pub refresh: String,
}

impl Default for ShortcutsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            toggle: "Ctrl+Alt+U".into(),
            open_peak: "Ctrl+Alt+I".into(),
            refresh: "Ctrl+Alt+R".into(),
        }
    }
}

/// GitHub Copilot: API oficial de facturación (peticiones premium del mes).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CopilotConfig {
    pub enabled: bool,
    /// Usuario de GitHub.
    pub username: String,
    /// free | pro | pro_plus | business | enterprise | custom
    pub plan: String,
    /// Peticiones premium incluidas si el plan es «custom» (o para sobrescribir).
    pub custom_allowance: Option<u32>,
}

impl Default for CopilotConfig {
    fn default() -> Self {
        Self { enabled: false, username: String::new(), plan: "pro".into(), custom_allowance: None }
    }
}

/// OpenRouter: API oficial (uso y saldo de la key).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenRouterConfig {
    pub enabled: bool,
}

/// Suscripciones de consumo (Claude Pro/Max, ChatGPT Plus/Pro) leídas
/// a partir de la sesión OAuth que ya guarda el CLI oficial.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubscriptionConfig {
    pub enabled: bool,
    /// Ruta explícita al fichero de credenciales. `None` = autodetectar.
    /// Útil para WSL: `\\wsl.localhost\Ubuntu\home\<user>\.claude\.credentials.json`
    pub credentials_path: Option<String>,
    /// Comando que abre el login oficial (OAuth) en una terminal nueva.
    pub login_command: String,
}

pub const EFFECTS: [&str; 4] = ["confetti", "glow", "custom", "none"];
pub const MEDIA_SIZES: [&str; 3] = ["small", "medium", "full"];

/// Avisos en dos momentos: al superar el límite y cuando ese límite se reinicia.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AlertsConfig {
    pub enabled: bool,
    /// Notificación nativa de Windows además del efecto.
    pub native: bool,
    /// % a partir del cual se considera superado el límite.
    pub threshold: f64,
    /// Efecto al superar el límite: confetti | glow | custom | none
    pub exceeded_effect: String,
    /// Avisar cuando un límite que se había superado se reinicia.
    pub on_reset: bool,
    pub reset_effect: String,
    /// Archivo del efecto propio para cada momento (vídeo WebM con alfa, GIF, WebP o APNG animado).
    pub exceeded_media: Option<String>,
    pub reset_media: Option<String>,
    /// Tamaño del efecto propio: small | medium | full
    pub media_size: String,
    pub media_sound: bool,
}

impl Default for AlertsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            native: true,
            threshold: 90.0,
            exceeded_effect: "confetti".into(),
            on_reset: true,
            reset_effect: "confetti".into(),
            exceeded_media: None,
            reset_media: None,
            media_size: "medium".into(),
            media_sound: false,
        }
    }
}

impl AlertsConfig {
    /// Archivo del efecto propio para un momento (`exceeded` | `reset`).
    pub fn media_for(&self, moment: &str) -> Option<&str> {
        match moment {
            "reset" => self.reset_media.as_deref(),
            _ => self.exceeded_media.as_deref(),
        }
    }
}

/// Gasto de API de pago por uso (Admin API key).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ApiCostConfig {
    pub enabled: bool,
    /// Presupuesto mensual en USD para pintar la barra (opcional).
    pub monthly_budget_usd: Option<f64>,
}

/// MiniMax. `base_url` cubre las dos regiones: global `api.minimax.io` y
/// China `api.minimaxi.com`.
///
/// Verificado contra la API en los cuatro hosts: `api.` y `www.` de ambas
/// regiones responden el mismo JSON con el sobre `base_resp`, así que cualquiera
/// de los dos sirve. Se usa `api.` por semántica (es el host de la API, no el
/// sitio web). La documentación oficial del Token Plan muestra `www.minimax.io`
/// en su ejemplo de `curl`, y ese host también responde, por si alguien prefiere
/// copiarlo tal cual desde Ajustes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct MiniMaxConfig {
    pub enabled: bool,
    pub base_url: String,
}

impl Default for MiniMaxConfig {
    fn default() -> Self {
        Self { enabled: false, base_url: "https://api.minimax.io".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct NanConfig {
    pub enabled: bool,
    pub base_url: String,
    /// `community` | `member` | `premium`
    pub plan: String,
    /// Endpoint opcional que devuelva JSON con el consumo (cuando NaN lo publique).
    pub usage_url: Option<String>,
    /// JSON Pointer (RFC 6901) al valor consumido, p. ej. `/data/used_tokens`.
    pub used_pointer: Option<String>,
    /// JSON Pointer al límite, p. ej. `/data/quota_tokens`.
    pub limit_pointer: Option<String>,
    pub usage_label: Option<String>,
    /// Día del mes en que empieza tu periodo de facturación (Stripe); solo afecta a glm5.3.
    pub billing_day: u32,
}

impl Default for NanConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: "https://api.nan.builders/v1".into(),
            plan: "member".into(),
            usage_url: None,
            used_pointer: None,
            limit_pointer: None,
            usage_label: None,
            billing_day: 1,
        }
    }
}

/// Periodos de uso que acepta 9Router (`GET /api/usage/stats?period=…`).
pub const NINE_ROUTER_PERIODS: [&str; 6] = ["today", "24h", "7d", "30d", "60d", "all"];

/// 9Router: pasarela local que enruta hacia 40+ proveedores y lleva su propio
/// registro de uso/coste. Quorb la trata como un proveedor agregador: lee su
/// uso con la sesión del dashboard y muestra uno o varios sub-proveedores.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct NineRouterConfig {
    pub enabled: bool,
    /// Base del servidor local de 9Router (sin barra final).
    pub base_url: String,
    /// today | 24h | 7d | 30d | 60d | all
    pub period: String,
    /// Presupuesto opcional en USD para pintar la barra de gasto.
    pub monthly_budget_usd: Option<f64>,
    /// Mostrar cada sub-proveedor (Claude, Kiro, GLM…) como su propia cuenta.
    pub show_sub_providers: bool,
    /// Gasto mínimo (USD) para mostrar un sub-proveedor como orbe. 0 = todos los que gasten.
    pub min_spend_usd: f64,
}

impl Default for NineRouterConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: "http://localhost:20128".into(),
            period: "7d".into(),
            monthly_budget_usd: None,
            show_sub_providers: true,
            min_spend_usd: 0.0,
        }
    }
}

impl AppConfig {
    /// Corrige valores fuera de rango.
    pub fn sanitized(mut self) -> Self {
        let locale = self.locale.trim().to_ascii_lowercase();
        self.locale = if LOCALES.contains(&locale.as_str()) { locale } else { LOCALE_DEFAULT.into() };
        self.refresh_minutes = self.refresh_minutes.clamp(1, 120);
        self.orb_size = self.orb_size.clamp(ORB_SIZE_MIN, ORB_SIZE_MAX);
        self.accent_color = normalize_hex(&self.accent_color).unwrap_or_else(|| ACCENT_DEFAULT.into());
        if !self.opacity.is_finite() {
            self.opacity = 0.94;
        }
        self.opacity = self.opacity.clamp(0.3, 1.0);
        if !matches!(self.dock_edge.as_str(), "top" | "bottom" | "left" | "right") {
            self.dock_edge = "top".into();
        }
        self.dock_offset = if self.dock_offset.is_finite() { self.dock_offset.clamp(0.0, 1.0) } else { 0.5 };
        for p in [
            &mut self.claude.credentials_path,
            &mut self.codex.credentials_path,
            &mut self.gemini.credentials_path,
            &mut self.cursor.credentials_path,
            &mut self.grok.credentials_path,
        ] {
            if p.as_deref().map(str::trim).unwrap_or("").is_empty() {
                *p = None;
            }
        }
        if self.nan.base_url.trim().is_empty() {
            self.nan.base_url = NanConfig::default().base_url;
        }
        self.nan.base_url = self.nan.base_url.trim().trim_end_matches('/').to_string();
        if self.minimax.base_url.trim().is_empty() {
            self.minimax.base_url = MiniMaxConfig::default().base_url;
        }
        self.minimax.base_url = self.minimax.base_url.trim().trim_end_matches('/').to_string();
        self.nan.billing_day = self.nan.billing_day.clamp(1, 28);
        if self.nine_router.base_url.trim().is_empty() {
            self.nine_router.base_url = NineRouterConfig::default().base_url;
        }
        self.nine_router.base_url = self.nine_router.base_url.trim().trim_end_matches('/').to_string();
        if !NINE_ROUTER_PERIODS.contains(&self.nine_router.period.as_str()) {
            self.nine_router.period = NineRouterConfig::default().period;
        }
        let min_spend = self.nine_router.min_spend_usd;
        self.nine_router.min_spend_usd = if min_spend.is_finite() { min_spend.max(0.0) } else { 0.0 };
        let a = &mut self.alerts;
        a.threshold = if a.threshold.is_finite() { a.threshold.clamp(1.0, 100.0) } else { 90.0 };
        for e in [&mut a.exceeded_effect, &mut a.reset_effect] {
            if e.as_str() == "video" {
                *e = "custom".into();
            }
            if !EFFECTS.contains(&e.as_str()) {
                *e = "confetti".into();
            }
        }
        for m in [&mut a.exceeded_media, &mut a.reset_media] {
            if m.as_deref().map(str::trim).unwrap_or("").is_empty() {
                *m = None;
            }
        }
        if !MEDIA_SIZES.contains(&a.media_size.as_str()) {
            a.media_size = "medium".into();
        }
        self.copilot.username = self.copilot.username.trim().trim_start_matches('@').to_string();
        for sc in [&mut self.shortcuts.toggle, &mut self.shortcuts.open_peak, &mut self.shortcuts.refresh] {
            *sc = sc.trim().to_string();
        }
        let mut ids = std::collections::HashSet::new();
        self.accounts.retain(|a| is_account_id(&a.id) && a.id.starts_with(&format!("{}:", a.provider)) && ids.insert(a.id.clone()));
        for (i, a) in self.accounts.iter_mut().enumerate() {
            a.label = a.label.trim().to_string();
            if a.label.is_empty() {
                a.label = format!("Cuenta {}", i + 2);
            }
            if a.config_dir.as_deref().map(str::trim).unwrap_or("").is_empty() {
                a.config_dir = None;
            }
            a.username = a.username.trim().trim_start_matches('@').to_string();
        }
        for list in [&mut self.provider_order, &mut self.hidden_providers] {
            let mut seen = std::collections::HashSet::new();
            list.retain(|id| seen.insert(id.clone()));
        }
        self
    }
}

pub fn load(path: &Path) -> AppConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<AppConfig>(&s).ok())
        .unwrap_or_default()
        .sanitized()
}

pub fn save(path: &Path, cfg: &AppConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_badges_default_visible_in_legacy_config() {
        let cfg: AppConfig = serde_json::from_str(r#"{}"#).unwrap();
        let json = serde_json::to_value(cfg).unwrap();
        assert_eq!(json.get("showResets"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn reset_visibility_roundtrips_and_live_patch_preserves_other_fields() {
        let mut cfg = AppConfig::default();
        let original = cfg.clone();
        cfg.apply_widget_patch(serde_json::from_str(r#"{"showResets":false}"#).unwrap());
        let encoded = serde_json::to_value(&cfg).unwrap();
        assert_eq!(encoded.get("showResets"), Some(&serde_json::json!(false)));
        let mut restored: AppConfig = serde_json::from_value(encoded).unwrap();
        restored.apply_widget_patch(WidgetPatch::default());
        assert_eq!(serde_json::to_value(&restored).unwrap()["showResets"], false);
        restored.apply_widget_patch(serde_json::from_str(r#"{"showResets":true}"#).unwrap());
        assert_eq!(restored, original);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let cfg: AppConfig = serde_json::from_str(r#"{"refreshMinutes": 0, "nan": {"enabled": true}}"#).unwrap();
        let cfg = cfg.sanitized();
        assert_eq!(cfg.refresh_minutes, 1);
        assert!(cfg.nan.enabled);
        assert_eq!(cfg.nan.base_url, "https://api.nan.builders/v1");
        assert_eq!(cfg.codex.login_command, "codex login");
        assert_eq!(cfg.dock_edge, "top");
    }

    #[test]
    fn invalid_dock_is_fixed() {
        let cfg: AppConfig = serde_json::from_str(r#"{"dockEdge": "middle", "dockOffset": 3.0}"#).unwrap();
        let cfg = cfg.sanitized();
        assert_eq!(cfg.dock_edge, "top");
        assert_eq!(cfg.dock_offset, 1.0);
    }

    #[test]
    fn orb_size_is_clamped() {
        let small: AppConfig = serde_json::from_str(r#"{"orbSize": 4}"#).unwrap();
        let big: AppConfig = serde_json::from_str(r#"{"orbSize": 500}"#).unwrap();
        assert_eq!(small.sanitized().orb_size, ORB_SIZE_MIN);
        assert_eq!(big.sanitized().orb_size, ORB_SIZE_MAX);
        assert_eq!(AppConfig::default().orb_size, ORB_SIZE_DEFAULT);
    }

    #[test]
    fn alerts_are_sanitized() {
        let cfg: AppConfig = serde_json::from_str(
            r#"{"alerts": {"threshold": 250, "exceededEffect": "video", "resetEffect": "boom", "resetMedia": "  ", "mediaSize": "xl"}}"#,
        )
        .unwrap();
        let a = cfg.sanitized().alerts;
        assert_eq!(a.threshold, 100.0);
        assert_eq!(a.exceeded_effect, "custom");
        assert_eq!(a.reset_effect, "confetti");
        assert_eq!(a.reset_media, None);
        assert_eq!(a.media_size, "medium");
        let d = AppConfig::default().alerts;
        assert_eq!((d.exceeded_effect.as_str(), d.reset_effect.as_str(), d.threshold), ("confetti", "confetti", 90.0));
        assert!(!AppConfig::default().auto_hide);
        assert!(AppConfig::default().auto_update);
    }

    #[test]
    fn new_providers_default_off_and_shortcuts_on() {
        let cfg = AppConfig::default();
        assert!(!cfg.gemini.enabled && !cfg.cursor.enabled && !cfg.copilot.enabled && !cfg.openrouter.enabled);
        assert_eq!(cfg.gemini.login_command, "gemini");
        assert_eq!(cfg.shortcuts.toggle, "Ctrl+Alt+U");
        assert!(cfg.shortcuts.enabled);
        assert!(cfg.claude.enabled);
        assert!(cfg.codex.enabled);
        let c: AppConfig = serde_json::from_str(r#"{"copilot": {"username": " @egdev6 "}}"#).unwrap();
        assert_eq!(c.sanitized().copilot.username, "egdev6");
    }

    #[test]
    fn accent_color_is_normalized() {
        let ok: AppConfig = serde_json::from_str(r##"{"accentColor": "0F0"}"##).unwrap();
        let bad: AppConfig = serde_json::from_str(r##"{"accentColor": "rojo"}"##).unwrap();
        assert_eq!(ok.sanitized().accent_color, "#00ff00");
        assert_eq!(bad.sanitized().accent_color, ACCENT_DEFAULT);
    }

    #[test]
    fn accounts_are_sanitized() {
        let cfg: AppConfig = serde_json::from_str(
            r#"{"accounts": [
                {"id": "claude:trabajo", "provider": "claude", "label": "  ", "configDir": " "},
                {"id": "claude:trabajo", "provider": "claude"},
                {"id": "codex:x", "provider": "claude"},
                {"id": "foo:x", "provider": "foo"},
                {"id": "copilot:Mal", "provider": "copilot"},
                {"id": "copilot:b2", "provider": "copilot", "username": " @otra ", "label": "Otra"}
            ]}"#,
        )
        .unwrap();
        let a = cfg.sanitized().accounts;
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].label.as_str(), a[0].config_dir.clone()), ("Cuenta 2", None));
        assert_eq!((a[1].label.as_str(), a[1].username.as_str()), ("Otra", "otra"));
    }

    #[test]
    fn account_session_files() {
        let home = Path::new("/h");
        let mut a = Account { id: "gemini:w1".into(), provider: "gemini".into(), ..Default::default() };
        assert_eq!(a.credentials_file(home).unwrap(), crate::channel::home_root(home).join("accounts/gemini-w1/.gemini/oauth_creds.json"));
        assert_eq!(a.session_env(), Some("GEMINI_CLI_HOME"));
        a.provider = "claude".into();
        a.config_dir = Some("/w/.claude-work".into());
        assert_eq!(a.credentials_file(home).unwrap(), Path::new("/w/.claude-work/.credentials.json"));
        a.provider = "openrouter".into();
        assert_eq!(a.credentials_file(home), None);
    }

    #[test]
    fn blank_paths_become_none() {
        let mut cfg = AppConfig::default();
        cfg.claude.credentials_path = Some("  ".into());
        assert_eq!(cfg.sanitized().claude.credentials_path, None);
    }

    #[test]
    fn widget_patch_preserves_accounts_saved_after_the_widget_snapshot() {
        // Config «actual» del backend, ya con la cuenta que Ajustes acaba de guardar.
        let saved: AppConfig = serde_json::from_str(
            r#"{"accounts":[{"id":"openrouter:abc123","provider":"openrouter","label":"Cuenta 2"}]}"#,
        )
        .unwrap();
        // El widget traía un snapshot obsoleto (sin esa cuenta) pero solo manda campos suyos.
        let patch: WidgetPatch =
            serde_json::from_str(r#"{"dockEdge":"left","dockOffset":0.25,"providerOrder":["claude"]}"#).unwrap();
        let mut next = saved.clone();
        next.apply_widget_patch(patch);
        let next = next.sanitized();
        assert_eq!(next.dock_edge, "left");
        assert_eq!(next.dock_offset, 0.25);
        assert_eq!(next.provider_order, vec!["claude".to_string()]);
        assert_eq!(next.accounts.len(), 1);
        assert_eq!(next.accounts[0].id, "openrouter:abc123");
        // Un patch vacío no toca nada.
        let mut untouched = saved.clone();
        untouched.apply_widget_patch(WidgetPatch::default());
        assert_eq!(untouched.sanitized(), saved.sanitized());
    }

    #[test]
    fn widget_patch_can_clear_the_monitor_and_hidden_providers() {
        let mut cfg = AppConfig::default();
        cfg.dock_monitor = Some("DELL".into());
        cfg.hidden_providers = vec!["nan".into()];
        let patch: WidgetPatch = serde_json::from_str(r#"{"dockMonitor":null,"hiddenProviders":[]}"#).unwrap();
        cfg.apply_widget_patch(patch);
        let cfg = cfg.sanitized();
        assert_eq!(cfg.dock_monitor, None);
        assert!(cfg.hidden_providers.is_empty());
    }

    #[test]
    fn widget_patch_applies_all_eight_live_fields_from_serialized_json() {
        // JSON serializado real con los 8 campos vivos (#97). No construimos un
        // subconjunto tipado: esto verifica literalmente el contrato camelCase.
        let base: AppConfig = serde_json::from_str(
            r##"{"opacity":0.94,"compact":false,"orbSize":48,"accentColor":"#ff0036","alwaysOnTop":true,
                "dockEdge":"top","dockOffset":0.5,"autoHide":true}"##,
        )
        .unwrap();
        let patch: WidgetPatch = serde_json::from_str(
            r##"{"opacity":0.36,"compact":true,"orbSize":60,"accentColor":"#00ff00","alwaysOnTop":false,
                "dockEdge":"bottom","dockOffset":0.25,"autoHide":false}"##,
        )
        .unwrap();
        let mut next = base.clone();
        next.apply_widget_patch(patch);
        let next = next.sanitized();
        assert_eq!(next.opacity, 0.36);
        assert!(next.compact);
        assert_eq!(next.orb_size, 60);
        assert_eq!(next.accent_color, "#00ff00");
        assert!(!next.always_on_top);
        assert_eq!(next.dock_edge, "bottom");
        assert_eq!(next.dock_offset, 0.25);
        assert!(!next.auto_hide, "autoHide debe viajar por el patch vivo");
    }

    #[test]
    fn widget_patch_applies_boolean_transitions_to_false() {
        let mut base: AppConfig = serde_json::from_str(r#"{"compact":true,"alwaysOnTop":true,"autoHide":true}"#).unwrap();
        let patch: WidgetPatch = serde_json::from_str(r#"{"compact":false,"alwaysOnTop":false,"autoHide":false}"#).unwrap();
        base.apply_widget_patch(patch);
        let next = base.sanitized();
        assert!(!next.compact);
        assert!(!next.always_on_top);
        assert!(!next.auto_hide);
    }

    #[test]
    fn widget_patch_applies_live_personalization_and_clamps() {
        let base: AppConfig = serde_json::from_str(
            r##"{"opacity":0.94,"compact":false,"orbSize":48,"accentColor":"#ff0036","alwaysOnTop":true,
                "dockEdge":"top","dockOffset":0.5,"shortcuts":{"toggle":"Ctrl+Alt+U"},
                "accounts":[{"id":"claude:work","provider":"claude","label":"Trabajo"}]}"##,
        )
        .unwrap();
        // Un patch vivo solo toca campos de personalización; el resto llega fuera de rango
        // para comprobar que el backend clampea/normaliza al persistir.
        let patch: WidgetPatch = serde_json::from_str(
            r#"{"opacity":9.0,"compact":true,"orbSize":500,"accentColor":"0F0","alwaysOnTop":false,"dockEdge":"left","dockOffset":0.2}"#,
        )
        .unwrap();
        let mut next = base.clone();
        next.apply_widget_patch(patch);
        let next = next.sanitized();
        assert_eq!(next.opacity, 1.0);
        assert!(next.compact);
        assert_eq!(next.orb_size, ORB_SIZE_MAX);
        assert_eq!(next.accent_color, "#00ff00");
        assert!(!next.always_on_top);
        assert_eq!(next.dock_edge, "left");
        assert_eq!(next.dock_offset, 0.2);
        // sin efectos colaterales: cuentas y atajos intactos.
        assert_eq!(next.accounts.len(), 1);
        assert_eq!(next.accounts[0].id, "claude:work");
        assert_eq!(next.shortcuts.toggle, "Ctrl+Alt+U");
        // Los campos ausentes conservan la base; un patch vacío no toca nada.
        let mut untouched = base.clone();
        untouched.apply_widget_patch(WidgetPatch::default());
        assert_eq!(untouched.sanitized(), base.sanitized());
    }

    #[test]
    fn widget_patch_out_of_range_live_values_are_sanitized() {
        let mut cfg = AppConfig::default();
        cfg.opacity = 0.94;
        let patch: WidgetPatch = serde_json::from_str(r#"{"opacity":0.0,"orbSize":4,"accentColor":"rojo"}"#).unwrap();
        cfg.apply_widget_patch(patch);
        let cfg = cfg.sanitized();
        assert_eq!(cfg.opacity, 0.3);
        assert_eq!(cfg.orb_size, ORB_SIZE_MIN);
        assert_eq!(cfg.accent_color, ACCENT_DEFAULT);
    }

    #[test]
    fn nine_router_config_is_sanitized() {
        let cfg: AppConfig =
            serde_json::from_str(r#"{"nineRouter":{"enabled":true,"baseUrl":"http://localhost:20128/","period":"year"}}"#).unwrap();
        let n = cfg.sanitized().nine_router;
        assert!(n.enabled);
        // Barra final eliminada y periodo inválido corregido al de por defecto.
        assert_eq!(n.base_url, "http://localhost:20128");
        assert_eq!(n.period, "7d");
        assert!(n.show_sub_providers);
        // Base vacía: se restaura la de por defecto.
        let blank: AppConfig = serde_json::from_str(r#"{"nineRouter":{"baseUrl":"  "}}"#).unwrap();
        assert_eq!(blank.sanitized().nine_router.base_url, "http://localhost:20128");
        assert!(!AppConfig::default().nine_router.enabled);
    }

    fn locale_of(cfg: &AppConfig) -> serde_json::Value {
        serde_json::to_value(cfg).unwrap()["locale"].clone()
    }

    fn temp_config_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("quorb-locale-{}-{tag}", std::process::id()))
            .join("config.json")
    }

    #[test]
    fn locale_defaults_to_es_on_clean_start() {
        assert_eq!(locale_of(&AppConfig::default()), "es");
        // Sin config.json: arranque limpio.
        let path = temp_config_path("missing");
        let _ = std::fs::remove_file(&path);
        assert_eq!(locale_of(&load(&path)), "es");
    }

    #[test]
    fn legacy_config_without_locale_uses_es_and_keeps_its_data() {
        let cfg: AppConfig = serde_json::from_str(r#"{"refreshMinutes": 7, "dockEdge": "left"}"#).unwrap();
        let cfg = cfg.sanitized();
        assert_eq!(locale_of(&cfg), "es");
        assert_eq!(cfg.refresh_minutes, 7);
        assert_eq!(cfg.dock_edge, "left");
    }

    #[test]
    fn supported_locales_are_kept_and_normalized() {
        for (raw, expected) in [("es", "es"), ("en", "en"), ("EN", "en"), (" en ", "en"), ("Es", "es")] {
            let json = serde_json::json!({ "locale": raw });
            let cfg: AppConfig = serde_json::from_value(json).unwrap();
            assert_eq!(locale_of(&cfg.sanitized()), expected, "locale {raw:?}");
        }
    }

    #[test]
    fn unsupported_or_empty_locale_falls_back_to_es() {
        for raw in ["fr", "en-US", "es_ES", "", "   ", "basura"] {
            let json = serde_json::json!({ "locale": raw });
            let cfg: AppConfig = serde_json::from_value(json).unwrap();
            assert_eq!(locale_of(&cfg.sanitized()), "es", "locale {raw:?}");
        }
    }

    #[test]
    fn null_or_non_string_locale_falls_back_to_es_without_losing_config() {
        // Un `locale` con tipo inesperado no puede tirar el parseo de todo config.json.
        for raw in [r#"null"#, r#"42"#, r#"true"#, r#"["en"]"#, r#"{"code":"en"}"#] {
            let text = format!(r#"{{"locale": {raw}, "refreshMinutes": 9, "compact": true}}"#);
            let path = temp_config_path(&format!("odd-{}", raw.len()));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            let cfg = load(&path);
            assert_eq!(locale_of(&cfg), "es", "locale {raw}");
            assert_eq!(cfg.refresh_minutes, 9, "locale {raw} perdió la config");
            assert!(cfg.compact, "locale {raw} perdió la config");
            let _ = std::fs::remove_dir_all(path.parent().unwrap());
        }
    }

    #[test]
    fn locale_survives_save_and_reload_preserving_other_data() {
        let path = temp_config_path("roundtrip");
        let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "locale": "en",
            "refreshMinutes": 12,
            "hiddenProviders": ["codex"],
            "copilot": { "username": "egdev6" },
            "accounts": [{ "id": "claude:work", "provider": "claude", "label": "Trabajo", "enabled": true }]
        }))
        .unwrap();
        cfg = cfg.sanitized();
        save(&path, &cfg).unwrap();
        let reloaded = load(&path);
        assert_eq!(locale_of(&reloaded), "en");
        assert_eq!(reloaded, cfg);
        // Volver a `es` también persiste sin tocar el resto.
        let mut expected = serde_json::to_value(&reloaded).unwrap();
        expected["locale"] = serde_json::json!("es");
        let back: AppConfig = serde_json::from_value(expected.clone()).unwrap();
        save(&path, &back.sanitized()).unwrap();
        assert_eq!(serde_json::to_value(load(&path)).unwrap(), expected);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn nine_router_accounts_are_valid() {
        assert!(is_account_id("nine_router:claude"));
        assert!(is_account_id("nine_router:open-code"));
        assert!(!is_account_id("nine_router:Claude")); // mayúsculas no válidas
    }
}
