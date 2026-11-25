//! Atajos globales: seams por capacidad y modelo de estados (#312, slice 1).
//!
//! Acá no hay portal, ni D-Bus, ni cliente: sólo los seams por los que el
//! slice 2 enchufa la implementación real. La idea es que **la cañería no
//! cambie** cuando cambia el enchufe: el registro pasa por un trait, la
//! detección por otro, y el estado final sale de una función pura que sólo
//! consume observaciones.
//!
//! Ojo con los nombres: acá el estado de **capacidad** (¿el atajo quedó global,
//! degradado o roto?) se llama `ShortcutCapability` a propósito, porque el
//! plugin `tauri-plugin-global-shortcut` ya tiene un `ShortcutState` que es
//! otra cosa: el estado de **pulsación** (`Pressed`/`Released`).

use tauri_plugin_global_shortcut::Shortcut;

/// Seam de registro: quién reserva un atajo global.
///
/// Existe como trait y no como `impl FnMut` para que el slice 2 pueda
/// enchufar el cliente del portal sin tocar a quien decide: el registro por
/// X11 y el registro por portal implementan el mismo contrato, así que el
/// código que arma el mapa de atajos no necesita saber cuál está detrás.
pub trait ShortcutRegistrar {
    /// Reserva `shortcut` como atajo global.
    ///
    /// `Err` lleva el motivo del fallo: es el texto que Ajustes muestra
    /// (combinación inválida, atajo ya tomado por otra app, portal que
    /// rechazó el registro).
    fn register(&mut self, shortcut: &Shortcut) -> Result<(), String>;
}

/// Implementación blanket: cualquier closure con esa firma **es** un
/// registrador.
///
/// Es lo que permite que el seam exista sin obligar a escribir un tipo nuevo
/// para el caso simple: el llamador actual sigue pasando un closure y el
/// slice 2 puede pasar un `PortalRegistrar` detrás de la misma firma.
///
/// El blanket también cubre `&mut F` (cuando `F: FnMut`), porque la librería
/// estándar implementa `FnMut` para `&mut F`: por eso se puede pasar
/// `&mut closure` a una API que pida `&mut impl ShortcutRegistrar`.
///
/// Ojo con la anotación: el bound es *higher-ranked* sobre el préstamo, así
/// que un closure tiene que anotar el tipo del parámetro
/// (`&mut |sc: &Shortcut| ...`). Sin la anotación, el compilador no puede
/// derivar el closure genérico que el bound exige y lo rechaza.
impl<F: FnMut(&Shortcut) -> Result<(), String>> ShortcutRegistrar for F {
    fn register(&mut self, shortcut: &Shortcut) -> Result<(), String> {
        self(shortcut)
    }
}

/// Resultado de la sonda del portal: **tres** estados, no dos.
///
/// La distinción entre "ausente" y "desconocido" es la que permite que la UI
/// diga la verdad: "tu escritorio no soporta atajos globales" y "no pudimos
/// comprobar si los soporta" son mensajes distintos y una de las dos
/// afirmaciones sería falsa si se fundieran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// El portal de atajos está disponible.
    ///
    /// `version` es la versión de la interfaz del portal: 1 = `GlobalShortcuts`
    /// v1, 2 = v2. Ojo: **la versión no alcanza para prometer `active`** (S12):
    /// la interfaz v1 no distingue GNOME 48 de GNOME 49, que es justamente el
    /// caso que corrige `BindShortcuts`. Por eso el estado no sale de la
    /// sonda, sino de la sonda **más** la comparación del trigger.
    Present { version: u32 },
    /// No hay portal de atajos globales en esta sesión.
    Absent,
    /// No se pudo saber. Nunca significa "no lo soporta": significa "no se
    /// pudo comprobar". Un fallo de la sonda (D-Bus caído, portal colgado,
    /// timeout) es un `Unknown`, jamás un `Absent`.
    Unknown,
}

/// Seam de sonda: ¿hay portal de atajos globales en esta sesión?
///
/// La sonda real (por D-Bus) es del slice 2: ahí se resuelve también el
/// app-id que exige el portal, que no es libre en una app no sandboxed (S9):
/// el portal deduce el `app-<id>` del scope de systemd o acepta el que se le
/// pase por `org.freedesktop.host.portal.Registry.Register`, pero en ambos
/// casos exige que exista un `.desktop` con ese nombre base.
pub trait ShortcutProbe {
    /// Sondea el portal. Un fallo se traduce a `ProbeOutcome::Unknown`.
    fn probe(&mut self) -> ProbeOutcome;
}

/// Lo mínimo de la sesión gráfica que el modelo de estados necesita.
///
/// Es una observación, no una detección: quién la arma y cómo (env,
/// XWayland, WM) es asunto del slice 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    /// Sesión X11 pura: el grab sobre la ventana raíz es global, no depende
    /// del foco.
    X11,
    /// Sesión Wayland. `xwayland` dice si hay servidor X11 disponible: es lo
    /// que separa el grab degradado (vía XWayland) de la imposibilidad total.
    Wayland { xwayland: bool },
}

/// Estado de capacidad de un atajo global: qué se puede garantizar de él.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutCapability {
    /// Registrado y funcional globalmente.
    Active,
    /// El escritorio asignó otra tecla: el atajo pedido no es el que quedó
    /// asignado.
    Remapped,
    /// Degradado bajo Wayland: el grab es de XWayland y depende del **foco de
    /// teclado** (no del puntero), así que el atajo sólo responde con el foco
    /// en una app X11. KDE Plasma 6 tiene una opción de compatibilidad con
    /// apps X11 que puede cambiar ese comportamiento.
    FocusedOnly,
    /// Ningún backend puede reservarlo.
    Unavailable,
}

/// Estado derivado **más** el resultado crudo de la detección.
///
/// La detección va aparte a propósito: el estado responde "qué garantiza la
/// app", y la detección responde "qué se pudo comprobar". Con `Unknown` el
/// estado cae al mínimo garantizable por la sesión, pero la detección sigue
/// diciendo `Unknown`, así que la UI puede distinguir "no lo soporta" de "no
/// se pudo comprobar" (S10, S11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShortcutStatus {
    /// Qué se puede garantizar del atajo.
    pub state: ShortcutCapability,
    /// Resultado de la sonda, sin reinterpretar.
    pub detection: ProbeOutcome,
}

/// Deriva el estado de un atajo a partir de las observaciones. Pura: no
/// sondea ni registra nada, sólo decide.
///
/// Reglas:
/// - portal **presente**: el estado sale de la comparación del trigger real
///   contra el preferido. `Active` si coinciden, `Remapped` si difieren. La
///   sonda por sí sola no promete `active` (S12), por eso la comparación
///   entra como dato.
/// - sin portal (`Absent`) o sin poder comprobarlo (`Unknown`): sólo queda el
///   grab de X11, y ahí manda la sesión: X11 pura → `Active` (el grab sobre
///   la raíz es global), Wayland con XWayland → `FocusedOnly` (degradado, y
///   depende del **foco de teclado**, no del puntero: S11), Wayland sin X11 →
///   `Unavailable`.
///
/// `Unknown` y `Absent` producen el mismo estado, pero **no** la misma
/// detección: `Unknown` nunca se reporta como `Absent`, porque no se puede
/// afirmar que el portal no esté.
///
/// `trigger_matches_preferred` sólo tiene sentido cuando la detección es
/// `Present`: con `Absent` o `Unknown` se ignora (no hay trigger que
/// comparar). Con `Present` tiene que ser la comparación real contra el
/// trigger que devolvió el portal: el slice 2 lee el trigger antes de
/// derivar, así que nunca hay que pasar un valor inventado.
pub fn derive_shortcut_status(
    session: SessionKind,
    detection: ProbeOutcome,
    trigger_matches_preferred: bool,
) -> ShortcutStatus {
    let state = match detection {
        ProbeOutcome::Present { .. } => {
            if trigger_matches_preferred {
                ShortcutCapability::Active
            } else {
                ShortcutCapability::Remapped
            }
        }
        ProbeOutcome::Absent | ProbeOutcome::Unknown => match session {
            SessionKind::X11 => ShortcutCapability::Active,
            SessionKind::Wayland { xwayland: true } => ShortcutCapability::FocusedOnly,
            SessionKind::Wayland { xwayland: false } => ShortcutCapability::Unavailable,
        },
    };
    ShortcutStatus { state, detection }
}

/// Sondea y deriva: el punto de entrada que usará el slice 2.
///
/// La sonda va por seam (`ShortcutProbe`) para que el cliente real del portal
/// entre después sin cambiar esta lógica.
pub fn probe_shortcut_status(
    session: SessionKind,
    probe: &mut impl ShortcutProbe,
    trigger_matches_preferred: bool,
) -> ShortcutStatus {
    let detection = probe.probe();
    derive_shortcut_status(session, detection, trigger_matches_preferred)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// Registrador falso: guarda lo que se le pidió y falla si se lo exigen.
    struct FakeRegistrar {
        registered: Vec<Shortcut>,
        error: Option<String>,
    }

    impl FakeRegistrar {
        fn ok() -> Self {
            Self {
                registered: vec![],
                error: None,
            }
        }

        fn failing(motivo: &str) -> Self {
            Self {
                registered: vec![],
                error: Some(motivo.to_string()),
            }
        }
    }

    impl ShortcutRegistrar for FakeRegistrar {
        fn register(&mut self, shortcut: &Shortcut) -> Result<(), String> {
            match &self.error {
                Some(motivo) => Err(motivo.clone()),
                None => {
                    self.registered.push(*shortcut);
                    Ok(())
                }
            }
        }
    }

    /// Sonda falsa: devuelve siempre el mismo resultado.
    struct FakeProbe {
        outcome: ProbeOutcome,
    }

    impl FakeProbe {
        fn new(outcome: ProbeOutcome) -> Self {
            Self { outcome }
        }
    }

    impl ShortcutProbe for FakeProbe {
        fn probe(&mut self) -> ProbeOutcome {
            self.outcome
        }
    }

    fn atajo(texto: &str) -> Shortcut {
        Shortcut::from_str(texto).expect("combinación de prueba válida")
    }

    // --- Registro: seam y blanket -------------------------------------------

    #[test]
    fn un_closure_sirve_como_registrador() {
        let mut registrador = |_sc: &Shortcut| Ok(());
        assert!(registrador.register(&atajo("Ctrl+Alt+U")).is_ok());
    }

    /// El blanket también cubre `&mut F` (la librería estándar implementa
    /// `FnMut` para `&mut F`), así que un closure prestado sirve como
    /// registrador: es justo lo que hacen los llamadores de `compute_shortcuts`.
    #[test]
    fn un_closure_prestado_sirve_como_registrador() {
        let mut closure = |_sc: &Shortcut| Ok(());
        let mut registrador = &mut closure;
        assert!(registrador.register(&atajo("Ctrl+Alt+U")).is_ok());
    }

    #[test]
    fn el_registrador_falso_registra_lo_pedido() {
        let mut registrador = FakeRegistrar::ok();
        registrador.register(&atajo("Ctrl+Alt+U")).unwrap();
        registrador.register(&atajo("Ctrl+Alt+R")).unwrap();
        assert_eq!(registrador.registered.len(), 2);
        assert_eq!(registrador.registered[0], atajo("Ctrl+Alt+U"));
        assert_eq!(registrador.registered[1], atajo("Ctrl+Alt+R"));
    }

    #[test]
    fn el_registrador_falso_propaga_el_error() {
        let mut registrador = FakeRegistrar::failing("ya en uso");
        let error = registrador.register(&atajo("Ctrl+Alt+U")).unwrap_err();
        assert_eq!(error, "ya en uso");
        assert!(
            registrador.registered.is_empty(),
            "un registro fallido no deja atajo registrado"
        );
    }

    // --- Sonda: seam y resultado tríestado ----------------------------------

    #[test]
    fn la_sonda_falsa_devuelve_su_resultado() {
        let mut presente = FakeProbe::new(ProbeOutcome::Present { version: 2 });
        assert_eq!(presente.probe(), ProbeOutcome::Present { version: 2 });
        let mut ausente = FakeProbe::new(ProbeOutcome::Absent);
        assert_eq!(ausente.probe(), ProbeOutcome::Absent);
        let mut desconocido = FakeProbe::new(ProbeOutcome::Unknown);
        assert_eq!(desconocido.probe(), ProbeOutcome::Unknown);
    }

    #[test]
    fn la_sonda_falsa_alimenta_el_seam_publico() {
        let mut probe = FakeProbe::new(ProbeOutcome::Present { version: 1 });
        let status = probe_shortcut_status(SessionKind::X11, &mut probe, true);
        assert_eq!(status.state, ShortcutCapability::Active);
        assert_eq!(status.detection, ProbeOutcome::Present { version: 1 });
    }

    // --- Matriz de estados --------------------------------------------------

    #[test]
    fn x11_pura_sin_portal_queda_activo() {
        let status = derive_shortcut_status(SessionKind::X11, ProbeOutcome::Absent, false);
        assert_eq!(
            status.state,
            ShortcutCapability::Active,
            "el grab sobre la raíz es global en una sesión X11 pura"
        );
        assert_eq!(status.detection, ProbeOutcome::Absent);
    }

    #[test]
    fn wayland_con_xwayland_sin_portal_queda_degradado() {
        let status = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Absent,
            false,
        );
        assert_eq!(
            status.state,
            ShortcutCapability::FocusedOnly,
            "sin portal sólo queda el grab de XWayland, que depende del foco de teclado"
        );
    }

    #[test]
    fn wayland_sin_x11_sin_portal_no_puede_reservarse() {
        let status = derive_shortcut_status(
            SessionKind::Wayland { xwayland: false },
            ProbeOutcome::Absent,
            false,
        );
        assert_eq!(status.state, ShortcutCapability::Unavailable);
    }

    #[test]
    fn portal_presente_con_trigger_igual_queda_activo() {
        let status = derive_shortcut_status(
            SessionKind::Wayland { xwayland: false },
            ProbeOutcome::Present { version: 2 },
            true,
        );
        assert_eq!(
            status.state,
            ShortcutCapability::Active,
            "el portal manda: con XWayland o sin él"
        );
    }

    #[test]
    fn portal_presente_con_trigger_distinto_queda_remapeado() {
        let status = derive_shortcut_status(
            SessionKind::X11,
            ProbeOutcome::Present { version: 1 },
            false,
        );
        assert_eq!(
            status.state,
            ShortcutCapability::Remapped,
            "el escritorio asignó otra tecla"
        );
    }

    #[test]
    fn la_version_del_portal_no_promete_activo_por_si_sola() {
        // S12: la interfaz v1 no distingue GNOME 48 de 49, así que la sonda
        // sola no alcanza; hace falta la comparación del trigger.
        let v1 = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Present { version: 1 },
            false,
        );
        let v2 = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Present { version: 2 },
            false,
        );
        assert_eq!(v1.state, ShortcutCapability::Remapped);
        assert_eq!(v2.state, ShortcutCapability::Remapped);
        assert_ne!(v1.state, ShortcutCapability::Active);
    }

    // --- Desconocido no es ausente -----------------------------------------

    #[test]
    fn sonda_desconocida_nunca_se_reporta_como_ausente() {
        let status = derive_shortcut_status(SessionKind::X11, ProbeOutcome::Unknown, false);
        assert_eq!(
            status.detection,
            ProbeOutcome::Unknown,
            "no se pudo comprobar: no es lo mismo que no exista"
        );
        assert_ne!(status.detection, ProbeOutcome::Absent);
    }

    #[test]
    fn sonda_desconocida_cae_al_minimo_garantizable_por_la_sesion() {
        let x11 = derive_shortcut_status(SessionKind::X11, ProbeOutcome::Unknown, false);
        assert_eq!(
            x11.state,
            ShortcutCapability::Active,
            "el grab X11 sobre la raíz es global igual que sin sonda"
        );
        let wayland = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Unknown,
            false,
        );
        assert_eq!(wayland.state, ShortcutCapability::FocusedOnly);
        let sin_x11 = derive_shortcut_status(
            SessionKind::Wayland { xwayland: false },
            ProbeOutcome::Unknown,
            false,
        );
        assert_eq!(sin_x11.state, ShortcutCapability::Unavailable);
    }

    #[test]
    fn desconocida_y_ausente_comparten_estado_pero_no_deteccion() {
        let desconocida = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Unknown,
            false,
        );
        let ausente = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Absent,
            false,
        );
        assert_eq!(desconocida.state, ausente.state);
        assert_ne!(desconocida.detection, ausente.detection);
    }
}
