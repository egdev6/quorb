//! Colocación nativa del widget en Linux/X11 (#179).
//!
//! La ventana del widget nace con `resizable: false`; bajo X11 el gestor
//! descarta cualquier resize programático (pistas fijas min=max=320×260) y la
//! tira nunca alcanza el borde del área de trabajo. Este módulo abre el
//! permiso de resize **sólo alrededor del resize programático** y fija la
//! ventana con pistas iguales (`min == max == tamaño de la tira`): el gestor no
//! puede ofrecer otro tamaño y, con el permiso retirado, GTK no muestra cursor
//! de redimensionar ni acepta un arrastre de borde.
//!
//! Lo que conserva el tamaño cuando el permiso se retira es la **petición de
//! tamaño** del widget (`gtk_widget_set_size_request`): al retirar el
//! permiso, GTK recalcula la configuración de la ventana con el tamaño
//! mínimo pedido y el gestor lo respeta (medido: 61×181 sobrevive; sin la
//! petición, la ventana volvía a 320×260).
//!
//! El ciclo es: pedir tamaño → pedir posición → leer lo que concedió el
//! gestor → recolocar con la geometría efectiva → leer de vuelta (el tamaño
//! **y** la posición). El permiso de resize se retira **dentro** de la llamada
//! de tamaño, así que desde el read-back ya nunca está abierto. La
//! visibilidad es del frontend: el backend nunca muestra la ventana. Los
//! read-backs salen de GDK: la señal de visibilidad es
//! `gdk_window_is_viewable()` y el origen sale de `gdk_window_get_origin`
//! (relativo a la raíz): si esa llamada falla, la lectura no es utilizable.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::detail_geometry::Bounds;

/// Tolerancia al comparar la geometría efectiva con la pedida: el gestor
/// redondea el tamaño lógico a píxeles de dispositivo enteros.
const TOLERANCE: i32 = 1;
/// Lecturas permitidas por fase mientras el gestor se estabiliza.
pub const READS: usize = 4;
/// Espera de estabilización entre lecturas.
pub const SETTLE: Duration = Duration::from_millis(15);
/// Intentos por llamada nativa: una llamada que no se puede confirmar se
/// reintenta una vez y, si tampoco, la colocación informa del fallo.
const CALL_ATTEMPTS: usize = 2;
/// Espera máxima de una llamada al hilo de UI: una colocación no puede
/// quedarse esperando para siempre.
const UI_TIMEOUT: Duration = Duration::from_secs(2);

/// Cómo respondió la superficie nativa a una colocación.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// La geometría efectiva se leyó del compositor y coincide con la pedida.
    Applied,
    /// La solicitud se aplicó pero no se pudo leer (plataformas sin read-back).
    Unverified,
    /// El gestor no concedió la geometría pedida.
    Limited,
    /// La colocación se canceló: otra posterior la sustituyó.
    Superseded,
}

/// Motivo por el que una colocación no pudo verificarse: un **código**, no
/// texto de interfaz (la etiqueta la pone el frontend).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// El gestor no concedió el tamaño pedido.
    SizeRefused,
    /// El gestor no colocó la tira donde se pidió.
    PositionRefused,
    /// La ventana todavía no era visible: no hay read-back del compositor.
    NotViewable,
    /// La lectura nativa falló.
    ReadFailed,
    /// La colocación fue sustituida por otra más reciente.
    Superseded,
}

/// Resultado de una colocación: la geometría que quedó en pantalla.
#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub status: Status,
    /// La geometría efectiva leída; `None` si no se pudo leer o se canceló.
    pub bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    /// True cuando la geometría viene del read-back del compositor (X11):
    /// sólo esa geometría admite la tolerancia de ±1 px del redondeo; la
    /// pidió (Windows, macOS, Wayland nativo) se compara exacta.
    #[serde(default)]
    pub read_back: bool,
}

/// Borde del área de trabajo al que la tira está anclada.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    Top,
    Bottom,
    Left,
    Right,
}

/// Lo que pide el frontend: el rectángulo, el borde anclado y el factor con el
/// que se calculó (en DPI mixto, el de la ventana puede ser otro).
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Placement {
    #[serde(flatten)]
    pub bounds: Bounds,
    pub anchor: Anchor,
    /// El factor de escala con el que se calculó el rectángulo.
    pub scale: f64,
}

impl Placement {
    /// Valida la petición **antes de tocar la superficie nativa**: el
    /// rectángulo tiene que ser utilizable y el factor de escala tiene que ser
    /// finito y positivo (con 0 la conversión a píxeles lógicos no tiene
    /// sentido: `to_logical` daría infinito y su recorte sería un tamaño de
    /// 2³¹ píxeles).
    pub fn validate(&self, label: &str) -> Result<Bounds, String> {
        let bounds = self.bounds.validate_widget(label)?;
        if !self.scale.is_finite() || self.scale <= 0.0 {
            return Err(format!("Invalid widget placement scale: {}", self.scale));
        }
        Ok(bounds)
    }
}

/// La geometría efectiva que se leyó del compositor (píxeles físicos).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    /// Origen absoluto del cliente.
    pub origin: (i32, i32),
    /// Tamaño del cliente.
    pub size: (i32, i32),
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Las operaciones nativas que el ciclo necesita: la implementación real salta
/// al hilo de UI y el doble de los tests responde en el acto.
pub trait Surface {
    /// Pide el tamaño fijo: la petición de tamaño del widget, las pistas
    /// `min == max` y el resize. El permiso de resize se abre **sólo** para el
    /// resize programático y se retira en la misma llamada nativa: fuera de
    /// ella no hay cursor de redimensionar ni arrastre de borde.
    ///
    /// `false` = la llamada nativa no se pudo confirmar (el hilo de UI no
    /// respondió o el permiso no quedó cerrado): el ciclo no puede seguir como
    /// si el tamaño se hubiera aplicado.
    fn request_size(&mut self, width: i32, height: i32) -> impl Future<Output = bool> + Send;
    /// Mueve la superficie nativa. `false` = la llamada no se pudo confirmar.
    fn request_position(&mut self, x: i32, y: i32) -> impl Future<Output = bool> + Send;
    /// Fija las pistas de tamaño de la ventana (la petición de tamaño del
    /// widget y las pistas `min == max`) **sin** redimensionarla: la deja
    /// sujeta a ese tamaño. En el camino `limited` ése es el **pedido**, no el
    /// que el compositor concedió: soltar las pistas haría crecer la ventana
    /// a su tamaño por defecto.
    fn set_size_constraints(
        &mut self,
        width: i32,
        height: i32,
    ) -> impl Future<Output = bool> + Send;
    /// Lee la geometría del compositor. `None` si todavía no es visible (es
    /// reintentable); `Err` sólo si la lectura falló de verdad.
    fn read_geometry(&mut self) -> impl Future<Output = Result<Option<Geometry>, String>> + Send;
    /// Espera a que el gestor responda.
    fn settle(&mut self) -> impl Future<Output = ()> + Send;
}

/// Transporte de la superficie nativa: X11/XWayland o native Wayland.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// X11 o XWayland: la ventana es un cliente X11 con posición absoluta.
    X11,
    /// Native Wayland: sin posición absoluta ni pistas de tamaño del gestor.
    Other,
}

/// Clasifica el tipo del display de GDK: X11 y XWayland comparten
/// `GdkX11Display`. Tras la unificación (#180) `transport()` deriva de
/// `kind_from_type_name`; esta función queda como pin pura de tests.
#[cfg(test)]
pub fn transport_from_type_name(name: &str) -> Transport {
    if name.contains("X11") {
        Transport::X11
    } else {
        Transport::Other
    }
}

/// Clasificación única del display GDK efectivo (issue #180, revisión del
/// mantenedor: una sola detección del backend). X11 y XWayland comparten
/// `GdkX11Display`; Wayland nativo es `GdkWaylandDisplay`; lo demás
/// (broadway u otro backend exótico) o un display sin inicializar es
/// desconocido. `transport()` (colocación) y `wm_compat::get_wm_info`
/// (Ajustes/arrastre) derivan de esta misma caché para no poder discrepar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayKind {
    X11,
    Wayland,
    Unknown,
}

/// Clasifica el nombre del tipo del display de GDK (puro, testeable sin
/// tocar GDK).
#[cfg(any(target_os = "linux", test))]
pub fn kind_from_type_name(name: &str) -> DisplayKind {
    if name.contains("X11") {
        DisplayKind::X11
    } else if name.contains("Wayland") {
        DisplayKind::Wayland
    } else {
        DisplayKind::Unknown
    }
}

/// Píxeles lógicos que pide GTK para un tamaño físico (GTK mide en lógicos).
pub fn to_logical(physical: i32, scale: f64) -> i32 {
    (physical as f64 / scale).round() as i32
}

/// El origen que se informa: el de la raíz (`gdk_window_get_origin`).
///
/// `None` cuando la llamada no pudo responder: el único respaldo disponible
/// (`gdk_window_get_geometry`) es **relativo al padre** —el marco de la
/// decoración si el gestor reparenta la ventana— y devolverlo mezclaría dos
/// espacios de coordenadas: la lectura no es utilizable.
pub fn rooted_origin(x: i32, y: i32, ok: bool) -> Option<(i32, i32)> {
    if ok {
        Some((x, y))
    } else {
        None
    }
}

/// Píxeles físicos que representa un tamaño lógico de GTK.
pub fn to_physical(logical: i32, scale: f64) -> i32 {
    (logical as f64 * scale).round() as i32
}

/// True cuando el tamaño concedido coincide con el pedido.
pub fn size_matches(requested: (i32, i32), granted: (i32, i32)) -> bool {
    matches_pair(requested, granted)
}

/// True cuando la posición concedida coincide con la pedida.
pub fn position_matches(requested: (i32, i32), granted: (i32, i32)) -> bool {
    matches_pair(requested, granted)
}

fn matches_pair(requested: (i32, i32), granted: (i32, i32)) -> bool {
    (requested.0 - granted.0).abs() <= TOLERANCE && (requested.1 - granted.1).abs() <= TOLERANCE
}

/// La posición que conserva el borde anclado con el tamaño efectivo: si el
/// gestor concede otra altura, el borde derecho o inferior no se despega.
pub fn anchored_position(placement: &Placement, size: (i32, i32)) -> (i32, i32) {
    match placement.anchor {
        Anchor::Top | Anchor::Left => (placement.bounds.x, placement.bounds.y),
        Anchor::Bottom => (
            placement.bounds.x,
            placement.bounds.y + placement.bounds.h as i32 - size.1,
        ),
        Anchor::Right => (
            placement.bounds.x + placement.bounds.w as i32 - size.0,
            placement.bounds.y,
        ),
    }
}

/// Corre el ciclo: tamaño (con el permiso de resize abierto **sólo** durante
/// el resize) → posición → read-back → recolocar → read-back final (el tamaño
/// **y** la posición). Las lecturas están acotadas y una colocación posterior
/// detiene el ciclo.
pub async fn drive<S: Surface>(
    surface: &mut S,
    placement: &Placement,
    mut superseded: impl FnMut() -> bool,
) -> Report {
    let wanted = (placement.bounds.w as i32, placement.bounds.h as i32);
    // El tamaño se pide primero: si la ventana todavía no está visible, el
    // gestor la coloca así al mapearla (sin el destello del tamaño por
    // defecto). El cancelador se comprueba **antes** de cada fase nativa: una
    // colocación posterior (o un arrastre) no debe dejar la ventana movida a
    // medias.
    if superseded() {
        return superseded_report();
    }
    if !request_size_checked(surface, wanted).await {
        // La llamada nativa no se pudo confirmar: el ciclo no sigue como si el
        // tamaño se hubiera aplicado.
        return failed_report(Reason::ReadFailed);
    }
    let wanted_position = anchored_position(placement, wanted);
    if superseded() {
        release_size(surface, &mut superseded).await;
        return superseded_report();
    }
    if !request_position_checked(surface, wanted_position).await {
        release_size(surface, &mut superseded).await;
        return failed_report(Reason::ReadFailed);
    }

    // El read-back sólo vale con la ventana visible y colocada por el
    // gestor: es lo que prueba que el compositor concedió la geometría.
    let mut effective = match read_until(surface, wanted).await {
        Ok(effective) => effective,
        Err(reason) => {
            release_size(surface, &mut superseded).await;
            return failed_report(reason);
        }
    };
    if !size_matches(wanted, effective.size) {
        // El compositor todavía no ha concedido el tamaño pedido: se le pide
        // otra vez (las pistas siguen siendo las **pedidas**: nunca se
        // sustituyen por un tamaño que el usuario no pidió).
        if superseded() {
            release_size(surface, &mut superseded).await;
            return superseded_report();
        }
        if !request_size_checked(surface, wanted).await {
            release_size(surface, &mut superseded).await;
            return failed_report(Reason::ReadFailed);
        }
        effective = match read_until(surface, wanted).await {
            Ok(effective) => effective,
            Err(reason) => {
                release_size(surface, &mut superseded).await;
                return failed_report(reason);
            }
        };
    }
    let target = anchored_position(placement, effective.size);
    if superseded() {
        release_size(surface, &mut superseded).await;
        return superseded_report();
    }
    if !request_position_checked(surface, target).await {
        release_size(surface, &mut superseded).await;
        return failed_report(Reason::ReadFailed);
    }

    // La lectura final: el tamaño **y** la posición, ya con el permiso de
    // resize retirado. Retirarlo es justo lo que hace que GTK recalcule la
    // configuración de la ventana, así que el tamaño se verifica aquí y no
    // antes: el informe dice lo que quedó en pantalla.
    let mut final_geometry = None;
    for _ in 0..READS {
        surface.settle().await;
        match surface.read_geometry().await {
            Ok(Some(geometry)) => {
                let settled = size_matches(wanted, geometry.size)
                    && position_matches(target, geometry.origin);
                final_geometry = Some(geometry);
                if settled {
                    break;
                }
            }
            Ok(None) => {}
            Err(_) => return failed_report(Reason::ReadFailed),
        }
    }
    match final_geometry {
        Some(geometry) => report_of(wanted, geometry, target),
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

/// Deja la ventana sujeta al tamaño que tiene de verdad.
///
/// Al fallar, la ventana puede haberse quedado con otro tamaño que el pedido:
/// las pistas se dejan en el que tiene (una lectura de respaldo). **No** se
/// sueltan: medido, soltar la petición de tamaño y las pistas hace que GTK
/// recalcule la configuración con el tamaño por defecto (la ventana crecía a
/// 320×260).
///
/// Sólo si esta colocación sigue vigente: una colocación posterior ya fijó
/// sus pistas y pisarlas dejaría la ventana sujeta a un tamaño viejo.
async fn release_size<S: Surface, F: FnMut() -> bool>(surface: &mut S, superseded: &mut F) {
    if superseded() {
        return;
    }
    if let Ok(Some(geometry)) = surface.read_geometry().await {
        surface
            .set_size_constraints(geometry.size.0, geometry.size.1)
            .await;
    }
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

/// Lee hasta que el gestor conceda el tamaño pedido (o se agote el presupuesto).
/// `None` (aún no visible) es reintentable; sólo un fallo real es error.
async fn read_until<S: Surface>(surface: &mut S, wanted: (i32, i32)) -> Result<Geometry, Reason> {
    let mut last: Option<Geometry> = None;
    for _ in 0..READS {
        surface.settle().await;
        match surface.read_geometry().await {
            Ok(Some(geometry)) => {
                if size_matches(wanted, geometry.size) {
                    return Ok(geometry);
                }
                last = Some(geometry);
            }
            Ok(None) => {}
            Err(_) => return Err(Reason::ReadFailed),
        }
    }
    last.ok_or(Reason::NotViewable)
}

/// Compone el informe final con la geometría que quedó en pantalla.
fn report_of(wanted: (i32, i32), effective: Geometry, target: (i32, i32)) -> Report {
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
        // tolerancia del redondeo.
        read_back: true,
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

/// Una colocación sin lectura fiable: no hay geometría que cachear.
fn failed_report(reason: Reason) -> Report {
    Report {
        status: Status::Unverified,
        bounds: None,
        reason: Some(reason),
        read_back: false,
    }
}

/// Reserva la siguiente generación: una colocación posterior cancela la pendiente.
pub fn next_generation() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Cancela la colocación pendiente (el usuario empezó a arrastrar la tira).
pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// True cuando una colocación posterior sustituyó a la `generation` dada.
pub fn superseded(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) != generation
}

/// Coloca el widget en la superficie nativa y devuelve la geometría efectiva.
#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
pub async fn place(
    window: &tauri::WebviewWindow,
    placement: Placement,
    generation: u64,
) -> Result<Report, String> {
    // Antes de tocar la superficie nativa: sólo la ventana del widget puede
    // colocarse, el rectángulo tiene que ser utilizable (no cero, acotado y
    // sin desbordamiento) y el factor de escala tiene que ser positivo y
    // finito. Vale para todos los transportes.
    let bounds = placement.validate(window.label())?;
    #[cfg(target_os = "linux")]
    {
        // GDK sólo se puede tocar en el hilo de UI: la detección del transporte
        // va allí, como todas las llamadas nativas.
        if transport_on_ui(window).await == Transport::X11 {
            let mut surface = UiSurface::new(window.clone(), placement.scale, generation).await;
            return Ok(drive(&mut surface, &placement, || superseded(generation)).await);
        }
    }
    // Sin read-back en esta plataforma: la solicitud se aplica como antes, y
    // la llamada nativa sigue en el hilo de UI.
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let ui_window = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.try_send(crate::detail_geometry::apply_widget(&ui_window, bounds));
        })
        .map_err(|e| e.to_string())?;
    rx.recv()
        .await
        .ok_or_else(|| "Widget bounds UI callback was dropped".to_string())?
        .map(|()| Report {
            status: Status::Unverified,
            bounds: None,
            reason: None,
            read_back: false,
        })
}

/// Fija las pistas de tamaño de la ventana: la **petición de tamaño** del
/// widget y las pistas `min == max`.
///
/// La petición de tamaño es lo que conserva el tamaño concedido cuando GTK
/// recalcula la configuración de la ventana (al retirar el permiso de resize):
/// medido, sin ella la ventana volvía a su tamaño por defecto. Las pistas
/// `min == max` son las que impiden al gestor ofrecer otro tamaño.
#[cfg(target_os = "linux")]
pub fn set_size_constraints<W: gtk::prelude::GtkWindowExt + gtk::prelude::WidgetExt>(
    window: &W,
    width: i32,
    height: i32,
) {
    window.set_size_request(width, height);
    let geometry = gtk::gdk::Geometry::new(
        width,
        height,
        width,
        height,
        0,
        0,
        0,
        0,
        0.0,
        0.0,
        gtk::gdk::Gravity::Center,
    );
    window.set_geometry_hints(
        None::<&gtk::Widget>,
        Some(&geometry),
        gtk::gdk::WindowHints::MIN_SIZE | gtk::gdk::WindowHints::MAX_SIZE,
    );
}

/// Fija el tamaño de la ventana nativa (#179).
///
/// Pistas iguales (`min == max == tamaño`): el gestor no puede ofrecer otro
/// tamaño y GTK recorta cualquier reconfiguración. Además, la **petición de
/// tamaño** del widget: al retirar el permiso de resize, GTK recalcula la
/// configuración con ese mínimo y el tamaño concedido se conserva (medido:
/// sin ella la ventana volvía a su tamaño por defecto). El permiso de resize
/// se activa aquí y se retira nada más terminar el resize.
#[cfg(target_os = "linux")]
pub fn fix_size<W: gtk::prelude::GtkWindowExt + gtk::prelude::WidgetExt>(
    window: &W,
    width: i32,
    height: i32,
) {
    set_size_constraints(window, width, height);
    window.set_resizable(true);
    window.resize(width, height);
}

/// Aplica el tamaño y **retira el permiso de resize en la misma llamada
/// nativa** (#179).
///
/// El permiso de resize se abre sólo para el resize programático: al
/// retirarlo, `tao` deja de ofrecer cursor de redimensionar y de arrancar un
/// arrastre de borde. La petición de tamaño del widget conserva el tamaño
/// concedido cuando GTK recalcula la configuración.
///
/// Devuelve `true` si el permiso quedó cerrado: el ciclo no puede seguir como
/// si el resize se hubiera hecho si no se puede confirmar.
#[cfg(target_os = "linux")]
pub fn apply_size<W: gtk::prelude::GtkWindowExt + gtk::prelude::WidgetExt>(
    window: &W,
    width: i32,
    height: i32,
) -> bool {
    fix_size(window, width, height);
    window.set_resizable(false);
    !window.is_resizable()
}

/// Corre una llamada nativa en el hilo de UI y espera su resultado.
#[cfg(target_os = "linux")]
async fn on_ui<T: Send + 'static>(
    window: &tauri::WebviewWindow,
    call: impl FnOnce(&gtk::ApplicationWindow) -> T + Send + 'static,
) -> Option<T> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let target = window.clone();
    let inner = window.clone();
    target
        .run_on_main_thread(move || {
            // La ventana GTK sólo se usa aquí: nunca cruza a otro hilo.
            let value = inner.gtk_window().ok().map(|gtk| call(&gtk));
            let _ = tx.try_send(value);
        })
        .ok()?;
    // La espera está acotada: una llamada nativa que no responde no puede
    // dejar la colocación esperando para siempre.
    match tokio::time::timeout(UI_TIMEOUT, rx.recv()).await {
        Ok(Some(value)) => value,
        _ => None,
    }
}

/// La superficie GTK: cada llamada nativa ocurre en el hilo de UI.
#[cfg(target_os = "linux")]
struct UiSurface {
    window: tauri::WebviewWindow,
    /// El factor con el que se calculó la petición (no el de la ventana: en DPI
    /// mixto pueden diferir).
    scale: f64,
    /// La generación de la colocación: el cierre la comprueba dentro del hilo
    /// de UI, para que una colocación posterior no mueva la ventana a medias.
    generation: u64,
    /// El último tamaño pedido (físico): sirve para saber si el tamaño
    /// efectivo ya es el pedido (nada que esperar al compositor).
    requested: (i32, i32),
}

#[cfg(target_os = "linux")]
impl UiSurface {
    async fn new(window: tauri::WebviewWindow, scale: f64, generation: u64) -> Self {
        Self {
            window,
            scale,
            generation,
            requested: (0, 0),
        }
    }
}

#[cfg(target_os = "linux")]
impl Surface for UiSurface {
    async fn request_size(&mut self, width: i32, height: i32) -> bool {
        let (w, h) = (
            to_logical(width, self.scale),
            to_logical(height, self.scale),
        );
        self.requested = (width, height);
        let generation = self.generation;
        on_ui(&self.window, move |window| {
            if superseded(generation) {
                // La colocación está caducada: no se toca la ventana (y el
                // permiso sigue cerrado).
                return true;
            }
            // La pista de tamaño, las pistas `min == max` y el resize, con el
            // permiso de resize abierto **sólo** para el resize: la misma
            // llamada lo retira y lo confirma.
            let closed = apply_size(window, w, h);
            // La confirmación: el permiso tiene que quedar cerrado.
            closed
        })
        .await
        .unwrap_or(false)
    }

    async fn request_position(&mut self, x: i32, y: i32) -> bool {
        let (x, y) = (to_logical(x, self.scale), to_logical(y, self.scale));
        let generation = self.generation;
        on_ui(&self.window, move |window| {
            // La generación se comprueba **dentro** del hilo de UI: entre la
            // comprobación y el `move_` no cabe otra colocación.
            if superseded(generation) {
                return true;
            }
            use gtk::prelude::*;
            window.move_(x, y);
            true
        })
        .await
        .unwrap_or(false)
    }

    async fn set_size_constraints(&mut self, width: i32, height: i32) -> bool {
        let (w, h) = (
            to_logical(width, self.scale),
            to_logical(height, self.scale),
        );
        let generation = self.generation;
        on_ui(&self.window, move |window| {
            // La generación se comprueba **dentro** del hilo de UI, como en el
            // tamaño y en la posición: si esta colocación está caducada, sus
            // pistas no pisan las de la colocación que la sustituyó.
            if superseded(generation) {
                return true;
            }
            // La petición de tamaño y las pistas `min == max`, sin tocar el
            // tamaño de la ventana.
            set_size_constraints(window, w, h);
            true
        })
        .await
        .unwrap_or(false)
    }

    async fn read_geometry(&mut self) -> Result<Option<Geometry>, String> {
        on_ui(&self.window, move |window| {
            use gtk::prelude::*;
            // Sin ventana GDK todavía no hay superficie que leer.
            let Some(gdk_window) = window.window() else {
                return Ok(None);
            };
            // La señal real de visibilidad: la ventana y sus ancestros están
            // mapeados.
            if !gdk_window.is_viewable() {
                return Ok(None);
            }
            // La geometría que el servidor X tiene ahora mismo, en píxeles
            // físicos del **propio** monitor de la ventana: en DPI mixto el
            // factor de la petición puede ser otro.
            let scale = window.scale_factor() as f64;
            let (_, _, gw, gh) = gdk_window.geometry();
            let size = (to_physical(gw, scale), to_physical(gh, scale));
            // El origen: `gdk_window_get_origin` da las coordenadas relativas
            // a la raíz (que es lo que se informa) y su valor de retorno dice
            // si la llamada tuvo éxito. Si falla, **no** hay origen usable:
            // el respaldo de `gdk_window_get_geometry` es relativo al padre
            // (el marco de la decoración si el gestor reparenta la ventana) y
            // mezclaría dos espacios de coordenadas.
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

/// La única lectura del display GDK del binario (issue #180, revisión del
/// mantenedor: una sola detección del backend): cacheada en `OnceLock` y
/// **sólo en el hilo de UI** — GDK no se puede tocar desde otro hilo.
/// `transport()` (colocación) y `wm_compat::get_wm_info` (Ajustes/arrastre)
/// derivan de esta misma caché para no poder discrepar.
#[cfg(target_os = "linux")]
fn display_kind() -> DisplayKind {
    static DISPLAY_KIND: std::sync::OnceLock<DisplayKind> = std::sync::OnceLock::new();
    *DISPLAY_KIND.get_or_init(|| {
        use gtk::prelude::*;
        match gtk::gdk::Display::default() {
            Some(display) => kind_from_type_name(display.type_().name()),
            None => DisplayKind::Unknown,
        }
    })
}

/// El transporte de la superficie nativa, derivado del display real (caché
/// de `display_kind`, hilo de UI): X11/XWayland o native Wayland.
#[cfg(target_os = "linux")]
fn transport() -> Transport {
    match display_kind() {
        DisplayKind::X11 => Transport::X11,
        DisplayKind::Wayland | DisplayKind::Unknown => Transport::Other,
    }
}

/// Detecta el transporte en el hilo de UI (GDK no admite otro hilo).
#[cfg(target_os = "linux")]
async fn transport_on_ui(window: &tauri::WebviewWindow) -> Transport {
    on_ui(window, |_| transport())
        .await
        .unwrap_or(Transport::Other)
}

/// Sonda del backend GDK efectivo para `wm_compat` (issue #180): la misma
/// lectura cacheada que decide la colocación, ejecutada en el hilo de UI.
/// Best-effort: sin display, tipo desconocido o hilo de UI que no responde
/// a tiempo degrada a `None` y decide el fallback por env
/// (`wm_compat::display_backend_from_env`).
#[cfg(target_os = "linux")]
pub async fn display_backend_on_ui(
    window: &tauri::WebviewWindow,
) -> Option<crate::wm_compat::DisplayBackend> {
    match on_ui(window, |_| display_kind()).await? {
        DisplayKind::X11 => Some(crate::wm_compat::DisplayBackend::X11),
        DisplayKind::Wayland => Some(crate::wm_compat::DisplayBackend::Wayland),
        DisplayKind::Unknown => None,
    }
}
