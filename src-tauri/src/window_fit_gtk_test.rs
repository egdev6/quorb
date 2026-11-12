//! El efecto real del ajuste de ventana, con GTK de verdad (#250, S18).
//!
//! Estas pruebas no usan el doble de los tests: construyen una `gtk::Window`
//! real y llaman a las **funciones de producción** (`fit_widget`,
//! `fit_detail` y `apply_type_hint` sobre `GtkFitSurface`). Así, si alguien
//! deja sin efecto `set_size_constraints` o `set_type_hint_utility`, estas
//! pruebas fallan: es la cobertura que pidió el mantenedor ("los tests
//! seguirían pasando si se eliminaran esas llamadas").
//!
//! El plan se construye a mano, como lo consume la producción: bajo X11 el
//! plan real **no** pide pistas (`size_hints()` es falso por diseño, porque en
//! X11 las manda el ciclo), así que el camino de Wayland nativo se ejercita
//! con el plan a mano.
//!
//! **Tier en vivo** (no determinista: depende de la sesión gráfica):
//! `GDK_BACKEND=x11 cargo test --locked window_fit -- --ignored`
//!
//! GTK sólo se puede usar desde el hilo que lo inicializa (`gtk::init` marca
//! ese hilo como principal y deja el contexto principal acquired en él), así
//! que todo el trabajo GTK de este módulo pasa por un único hilo: el runner
//! de tests lanza cada prueba en el suyo.

use std::panic::{self, AssertUnwindSafe};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::detail_placement::fit_detail;
use crate::widget_placement::{fit_widget, Transport};
use crate::window_fit::{
    apply_type_hint, fit_plan, FitOutcome, FitPlan, FitProfile, GtkFitSurface,
};

/// Un trabajo para el hilo que posee GTK.
type Job = Box<dyn FnOnce() + Send + 'static>;

/// El hilo que posee GTK, con su canal de trabajos.
///
/// `gtk::init` sólo se puede llamar una vez (marca el hilo como principal) y
/// deja el contexto principal acquired en él: un segundo `gtk::init` en otro
/// hilo se quedaría esperando ese contexto. Por eso hay un único hilo de GTK
/// y las pruebas le envían su trabajo.
fn gtk_worker() -> &'static Result<Sender<Job>, String> {
    static WORKER: OnceLock<Result<Sender<Job>, String>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (jobs_tx, jobs_rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("quorb-gtk".to_string())
            .spawn(move || {
                let ready = gtk::init().map_err(|e| e.to_string());
                let failed = ready.is_err();
                let _ = ready_tx.send(ready);
                if failed {
                    return;
                }
                while let Ok(job) = jobs_rx.recv() {
                    job();
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(jobs_tx),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("el hilo de GTK no arrancó".to_string()),
        }
    })
}

/// Corre el trabajo en el hilo que posee GTK y devuelve su resultado.
///
/// Un pánico dentro del trabajo se vuelve a lanzar aquí: la prueba falla con
/// su mensaje, como si hubiera corrido en este hilo.
fn on_gtk<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> T {
    let (done_tx, done_rx) = mpsc::channel();
    let worker = gtk_worker()
        .as_ref()
        .unwrap_or_else(|e| panic!("GTK no se pudo inicializar (¿falta DISPLAY?): {e}"));
    worker
        .send(Box::new(move || {
            let outcome = panic::catch_unwind(AssertUnwindSafe(job));
            let _ = done_tx.send(outcome);
        }))
        .expect("el hilo de GTK tiene que aceptar el trabajo");
    match done_rx.recv() {
        Ok(Ok(value)) => value,
        Ok(Err(payload)) => panic::resume_unwind(payload),
        Err(_) => panic!("el hilo de GTK no respondió"),
    }
}

/// El plan de Hyprland con el transporte a mano: el plan que la producción
/// consume cuando el compositor pide ajustes.
fn hyprland_plan(transport: Transport) -> FitPlan {
    fit_plan(
        FitProfile {
            wayland_size_hints: true,
            x11_float_hint: true,
        },
        transport,
    )
}

/// Espera a que GTK procese lo pendiente (el `map` de la ventana).
fn settle(ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        while gtk::events_pending() {
            let _ = gtk::main_iteration_do(false);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// La tira: la petición de tamaño real de producción llega a GTK.
///
/// Si `GtkFitSurface::set_size_constraints` o
/// `widget_placement::set_size_constraints` dejaran de llamar a
/// `set_size_request`, la ventana no pediría nada y esta prueba falla.
#[test]
#[ignore = "needs an X11 session"]
fn the_strip_really_asks_for_its_size_hints() {
    let requested = on_gtk(|| {
        use gtk::prelude::*;
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        // El plan de la ruta sin ciclo (Wayland nativo): el que pide pistas.
        let plan = hyprland_plan(Transport::Other);
        let outcome = fit_widget(&mut GtkFitSurface(&window), &plan, (61, 181), 1.0, || false);
        assert_eq!(outcome, FitOutcome::Applied, "la tira pide el ajuste");
        // La lectura real de GTK (`gtk_widget_get_size_request`): la petición
        // de producción llegó a la ventana.
        window.size_request()
    });
    assert_eq!(requested, (61, 181), "la tira pide su tamaño a GTK");
}

/// El detalle: la petición de tamaño real de producción llega a GTK.
///
/// El detalle convierte con el factor que **informa la ventana** (S13), así
/// que esta prueba necesita una sesión a escala 1 (la de X11 sin manager de
/// ventanas).
#[test]
#[ignore = "needs an X11 session"]
fn the_detail_really_asks_for_its_size_hints() {
    let requested = on_gtk(|| {
        use gtk::prelude::*;
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        assert_eq!(
            window.scale_factor(),
            1,
            "la prueba en vivo necesita una sesión a escala 1"
        );
        let plan = hyprland_plan(Transport::Other);
        let outcome = fit_detail(&mut GtkFitSurface(&window), &plan, (314, 379), || false);
        assert_eq!(outcome, FitOutcome::Applied, "el detalle pide el ajuste");
        window.size_request()
    });
    assert_eq!(requested, (314, 379), "el detalle pide su tamaño a GTK");
}

/// El tipo de ventana: `Utility` declarado **antes** del primer `show` y el
/// que el compositor lee en el momento del map.
///
/// El tipo se declara al crear la ventana (`start_main_ui`), así que la
/// ventana ya lo tiene antes de mapearse. Si se declarara después del `show`,
/// lo que el compositor leería al mapear sería `Normal`.
#[test]
#[ignore = "needs an X11 session"]
fn the_utility_type_is_declared_before_the_window_is_mapped() {
    let captured = on_gtk(|| {
        use gtk::prelude::*;
        use std::cell::Cell;
        use std::rc::Rc;
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        // El plan de X11: el tipo de ventana es de ese backend.
        let plan = hyprland_plan(Transport::X11);
        assert!(
            apply_type_hint(&mut GtkFitSurface(&window), &plan),
            "el plan de X11 pide el tipo de ventana"
        );
        assert_eq!(
            window.type_hint(),
            gtk::gdk::WindowTypeHint::Utility,
            "la ventana declara su tipo antes de mapearse"
        );
        // El momento en el que el compositor lee el tipo: el map.
        let captured = Rc::new(Cell::new(gtk::gdk::WindowTypeHint::Normal));
        let sink = Rc::clone(&captured);
        let watcher = window.clone();
        window.connect_map(move |_| sink.set(watcher.type_hint()));
        window.show();
        settle(400);
        captured.get()
    });
    assert_eq!(
        captured,
        gtk::gdk::WindowTypeHint::Utility,
        "al mapear, la ventana ya era `Utility`"
    );
}
