//! Contrato determinista del ciclo de colocación nativa (#179).
//!
//! El doble de `Surface` modela al gestor de ventanas: **la visibilidad la
//! decide el frontend** (el backend nunca mapea la ventana), el compositor
//! responde tarde, el permiso de resize se abre **sólo** alrededor del resize
//! programático y ninguna llamada nativa se da por buena sin confirmar. Las
//! aserciones miran el resultado del ciclo, no sólo el orden de las llamadas.

use super::widget_placement::*;
use crate::detail_geometry::Bounds;

/// Gestor de ventanas simulado: la visibilidad es del frontend, el compositor
/// responde tarde y el permiso de resize sólo vive durante el resize.
struct Fake {
    /// (origen, tamaño) que concede el gestor una vez colocada la ventana.
    granted: Geometry,
    /// (origen, tamaño) que la ventana conserva mientras el gestor calla.
    pending: Geometry,
    /// Lecturas que el gestor necesita antes de conceder la geometría.
    delay: usize,
    /// Lecturas que aún no ven la ventana (todavía no visible).
    hidden: usize,
    /// Lecturas hechas y estabilizaciones esperadas.
    reads: usize,
    settles: usize,
    /// Si la ventana es visible: lo decide el frontend, no el backend.
    viewable: bool,
    /// Si la lectura falla (no hay respuesta de la superficie nativa).
    fail_read: bool,
    /// Llamadas nativas que no se pueden confirmar (las primeras N).
    fail_calls: usize,
    /// Llamadas de posición que no se pueden confirmar (las primeras N).
    fail_position_calls: usize,
    /// El tamaño en efecto **después** de un número de lecturas: el
    /// compositor puede cambiar el tamaño más tarde (su respuesta llega
    /// asíncrona), y el informe tiene que reflejar lo que quedó en pantalla.
    size_after_reads: Option<(usize, (i32, i32))>,
    /// Las pistas que ya fijó la colocación sucesora (la que cancela a
    /// esta): se aplican en la primera lectura, como en la carrera real (la
    /// sucesora escribe sus pistas antes de que la cancelada suelte el
    /// tamaño).
    successor_constraints: Option<(i32, i32)>,
    /// Si el permiso de resize está activo.
    resizable: bool,
    /// Llamadas nativas, en orden.
    calls: Vec<String>,
}

impl Fake {
    /// El gestor concede la geometría pedida, tras una lectura.
    fn granting() -> Self {
        Fake {
            granted: Geometry {
                origin: (1859, 899),
                size: (61, 181),
            },
            pending: Geometry {
                origin: (800, 425),
                size: (320, 260),
            },
            delay: 1,
            hidden: 0,
            reads: 0,
            settles: 0,
            viewable: true,
            fail_read: false,
            fail_calls: 0,
            fail_position_calls: 0,
            size_after_reads: None,
            successor_constraints: None,
            resizable: false,
            calls: Vec::new(),
        }
    }

    /// El gestor nunca concede la geometría: conserva la anterior.
    fn refusing() -> Self {
        Fake {
            delay: usize::MAX,
            ..Fake::granting()
        }
    }

    /// La ventana que el frontend todavía no ha mostrado.
    fn hidden_window() -> Self {
        Fake {
            viewable: false,
            ..Fake::granting()
        }
    }

    /// El índice de la llamada "permission open" y el de "permission closed".
    fn permission_window(&self) -> (usize, usize) {
        let open = self
            .calls
            .iter()
            .position(|c| c == "permission open")
            .expect("el permiso se abre para el resize");
        let closed = self
            .calls
            .iter()
            .position(|c| c == "permission closed")
            .expect("el permiso se retira");
        (open, closed)
    }
}

impl Surface for Fake {
    async fn request_size(&mut self, width: i32, height: i32) -> bool {
        if self.fail_calls > 0 {
            self.fail_calls -= 1;
            self.calls
                .push(format!("size {width}x{height} (sin confirmar)"));
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
            self.calls.push(format!("position {x},{y} (sin confirmar)"));
            return false;
        }
        self.calls.push(format!("position {x},{y}"));
        true
    }

    async fn set_size_constraints(&mut self, width: i32, height: i32) -> bool {
        self.calls.push(format!("constraints {width}x{height}"));
        true
    }

    async fn read_geometry(&mut self) -> Result<Option<Geometry>, String> {
        self.reads += 1;
        if self.fail_read {
            return Err("the native surface did not answer".into());
        }
        // Todavía no visible: no es un fallo, es "todavía no".
        if self.reads <= self.hidden {
            return Ok(None);
        }
        // Sin visibilidad no hay prueba del compositor: la geometría no se lee.
        if !self.viewable {
            return Ok(None);
        }
        // La colocación sucesora ya fijó sus pistas: la cancelada no puede
        // pisarlas con una lectura vieja.
        if let Some((w, h)) = self.successor_constraints.take() {
            self.calls.push(format!("constraints {w}x{h}"));
        }
        let geometry = if self.reads > self.delay {
            self.granted
        } else {
            self.pending
        };
        // El compositor puede cambiar el tamaño más tarde (su respuesta llega
        // asíncrona): el informe tiene que reflejar lo que quedó en pantalla.
        let geometry = match self.size_after_reads {
            Some((after, size)) if self.reads >= after => Geometry {
                origin: geometry.origin,
                size,
            },
            _ => geometry,
        };
        Ok(Some(geometry))
    }

    async fn settle(&mut self) {
        self.settles += 1;
    }
}

fn placement(anchor: Anchor) -> Placement {
    Placement {
        bounds: Bounds {
            x: 1859,
            y: 899,
            w: 61,
            h: 181,
        },
        anchor,
        scale: 1.0,
    }
}

/// Corre el ciclo con el doble: sin temporizadores, sin hilo de UI.
fn run(fake: &mut Fake, placement: &Placement, superseded: bool) -> Report {
    futures::executor::block_on(drive(fake, placement, || superseded))
}

/// Corre el ciclo con un cancelador que decide en cada fase.
fn run_with(fake: &mut Fake, placement: &Placement, superseded: impl FnMut() -> bool) -> Report {
    futures::executor::block_on(drive(fake, placement, superseded))
}

#[test]
fn the_cycle_reports_the_geometry_the_window_manager_granted() {
    let mut fake = Fake::granting();
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Applied);
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 1859,
            y: 899,
            w: 61,
            h: 181
        })
    );
    assert!(report.reason.is_none());
    // La geometría viene del compositor: el frontend sabe que admite la
    // tolerancia del redondeo.
    assert!(report.read_back, "la geometría es del read-back");
}

#[test]
fn the_resize_permission_is_open_only_while_the_programmatic_resize_runs() {
    let mut fake = Fake::granting();
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Applied);
    // El permiso se abre y se retira dentro de la misma llamada nativa: entre
    // las dos no cabe ninguna otra llamada (ni una lectura, ni un movimiento).
    let (open, closed) = fake.permission_window();
    assert_eq!(
        closed,
        open + 1,
        "el permiso dura lo que el resize: {:?}",
        fake.calls
    );
    // Y al final del ciclo no queda permiso abierto.
    assert!(!fake.resizable, "el permiso de resize se retira");
    // El permiso se abre una sola vez por ciclo.
    assert_eq!(
        fake.calls
            .iter()
            .filter(|c| *c == "permission open")
            .count(),
        1,
        "un solo resize con permiso: {:?}",
        fake.calls
    );
}

#[test]
fn the_final_read_back_verifies_the_size_after_the_withdrawal() {
    let mut fake = Fake::granting();
    fake.delay = 0;
    // El compositor cambia el tamaño **después** de la lectura intermedia (su
    // respuesta es asíncrona): el informe tiene que decir el tamaño que quedó
    // en pantalla, no el de antes.
    fake.size_after_reads = Some((2, (320, 260)));
    let report = run(&mut fake, &placement(Anchor::Right), false);
    // Si el tamaño ya no es el concedido, la colocación es una limitación, no
    // `applied`.
    assert_eq!(report.status, Status::Limited);
    assert_eq!(report.reason, Some(Reason::SizeRefused));
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 1859,
            y: 899,
            w: 320,
            h: 260
        }),
        "el tamaño del informe es el que quedó en pantalla"
    );
}

#[test]
fn a_native_call_that_cannot_be_confirmed_is_not_a_success() {
    let mut fake = Fake::granting();
    // La llamada nativa no responde (ni al reintento): el ciclo no puede
    // seguir como si el tamaño se hubiera aplicado.
    fake.fail_calls = 2;
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_ne!(report.status, Status::Applied);
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.reason, Some(Reason::ReadFailed));
    assert_eq!(report.bounds, None);
}

#[test]
fn a_native_call_is_retried_within_a_bounded_budget() {
    let mut fake = Fake::granting();
    // La primera llamada no se confirma: el ciclo la reintenta (una sola vez)
    // y si va bien, la colocación sigue.
    fake.fail_calls = 1;
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Applied);
    let sizes = fake.calls.iter().filter(|c| c.starts_with("size ")).count();
    assert_eq!(sizes, 2, "un reintento y nada más: {:?}", fake.calls);
}

#[test]
fn the_backend_never_shows_the_window() {
    let mut fake = Fake::granting();
    run(&mut fake, &placement(Anchor::Right), false);
    // La visibilidad es del frontend: el backend no mapea ni muestra nada.
    assert!(
        !fake
            .calls
            .iter()
            .any(|c| c.contains("map") || c.contains("show")),
        "el backend no muestra la ventana: {:?}",
        fake.calls
    );
}

#[test]
fn a_window_that_is_not_viewable_yet_is_retried_and_not_a_failure() {
    let mut fake = Fake::granting();
    // Las dos primeras lecturas no ven la ventana: no es un error, es "todavía
    // no" y el ciclo tiene que sobrevivir dentro de su presupuesto.
    fake.hidden = 2;
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Applied);
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 1859,
            y: 899,
            w: 61,
            h: 181
        })
    );

    // Si la ventana no llega a verse dentro del presupuesto, tampoco es un
    // fallo de lectura: se informa como tal y no se cachea geometría.
    let mut hidden = Fake::hidden_window();
    hidden.hidden = usize::MAX;
    let report = run(&mut hidden, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.reason, Some(Reason::NotViewable));
    assert_eq!(report.bounds, None);
}

#[test]
fn a_visible_window_whose_size_never_matches_is_a_size_problem_not_a_visibility_one() {
    // La ventana se ve pero el gestor no concede el tamaño: el motivo es el
    // tamaño, no «la ventana todavía no es visible».
    let mut fake = Fake::refusing();
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Limited);
    assert_eq!(report.reason, Some(Reason::SizeRefused));
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 800,
            y: 425,
            w: 320,
            h: 260
        })
    );
}

#[test]
fn a_size_the_window_manager_clamps_is_a_limitation_and_not_the_request() {
    let mut fake = Fake::refusing();
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Limited);
    assert_eq!(report.reason, Some(Reason::SizeRefused));
    // La geometría que se informa es la que quedó en pantalla, no la pedida.
    assert_eq!(
        report.bounds,
        Some(Bounds {
            x: 800,
            y: 425,
            w: 320,
            h: 260
        })
    );
}

#[test]
fn the_cycle_stops_reading_after_its_budget() {
    let mut fake = Fake::refusing();
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert!(fake.reads <= 6 * READS, "reads: {}", fake.reads);
    assert!(fake.settles <= 6 * READS, "sin recuperación permanente");
    assert_eq!(report.status, Status::Limited);
}

#[test]
fn an_already_sized_surface_is_not_positioned_after_a_cancellation() {
    let mut fake = Fake::granting();
    // El tamaño ya es el pedido: el ciclo no entra en la espera.
    fake.granted.size = (61, 181);
    fake.pending.size = (61, 181);
    fake.delay = 0;
    // La cancelación llega después de la fase de tamaño: la posición tampoco
    // se pide (el cancelador se comprueba antes de cada fase nativa).
    let mut checks = 0;
    let report = run_with(&mut fake, &placement(Anchor::Right), || {
        checks += 1;
        checks > 1
    });
    assert_eq!(report.status, Status::Superseded);
    assert!(
        !fake.calls.iter().any(|c| c.starts_with("position")),
        "no se mueve la ventana después de cancelar: {:?}",
        fake.calls
    );
    // Una colocación cancelada no informa geometría: quedó a medias.
    assert_eq!(report.bounds, None);
}

#[test]
fn the_limited_path_does_not_move_the_window_after_a_cancellation() {
    let mut fake = Fake::refusing();
    // El cancelador pasa a true tras el primer read_until: en el camino
    // limitado tampoco se piden tamaño ni posición.
    let mut checks = 0;
    let report = run_with(&mut fake, &placement(Anchor::Right), || {
        checks += 1;
        checks > 2
    });
    assert_eq!(report.status, Status::Superseded);
    let after = fake
        .calls
        .iter()
        .position(|c| c.starts_with("position"))
        .expect("la ventana se mueve");
    let native_after: Vec<&String> = fake.calls[after + 1..]
        .iter()
        .filter(|c| c.starts_with("size") || c.starts_with("position"))
        .collect();
    assert!(
        native_after.is_empty(),
        "sin fases nativas tras cancelar: {native_after:?}"
    );
}

#[test]
fn a_cancelled_placement_leaves_no_resize_permission_open() {
    let mut fake = Fake::granting();
    let mut checks = 0;
    let report = run_with(&mut fake, &placement(Anchor::Right), || {
        checks += 1;
        checks > 1
    });
    assert_eq!(report.status, Status::Superseded);
    // Aunque la colocación se cancele, el permiso de resize no queda abierto:
    // se abre y se retira dentro de la misma llamada.
    assert!(!fake.resizable, "el permiso se retira");
}

#[test]
fn a_failed_placement_leaves_the_window_in_its_real_size() {
    // La llamada nativa no se pudo confirmar: la colocación termina, pero la
    // ventana no puede quedar sujeta a un tamaño que ya no tiene: las pistas
    // se dejan en el que tiene de verdad (no se sueltan: medido, soltar la
    // petición de tamaño hace que la ventana vuelva a su tamaño por defecto).
    let mut fake = Fake::granting();
    // La llamada de posición no se puede confirmar (ni al reintento).
    fake.fail_position_calls = 2;
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.reason, Some(Reason::ReadFailed));
    let constraints: Vec<&String> = fake
        .calls
        .iter()
        .filter(|c| c.starts_with("constraints "))
        .collect();
    assert_eq!(
        constraints,
        vec!["constraints 320x260"],
        "las pistas quedan en el tamaño real: {:?}",
        fake.calls
    );
}

#[test]
fn a_superseded_placement_cannot_overwrite_the_successor_constraints() {
    // La carrera real: la colocación sucesora fija sus pistas y cancela a
    // esta. Al soltar el tamaño, la cancelada no puede pisarlas con una
    // lectura vieja: dejarían la ventana sujeta a un tamaño que ya no tiene.
    let mut fake = Fake::refusing();
    // El compositor no concede el tamaño pedido: la ventana conserva el suyo.
    // Las pistas de la sucesora son otras (otra medida de la tira).
    fake.successor_constraints = Some((120, 181));
    let first = next_generation();
    let mut checks = 0;
    let mut started = false;
    let report = run_with(&mut fake, &placement(Anchor::Right), || {
        checks += 1;
        if checks > 2 && !started {
            started = true;
            next_generation(); // la sucesora empieza: cancela a esta
        }
        superseded(first)
    });
    assert_eq!(report.status, Status::Superseded);
    // Las pistas son las de la sucesora: la cancelada no escribe ninguna.
    let constraints: Vec<&String> = fake
        .calls
        .iter()
        .filter(|c| c.starts_with("constraints "))
        .collect();
    assert_eq!(
        constraints,
        vec!["constraints 120x181"],
        "una colocación caducada no pisa las pistas de la sucesora: {:?}",
        fake.calls
    );
}

#[test]
fn a_failed_read_is_not_reported_as_a_zero_sized_geometry() {
    let mut fake = Fake::granting();
    fake.fail_read = true;
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Unverified);
    assert_eq!(report.reason, Some(Reason::ReadFailed));
    // Sin read-back no hay geometría que cachear como origen del arrastre.
    assert_eq!(report.bounds, None);
    assert!(!fake.calls.iter().any(|c| c.starts_with("size 0")));
}

#[test]
fn the_anchored_edge_survives_a_different_granted_size() {
    let mut fake = Fake::granting();
    // El gestor concede otra anchura: el borde derecho no debe despegarse.
    fake.granted = Geometry {
        origin: (1680, 899),
        size: (240, 181),
    };
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Limited);
    // La posición se recalcula con el tamaño efectivo: 1859 + 61 - 240 = 1680.
    assert!(
        fake.calls.iter().any(|c| c == "position 1680,899"),
        "la posición usa el tamaño efectivo: {:?}",
        fake.calls
    );
}

#[test]
fn each_anchor_keeps_its_edge_with_the_effective_size() {
    // El gestor concede un tamaño menor que el pedido: cada borde anclado se
    // conserva con la geometría efectiva. `Top` y `Left` comparten fórmula
    // (conservan el origen), así que se distinguen de `Bottom` y `Right`.
    for (anchor, expected) in [
        (Anchor::Top, "position 1859,899"),
        (Anchor::Bottom, "position 1859,980"),
        (Anchor::Left, "position 1859,899"),
        (Anchor::Right, "position 1880,899"),
    ] {
        let mut fake = Fake::granting();
        fake.granted = Geometry {
            origin: (1859, 899),
            size: (40, 100),
        };
        fake.pending = fake.granted;
        fake.delay = 0;
        let report = run(&mut fake, &placement(anchor), false);
        assert_eq!(report.status, Status::Limited, "{anchor:?}");
        let moves: Vec<&String> = fake
            .calls
            .iter()
            .filter(|c| c.starts_with("position"))
            .collect();
        // El primer movimiento usa el tamaño pedido; el segundo, el efectivo.
        assert_eq!(
            moves.first().map(|m| m.as_str()),
            Some("position 1859,899"),
            "{anchor:?}"
        );
        assert_eq!(
            moves.last().map(|m| m.as_str()),
            Some(expected),
            "el borde {anchor:?} se conserva: {moves:?}"
        );
    }
}

#[test]
fn a_second_generation_cancels_the_first_placement() {
    // Dos generaciones reales: la segunda (un arrastre o una colocación
    // posterior) invalida la primera. La cancelación llega **después** de la
    // lectura: el ciclo ya movió la ventana y se para antes de informarla.
    let first = next_generation();
    let second = next_generation();
    let mut fake = Fake::granting();
    let mut checks = 0;
    let report = run_with(&mut fake, &placement(Anchor::Right), || {
        checks += 1;
        checks > 2
    });
    assert_eq!(report.status, Status::Superseded);
    assert!(superseded(first), "la primera generación está caducada");
    assert!(!superseded(second), "la segunda sigue vigente");
}

#[test]
fn the_limited_path_keeps_the_requested_size_and_never_another_one() {
    let mut fake = Fake::refusing();
    let report = run(&mut fake, &placement(Anchor::Right), false);
    assert_eq!(report.status, Status::Limited);
    // Las pistas y la petición de tamaño son siempre las **pedidas**: nunca
    // se sustituyen por un tamaño que el usuario no pidió (dejarían la
    // ventana sujeta a un tamaño viejo).
    for call in fake.calls.iter().filter(|c| c.starts_with("size ")) {
        assert_eq!(call, "size 61x181", "sólo el tamaño pedido: {call}");
    }
}

#[test]
fn a_non_positive_or_non_finite_scale_is_rejected_before_any_native_call() {
    // El factor de escala convierte píxeles físicos y lógicos: con 0 (o con un
    // valor no finito) la conversión no tiene sentido (a 0 el tamaño lógico
    // sería infinito y su recorte, un tamaño de 2³¹ píxeles).
    let mut p = placement(Anchor::Right);
    for scale in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        p.scale = scale;
        let error = p
            .validate("widget")
            .expect_err("un factor no utilizable no puede colocarse");
        assert!(error.contains("scale"), "el error dice qué falla: {error}");
    }
    // Un factor utilizable pasa: la colocación sigue su curso.
    p.scale = 1.5;
    assert!(p.validate("widget").is_ok());
    // Y el rectángulo se sigue validando igual.
    p.scale = 1.0;
    p.bounds.w = 0;
    assert!(p.validate("widget").is_err());
    p.bounds.w = 61;
    assert!(p.validate("detail").is_err(), "sólo la ventana del widget");
}

#[test]
fn the_origin_comes_from_the_root_or_there_is_no_reading_at_all() {
    // La llamada a la raíz respondió: su origen es el que se informa.
    assert_eq!(rooted_origin(1859, 899, true), Some((1859, 899)));
    // Si falla, la lectura no es utilizable: el único respaldo disponible
    // (`gdk_window_get_geometry`) es relativo al padre y mezclaría dos
    // espacios de coordenadas.
    assert_eq!(rooted_origin(0, 0, false), None);
}

#[test]
fn the_display_kind_classification_matches_the_transport_one() {
    // Fuente única del backend GDK efectivo (issue #180): X11 (y XWayland),
    // Wayland nativo, y lo demás desconocido (degrada al fallback por env).
    assert_eq!(kind_from_type_name("GdkX11Display"), DisplayKind::X11);
    assert_eq!(
        kind_from_type_name("GdkWaylandDisplay"),
        DisplayKind::Wayland
    );
    assert_eq!(
        kind_from_type_name("GdkBroadwayDisplay"),
        DisplayKind::Unknown
    );
    assert_eq!(kind_from_type_name(""), DisplayKind::Unknown);
}

#[test]
fn the_transport_comes_from_the_real_gdk_display_type() {
    assert_eq!(transport_from_type_name("GdkX11Display"), Transport::X11);
    assert_eq!(
        transport_from_type_name("GdkWaylandDisplay"),
        Transport::Other
    );
    assert_eq!(
        transport_from_type_name("GdkBroadwayDisplay"),
        Transport::Other
    );
    assert_eq!(transport_from_type_name(""), Transport::Other);
}

#[test]
fn the_size_tolerance_absorbs_the_window_manager_rounding() {
    assert!(size_matches((61, 181), (61, 181)));
    assert!(size_matches((61, 181), (62, 181)));
    assert!(size_matches((61, 181), (60, 180)));
    assert!(!size_matches((61, 181), (63, 181)));
    assert!(!size_matches((61, 181), (61, 183)));
    assert!(!size_matches((61, 181), (240, 181)));
}

#[test]
fn only_the_widget_window_may_place_its_own_bounds() {
    let ok = Bounds {
        x: 10,
        y: 20,
        w: 61,
        h: 181,
    };
    assert!(ok.validate_widget("widget").is_ok());
    // Sólo la ventana del widget puede colocarse.
    for label in ["detail", "settings", "overlay", ""] {
        assert!(ok.validate_widget(label).is_err(), "label: {label}");
    }
    // Y el rectángulo tiene que ser utilizable.
    assert!(Bounds { w: 0, ..ok }.validate_widget("widget").is_err());
    assert!(Bounds { h: 0, ..ok }.validate_widget("widget").is_err());
    assert!(Bounds { w: 1_000_001, ..ok }
        .validate_widget("widget")
        .is_err());
    assert!(Bounds { h: 1_000_001, ..ok }
        .validate_widget("widget")
        .is_err());
    assert!(Bounds { x: i32::MAX, ..ok }
        .validate_widget("widget")
        .is_err());
    assert!(Bounds { y: i32::MAX, ..ok }
        .validate_widget("widget")
        .is_err());
    assert!(Bounds {
        x: -1920,
        y: -100,
        ..ok
    }
    .validate_widget("widget")
    .is_ok());
}

#[test]
fn the_scale_conversion_uses_the_factor_the_request_was_computed_with() {
    // A escala 1 el round-trip es exacto; a 1,5 y 2 el gestor redondea al
    // píxel de dispositivo, así que el error físico es de 1 px como mucho.
    for scale in [1.0, 1.5, 2.0] {
        for physical in [61, 91, 181, 362] {
            let logical = to_logical(physical, scale);
            let back = to_physical(logical, scale);
            assert!(
                (back - physical).abs() <= 1,
                "scale {scale}: {physical} -> {logical} -> {back}"
            );
        }
    }
    // A escala 1,5 el tamaño físico pedido puede no existir: 91 px es 60,67
    // lógicos y el gestor concede 92 px físicos.
    assert_eq!(to_logical(91, 1.5), 61);
    assert_eq!(to_physical(61, 1.5), 92);
    // En DPI mixto manda el factor de la petición, no el de la ventana.
    let placement = Placement {
        bounds: Bounds {
            x: 0,
            y: 0,
            w: 100,
            h: 100,
        },
        anchor: Anchor::Top,
        scale: 1.25,
    };
    assert_eq!(to_logical(placement.bounds.w as i32, placement.scale), 80);
    assert_eq!(to_physical(80, placement.scale), 100);
}

#[test]
fn the_placement_payload_deserializes_with_its_bounds_anchor_and_scale() {
    // El payload es el que manda el frontend: rectángulo, borde anclado y el
    // factor con el que se calculó.
    let payload = r#"{"x":1859,"y":899,"w":61,"h":181,"anchor":"right","scale":1.5}"#;
    let placement: Placement = serde_json::from_str(payload).expect("the payload must deserialize");
    assert_eq!(
        placement.bounds,
        Bounds {
            x: 1859,
            y: 899,
            w: 61,
            h: 181
        }
    );
    assert_eq!(placement.anchor, Anchor::Right);
    assert_eq!(placement.scale, 1.5);
    // Y sin factor no hay colocación: la conversión necesita el factor con el
    // que se calculó el rectángulo.
    let without_scale = r#"{"x":1859,"y":899,"w":61,"h":181,"anchor":"right"}"#;
    assert!(serde_json::from_str::<Placement>(without_scale).is_err());
}

#[test]
fn the_report_travels_with_the_effective_geometry_and_its_reason_code() {
    let applied = Report {
        status: Status::Applied,
        bounds: Some(Bounds {
            x: 1859,
            y: 899,
            w: 61,
            h: 181,
        }),
        reason: None,
        read_back: true,
    };
    let json = serde_json::to_value(applied).unwrap();
    assert_eq!(json["status"], "applied");
    assert_eq!(json["bounds"]["x"], 1859);
    assert_eq!(json["bounds"]["w"], 61);
    assert!(json.get("reason").is_none());
    // La marca del read-back: el frontend sólo aplica la tolerancia del
    // redondeo a la geometría que vino del compositor.
    assert_eq!(json["read_back"], true);

    let limited = Report {
        status: Status::Limited,
        bounds: Some(Bounds {
            x: 0,
            y: 0,
            w: 320,
            h: 260,
        }),
        reason: Some(Reason::SizeRefused),
        read_back: true,
    };
    let json = serde_json::to_value(limited).unwrap();
    assert_eq!(json["status"], "limited");
    // El motivo es un código, no prosa de interfaz.
    assert_eq!(json["reason"], "size_refused");

    let superseded = Report {
        status: Status::Superseded,
        bounds: None,
        reason: Some(Reason::Superseded),
        read_back: false,
    };
    let json = serde_json::to_value(superseded).unwrap();
    assert_eq!(json["status"], "superseded");
    assert_eq!(json["reason"], "superseded");
    assert!(json["bounds"].is_null());
    assert_eq!(json["read_back"], false);
}

/// Prueba en vivo de la secuencia nativa con un webview real (#179). No es
/// determinista: `GDK_BACKEND=x11 cargo test --locked widget_placement -- --ignored`.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "needs an X11 session"]
fn the_native_sequence_grants_the_size_and_leaves_no_resize_permission() {
    use gtk::prelude::*;
    use webkit2gtk::WebViewExt;
    gtk::init().expect("GTK must initialise");
    // El transporte real de esta sesión: sin display X11 no hay transporte X11.
    let display = gtk::gdk::Display::default().expect("a display");
    let name = display.type_().name().to_string();
    assert_eq!(
        crate::widget_placement::transport_from_type_name(&name),
        Transport::X11
    );

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_decorated(false);
    window.set_resizable(false);
    window.set_default_size(320, 260);
    let view = webkit2gtk::WebView::new();
    view.load_html(
        "<html><body style='margin:0'><div style='width:61px;height:181px'></div></body></html>",
        None,
    );
    window.add(&view);
    settle(700);
    assert_ne!(
        window.size(),
        (61, 181),
        "la ventana arranca con su tamaño por defecto"
    );

    // La visibilidad es del frontend: la ventana se muestra antes de colocarla.
    window.show_all();
    settle(700);
    assert!(window.is_mapped(), "la ventana está visible");

    // La secuencia de producción: la pista fija el tamaño y el permiso de
    // resize se abre **sólo** alrededor del resize programático (la misma
    // llamada lo retira).
    assert!(
        crate::widget_placement::apply_size(&window, 61, 181),
        "el permiso de resize queda cerrado"
    );
    settle(600);
    assert_eq!(window.size(), (61, 181), "el tamaño se concede exacto");
    assert!(!window.is_resizable(), "el permiso está cerrado");

    // Y la posición se aplica con el tamaño fijo puesto: las pistas iguales no
    // bloquean el movimiento.
    window.move_(1859, 899);
    settle(400);
    assert_eq!(window.position(), (1859, 899), "la posición se aplica");

    // El tamaño sigue en pie después de la retirada: es lo que la pide el
    // widget y lo que el gestor respeta.
    settle(700);
    assert_eq!(
        window.size(),
        (61, 181),
        "el tamaño sobrevive a la retirada del permiso"
    );
    assert_eq!(
        window.position(),
        (1859, 899),
        "la posición sobrevive a la retirada del permiso"
    );

    // El read-back de GDK coincide con el compositor (sonda X11 opcional).
    let gdk_window = window.window().expect("the gdk window");
    let (gx, gy, gw, gh) = gdk_window.geometry();
    assert_eq!(
        (gx, gy, gw, gh),
        (1859, 899, 61, 181),
        "el read-back de GDK"
    );
    assert!(gdk_window.is_viewable(), "la ventana es visible");
    match std::env::var("QUORB_X11_GEOMETRY_PROBE") {
        Ok(probe) => {
            let output = std::process::Command::new(&probe)
                .args(["61", "181"])
                .output()
                .expect("the X11 probe must run");
            let tree = String::from_utf8_lossy(&output.stdout);
            println!("X11 window tree (abs=posición de raíz, size=tamaño):\n{tree}");
            assert!(
                tree.contains("abs=1859,899 size=61x181"),
                "el compositor sitúa la ventana donde se pidió:\n{tree}"
            );
        }
        Err(_) => {
            println!("sin QUORB_X11_GEOMETRY_PROBE: el contraste con el compositor no se ejecuta")
        }
    }
}

/// Deja que GTK procese los eventos (la respuesta del gestor) durante `ms`.
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
