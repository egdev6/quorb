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
//!
//! El **plan** ([`FitPlan`]) une el perfil con el transporte real de la
//! ventana: cada efecto pertenece a un solo backend (las pistas son del camino
//! sin ciclo; el tipo de ventana, del X11). El **efecto** pasa por la costura
//! [`FitSurface`]: la implementación real habla con GTK en el hilo de UI y los
//! tests usan un doble que registra las llamadas, así que el cableado se
//! puede afirmar (pistas en las dos ventanas, `Utility` antes del primer
//! `show`, ninguna llamada nueva fuera de Hyprland).

use crate::widget_placement::{to_logical, Transport};
use crate::wm_compat::{is_hyprland_signal, normalize_env, Env};

/// Qué ajustes de ventana necesita un compositor. Un campo por efecto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FitProfile {
    /// Mandar la petición de tamaño y las pistas `min == max` también en la
    /// ruta sin ciclo (Wayland nativo): sin ellas el compositor conserva el
    /// tamaño con el que mapeó la ventana.
    pub wayland_size_hints: bool,
    /// Declarar el tipo de ventana GTK (`Utility`) antes del primer `show`
    /// bajo X11/XWayland: los compositores que colocan la ventana en mosaico
    /// la flotan y respetan las pistas del ciclo X11.
    pub x11_float_hint: bool,
}

impl FitProfile {
    /// Sin ajustes: el comportamiento de siempre (GNOME/Mutter y el resto).
    pub const NONE: FitProfile = FitProfile {
        wayland_size_hints: false,
        x11_float_hint: false,
    };
}

/// El plan de ajuste: el perfil del compositor con el transporte real de la
/// ventana. Cada efecto pertenece a un solo backend, así que el plan los
/// separa: en X11 manda el ciclo (que ya fija las pistas) y el tipo de
/// ventana; en Wayland nativo, las pistas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FitPlan {
    /// El perfil del compositor.
    pub profile: FitProfile,
    /// El transporte de la ventana (X11/XWayland o Wayland nativo).
    pub transport: Transport,
}

impl FitPlan {
    /// ¿Pide las pistas de tamaño (`min == max`)? Sólo en la ruta sin ciclo:
    /// en X11 las manda el ciclo, que además las vuelve a fijar.
    pub fn size_hints(&self) -> bool {
        self.profile.wayland_size_hints && self.transport != Transport::X11
    }

    /// ¿Declara el tipo de ventana `Utility`? Sólo bajo X11/XWayland: en
    /// Wayland nativo el tipo de ventana no tiene efecto (medido).
    pub fn utility_type_hint(&self) -> bool {
        self.profile.x11_float_hint && self.transport == Transport::X11
    }
}

/// El plan del perfil con el transporte real. Pura: los tests la llaman con
/// un perfil y un transporte a mano.
pub fn fit_plan(profile: FitProfile, transport: Transport) -> FitPlan {
    FitPlan { profile, transport }
}

/// El plan del proceso actual (Linux): el perfil del compositor y el
/// transporte real del display de GDK. El transporte se lee en el hilo de UI
/// (GDK no admite otro hilo), así que esta función se llama allí.
#[cfg(target_os = "linux")]
pub(crate) fn fit_plan_now() -> FitPlan {
    fit_plan(fit_profile(), crate::widget_placement::transport())
}

/// De dónde sale el factor de escala con el que se convierte la petición
/// física a píxeles lógicos.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScaleSource {
    /// El factor con el que se calculó la petición (la tira): en DPI mixto
    /// puede diferir del de la ventana.
    Request(f64),
    /// El factor que informa la propia ventana (el detalle).
    Window,
}

/// La ventana nativa que el ajuste necesita. La implementación real habla con
/// GTK en el hilo de UI; los tests usan un doble que registra las llamadas
/// (sin lógica: sólo anotan lo que se les pidió).
pub trait FitSurface {
    /// El factor de escala que informa la ventana (GTK mide en lógicos).
    fn window_scale(&self) -> f64;
    /// Fija la petición de tamaño y las pistas `min == max`.
    fn set_size_constraints(&mut self, width: i32, height: i32);
    /// Declara el tipo de ventana `Utility`.
    fn set_type_hint_utility(&mut self);
    /// Muestra la ventana con su contenido.
    fn show(&mut self);
}

/// El factor de la conversión según la fuente.
fn scale_of<S: FitSurface>(surface: &S, source: ScaleSource) -> f64 {
    match source {
        ScaleSource::Request(scale) => scale,
        ScaleSource::Window => surface.window_scale(),
    }
}

/// Pide las pistas de tamaño que el plan pide, en píxeles lógicos (GTK mide
/// en lógicos y la petición llega en físicos). `false` si el plan no las pide:
/// entonces no se hace ninguna llamada nativa.
pub fn apply_size_hints<S: FitSurface>(
    surface: &mut S,
    plan: &FitPlan,
    physical: (i32, i32),
    source: ScaleSource,
) -> bool {
    if !plan.size_hints() {
        return false;
    }
    let scale = scale_of(surface, source);
    let Some((width, height)) = hint_size(plan.profile, physical, scale) else {
        return false;
    };
    surface.set_size_constraints(width, height);
    true
}

/// Declara el tipo de ventana `Utility` si el plan lo pide. `false` si no lo
/// pide: entonces no se hace ninguna llamada nativa.
pub fn apply_type_hint<S: FitSurface>(surface: &mut S, plan: &FitPlan) -> bool {
    if !plan.utility_type_hint() {
        return false;
    }
    surface.set_type_hint_utility();
    true
}

/// Declara el tipo de la ventana y la muestra: el tipo va **antes** del
/// `show` (#250), porque el compositor lee el tipo de ventana al mapear y
/// después ya no lo cambia.
///
/// Las dos cosas van en la misma llamada: el compositor ve el tipo antes de
/// mapear la ventana, sin depender del orden entre dos colas.
pub fn show_with_utility_hint<S: FitSurface>(surface: &mut S, plan: &FitPlan) {
    apply_type_hint(surface, plan);
    surface.show();
}

/// El desenlace del ajuste de la ventana en la ruta sin ciclo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FitOutcome {
    /// Las pistas se aplicaron.
    Applied,
    /// El plan no pedía ninguna pista: no se hizo ninguna llamada nativa.
    NotRequested,
    /// La colocación estaba caducada: la ventana no se tocó.
    Superseded,
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
    Some((to_logical(physical.0, scale), to_logical(physical.1, scale)))
}

/// La superficie GTK: las llamadas nativas van al hilo de UI y el factor de
/// escala lo informa la ventana (GTK mide en lógicos).
#[cfg(target_os = "linux")]
pub struct GtkFitSurface<'a, W>(pub &'a W);

#[cfg(target_os = "linux")]
impl<'a, W> FitSurface for GtkFitSurface<'a, W>
where
    W: gtk::prelude::GtkWindowExt + gtk::prelude::WidgetExt,
{
    fn window_scale(&self) -> f64 {
        self.0.scale_factor() as f64
    }

    fn set_size_constraints(&mut self, width: i32, height: i32) {
        crate::widget_placement::set_size_constraints(self.0, width, height);
    }

    fn set_type_hint_utility(&mut self) {
        self.0.set_type_hint(gtk::gdk::WindowTypeHint::Utility);
    }

    fn show(&mut self) {
        // Es lo que hace `tao` cuando Tauri muestra la ventana
        // (`WindowRequest::Visible`), con la diferencia de que aquí el tipo de
        // ventana ya está declarado.
        self.0.show_all();
    }
}
