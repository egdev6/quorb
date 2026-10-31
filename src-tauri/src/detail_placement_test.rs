//! Contrato determinístico del ciclo de colocación del detalle (#215).
//!
//! El doble `Surface` modela al gestor de ventanas: la visibilidad la decide
//! el frontend, el compositor contesta tarde, el permiso de resize está
//! abierto **sólo** alrededor del resize programático dentro de la única
//! llamada de tamaño, una colocación posterior de detalle sustituye a la
//! pendiente con su propia generación, y ninguna llamada nativa se da por
//! buena sin confirmación. Las aserciones comprueban lo que el ciclo informa,
//! no sólo el orden de las llamadas.

use super::detail_placement::*;
use crate::detail_geometry::Bounds;
use crate::widget_placement::{Geometry, Reason, Status, Transport, READS};

/// Doble del gestor de ventanas: la ventana suele estar oculta cuando llegan
/// los bounds, el compositor puede rechazar el tamaño, y el permiso vive
/// sólo dentro de la llamada de tamaño.
struct Fake {
    /// (origen, tamaño) que el compositor concede una vez que la ventana es
    /// legible.
    granted: Geometry,
    /// Lecturas que todavía no ven la ventana (sigue oculta).
    hidden: usize,
    /// Lecturas hechas y settles esperados.
    reads: usize,
    settles: usize,
    /// Si la ventana es visible: esto lo decide el frontend.
    viewable: bool,
    /// Si las lecturas fallan (sin respuesta de la superficie nativa).
    fail_read: bool,
    /// Llamadas de tamaño que no se pueden confirmar (las primeras N).
    fail_calls: usize,
    /// Llamadas de posición que no se pueden confirmar (las primeras N).
    fail_position_calls: usize,
    /// Si el permiso de resize está activo.
    resizable: bool,
    /// Llamadas nativas, en orden (lecturas incluidas, así el orden es
    /// observable).
    calls: Vec<String>,
}

impl Fake {
    /// El compositor concede la geometría pedida, lecturas incluidas.
    fn granting() -> Self {
        Fake {
            granted: Geometry {
                origin: (1859, 899),
                size: (314, 379),
            },
            hidden: 0,
            reads: 0,
            settles: 0,
            viewable: true,
            fail_read: false,
            fail_calls: 0,
            fail_position_calls: 0,
            resizable: false,
            calls: Vec::new(),
        }
    }

    /// La ventana que el frontend todavía no mostró.
    fn hidden_window() -> Self {
        Fake {
            viewable: false,
            ..Fake::granting()
        }
    }

    /// Índices de «permiso abierto» y «permiso cerrado».
    fn permission_window(&self) -> (usize, usize) {
        let open = self
            .calls
            .iter()
            .position(|c| c == "permission open")
            .expect("the permission opens for the resize");
        let closed = self
            .calls
            .iter()
            .position(|c| c == "permission closed")
            .expect("the permission is withdrawn");
        (open, closed)
    }
}

impl Surface for Fake {
    async fn request_size(&mut self, width: i32, height: i32) -> bool {
        if self.fail_calls > 0 {
            self.fail_calls -= 1;
            self.calls
                .push(format!("size {width}x{height} (unconfirmed)"));
            return false;
        }
        self.calls.push(format!("size {width}x{height}"));
        // El permiso de resize se abre **sólo** para el resize programático y
        // se retira en la misma llamada: fuera de ella no hay cursor de
        // redimensionar ni arrastre de borde.
        self.calls.push("permission open".into());
        self.calls.push("permission closed".into());
        self.resizable = false;
        true
    }

    async fn request_position(&mut self, x: i32, y: i32) -> bool {
        if self.fail_position_calls > 0 {
            self.fail_position_calls -= 1;
            self.calls.push(format!("position {x},{y} (unconfirmed)"));
            return false;
        }
        self.calls.push(format!("position {x},{y}"));
        true
    }

    async fn read_geometry(&mut self) -> Result<Option<Geometry>, String> {
        self.reads += 1;
        self.calls.push(format!("read {}", self.reads));
        if self.fail_read {
            return Err("the native surface did not answer".into());
        }
        // Todavía no es visible: no es un fallo, sólo un «todavía no».
        if self.reads <= self.hidden || !self.viewable {
            return Ok(None);
        }
        Ok(Some(self.granted))
    }

    async fn settle(&mut self) {
        self.settles += 1;
    }
}

/// Los bounds pedidos: el rectángulo físico que manda el frontend (contenido
/// del panel de detalle, sin anclaje).
fn bounds() -> Bounds {
    Bounds {
        x: 1859,
        y: 899,
        w: 314,
        h: 379,
    }
}

/// Corre el ciclo con el doble: sin temporizadores, sin hilo de UI.
fn run(fake: &mut Fake, bounds: &Bounds, superseded: bool) -> Report {
    futures::executor::block_on(drive(fake, *bounds, || superseded))
}

/// Corre el ciclo con un cancelador que decide en cada fase.
fn run_with(fake: &mut Fake, bounds: &Bounds, superseded: impl FnMut() -> bool) -> Report {
    futures::executor::block_on(drive(fake, *bounds, superseded))
}

#[test]
fn the_cycle_reports_the_geometry_the_window_manager_granted() {
    let mut fake = Fake::granting();
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Applied);
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 1859,
            y: 899,
            w: 314,
            h: 379
        })
    );
    assert!(report.reason.is_none());
    // La geometría viene del compositor: el frontend sabe que admite la
    // tolerancia de redondeo.
    assert!(report.read_back, "the geometry is read-back geometry");
}

#[test]
fn the_size_permission_is_open_only_during_the_single_size_call() {
    let mut fake = Fake::granting();
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Applied);
    // El permiso se abre y se retira dentro de la misma llamada nativa:
    // entre las dos no cabe otra llamada (ni lectura ni movimiento).
    let (open, closed) = fake.permission_window();
    assert_eq!(
        closed,
        open + 1,
        "the permission lasts exactly the resize: {:?}",
        fake.calls
    );
    // Al final del ciclo no queda ningún permiso abierto, y se abrió
    // exactamente una vez.
    assert!(!fake.resizable, "the resize permission is withdrawn");
    assert_eq!(
        fake.calls
            .iter()
            .filter(|c| *c == "permission open")
            .count(),
        1,
        "a single resize with permission: {:?}",
        fake.calls
    );
}

/// Doble para `Sizable` que registra cada paso, así el orden real de la
/// composición (`size_call`) es observable sin GTK.
struct Recorder {
    calls: Vec<String>,
    resizable: bool,
}

impl Sizable for Recorder {
    fn set_constraints(&mut self, width: i32, height: i32) {
        self.calls.push(format!("constraints {width}x{height}"));
    }
    fn resize_with_permission(&mut self, width: i32, height: i32) {
        self.calls.push("permission open".into());
        self.calls.push(format!("resize {width}x{height}"));
    }
    fn close_permission(&mut self) -> bool {
        self.calls.push("permission closed".into());
        self.resizable = false;
        true
    }
}

#[test]
fn the_size_call_fixes_the_hints_before_resizing_and_closes_the_permission() {
    let mut window = Recorder {
        calls: Vec::new(),
        resizable: true,
    };
    let closed = size_call(&mut window, 314, 379);
    assert!(closed, "the permission ends closed");
    assert_eq!(
        window.calls,
        vec![
            "constraints 314x379",
            "permission open",
            "resize 314x379",
            "permission closed"
        ],
        "size request + hints min == max go before the resize: {:?}",
        window.calls
    );
    assert!(!window.resizable, "no permission left open");
}

#[test]
fn the_position_comes_after_the_size_and_the_read_back_after_the_permission() {
    let mut fake = Fake::granting();
    run(&mut fake, &bounds(), false);
    // Orden: primero la llamada de tamaño, después la posición, y ninguna
    // lectura antes de que el permiso quede cerrado (el read-back no debe
    // ocurrir con un permiso abierto).
    let size = fake
        .calls
        .iter()
        .position(|c| c.starts_with("size "))
        .expect("the size is requested");
    let position = fake
        .calls
        .iter()
        .position(|c| c.starts_with("position "))
        .expect("the position is requested");
    let (_, permission_closed) = fake.permission_window();
    let first_read = fake
        .calls
        .iter()
        .position(|c| c.starts_with("read "))
        .expect("the geometry is read back");
    assert!(size < position, "position after size: {:?}", fake.calls);
    assert!(
        permission_closed < first_read,
        "read-back after the permission closes: {:?}",
        fake.calls
    );
}

#[test]
fn a_hidden_window_with_an_exhausted_budget_reports_a_soft_unverified_reason() {
    let mut hidden = Fake::hidden_window();
    hidden.hidden = usize::MAX;
    let report = run(&mut hidden, &bounds(), false);
    // Ni un error, ni un aplicado fingido: la apertura nunca queda bloqueada
    // esperando visibilidad y nada se cachea como confirmado.
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.reason, Some(Reason::NotViewable));
    assert_eq!(report.bounds, None, "no geometry to cache");
    assert!(!report.read_back);
    // Y el presupuesto es acotado, no hay espera permanente.
    assert!(
        hidden.reads <= 2 * READS,
        "no permanent wait: {} reads",
        hidden.reads
    );
}

#[test]
fn a_not_yet_viewable_window_is_retried_within_the_budget() {
    let mut fake = Fake::granting();
    // Las primeras lecturas no ven la ventana: «todavía no», no un fallo.
    fake.hidden = 2;
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Applied);
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 1859,
            y: 899,
            w: 314,
            h: 379
        })
    );
}

#[test]
fn a_visible_window_whose_size_never_matches_reports_size_refused() {
    // La ventana es visible pero el compositor mantiene pegado el tamaño
    // viejo (p. ej. 330×379 para un panel de 314 de ancho).
    let mut fake = Fake::granting();
    fake.granted.size = (330, 379);
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Limited);
    assert_eq!(report.reason, Some(Reason::SizeRefused));
    // La geometría informada es la efectiva en pantalla, no la pedida.
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 1859,
            y: 899,
            w: 330,
            h: 379
        })
    );
    assert!(report.read_back);
}

#[test]
fn a_size_that_is_granted_but_a_position_that_is_not_is_a_position_problem() {
    let mut fake = Fake::granting();
    fake.granted.origin = (800, 425);
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Limited);
    assert_eq!(report.reason, Some(Reason::PositionRefused));
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 800,
            y: 425,
            w: 314,
            h: 379
        })
    );
}

#[test]
fn the_one_pixel_tolerance_is_reserved_for_the_read_back_geometry() {
    // La geometría del read-back se admite dentro de ±1 px (el gestor
    // redondea el tamaño lógico a píxeles de dispositivo)…
    let mut fake = Fake::granting();
    fake.granted.size = (313, 379);
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Applied);
    // …pero se informa exactamente la geometría que concedió el servidor,
    // nunca la pedida.
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 1859,
            y: 899,
            w: 313,
            h: 379
        })
    );
    // A dos píxeles ya no es el tamaño pedido.
    let mut fake = Fake::granting();
    fake.granted.size = (316, 379);
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Limited);
    assert_eq!(report.reason, Some(Reason::SizeRefused));
}

#[test]
fn a_native_call_that_cannot_be_confirmed_is_not_a_success() {
    let mut fake = Fake::granting();
    // La llamada nativa no responde (ni en el reintento): el ciclo no puede
    // seguir como si el tamaño se hubiera aplicado.
    fake.fail_calls = 2;
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.reason, Some(Reason::ReadFailed));
    assert_eq!(report.bounds, None);
    assert!(!fake.resizable, "no permission left open");
}

#[test]
fn a_native_call_is_retried_within_a_bounded_budget() {
    let mut fake = Fake::granting();
    // La primera llamada de tamaño no se confirma: el ciclo la reintenta
    // exactamente una vez y, si sale bien, la colocación sigue.
    fake.fail_calls = 1;
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Applied);
    let sizes = fake.calls.iter().filter(|c| c.starts_with("size ")).count();
    assert_eq!(sizes, 2, "one retry and nothing more: {:?}", fake.calls);
}

#[test]
fn a_later_detail_placement_supersedes_the_pending_one_with_its_own_generation() {
    // Dos generaciones reales del detalle: la posterior (otra colocación del
    // mismo panel) invalida la primera. La generación es la propia del
    // detalle, nunca toca la de la tira.
    let first = next_generation();
    let mut fake = Fake::granting();
    let mut checks = 0;
    let report = run_with(&mut fake, &bounds(), || {
        checks += 1;
        if checks == 2 {
            next_generation(); // la colocación posterior reserva su generación
        }
        superseded(first)
    });
    assert_eq!(report.status, Status::Superseded);
    assert!(superseded(first), "the first generation expired");
    assert_eq!(
        report.bounds, None,
        "no geometry is reported post-cancellation"
    );
    // La colocación sustituida se detiene antes de la siguiente fase nativa:
    // nunca vuelve a mover la ventana.
    assert!(
        !fake.calls.iter().any(|c| c.starts_with("position")),
        "no move after supersession: {:?}",
        fake.calls
    );
}

#[test]
fn an_earlier_placement_cannot_touch_the_window_after_a_later_one_took_over() {
    // El relevo llega después de la fase de tamaño: el ciclo anterior no debe
    // redimensionar, mover ni pisar nada de lo que el sucesor acaba de
    // colocar.
    let first = next_generation();
    let mut fake = Fake::granting();
    let mut checks = 0;
    let mut took_over = false;
    let report = run_with(&mut fake, &bounds(), || {
        checks += 1;
        if checks > 2 && !took_over {
            took_over = true;
            next_generation(); // arranca el sucesor
        }
        superseded(first)
    });
    assert_eq!(report.status, Status::Superseded);
    // El relevo llega mientras el ciclo anterior está entre fases: ya había
    // redimensionado y movido la ventana, pero no debe informar la geometría
    // (el sucesor está a punto de reemplazarla) ni volver a tocar la ventana.
    assert_eq!(
        fake.calls
            .iter()
            .filter(|c| c.starts_with("size ") || c.starts_with("position "))
            .count(),
        2,
        "the size and move already happened, and nothing more: {:?}",
        fake.calls
    );
    assert_eq!(report.bounds, None);
}

#[test]
fn a_superseded_placement_leaves_no_resize_permission_open() {
    let mut fake = Fake::granting();
    let mut checks = 0;
    let report = run_with(&mut fake, &bounds(), || {
        checks += 1;
        checks > 1
    });
    assert_eq!(report.status, Status::Superseded);
    // Ni una colocación cancelada deja el permiso abierto: se abre y se
    // retira dentro de la misma llamada de tamaño.
    assert!(!fake.resizable, "the permission is withdrawn");
    assert_eq!(
        fake.calls
            .iter()
            .filter(|c| *c == "permission open")
            .count(),
        1,
        "the permission opened only for the size call: {:?}",
        fake.calls
    );
}

#[test]
fn a_failed_read_is_not_reported_as_a_geometry() {
    let mut fake = Fake::granting();
    fake.fail_read = true;
    let report = run(&mut fake, &bounds(), false);
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.reason, Some(Reason::ReadFailed));
    assert_eq!(report.bounds, None, "no read-back, no geometry to cache");
    assert!(!report.read_back);
}

#[test]
fn a_non_x11_display_keeps_the_apply_only_unverified_path() {
    // S1: sólo X11/XWayland toma el ciclo; Wayland nativo (y cualquier otra
    // cosa) conserva el viejo comportamiento de aplicar e informar
    // unverified.
    assert_eq!(
        route_of(Transport::X11),
        Route::X11Cycle,
        "X11/XWayland: the size cycle with read-back"
    );
    assert_eq!(
        route_of(Transport::Other),
        Route::UnverifiedPath,
        "native Wayland: no anchoring, no read-back"
    );
}

#[test]
fn the_unverified_report_carries_no_geometry_and_no_reason() {
    // No X11 (y el oculto ilegible) sólo confirman que la petición se aplicó:
    // sin bounds, sin motivo, sin marca de read-back.
    let report = unverified_report();
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.bounds, None);
    assert!(report.reason.is_none());
    assert!(!report.read_back);
}

/// Prueba en vivo de la secuencia nativa de tamaño con un webview real (#215).
/// No determinística:
/// `GDK_BACKEND=x11 cargo test --locked detail_placement -- --ignored`.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "necesita una sesión X11"]
fn the_native_size_call_grants_the_size_and_leaves_no_permission_open() {
    use gtk::prelude::*;
    use webkit2gtk::WebViewExt;
    gtk::init().expect("GTK must initialise");
    // Mismas condiciones de nacimiento que la ventana de detalle: sin
    // decoraciones, sin redimensionar y con un tamaño por defecto mayor que
    // el contenido (el bug del PMinSize pegado).
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_decorated(false);
    window.set_resizable(false);
    window.set_default_size(330, 260);
    let view = webkit2gtk::WebView::new();
    view.load_html(
        "<html><body style='margin:0'><div style='width:314px;height:379px'></div></body></html>",
        None,
    );
    window.add(&view);
    settle(700);
    assert_ne!(
        window.size(),
        (314, 379),
        "the window starts at its default size"
    );

    // La visibilidad es del frontend: la ventana se muestra antes de que se
    // coloquen los bounds.
    window.show_all();
    settle(700);
    assert!(window.is_mapped(), "the window is visible");

    // La única llamada de tamaño de producción: primero las pistas, el
    // permiso de resize abierto sólo alrededor del resize, cerrado en la
    // misma llamada.
    let closed = size_call(&mut GtkSizable(&window), 314, 379);
    assert!(closed, "the resize permission ends closed");
    settle(600);
    assert_eq!(window.size(), (314, 379), "the size is granted exact");
    assert!(!window.is_resizable(), "the permission stays closed");

    // La posición es explícita después del ciclo de tamaño: sin anclaje, sin
    // resize. Dentro del área útil: con una posición fuera de pantalla el
    // gestor la reubica para que la ventana quepa y la petición no se
    // reflejaría tal cual.
    window.move_(100, 100);
    settle(400);
    assert_eq!(window.position(), (100, 100), "the position is applied");

    // El tamaño concedido sobrevive a la retirada del permiso.
    settle(700);
    assert_eq!(
        window.size(),
        (314, 379),
        "the size survives the permission withdrawal"
    );
    assert_eq!(window.position(), (100, 100));
}

/// Le hace a GTK procesar eventos (la respuesta del gestor) durante `ms`.
#[cfg(target_os = "linux")]
fn settle(ms: u64) {
    let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    while std::time::Instant::now() < until {
        while gtk::events_pending() {
            let _ = gtk::main_iteration_do(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}
