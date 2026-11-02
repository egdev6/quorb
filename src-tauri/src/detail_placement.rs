//! Colocación nativa del panel de detalle de la clave de API en Linux/X11 (#215).
//!
//! La ventana de detalle nace con `resizable(false)` + `inner_size(330, 260)`;
//! bajo X11/XWayland GTK mantiene pegado un `PMinSize` de origen y el resize
//! externo se rechaza en ancho, así que la caja del contenedor translúcido
//! asoma alrededor del contenido. Este módulo le da a la ventana de detalle
//! el mismo ciclo de tamaño en X11 que recibió la tira en #205: el permiso de
//! resize se abre **sólo alrededor del resize programático** y la ventana
//! queda sujeta con pistas iguales (`min == max == pedido`) dentro de una
//! **única llamada de tamaño en el hilo de UI**.
//!
//! Lo que el detalle agrega por encima de #205:
//!
//! - Su **propia generación** (un estático separado, nunca
//!   `widget_placement::GENERATION`): una colocación posterior de detalle
//!   sustituye a la pendiente, y la generación se comprueba antes de cada
//!   fase nativa.
//! - **Sin anclaje**: después del ciclo de tamaño el panel sólo necesita la
//!   `x, y` física explícita de la petición.
//! - La ventana suele estar **oculta** cuando llegan los bounds
//!   (`DetailPanel.tsx` los aplica antes de `showDetail()`): el read-back
//!   nunca bloquea la apertura esperando visibilidad. Dentro de su
//!   presupuesto acotado, una ventana ilegible da un informe suave honesto
//!   (`unverified`, sin geometría cacheada): el frontend puede volver a pedir
//!   después de `show()`.
//!
//! El read-back sale de GDK (la señal `gdk_window_is_viewable()`, la
//! geometría escalada con el factor de escala de la propia ventana, el origen
//! de `gdk_window_get_origin`) y sólo la geometría del read-back se compara
//! con la tolerancia de ±1 px de redondeo de #205.
//!
//! Windows/macOS/Wayland nativo conservan intacto el camino existente de
//! `detail_geometry::apply`: la petición se aplica como siempre y se informa
//! `unverified` sin geometría.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::detail_geometry::Bounds;
use crate::widget_placement::{
    position_matches, rooted_origin, size_matches, to_logical, to_physical, Geometry, Reason,
    Transport, READS, SETTLE,
};
// El informe es el espejo de `set_widget_bounds`: viajan los mismos tipos,
// así el frontend trata con un solo contrato.
pub use crate::widget_placement::{Report, Status};

/// Intentos por llamada nativa: una llamada que no se puede confirmar se
/// reintenta una vez y, si tampoco, la colocación informa del fallo.
const CALL_ATTEMPTS: usize = 2;

/// Desvío que toma la colocación por transporte: sólo X11/XWayland tiene un
/// ciclo con read-back; los demás transportes aplican la petición y la
/// informan sin verificar (comportamiento sin cambios, S1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    /// X11/XWayland: el ciclo de tamaño con la ventana del permiso de resize.
    X11Cycle,
    /// Sin read-back del compositor: aplicar e informar sin verificar.
    UnverifiedPath,
}

pub(crate) fn route_of(transport: Transport) -> Route {
    match transport {
        Transport::X11 => Route::X11Cycle,
        Transport::Other => Route::UnverifiedPath,
    }
}

/// La generación propia del detalle: un contador separado, nunca el de la
/// tira (#215): una colocación posterior de detalle sustituye a la pendiente.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Reserva la siguiente generación del detalle.
pub fn next_generation() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// True cuando una colocación posterior de detalle sustituyó a la
/// `generation` dada.
pub fn superseded(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) != generation
}

/// Ventana nativa abstracta para la llamada de tamaño, así su orden es
/// testeable de forma determinística sin GTK: primero las pistas, el permiso
/// de resize abierto sólo alrededor del resize, cerrado y confirmado después.
pub(crate) trait Sizable {
    /// Petición de tamaño + pistas `min == max` SIN redimensionar.
    fn set_constraints(&mut self, width: i32, height: i32);
    /// Abre el permiso de resize y redimensiona (`widget_placement::fix_size`).
    fn resize_with_permission(&mut self, width: i32, height: i32);
    /// Retira el permiso; devuelve si quedó cerrado.
    fn close_permission(&mut self) -> bool;
}

/// La única llamada de tamaño en el hilo de UI (#215): petición de tamaño +
/// pistas `min == max == pedido` + `resizable(true)` + resize +
/// `resizable(false)`. El permiso no puede quedar abierto para siempre (S4):
/// la llamada informa si quedó cerrado.
pub(crate) fn size_call<W: Sizable>(window: &mut W, width: i32, height: i32) -> bool {
    window.set_constraints(width, height);
    window.resize_with_permission(width, height);
    window.close_permission()
}

/// Ventana nativa abstracta para la llamada de posición, así la conversión
/// de la petición a píxeles lógicos es testeable de forma determinística
/// sin GTK (P2 de PR #224).
pub(crate) trait Positioner {
    /// El factor de escala de la propia ventana: GTK mide en píxeles
    /// lógicos y la petición llega en píxeles físicos.
    fn scale(&self) -> f64;
    /// Mueve la ventana a coordenadas ya LÓGICAS.
    fn move_to(&mut self, x: i32, y: i32);
}

/// La única llamada de posición en el hilo de UI (#215): la petición física
/// se convierte a píxeles lógicos en **los dos ejes** antes del movimiento,
/// porque GTK mide en píxeles lógicos (el mismo mapeo que hace el adaptador
/// de widgets en `widget_placement.rs`). A escala ×2 mover los valores
/// físicos tal cual duplicaría el desplazamiento del panel (P2 de PR #224).
pub(crate) fn position_call<W: Positioner>(window: &mut W, x: i32, y: i32) -> bool {
    let (lx, ly) = (to_logical(x, window.scale()), to_logical(y, window.scale()));
    window.move_to(lx, ly);
    true
}

/// Operaciones nativas que necesita el ciclo del detalle: la implementación
/// real salta al hilo de UI y el doble de los tests responde en el acto.
pub trait Surface {
    /// La única llamada de tamaño: petición de tamaño, pistas `min == max`,
    /// resize y el permiso de resize retirado en la misma llamada. `false` =
    /// la llamada no se pudo confirmar (el hilo de UI no respondió o el
    /// permiso no quedó cerrado): el ciclo no puede seguir como si el tamaño
    /// se hubiera aplicado.
    fn request_size(&mut self, width: i32, height: i32) -> impl Future<Output = bool> + Send;
    /// Mueve la superficie nativa. `false` = la llamada no se pudo confirmar.
    fn request_position(&mut self, x: i32, y: i32) -> impl Future<Output = bool> + Send;
    /// Lee la geometría que concedió el compositor. `None` mientras la
    /// ventana siga sin poder leerse (reintentable dentro del presupuesto);
    /// `Err` sólo si la lectura falló de verdad.
    fn read_geometry(&mut self) -> impl Future<Output = Result<Option<Geometry>, String>> + Send;
    /// Espera a que el gestor responda.
    fn settle(&mut self) -> impl Future<Output = ()> + Send;
}

/// Corre el ciclo del detalle:
///
/// 1. **tamaño** (la única llamada con su ventana de permiso),
/// 2. **posición** (la `x, y` física explícita, sin anclaje),
/// 3. **read-back** (sólo después de que el permiso esté cerrado;
///    presupuesto acotado).
///
/// Una colocación posterior (generación propia) se comprueba antes de cada
/// fase nativa y detiene el ciclo sin volver a tocar la ventana.
pub async fn drive<S: Surface>(
    surface: &mut S,
    bounds: Bounds,
    mut superseded: impl FnMut() -> bool,
) -> Report {
    let wanted = (bounds.w as i32, bounds.h as i32);
    // El cancelador se comprueba antes de cada fase nativa: una colocación
    // posterior no debe dejar la ventana movida a medias por esta.
    if superseded() {
        return superseded_report();
    }
    if !request_size_checked(surface, wanted).await {
        // La llamada nativa no se pudo confirmar: el ciclo no sigue como si
        // el tamaño se hubiera aplicado.
        return failed_report(Reason::ReadFailed);
    }
    // La posición es explícita: sin anclaje para el detalle, la `x, y` física
    // de la petición.
    let target = (bounds.x, bounds.y);
    if superseded() {
        return superseded_report();
    }
    if !request_position_checked(surface, target).await {
        return failed_report(Reason::ReadFailed);
    }
    // El read-back ocurre después de que el permiso esté cerrado (la única
    // llamada de tamaño ya lo retiró). El presupuesto es acotado: una ventana
    // oculta nunca bloquea la apertura esperando visibilidad, y una que
    // nunca se vuelve legible da un informe suave honesto —el frontend puede
    // volver a pedir después de `show()`.
    if superseded() {
        return superseded_report();
    }
    let mut last: Option<Geometry> = None;
    for _ in 0..READS {
        surface.settle().await;
        match surface.read_geometry().await {
            Ok(Some(geometry)) => {
                if size_matches(wanted, geometry.size) && position_matches(target, geometry.origin)
                {
                    return report_of(wanted, target, geometry);
                }
                last = Some(geometry);
            }
            Ok(None) => {}
            Err(_) => return failed_report(Reason::ReadFailed),
        }
    }
    match last {
        Some(geometry) => report_of(wanted, target, geometry),
        None => failed_report(Reason::NotViewable),
    }
}

/// Pide el tamaño con un presupuesto acotado de reintentos: una llamada
/// nativa que no se puede confirmar no se da por buena.
async fn request_size_checked<S: Surface>(surface: &mut S, size: (i32, i32)) -> bool {
    for attempt in 0..CALL_ATTEMPTS {
        if surface.request_size(size.0, size.1).await {
            return true;
        }
        if attempt + 1 < CALL_ATTEMPTS {
            surface.settle().await;
        }
    }
    false
}

/// Mueve la ventana con un presupuesto acotado de reintentos.
async fn request_position_checked<S: Surface>(surface: &mut S, position: (i32, i32)) -> bool {
    for attempt in 0..CALL_ATTEMPTS {
        if surface.request_position(position.0, position.1).await {
            return true;
        }
        if attempt + 1 < CALL_ATTEMPTS {
            surface.settle().await;
        }
    }
    false
}

/// Una colocación sin lectura fiable: no hay geometría que cachear.
pub(crate) fn unverified_report() -> Report {
    Report {
        status: Status::Unverified,
        bounds: None,
        reason: None,
        read_back: false,
    }
}

/// Una colocación cancelada: la geometría quedó a medias y no se informa.
fn superseded_report() -> Report {
    Report {
        status: Status::Superseded,
        bounds: None,
        reason: Some(Reason::Superseded),
        read_back: false,
    }
}

/// Una colocación cuya llamada nativa no se pudo confirmar: nada que cachear.
fn failed_report(reason: Reason) -> Report {
    Report {
        status: Status::Unverified,
        bounds: None,
        reason: Some(reason),
        read_back: false,
    }
}

/// Compone el informe final con la geometría que quedó en pantalla: es
/// geometría de read-back, así que se compara con la tolerancia de ±1 px y se
/// informa exactamente lo concedido, nunca lo pedido.
fn report_of(wanted: (i32, i32), target: (i32, i32), effective: Geometry) -> Report {
    let size_ok = size_matches(wanted, effective.size);
    let position_ok = position_matches(target, effective.origin);
    Report {
        status: if size_ok && position_ok {
            Status::Applied
        } else {
            Status::Limited
        },
        bounds: Some(Bounds {
            x: effective.origin.0,
            y: effective.origin.1,
            w: effective.size.0.max(0) as u32,
            h: effective.size.1.max(0) as u32,
        }),
        reason: if size_ok && position_ok {
            None
        } else if size_ok {
            Some(Reason::PositionRefused)
        } else {
            Some(Reason::SizeRefused)
        },
        // La geometría es la que leyó el compositor: sólo ella admite la
        // tolerancia del redondeo de píxeles de dispositivo.
        read_back: true,
    }
}

/// Coloca la ventana de detalle en la superficie nativa e informa lo que
/// pasó.
#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
pub async fn place(
    window: &tauri::WebviewWindow,
    bounds: Bounds,
    generation: u64,
) -> Result<Report, String> {
    // Antes de tocar la superficie nativa: sólo la ventana de detalle puede
    // colocar sus propios bounds y el rectángulo tiene que ser utilizable
    // (validación exclusiva del detalle, sin cambios).
    let bounds = bounds.validate(window.label())?;
    #[cfg(target_os = "linux")]
    {
        // GDK sólo se puede tocar en el hilo de UI: la detección del
        // transporte va allí, como todas las llamadas nativas.
        if route_of(crate::widget_placement::transport_on_ui(window).await) == Route::X11Cycle {
            let mut surface = UiSurface::new(window.clone(), generation);
            return Ok(drive(&mut surface, bounds, || superseded(generation)).await);
        }
    }
    // Sin read-back del compositor en esta plataforma la petición se aplica
    // como antes, y la llamada nativa sigue en el hilo de UI.
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let ui_window = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.try_send(crate::detail_geometry::apply(&ui_window, bounds));
        })
        .map_err(|e| e.to_string())?;
    rx.recv()
        .await
        .ok_or_else(|| "Detail bounds UI callback was dropped".to_string())?
        .map(|()| unverified_report())
}

/// Adaptador GTK para que el orden de la llamada de tamaño siga siendo
/// testeable de forma determinística mientras el permiso nunca queda abierto
/// para siempre (S4). Genérico: la superficie de producción pasa la ventana
/// de aplicación GTK, el test en vivo pasa una `gtk::Window` simple.
#[cfg(target_os = "linux")]
pub(crate) struct GtkSizable<'a, W>(pub &'a W);

#[cfg(target_os = "linux")]
impl<W> Sizable for GtkSizable<'_, W>
where
    W: gtk::prelude::GtkWindowExt + gtk::prelude::WidgetExt,
{
    fn set_constraints(&mut self, width: i32, height: i32) {
        crate::widget_placement::set_size_constraints(self.0, width, height);
    }

    fn resize_with_permission(&mut self, width: i32, height: i32) {
        crate::widget_placement::fix_size(self.0, width, height);
    }

    fn close_permission(&mut self) -> bool {
        self.0.set_resizable(false);
        !self.0.is_resizable()
    }
}

/// La contrapartida GTK del adaptador de posición: genérico como
/// `GtkSizable`, así la llamada de posición sigue siendo testeable.
#[cfg(target_os = "linux")]
pub(crate) struct GtkPositioner<'a, W>(pub &'a W);

#[cfg(target_os = "linux")]
impl<W> Positioner for GtkPositioner<'_, W>
where
    W: gtk::prelude::GtkWindowExt + gtk::prelude::WidgetExt,
{
    fn scale(&self) -> f64 {
        self.0.scale_factor() as f64
    }

    fn move_to(&mut self, x: i32, y: i32) {
        self.0.move_(x, y);
    }
}

/// La superficie GTK: todas las llamadas nativas ocurren en el hilo de UI.
#[cfg(target_os = "linux")]
struct UiSurface {
    window: tauri::WebviewWindow,
    /// La generación de esta colocación: las closures la comprueban dentro
    /// del hilo de UI, así una colocación posterior nunca mueve la ventana a
    /// medias.
    generation: u64,
}

#[cfg(target_os = "linux")]
impl UiSurface {
    fn new(window: tauri::WebviewWindow, generation: u64) -> Self {
        Self { window, generation }
    }
}

#[cfg(target_os = "linux")]
impl Surface for UiSurface {
    async fn request_size(&mut self, width: i32, height: i32) -> bool {
        let generation = self.generation;
        crate::widget_placement::on_ui(&self.window, move |gtk| {
            if superseded(generation) {
                // La colocación está vencida: la ventana no se toca (y el
                // permiso queda cerrado).
                return true;
            }
            // El factor de escala de la ventana de detalle convierte la
            // petición física (GTK mide en píxeles lógicos).
            use gtk::prelude::*;
            let scale = gtk.scale_factor() as f64;
            let (w, h) = (to_logical(width, scale), to_logical(height, scale));
            size_call(&mut GtkSizable(gtk), w, h)
        })
        .await
        .unwrap_or(false)
    }

    async fn request_position(&mut self, x: i32, y: i32) -> bool {
        let generation = self.generation;
        crate::widget_placement::on_ui(&self.window, move |gtk| {
            // La generación se comprueba dentro del hilo de UI: entre la
            // comprobación y el movimiento no cabe otra colocación.
            if superseded(generation) {
                return true;
            }
            // GTK mide en píxeles lógicos y la petición llega en píxeles
            // físicos (P2 de PR #224): la conversión a los dos ejes va
            // dentro de la única llamada de posición, con el factor de
            // escala de la propia ventana, el mismo mapeo que el adaptador
            // de widgets en `widget_placement.rs`.
            position_call(&mut GtkPositioner(gtk), x, y)
        })
        .await
        .unwrap_or(false)
    }

    async fn read_geometry(&mut self) -> Result<Option<Geometry>, String> {
        crate::widget_placement::on_ui(&self.window, move |gtk| {
            use gtk::prelude::*;
            // Sin ventana GDK todavía no hay superficie que leer.
            let Some(gdk_window) = gtk.window() else {
                return Ok(None);
            };
            // La señal real de visibilidad: la ventana y sus ancestros están
            // mapeados.
            if !gdk_window.is_viewable() {
                return Ok(None);
            }
            // La geometría que tiene el servidor X en este momento,
            // convertida con el factor de escala de la propia ventana.
            let scale = gtk.scale_factor() as f64;
            let (_, _, gw, gh) = gdk_window.geometry();
            let size = (to_physical(gw, scale), to_physical(gh, scale));
            // El origen: `gdk_window_get_origin` da coordenadas relativas a
            // la raíz. Su valor de retorno no confirma una lectura utilizable
            // (#205): un 0 se lee como «no hay origen».
            let (ox, oy, rooted) = gdk_window.origin();
            let Some((ox, oy)) = rooted_origin(ox, oy, rooted != 0) else {
                return Err("the native window origin could not be read".to_string());
            };
            Ok(Some(Geometry {
                origin: (to_physical(ox, scale), to_physical(oy, scale)),
                size,
            }))
        })
        .await
        .ok_or_else(|| "the native window could not be read".to_string())?
    }

    async fn settle(&mut self) {
        // El hilo de UI queda libre mientras el gestor responde.
        tokio::time::sleep(SETTLE).await;
    }
}
