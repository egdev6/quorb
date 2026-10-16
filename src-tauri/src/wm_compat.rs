//! Detección de compositor y caveats de Ajustes para el port nativo a Linux.
//!
//! Lee las variables de entorno estándar (`WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`,
//! `DESKTOP_SESSION`, `XDG_CURRENT_DESKTOP`) y devuelve un resumen accionable
//! para Ajustes. El frontend usa esto para mostrar el bloque "Compatibilidad"
//! y degradar comportamientos no soportados por el compositor actual.
//!
//! Issue ODD #107 (escritorio y widget nativos): este módulo es **solo
//! informativo**; las decisiones de fallback (saltar always-on-top, ocultar
//! click-through) las toma el frontend a partir de la `recommendation`.
//!
//! La función pública es `detect_wm_info_from_env` (pura) — toma las 4
//! env vars como `&Env` y devuelve un `WindowManagerInfo`. Los tests la usan
//! directamente, sin tocar `std::env` global (evita race entre threads en
//! `cargo test`). `detect_wm_info` la envuelve con `std::env::var` para uso
//! desde el command Tauri y desde el frontend vía `invoke('get_wm_info')`.

use serde::Serialize;

/// Resumen de compositor y caveats para Ajustes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowManagerInfo {
    /// `Some` si `WAYLAND_DISPLAY` está set; el widget está corriendo bajo Wayland.
    pub wayland_display: Option<String>,
    /// `Some` si `XDG_SESSION_TYPE` está set; valores esperados: `wayland`, `x11`, `tty`, `mir`.
    pub xdg_session_type: Option<String>,
    /// `Some` si `DESKTOP_SESSION` está set (p. ej. `gnome`, `plasma`, `hyprland`).
    pub desktop_session: Option<String>,
    /// `Some` si `XDG_CURRENT_DESKTOP` está set (p. ej. `GNOME`, `KDE`, `Hyprland`).
    pub xdg_current_desktop: Option<String>,
    /// `true` si detectamos un compositor Wayland por alguna señal.
    pub is_wayland: bool,
    /// `true` si detectamos Hyprland (siempre-on-top especialmente estricto).
    pub is_hyprland: bool,
    /// Recomendación accionable para Ajustes: qué hacer con always-on-top,
    /// click-through y edge-docking en este entorno.
    pub recommendation: &'static str,
}

/// Las 4 env vars que miramos, normalizadas: `None` si ausentes o vacías.
#[derive(Debug, Default, Clone)]
pub struct Env {
    pub wayland_display: Option<String>,
    pub xdg_session_type: Option<String>,
    pub desktop_session: Option<String>,
    pub xdg_current_desktop: Option<String>,
}

impl Env {
    /// Lee las env vars del proceso y las normaliza (vacía → None).
    pub fn from_process() -> Self {
        Self {
            wayland_display: std::env::var("WAYLAND_DISPLAY").ok().filter(|s| !s.is_empty()),
            xdg_session_type: std::env::var("XDG_SESSION_TYPE").ok().filter(|s| !s.is_empty()),
            desktop_session: std::env::var("DESKTOP_SESSION").ok().filter(|s| !s.is_empty()),
            xdg_current_desktop: std::env::var("XDG_CURRENT_DESKTOP").ok().filter(|s| !s.is_empty()),
        }
    }
}

/// Versión pura: toma un `&Env` y devuelve el resumen. Sin globales, sin
/// efectos secundarios, **thread-safe** (los tests la llaman directamente
/// sin tocar `std::env`).
pub fn detect_wm_info_from_env(env: &Env) -> WindowManagerInfo {
    // Normaliza el string vacío como "ausente" para TODOS los checks, igual
    // que `Env::from_process`: si el caller construye el `Env` a mano y le
    // pasa `Some("")` (los tests lo hacen), un string vacío no debe contar
    // como señal de Wayland ni aparecer en el struct.
    let non_empty = |opt: &Option<String>| opt.clone().filter(|s| !s.is_empty());
    let env_n = Env {
        wayland_display: non_empty(&env.wayland_display),
        xdg_session_type: non_empty(&env.xdg_session_type),
        desktop_session: non_empty(&env.desktop_session),
        xdg_current_desktop: non_empty(&env.xdg_current_desktop),
    };

    let is_wayland = env_n.wayland_display.is_some()
        || env_n.xdg_session_type.as_deref().map(|s| s.eq_ignore_ascii_case("wayland")).unwrap_or(false)
        || env_n
            .xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(is_wayland_compositor))
            .unwrap_or(false);

    let is_hyprland = env_n
        .desktop_session
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("hyprland"))
        .unwrap_or(false)
        || env_n
            .xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(|p| p.eq_ignore_ascii_case("Hyprland")))
            .unwrap_or(false);

    let recommendation = recommendation(
        is_wayland,
        is_hyprland,
        env_n.desktop_session.as_deref(),
        env_n.xdg_current_desktop.as_deref(),
    );

    // `env_n` ya clonó los `Option<String>` desde el `&Env` input (y filtró
    // vacíos); se mueven al struct sin clones adicionales.
    WindowManagerInfo {
        wayland_display: env_n.wayland_display,
        xdg_session_type: env_n.xdg_session_type,
        desktop_session: env_n.desktop_session,
        xdg_current_desktop: env_n.xdg_current_desktop,
        is_wayland,
        is_hyprland,
        recommendation,
    }
}

/// Wrapper que lee `std::env::var` y delega en `detect_wm_info_from_env`.
/// El command Tauri usa este; el frontend nunca lo llama directamente.
pub fn detect_wm_info() -> WindowManagerInfo {
    detect_wm_info_from_env(&Env::from_process())
}

/// ¿Es un compositor Wayland? Considera `XDG_CURRENT_DESKTOP` y similares.
fn is_wayland_compositor(token: &str) -> bool {
    matches!(
        token.trim().to_ascii_lowercase().as_str(),
        "wayland" | "gnome" | "kde" | "kde-plasma" | "plasma" | "hyprland" | "sway" | "wlroots"
    )
}

/// Recomendación estática derivada del compositor detectado. Pura: el caller
/// la copia al JSON sin hacer formatting (es &'static str).
fn recommendation(
    is_wayland: bool,
    is_hyprland: bool,
    desktop_session: Option<&str>,
    xdg_current_desktop: Option<&str>,
) -> &'static str {
    if is_hyprland {
        "Hyprland es particularmente estricto con always-on-top. \
         Si la tira se ve normal pero se oculta tras otras ventanas, \
         activa «Auto-hide» en Ajustes como Plan B."
    } else if is_wayland {
        match (desktop_session, xdg_current_desktop) {
            (Some(d), _) if d.eq_ignore_ascii_case("gnome") => {
                "GNOME Wayland (Mutter) puede ignorar hints de always-on-top en \
                 algunos escenarios. La tira recurre a posición fija + skip_taskbar."
            }
            (Some(d), _) if d.eq_ignore_ascii_case("kde-plasma") || d.eq_ignore_ascii_case("plasma") => {
                "KDE Wayland suele respetar always-on-top; click-through puede \
                 fallar — usa la posición fija como fallback."
            }
            _ => {
                "Wayland detectado. Si always-on-top o click-through fallan, \
                 el widget activa auto-hide."
            }
        }
    } else {
        "X11 (u otro). Compatibilidad completa con always-on-top y click-through."
    }
}

/// Tauri command expuesto al frontend (`invoke('get_wm_info')`).
#[tauri::command]
pub fn get_wm_info() -> WindowManagerInfo {
    detect_wm_info()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(wayland_display: Option<&str>, xdg_session_type: Option<&str>, desktop_session: Option<&str>, xdg_current_desktop: Option<&str>) -> Env {
        Env {
            wayland_display: wayland_display.map(str::to_string),
            xdg_session_type: xdg_session_type.map(str::to_string),
            desktop_session: desktop_session.map(str::to_string),
            xdg_current_desktop: xdg_current_desktop.map(str::to_string),
        }
    }

    #[test]
    fn empty_env_returns_no_wayland() {
        let info = detect_wm_info_from_env(&env(None, None, None, None));
        assert_eq!(info.wayland_display, None);
        assert!(!info.is_wayland);
        assert!(!info.is_hyprland);
        assert!(info.recommendation.contains("X11") || info.recommendation.contains("completa"));
    }

    #[test]
    fn wayland_display_signals_wayland() {
        let info = detect_wm_info_from_env(&env(Some("wayland-0"), None, None, None));
        assert!(info.is_wayland);
        assert_eq!(info.wayland_display.as_deref(), Some("wayland-0"));
        assert!(info.recommendation.contains("Wayland"));
    }

    #[test]
    fn xdg_session_type_wayland_signals_wayland() {
        let info = detect_wm_info_from_env(&env(None, Some("wayland"), None, None));
        assert!(info.is_wayland);
        assert!(!info.is_hyprland);
    }

    #[test]
    fn xdg_current_desktop_hyprland_signals_hyprland() {
        let info = detect_wm_info_from_env(&env(None, None, None, Some("Hyprland")));
        assert!(info.is_hyprland);
        // Hyprland es compositor Wayland-only, así que esperarse `is_wayland=true`.
        assert!(info.is_wayland);
        assert!(info.recommendation.contains("Hyprland"));
    }

    #[test]
    fn desktop_session_hyprland_signals_hyprland() {
        let info = detect_wm_info_from_env(&env(None, None, Some("hyprland"), None));
        assert!(info.is_hyprland);
    }

    #[test]
    fn empty_strings_are_treated_as_absent() {
        let info = detect_wm_info_from_env(&env(Some(""), Some(""), None, None));
        assert_eq!(info.wayland_display, None);
        assert_eq!(info.xdg_session_type, None);
        assert!(!info.is_wayland);
    }

    #[test]
    fn xdg_current_desktop_can_combine_desktop_sessions() {
        // `XDG_CURRENT_DESKTOP:GNOME:Hyprland` debe reconocer Hyprland en la lista.
        let info = detect_wm_info_from_env(&env(None, None, None, Some("GNOME:Hyprland")));
        assert!(info.is_hyprland);
        assert!(info.is_wayland);
    }

    #[test]
    fn recommendation_for_gnome_wayland_mentions_mutter() {
        let info = detect_wm_info_from_env(&env(None, Some("wayland"), Some("gnome"), None));
        assert!(info.recommendation.contains("GNOME Wayland"));
        assert!(info.recommendation.contains("Mutter"));
    }
}
