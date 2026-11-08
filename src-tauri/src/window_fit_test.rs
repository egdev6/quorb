//! Contrato del perfil de ajuste de ventana por compositor (#250).
//!
//! Lo que puede fallar aquí es qué entornos piden ajustes (solo Hyprland: GNOME,
//! Ubuntu y el resto conservan el comportamiento de siempre) y el tamaño de las
//! pistas, que GTK mide en píxeles lógicos mientras la petición llega en físicos
//! (P2 de #224). El efecto en sí es una llamada directa a `set_size_constraints`.

use super::window_fit::*;
use crate::wm_compat::Env;

#[test]
fn hyprland_asks_for_size_hints_on_native_wayland() {
    // Las dos señales que `wm_compat` reconoce como Hyprland, cada una sola.
    for env in [
        Env {
            xdg_current_desktop: Some("Hyprland".to_string()),
            ..Env::default()
        },
        Env {
            desktop_session: Some("hyprland".to_string()),
            ..Env::default()
        },
    ] {
        assert!(fit_profile_from_env(&env).wayland_size_hints, "{env:?}");
    }
}

#[test]
fn other_desktops_keep_the_current_behavior() {
    // GNOME/Ubuntu (Wayland nativo y XWayland), KDE y un entorno vacío: sin
    // ajustes. Es la fila que protege a Ubuntu (S1).
    let none = FitProfile {
        wayland_size_hints: false,
    };
    for env in [
        Env {
            xdg_current_desktop: Some("ubuntu:GNOME".to_string()),
            desktop_session: Some("ubuntu".to_string()),
            wayland_display: Some("wayland-0".to_string()),
            ..Env::default()
        },
        Env {
            xdg_current_desktop: Some("ubuntu:GNOME".to_string()),
            gdk_backend: Some("x11".to_string()),
            ..Env::default()
        },
        Env {
            xdg_current_desktop: Some("KDE".to_string()),
            ..Env::default()
        },
        Env::default(),
    ] {
        assert_eq!(fit_profile_from_env(&env), none, "{env:?}");
    }
}

#[test]
fn the_size_hints_are_requested_in_logical_pixels() {
    let hyprland = FitProfile {
        wayland_size_hints: true,
    };
    // Escala ×1: el tamaño de la tira que se midió en Hyprland.
    assert_eq!(hint_size(hyprland, (61, 181), 1.0), Some((61, 181)));
    // Escala ×2: GTK mide en lógicos y la petición llega en físicos; pasar los
    // físicos tal cual duplicaría la ventana (P2 de #224).
    assert_eq!(hint_size(hyprland, (200, 300), 2.0), Some((100, 150)));
}

#[test]
fn the_default_profile_asks_for_no_hints() {
    let none = FitProfile {
        wayland_size_hints: false,
    };
    assert_eq!(hint_size(none, (61, 181), 1.0), None);
}
