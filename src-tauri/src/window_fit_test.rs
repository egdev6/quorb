//! Contrato del perfil de ajuste de ventana por compositor (#250).
//!
//! Lo que puede fallar aquí es qué entornos piden ajustes (solo Hyprland: GNOME,
//! Ubuntu y el resto conservan el comportamiento de siempre), qué efecto pide
//! cada transporte (las pistas son del camino sin ciclo; el tipo de ventana,
//! del X11) y el tamaño de las pistas, que GTK mide en píxeles lógicos
//! mientras la petición llega en físicos (P2 de #224).
//!
//! El efecto también se afirma aquí: las llamadas del ajuste pasan por la
//! costura `FitSurface`, y el doble de los tests registra lo que se le pidió
//! (pistas en las dos ventanas, `Utility` antes del primer `show`, ninguna
//! llamada nueva fuera de Hyprland). El doble no decide nada: sólo anota.

use super::window_fit::*;
use crate::widget_placement::Transport;
use crate::wm_compat::Env;

/// El doble de la ventana nativa: anota las llamadas del ajuste, en orden.
///
/// No decide nada: sólo registra lo que se le pidió (el tipo de ventana, las
/// pistas y el `show`), para que el test vea el orden.
pub(crate) struct FakeFitSurface {
    /// El factor de escala que informa la ventana.
    window_scale: f64,
    /// Las llamadas, en orden.
    calls: Vec<String>,
}

impl FakeFitSurface {
    /// La ventana que informa `window_scale`.
    pub(crate) fn new(window_scale: f64) -> Self {
        FakeFitSurface {
            window_scale,
            calls: Vec::new(),
        }
    }

    /// Las llamadas registradas, en orden.
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.clone()
    }
}

impl FitSurface for FakeFitSurface {
    fn window_scale(&self) -> f64 {
        self.window_scale
    }

    fn set_size_constraints(&mut self, width: i32, height: i32) {
        self.calls.push(format!("constraints {width}x{height}"));
    }

    fn set_type_hint_utility(&mut self) {
        self.calls.push("type_hint utility".into());
    }

    fn show(&mut self) {
        self.calls.push("show".into());
    }
}

/// El perfil de Hyprland: el único que pide ajustes (#250).
pub(crate) fn hyprland_profile() -> FitProfile {
    FitProfile {
        wayland_size_hints: true,
        x11_float_hint: true,
    }
}

#[test]
fn hyprland_asks_for_size_hints_on_native_wayland() {
    // Las señales que `wm_compat` reconoce como Hyprland, cada una sola.
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
fn the_profile_activates_with_the_instance_signature_alone() {
    // #250: la firma de la instancia de Hyprland sobrevive a los lanzadores y
    // servicios que limpian `XDG_CURRENT_DESKTOP` y `DESKTOP_SESSION`: con
    // esa sola señal el perfil se activa.
    let env = Env {
        hyprland_instance_signature: Some("1234abcd-0000-0000-0000-000000000000".to_string()),
        ..Env::default()
    };
    let profile = fit_profile_from_env(&env);
    assert!(profile.wayland_size_hints, "la firma sola pide las pistas");
    assert!(
        profile.x11_float_hint,
        "la firma sola pide el tipo de ventana"
    );
}

#[test]
fn other_desktops_keep_the_current_behavior() {
    // GNOME/Ubuntu (Wayland nativo y XWayland), KDE y un entorno vacío: sin
    // ajustes. Es la fila que protege a Ubuntu (S1).
    let none = FitProfile {
        wayland_size_hints: false,
        x11_float_hint: false,
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
        // Ubuntu sin `DESKTOP_SESSION`: solo `XDG_CURRENT_DESKTOP`.
        Env {
            xdg_current_desktop: Some("ubuntu:GNOME".to_string()),
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
fn an_empty_hyprland_signal_is_rejected() {
    // `normalize_env` trata el string vacío como ausente: una señal vacía no
    // puede activar el perfil de Hyprland (ni delatar a un entorno que no lo
    // es).
    let env = Env {
        xdg_current_desktop: Some("ubuntu:GNOME".to_string()),
        hyprland_instance_signature: Some(String::new()),
        ..Env::default()
    };
    assert_eq!(fit_profile_from_env(&env), FitProfile::NONE, "{env:?}");
}

#[test]
fn the_size_hints_are_requested_in_logical_pixels() {
    let hyprland = FitProfile {
        wayland_size_hints: true,
        x11_float_hint: false,
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
        x11_float_hint: false,
    };
    assert_eq!(hint_size(none, (61, 181), 1.0), None);
}

#[test]
fn hyprland_asks_for_the_float_hint_on_xwayland() {
    // La misma detección de Hyprland que la bandera de Wayland nativo.
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
        assert!(fit_profile_from_env(&env).x11_float_hint, "{env:?}");
    }
}

#[test]
fn each_effect_belongs_to_a_single_backend() {
    // Las pistas `min == max` son del camino sin ciclo (Wayland nativo): en X11
    // las manda el ciclo, que además las vuelve a fijar.
    let hyprland = hyprland_profile();
    let native = fit_plan(hyprland, Transport::Other);
    assert!(native.size_hints(), "en Wayland nativo: las pistas");
    assert!(
        !native.utility_type_hint(),
        "en Wayland nativo el tipo de ventana no tiene efecto (medido)"
    );
    // El tipo de ventana es de X11/XWayland: sin él el compositor coloca la
    // ventana en mosaico.
    let x11 = fit_plan(hyprland, Transport::X11);
    assert!(!x11.size_hints(), "en X11 las manda el ciclo");
    assert!(x11.utility_type_hint(), "en X11: el tipo de ventana");
}

#[test]
fn no_native_call_is_requested_outside_hyprland() {
    // La fila que protege a Ubuntu (S1): con el perfil por defecto no hay
    // ninguna llamada nativa nueva, en ningún transporte.
    for transport in [Transport::X11, Transport::Other] {
        let plan = fit_plan(FitProfile::NONE, transport);
        let mut surface = FakeFitSurface::new(1.0);
        assert!(
            !apply_size_hints(&mut surface, &plan, (61, 181), ScaleSource::Request(1.0)),
            "sin perfil no se piden pistas: {transport:?}"
        );
        assert!(
            !apply_type_hint(&mut surface, &plan),
            "sin perfil no se declara el tipo: {transport:?}"
        );
        assert!(
            surface.calls().is_empty(),
            "fuera de Hyprland no hay llamadas nuevas: {:?}",
            surface.calls()
        );
    }
}

#[test]
fn the_size_hints_use_the_scale_the_window_reports() {
    // La ventana informa escala 2: la petición física llega en píxeles
    // físicos y las pistas van en lógicos (P2 de #224).
    let plan = fit_plan(hyprland_profile(), Transport::Other);
    let mut surface = FakeFitSurface::new(2.0);
    assert!(apply_size_hints(
        &mut surface,
        &plan,
        (200, 300),
        ScaleSource::Window
    ));
    assert_eq!(
        surface.calls(),
        vec!["constraints 100x150"],
        "las pistas van en píxeles lógicos"
    );
}

#[test]
fn the_utility_hint_is_requested_before_the_show() {
    // El compositor lee el tipo de ventana al mapear: el tipo tiene que estar
    // antes del primer `show`, o la ventana no flota.
    let plan = fit_plan(hyprland_profile(), Transport::X11);
    let mut surface = FakeFitSurface::new(1.0);
    show_with_utility_hint(&mut surface, &plan);
    assert_eq!(
        surface.calls(),
        vec!["type_hint utility", "show"],
        "el tipo va antes del show"
    );
}

#[test]
fn the_show_happens_even_without_the_float_hint() {
    // Sin el perfil de Hyprland no hay tipo que declarar, pero la ventana se
    // muestra igual: el ajuste no puede impedir el `show`.
    let plan = fit_plan(FitProfile::NONE, Transport::X11);
    let mut surface = FakeFitSurface::new(1.0);
    show_with_utility_hint(&mut surface, &plan);
    assert_eq!(surface.calls(), vec!["show"], "sólo el show");
}

#[test]
fn the_native_route_calls_the_fit_in_both_windows() {
    // El cableado de la ruta sin ciclo: las dos ventanas tienen que llamar al
    // ajuste. `place()` necesita una ventana real, así que el efecto se
    // prueba por la costura; esta afirmación es la que ata esa costura al
    // punto de llamada: sin ella, borrar la llamada dejaría la ventana sin
    // ajustar y ningún test lo detectaría. Es lo que pidió el mantenedor en la
    // revisión de #250 ("los tests de `window_fit_test.rs` seguirían pasando
    // si se eliminaran esas llamadas").
    let widget = include_str!("widget_placement.rs");
    let detail = include_str!("detail_placement.rs");
    assert!(
        widget.contains("fit_widget(&mut surface"),
        "la ruta sin ciclo de la tira tiene que llamar a `fit_widget`"
    );
    assert!(
        detail.contains("fit_detail(&mut surface"),
        "la ruta sin ciclo del detalle tiene que llamar a `fit_detail`"
    );
}
