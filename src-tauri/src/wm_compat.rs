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

/// Lee las variables de entorno y devuelve un `WindowManagerInfo`.
///
/// Pura: sin estado, sin Tauri, sin efectos secundarios. Los tests la invocan
/// directamente; el `#[tauri::command]` (`get_wm_info`) la envuelve.
pub fn detect_wm_info() -> WindowManagerInfo {
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok().filter(|s| !s.is_empty());
    let xdg_session_type = std::env::var("XDG_SESSION_TYPE").ok().filter(|s| !s.is_empty());
    let desktop_session = std::env::var("DESKTOP_SESSION").ok().filter(|s| !s.is_empty());
    let xdg_current_desktop = std::env::var("XDG_CURRENT_DESKTOP").ok().filter(|s| !s.is_empty());

    // Wayland si cualquiera de las señales dice Wayland.
    let is_wayland = wayland_display.is_some()
        || xdg_session_type.as_deref() == Some("wayland")
        || xdg_current_desktop.as_deref().map(|s| s.eq_ignore_ascii_case("wayland")).unwrap_or(false);

    // Hyprland si DESKTOP_SESSION o XDG_CURRENT_DESKTOP lo mencionan.
    let is_hyprland = desktop_session
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("hyprland"))
        .unwrap_or(false)
        || xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(|p| p.eq_ignore_ascii_case("Hyprland")))
            .unwrap_or(false);

    let recommendation = recommendation(is_wayland, is_hyprland, desktop_session.as_deref(), xdg_current_desktop.as_deref());

    WindowManagerInfo {
        wayland_display,
        xdg_session_type,
        desktop_session,
        xdg_current_desktop,
        is_wayland,
        is_hyprland,
        recommendation,
    }
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
    use std::ffi::OsString;

    /// Ejecuta `f` con las env vars deseadas restauradas al final, sin importar
    /// qué otras env vars estén en el entorno del test.
    fn with_env<F: FnOnce()>(vars: &[(&str, &str)], f: F) {
        // Guarda y limpia las vars del scope (solo las que vamos a tocar).
        let mut saved: Vec<(String, Option<OsString>)> = Vec::new();
        for (k, _) in vars {
            saved.push((k.to_string(), std::env::var_os(k)));
            std::env::remove_var(k);
        }
        for (k, v) in vars {
            std::env::set_var(k, v);
        }
        f();
        // Restaura.
        for (k, prev) in saved.iter().rev() {
            match prev {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }

    #[test]
    fn empty_env_returns_no_wayland() {
        with_env(&[], || {
            let info = detect_wm_info();
            assert_eq!(info.wayland_display, None);
            assert_eq!(info.xdg_session_type, None);
            assert!(!info.is_wayland);
            assert!(!info.is_hyprland);
            assert!(info.recommendation.contains("X11") || info.recommendation.contains("completa"));
        });
    }

    #[test]
    fn wayland_display_signals_wayland() {
        with_env(&[("WAYLAND_DISPLAY", "wayland-0")], || {
            let info = detect_wm_info();
            assert!(info.is_wayland);
            assert_eq!(info.wayland_display.as_deref(), Some("wayland-0"));
            assert!(info.recommendation.contains("Wayland"));
        });
    }

    #[test]
    fn xdg_session_type_wayland_signals_wayland() {
        with_env(&[("XDG_SESSION_TYPE", "wayland")], || {
            let info = detect_wm_info();
            assert!(info.is_wayland);
            assert!(!info.is_hyprland);
        });
    }

    #[test]
    fn xdg_current_desktop_hyprland_signals_hyprland() {
        with_env(&[("XDG_CURRENT_DESKTOP", "Hyprland")], || {
            let info = detect_wm_info();
            assert!(info.is_hyprland);
            assert!(info.is_wayland);
            assert!(info.recommendation.contains("Hyprland"));
        });
    }

    #[test]
    fn desktop_session_hyprland_signals_hyprland() {
        with_env(&[("DESKTOP_SESSION", "hyprland")], || {
            let info = detect_wm_info();
            assert!(info.is_hyprland);
        });
    }

    #[test]
    fn empty_strings_are_treated_as_absent() {
        // Si una var está set pero vacía, la tratamos como ausente.
        with_env(&[
            ("WAYLAND_DISPLAY", ""),
            ("XDG_SESSION_TYPE", ""),
        ], || {
            let info = detect_wm_info();
            assert_eq!(info.wayland_display, None);
            assert_eq!(info.xdg_session_type, None);
            assert!(!info.is_wayland);
        });
    }

    #[test]
    fn xdg_current_desktop_can_combine_desktop_sessions() {
        // `XDG_CURRENT_DESKTOP:GNOME:KDE` debe reconocer Hyprland en la lista.
        with_env(
            &[("XDG_CURRENT_DESKTOP", "GNOME:Hyprland")],
            || {
                let info = detect_wm_info();
                assert!(info.is_hyprland);
                assert!(info.is_wayland);
            },
        );
    }

    #[test]
    fn recommendation_for_gnome_wayland_mentions_mutter() {
        with_env(
            &[("XDG_SESSION_TYPE", "wayland"), ("DESKTOP_SESSION", "gnome")],
            || {
                let info = detect_wm_info();
                assert!(info.recommendation.contains("GNOME Wayland"));
                assert!(info.recommendation.contains("Mutter"));
            },
        );
    }
}
