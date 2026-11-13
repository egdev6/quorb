//! Relé nativo de los cruces del puntero (#264/S16) y filtro de los que son
//! cruces reales del borde del toplevel (#264/S17).
//!
//! GTK entrega `enter-notify-event`/`leave-notify-event` aunque WebKitGTK no
//! los traduzca al DOM: en Wayland nativo la señal existe y se pierde al
//! sintetizar el DOM (S16). Este módulo la reenvía al frente como otra fuente
//! de presencia de la superficie, y filtra los cruces que no son una salida
//! real de la ventana (S17).

use gtk::gdk;
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindow};

use crate::WIDGET;

/// El canal por el que el backend reenvía al frente la entrada y la salida
/// nativas del puntero (#264/S16). El payload es la superficie y el tipo de
/// transición: `{ surface: "widget"|"detail", kind: "enter"|"leave" }`.
pub(crate) const POINTER_SURFACE_EVENT: &str = "pointer-surface";

/// La transición nativa del puntero que GTK entregó de una ventana (#264/S16).
#[derive(Clone, Serialize)]
pub(crate) struct PointerSurface {
    /// La ventana que la entregó: la tira (`widget`) o el detalle (`detail`).
    surface: &'static str,
    /// La transición: `enter` o `leave`.
    kind: &'static str,
}

/// Reenvía al frente la entrada y la salida nativas del puntero de una ventana
/// (#264/S16).
///
/// **Una sola fuente por ventana**: el toplevel GTK. Enganchar también el
/// widget de la webview duplicaría cada cruce (el toplevel y el widget ven el
/// mismo evento) y el modelo recibiría dos veces la misma transición.
///
/// El evento **no se consume** (`Propagation::Proceed`): el DOM sigue
/// recibiendo su propio `mouseenter`/`mouseleave`.
///
/// Sólo se reenvían los cruces reales del borde del toplevel (#264/S17): el
/// filtro vive en [`should_forward`].
///
/// Sólo Linux: es el único sitio donde el GTK es accesible desde el backend.
pub(crate) fn forward_pointer_events(window: &WebviewWindow, label: &'static str) {
    // El `AppHandle` se toma antes del closure: la ventana GTK sólo se puede
    // tocar en el hilo de UI, pero el handle se puede usar desde cualquiera.
    let app = window.app_handle().clone();
    let win = window.clone();
    // El closure viaja al hilo de UI: la ventana GTK sólo se puede tocar ahí.
    let gtk_win = win.clone();
    let outcome = win.with_webview(move |_wv| {
        use gtk::prelude::*;
        // Sin estas máscaras GTK no entrega `enter`/`leave` a la ventana.
        let masks = gtk::gdk::EventMask::ENTER_NOTIFY_MASK | gtk::gdk::EventMask::LEAVE_NOTIFY_MASK;
        // El toplevel GTK de la ventana: lo que GTK entrega a la ventana.
        if let Ok(gtk_window) = gtk_win.gtk_window() {
            gtk_window.add_events(masks);
            gtk_window.connect_enter_notify_event({
                let app = app.clone();
                move |_w, e| {
                    // S17: sólo los cruces reales del borde del toplevel.
                    if should_forward(e.mode(), e.detail()) {
                        let _ = app.emit_to(
                            WIDGET,
                            POINTER_SURFACE_EVENT,
                            PointerSurface {
                                surface: label,
                                kind: "enter",
                            },
                        );
                    }
                    gtk::glib::Propagation::Proceed
                }
            });
            gtk_window.connect_leave_notify_event({
                let app = app.clone();
                move |_w, e| {
                    // S17: sólo los cruces reales del borde del toplevel.
                    if should_forward(e.mode(), e.detail()) {
                        let _ = app.emit_to(
                            WIDGET,
                            POINTER_SURFACE_EVENT,
                            PointerSurface {
                                surface: label,
                                kind: "leave",
                            },
                        );
                    }
                    gtk::glib::Propagation::Proceed
                }
            });
        }
    });
    if let Err(e) = outcome {
        eprintln!("Relé de puntero: no pude enganchar GTK en {label}: {e}");
    }
}

/// Decide si un cruce del puntero entregado por GTK es un cruce real del
/// borde del toplevel (#264/S17).
///
/// S17: "El relé nativo reenvía sólo cruces reales del borde de la ventana
/// toplevel. Se descarta un cruce con detalle `Inferior` (el puntero pasó a
/// una ventana hija y sigue dentro de la ventana). Se descartan los modos
/// sintéticos, en los que el puntero no se movió: `Grab`, `GtkGrab`,
/// `StateChanged`, `DeviceSwitch`, `TouchBegin`, `TouchEnd`. Se conservan
/// `Normal`, `Ungrab` y `GtkUngrab`: estos dos últimos informan dónde quedó
/// de verdad el puntero cuando termina un grab (por ejemplo, soltar un
/// arrastre fuera de la tira), y descartarlos perdería una salida real. Los
/// detalles `Virtual` y `NonlinearVirtual` se conservan: son entradas y
/// salidas reales del toplevel cuando el puntero cruza directo hacia o desde
/// una ventana hija."
///
/// Los detalles que no son `Inferior` se conservan todos, incluidos `Unknown`:
/// perder un cruce real deja el detalle abierto (es el fallo que #264
/// persigue), así que ante un valor que no se conoce se conserva.
pub(crate) fn should_forward(mode: gdk::CrossingMode, detail: gdk::NotifyType) -> bool {
    // S17: el puntero pasó a una ventana hija y sigue dentro del toplevel:
    // no es una salida de la ventana.
    if matches!(detail, gdk::NotifyType::Inferior) {
        return false;
    }
    match mode {
        // S17: modos sintéticos, en los que el puntero no se movió.
        gdk::CrossingMode::Grab
        | gdk::CrossingMode::GtkGrab
        | gdk::CrossingMode::StateChanged
        | gdk::CrossingMode::DeviceSwitch
        | gdk::CrossingMode::TouchBegin
        | gdk::CrossingMode::TouchEnd => false,
        // S17: `Normal` es el cruce real; `Ungrab` y `GtkUngrab` dicen dónde
        // quedó el puntero al terminar un grab (soltar un arrastre fuera de
        // la tira), así que también son una salida real.
        gdk::CrossingMode::Normal | gdk::CrossingMode::Ungrab | gdk::CrossingMode::GtkUngrab => {
            true
        }
        // Un modo que no se conoce (`Unknown` o uno que GTK añada después) se
        // conserva: descartarlo perdería una salida real y dejaría el
        // detalle abierto, que es justo lo que #264 viene a cerrar.
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gtk::gdk::{CrossingMode, NotifyType};

    // ───── modos descartados (S17) ─────

    #[test]
    fn descarta_el_modo_grab() {
        assert!(!should_forward(CrossingMode::Grab, NotifyType::Virtual));
    }

    #[test]
    fn descarta_el_modo_gtk_grab() {
        assert!(!should_forward(CrossingMode::GtkGrab, NotifyType::Virtual));
    }

    #[test]
    fn descarta_el_modo_state_changed() {
        assert!(!should_forward(
            CrossingMode::StateChanged,
            NotifyType::Virtual
        ));
    }

    #[test]
    fn descarta_el_modo_device_switch() {
        assert!(!should_forward(
            CrossingMode::DeviceSwitch,
            NotifyType::Virtual
        ));
    }

    #[test]
    fn descarta_el_modo_touch_begin() {
        assert!(!should_forward(
            CrossingMode::TouchBegin,
            NotifyType::Virtual
        ));
    }

    #[test]
    fn descarta_el_modo_touch_end() {
        assert!(!should_forward(CrossingMode::TouchEnd, NotifyType::Virtual));
    }

    // ───── modos conservados (S17) ─────

    #[test]
    fn conserva_el_modo_normal() {
        assert!(should_forward(CrossingMode::Normal, NotifyType::Virtual));
    }

    #[test]
    fn conserva_el_modo_ungrab() {
        assert!(should_forward(CrossingMode::Ungrab, NotifyType::Virtual));
    }

    #[test]
    fn conserva_el_modo_gtk_ungrab() {
        assert!(should_forward(CrossingMode::GtkUngrab, NotifyType::Virtual));
    }

    // ───── detalle `Inferior` (S17) ─────

    #[test]
    fn descarta_el_detalle_inferior_aunque_el_modo_sea_normal() {
        assert!(!should_forward(CrossingMode::Normal, NotifyType::Inferior));
    }

    // ───── detalles conservados (S17) ─────

    #[test]
    fn conserva_los_detalles_virtual_nonlinear_virtual_ancestor_y_nonlinear() {
        for detail in [
            NotifyType::Virtual,
            NotifyType::NonlinearVirtual,
            NotifyType::Ancestor,
            NotifyType::Nonlinear,
        ] {
            assert!(should_forward(CrossingMode::Normal, detail), "{detail:?}");
        }
    }

    #[test]
    fn conserva_el_detalle_desconocido() {
        assert!(should_forward(CrossingMode::Normal, NotifyType::Unknown));
    }
}
