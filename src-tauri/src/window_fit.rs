//! Ajuste de la ventana de la tira y del detalle por compositor (#250).
//!
//! Hyprland no respeta el tamaño de la ventana en dos casos medidos: en Wayland
//! nativo conserva el tamaño con el que la mapea, porque la rama sin ciclo de
//! `widget_placement::place` nunca manda las pistas de tamaño que sí manda el
//! ciclo X11; y en XWayland la coloca en mosaico, donde el layout fija el
//! tamaño (`SizeRefused`). Cada efecto es una bandera de [`FitProfile`]. La fila
//! por defecto no pide nada, así GNOME/Ubuntu y el resto de entornos conservan
//! el comportamiento de siempre; soportar otro compositor es añadir una fila y
//! su test.

use crate::wm_compat::{is_hyprland_signal, normalize_env, Env};

/// Qué ajustes de ventana necesita un compositor. Un campo por efecto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FitProfile {
    /// Mandar la petición de tamaño y las pistas `min == max` también en la
    /// ruta sin ciclo (Wayland nativo): sin ellas el compositor conserva el
    /// tamaño con el que mapeó la ventana.
    pub wayland_size_hints: bool,
    /// Declarar el tipo de ventana GTK (`Utility`) antes del primer `show`
    /// bajo X11/XWayland: los compositores que colo la ventana en mosaico la
    /// flotan y respetan las pistas del ciclo X11.
    pub x11_float_hint: bool,
}

impl FitProfile {
    /// Sin ajustes: el comportamiento de siempre (GNOME/Mutter y el resto).
    pub const NONE: FitProfile = FitProfile {
        wayland_size_hints: false,
        x11_float_hint: false,
    };
}

/// El perfil del compositor que señala el entorno. Pura: los tests la llaman
/// con un `Env` a mano, sin tocar `std::env`.
///
/// Sólo Hyprland pide ajustes hoy (#250): en Wayland nativo conserva el tamaño
/// con el que mapea la ventana y en XWayland la coloca en mosaico. GNOME/Mutter
/// y el resto conservan el comportamiento de siempre. La detección reutiliza
/// `wm_compat` (una sola fuente de señales, #180) y `normalize_env` trata el
/// string vacío como ausente, igual que los tests de `wm_compat` esperan.
pub fn fit_profile_from_env(env: &Env) -> FitProfile {
    let env_n = normalize_env(env);
    if is_hyprland_signal(&env_n) {
        FitProfile {
            wayland_size_hints: true,
            x11_float_hint: true,
        }
    } else {
        FitProfile::NONE
    }
}

/// El perfil del proceso actual.
pub fn fit_profile() -> FitProfile {
    fit_profile_from_env(&Env::from_process())
}

/// El tamaño al que se fijan las pistas en la ruta sin ciclo, o `None` si el
/// perfil no las pide (entonces no se hace ninguna llamada nativa). GTK mide en
/// píxeles lógicos y la petición llega en físicos: se convierte en los dos
/// ejes (P2 de #224).
pub fn hint_size(profile: FitProfile, physical: (i32, i32), scale: f64) -> Option<(i32, i32)> {
    if !profile.wayland_size_hints {
        return None;
    }
    Some((
        crate::widget_placement::to_logical(physical.0, scale),
        crate::widget_placement::to_logical(physical.1, scale),
    ))
}
