//! Atajos globales: seams por capacidad y modelo de estados (#312, slice 1).
//!
//! Este módulo no tiene portal, ni D-Bus, ni cliente: sólo los seams por los
//! que el slice 2 enchufa la implementación real. La idea es que **la canería
//! no cambie** cuando cambia la implementación: el registro pasa por un trait, la
//! detección por otro, y el estado final sale de una función pura que sólo
//! consume observaciones.
//!
//! El estado de **capacidad** (¿el atajo quedó global, degradado o roto?) se
//! llama `ShortcutCapability` a propósito, porque el plugin
//! `tauri-plugin-global-shortcut` ya tiene un `ShortcutState` que es otra cosa:
//! el estado de **pulsación** (`Pressed`/`Released`).
//!
//! Vocabulario: `global-hotkey#172` (sin mergear) nombra `trigger_description`,
//! `HotKey::with_description` y `GLOBAL_HOTKEY_APP_ID`. La versión que usa
//! `tauri-plugin-global-shortcut` hoy es `global-hotkey` 0.8, que no tiene
//! ninguno de los tres, así que en este slice no hay nada que alinear: el
//! modelo sólo anticipa la forma (`AppIdState`, `TriggerMatch`) para que el
//! slice 2 los use con esos nombres cuando elija el crate del portal.
//!
//! Los elementos que el slice 2 todavía no consume llevan `allow(dead_code)`
//! propio: no se silencia el módulo entero, para que el código muerto que se
//! agregue después siga avisando.

use tauri_plugin_global_shortcut::Shortcut;

/// Seam de registro: quién reserva un atajo global.
///
/// Existe como trait y no como `impl FnMut` para que el slice 2 pueda
/// enchufar el cliente del portal sin tocar a quien decide: el registro por
/// X11 y el registro por portal implementan el mismo contrato, así que el
/// código que arma el mapa de atajos no necesita saber cuál está detrás.
pub(crate) trait ShortcutRegistrar {
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
/// La anotación es necesaria: el bound es *higher-ranked* sobre el préstamo, así
/// que un closure tiene que anotar el tipo del parámetro
/// (`&mut |sc: &Shortcut| ...`). Sin la anotación, el compilador no puede
/// derivar el closure genérico que el bound exige y lo rechaza.
impl<F: FnMut(&Shortcut) -> Result<(), String>> ShortcutRegistrar for F {
    fn register(&mut self, shortcut: &Shortcut) -> Result<(), String> {
        self(shortcut)
    }
}

/// Estado del app-id que el portal exige para identificar la app (#312, S4).
///
/// El portal no acepta un app-id libre en una app no sandboxed: lo deduce del
/// scope de systemd (`app-<id>-*.scope`) o lo acepta por
/// `org.freedesktop.host.portal.Registry.Register`, y en los dos caminos exige
/// un `.desktop` con ese nombre base. Nombrar el resultado —en lugar de
/// colapsarlo en `Absent` o `Unknown`— evita el respaldo silencioso que se
/// descartó en #312 (#312, S11): con el portal presente pero sin app-id, la UI dice
/// "el portal no pudo identificar la app" en vez de "no hay atajos globales".
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppIdState {
    /// El portal identificó la app: por el scope de systemd o por `Register`.
    Resolved,
    /// La app no tiene app-id: no hay `.desktop` con ese nombre base (una
    /// AppImage sin instalar, por ejemplo).
    Missing,
    /// `Registry.Register` existe y rechazó el app-id.
    Rejected,
    /// El portal no ofrece `Registry` (anterior a 1.19.4; en el código desde
    /// 1.19.3) y el scope de systemd tampoco dio un id.
    RegistryUnavailable,
}

#[allow(dead_code)]
impl AppIdState {
    /// ¿El portal puede abrir sesión de atajos? Sólo con el app-id resuelto.
    pub(crate) fn is_resolved(self) -> bool {
        matches!(self, AppIdState::Resolved)
    }
}

/// Versión mínima de la interfaz del portal que expone `ConfigureShortcuts`
/// (GlobalShortcuts v2).
///
/// Es lo **único** que la v2 agrega: `trigger_description` ya viene en las
/// respuestas de `BindShortcuts` y `ListShortcuts` desde la v1
/// (`org.freedesktop.portal.GlobalShortcuts`), así que poder comparar el
/// trigger no depende de la versión del portal (#312, S14).
#[allow(dead_code)]
pub(crate) const PORTAL_VERSION_CONFIGURE: u32 = 2;

/// Resultado de la sonda del portal: **tres** estados, no dos.
///
/// La distinción entre "ausente" y "desconocido" es la que permite que la UI
/// diga la verdad: "tu escritorio no soporta atajos globales" y "no pudimos
/// comprobar si los soporta" son mensajes distintos y una de las dos
/// afirmaciones sería falsa si se fundieran.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeOutcome {
    /// El portal de atajos está disponible.
    ///
    /// `version` es la versión de la interfaz del portal: 1 = `GlobalShortcuts`
    /// v1, 2 = v2. **La versión no alcanza para prometer `active`** (#312, S7): la
    /// interfaz v1 no distingue GNOME 48 de GNOME 49, que es justamente el caso
    /// que corrige `BindShortcuts`. Por eso el estado no sale de la sonda, sino
    /// de la sonda **más** la comparación del trigger.
    ///
    /// La versión no decide si se puede comparar el trigger —eso depende de que
    /// la respuesta traiga `trigger_description`, que la v1 ya trae— sino qué
    /// funciones se pueden pedir: `ConfigureShortcuts` es lo único de la v2
    /// (#312, S14).
    ///
    /// `app_id` dice cómo se resolvió la identidad de la app (#312, S4). Con el
    /// portal presente pero el app-id sin resolver no hay sesión de atajos: el
    /// estado cae al mínimo garantizable por la sesión, pero la detección
    /// conserva el motivo, así que no se confunde con un portal ausente (#312, S11).
    Present { version: u32, app_id: AppIdState },
    /// No hay portal de atajos globales en esta sesión.
    Absent,
    /// No se pudo saber. Nunca significa "no lo soporta": significa "no se
    /// pudo comprobar". Un fallo de la sonda (D-Bus caído, portal colgado,
    /// timeout) es un `Unknown`, jamás un `Absent`.
    Unknown,
}

#[allow(dead_code)]
impl ProbeOutcome {
    /// ¿La interfaz del portal expone `ConfigureShortcuts` (GlobalShortcuts v2)?
    ///
    /// La versión del portal no decide si se puede **comparar** el trigger: eso
    /// depende de que la respuesta traiga `trigger_description`, que la v1 ya
    /// trae (#312, S14). La versión sólo decide qué funciones se pueden pedir.
    pub(crate) fn supports_configure(self) -> bool {
        matches!(
            self,
            ProbeOutcome::Present { version, .. } if version >= PORTAL_VERSION_CONFIGURE
        )
    }
}

/// Seam de sonda: ¿hay portal de atajos globales en esta sesión?
///
/// La sonda real (por D-Bus) es del slice 2: ahí se resuelve también el
/// app-id que exige el portal, que no es libre en una app no sandboxed (#312, S4):
/// el portal deduce el `app-<id>` del scope de systemd o acepta el que se le
/// pase por `org.freedesktop.host.portal.Registry.Register`, pero en ambos
/// casos exige que exista un `.desktop` con ese nombre base.
#[allow(dead_code)]
pub(crate) trait ShortcutProbe {
    /// Sondea el portal. Un fallo se traduce a `ProbeOutcome::Unknown`.
    fn probe(&mut self) -> ProbeOutcome;
}

/// Lo mínimo de la sesión gráfica que el modelo de estados necesita.
///
/// Es una observación, no una detección: quién la arma y cómo (env,
/// XWayland, WM) es asunto del slice 2.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionKind {
    /// Sesión X11 pura: el grab sobre la ventana raíz es global, no depende
    /// del foco.
    X11,
    /// Sesión Wayland. `xwayland` dice si hay servidor X11 disponible: es lo
    /// que separa el grab degradado (vía XWayland) de la imposibilidad total.
    Wayland { xwayland: bool },
}

/// Estado de capacidad de un atajo global: qué se puede garantizar de él.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShortcutCapability {
    /// Registrado y funcional globalmente.
    ///
    /// El estado no afirma que la combinación sea la preferida: eso lo dice la
    /// comparación (`TriggerMatch`), que viaja aparte en `ShortcutStatus` para
    /// que la UI no presente un trigger sin comparar como reasignación (#312, S12).
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

/// Comparación entre el trigger preferido y el que asignó el escritorio.
///
/// Tres valores y no un `bool` (#312, S12): `Unknown` —no se pudo comparar— no es un
/// "difiere", y con un `bool` ese caso terminaba en `Remapped`, afirmando una
/// reasignación que nadie comprobó. El texto del trigger real
/// (`trigger_description` en el vocabulario de `global-hotkey#172`) entra con el
/// slice 2; en este slice sólo se compara.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TriggerMatch {
    /// El escritorio asignó el trigger preferido.
    Same,
    /// El escritorio asignó otro trigger: se conoce el real y difiere.
    Different,
    /// No se pudo comparar: la respuesta del portal no trajo `trigger_description`
    /// o la lectura falló. La UI muestra el trigger que informe el escritorio sin
    /// afirmar que fue reasignado.
    ///
    /// La causa es la **respuesta**, no la versión de la interfaz:
    /// `trigger_description` viene en `BindShortcuts` y `ListShortcuts` desde la
    /// v1 (#312, S14).
    Unknown,
}

/// Estado derivado **más** las observaciones crudas que lo sostienen.
///
/// La detección y la comparación van aparte a propósito: el estado responde
/// "qué garantiza la app", la detección "qué se pudo comprobar" y la
/// comparación "qué trigger asignó el escritorio". Con `Unknown` el estado cae
/// al mínimo garantizable por la sesión, pero la detección sigue diciendo
/// `Unknown` y la comparación sigue diciendo "no se pudo comparar", así que la
/// UI puede distinguir "no lo soporta" de "no se pudo comprobar" y de "no sé
/// si reasignó" (#312, S11, S12).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShortcutStatus {
    /// Qué se puede garantizar del atajo.
    pub(crate) state: ShortcutCapability,
    /// Resultado de la sonda, sin reinterpretar.
    pub(crate) detection: ProbeOutcome,
    /// Comparación del trigger ya normalizada: es `Unknown` cuando no hay un
    /// portal utilizable (o la respuesta no trajo `trigger_description`), y es lo
    /// que permite mostrar el que asignó el escritorio sin presentarlo como
    /// reasignación.
    pub(crate) trigger: TriggerMatch,
}

/// Deriva el estado de un atajo a partir de las observaciones. Pura: no
/// sondea ni registra nada, sólo decide.
///
/// Reglas:
/// - portal **presente con el app-id resuelto**: el estado sale de la
///   comparación del trigger. `Active` si coincide, `Remapped` si difiere y
///   `Active` otra vez si no se pudo comparar: el atajo es global, pero la app
///   no puede afirmar que sea el preferido ni que se haya reasignado (#312, S12). La
///   sonda por sí sola no promete `active` (#312, S7), por eso la comparación entra
///   como dato.
/// - portal ausente (`Absent`), sin poder comprobarlo (`Unknown`) o presente
///   **sin app-id resuelto** (`Present { app_id }`, S11): sólo queda el grab de
///   X11, y ahí manda la sesión: X11 pura → `Active` (el grab sobre la raíz es
///   global), Wayland con XWayland → `FocusedOnly` (degradado, y depende del
///   **foco de teclado**, no del puntero: S6), Wayland sin X11 → `Unavailable`.
///   Los tres casos comparten estado, pero **no** detección: un app-id sin
///   resolver nunca se reporta como portal ausente.
///
/// `Unknown` y `Absent` producen el mismo estado, pero **no** la misma
/// detección: `Unknown` nunca se reporta como `Absent`, porque no se puede
/// afirmar que el portal no esté.
///
/// `trigger` sólo tiene sentido cuando la detección es `Present` con el app-id
/// resuelto: el slice 2 lo lee antes de derivar, así que nunca hay que pasar un
/// valor inventado. Sin un portal utilizable la comparación se normaliza a
/// `TriggerMatch::Unknown` y queda así en `ShortcutStatus::trigger`: un `Same`
/// que no se pudo comprobar no puede prometer el trigger preferido (#312, S7).
///
/// La versión de la interfaz **no** participa en esta regla: la comparación
/// depende de que la respuesta del portal traiga `trigger_description`, que
/// `BindShortcuts` y `ListShortcuts` ya devuelven desde la v1. Con la v1 el
/// escritorio puede haber reasignado la tecla y hay que poder decirlo
/// (#312, S14).
#[allow(dead_code)]
pub(crate) fn derive_shortcut_status(
    session: SessionKind,
    detection: ProbeOutcome,
    trigger: TriggerMatch,
) -> ShortcutStatus {
    let portal_usable = matches!(
        detection,
        ProbeOutcome::Present { app_id, .. } if app_id.is_resolved()
    );
    // La comparación sólo cuenta con un portal utilizable: sin app-id resuelto
    // no hay sesión de atajos de la que venga una respuesta (#312, S7), así que
    // un `Same` que no se pudo comprobar se normaliza a `Unknown`.
    let trigger = if portal_usable {
        trigger
    } else {
        TriggerMatch::Unknown
    };
    let state = if portal_usable {
        match trigger {
            TriggerMatch::Same => ShortcutCapability::Active,
            TriggerMatch::Different => ShortcutCapability::Remapped,
            // Sin comparación no se afirma reasignación: el atajo es global.
            TriggerMatch::Unknown => ShortcutCapability::Active,
        }
    } else {
        match session {
            SessionKind::X11 => ShortcutCapability::Active,
            SessionKind::Wayland { xwayland: true } => ShortcutCapability::FocusedOnly,
            SessionKind::Wayland { xwayland: false } => ShortcutCapability::Unavailable,
        }
    };
    ShortcutStatus {
        state,
        detection,
        trigger,
    }
}

/// Sondea y deriva: el punto de entrada que usará el slice 2.
///
/// La sonda va por seam (`ShortcutProbe`) para que el cliente real del portal
/// entre después sin cambiar esta lógica.
#[allow(dead_code)]
pub(crate) fn probe_shortcut_status(
    session: SessionKind,
    probe: &mut impl ShortcutProbe,
    trigger: TriggerMatch,
) -> ShortcutStatus {
    let detection = probe.probe();
    derive_shortcut_status(session, detection, trigger)
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
        let registrador = &mut closure;
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
        let resuelto = AppIdState::Resolved;
        let mut presente = FakeProbe::new(ProbeOutcome::Present {
            version: 2,
            app_id: resuelto,
        });
        assert_eq!(
            presente.probe(),
            ProbeOutcome::Present {
                version: 2,
                app_id: resuelto
            }
        );
        let mut ausente = FakeProbe::new(ProbeOutcome::Absent);
        assert_eq!(ausente.probe(), ProbeOutcome::Absent);
        let mut desconocido = FakeProbe::new(ProbeOutcome::Unknown);
        assert_eq!(desconocido.probe(), ProbeOutcome::Unknown);
    }

    #[test]
    fn la_sonda_falsa_alimenta_el_seam_publico() {
        let mut probe = FakeProbe::new(ProbeOutcome::Present {
            version: 1,
            app_id: AppIdState::Resolved,
        });
        let status = probe_shortcut_status(SessionKind::X11, &mut probe, TriggerMatch::Same);
        assert_eq!(status.state, ShortcutCapability::Active);
        assert_eq!(
            status.detection,
            ProbeOutcome::Present {
                version: 1,
                app_id: AppIdState::Resolved
            }
        );
        // La v1 ya trae `trigger_description`: se puede comparar (#312, S14).
        assert_eq!(status.trigger, TriggerMatch::Same);
    }

    // --- Matriz de estados --------------------------------------------------

    #[test]
    fn x11_pura_sin_portal_queda_activo() {
        let status = derive_shortcut_status(
            SessionKind::X11,
            ProbeOutcome::Absent,
            TriggerMatch::Unknown,
        );
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
            TriggerMatch::Unknown,
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
            TriggerMatch::Unknown,
        );
        assert_eq!(status.state, ShortcutCapability::Unavailable);
    }

    #[test]
    fn portal_presente_con_trigger_igual_queda_activo() {
        let status = derive_shortcut_status(
            SessionKind::Wayland { xwayland: false },
            ProbeOutcome::Present {
                version: 2,
                app_id: AppIdState::Resolved,
            },
            TriggerMatch::Same,
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
            ProbeOutcome::Present {
                version: PORTAL_VERSION_CONFIGURE,
                app_id: AppIdState::Resolved,
            },
            TriggerMatch::Different,
        );
        assert_eq!(
            status.state,
            ShortcutCapability::Remapped,
            "el escritorio asignó otra tecla"
        );
    }

    /// La versión del portal **no** decide si la comparación es posible: la
    /// respuesta trae `trigger_description` desde la v1 (`BindShortcuts` y
    /// `ListShortcuts`), así que en los escritorios que exponen la v1 —GNOME
    /// 48/49, KDE— un escritorio que reasignó la tecla tiene que poder decirlo
    /// (#312, S14).
    #[test]
    fn la_comparacion_no_depende_de_la_version_del_portal() {
        for version in [1, PORTAL_VERSION_CONFIGURE, PORTAL_VERSION_CONFIGURE + 1] {
            let igual = derive_shortcut_status(
                SessionKind::Wayland { xwayland: true },
                ProbeOutcome::Present {
                    version,
                    app_id: AppIdState::Resolved,
                },
                TriggerMatch::Same,
            );
            assert_eq!(igual.trigger, TriggerMatch::Same);
            assert_eq!(igual.state, ShortcutCapability::Active);

            let distinto = derive_shortcut_status(
                SessionKind::Wayland { xwayland: true },
                ProbeOutcome::Present {
                    version,
                    app_id: AppIdState::Resolved,
                },
                TriggerMatch::Different,
            );
            assert_eq!(distinto.trigger, TriggerMatch::Different);
            assert_eq!(
                distinto.state,
                ShortcutCapability::Remapped,
                "con `trigger_description` presente, el escritorio puede haber reasignado"
            );
        }
    }

    // --- Desconocido no es ausente -----------------------------------------

    #[test]
    fn sonda_desconocida_nunca_se_reporta_como_ausente() {
        let status = derive_shortcut_status(
            SessionKind::X11,
            ProbeOutcome::Unknown,
            TriggerMatch::Unknown,
        );
        assert_eq!(
            status.detection,
            ProbeOutcome::Unknown,
            "no se pudo comprobar: no es lo mismo que no exista"
        );
        assert_ne!(status.detection, ProbeOutcome::Absent);
    }

    #[test]
    fn sonda_desconocida_cae_al_minimo_garantizable_por_la_sesion() {
        let x11 = derive_shortcut_status(
            SessionKind::X11,
            ProbeOutcome::Unknown,
            TriggerMatch::Unknown,
        );
        assert_eq!(
            x11.state,
            ShortcutCapability::Active,
            "el grab X11 sobre la raíz es global igual que sin sonda"
        );
        let wayland = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Unknown,
            TriggerMatch::Unknown,
        );
        assert_eq!(wayland.state, ShortcutCapability::FocusedOnly);
        let sin_x11 = derive_shortcut_status(
            SessionKind::Wayland { xwayland: false },
            ProbeOutcome::Unknown,
            TriggerMatch::Unknown,
        );
        assert_eq!(sin_x11.state, ShortcutCapability::Unavailable);
    }

    #[test]
    fn desconocida_y_ausente_comparten_estado_pero_no_deteccion() {
        let desconocida = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Unknown,
            TriggerMatch::Unknown,
        );
        let ausente = derive_shortcut_status(
            SessionKind::Wayland { xwayland: true },
            ProbeOutcome::Absent,
            TriggerMatch::Unknown,
        );
        assert_eq!(desconocida.state, ausente.state);
        assert_ne!(desconocida.detection, ausente.detection);
    }

    // --- App-id: el portal está, la app no se pudo identificar (#312, S11) --------

    /// Un app-id sin resolver **no** se reporta como portal ausente ni como
    /// desconocido: la detección conserva el motivo, así que la UI puede decir
    /// "el portal no pudo identificar la app" en vez del respaldo genérico.
    #[test]
    fn un_app_id_sin_resolver_no_se_reporta_como_portal_ausente() {
        for app_id in [
            AppIdState::Missing,
            AppIdState::Rejected,
            AppIdState::RegistryUnavailable,
        ] {
            let detection = ProbeOutcome::Present { version: 2, app_id };
            let status = derive_shortcut_status(
                SessionKind::Wayland { xwayland: true },
                detection,
                TriggerMatch::Unknown,
            );
            assert_eq!(
                status.state,
                ShortcutCapability::FocusedOnly,
                "{app_id:?}: sin portal utilizable sólo queda el grab de XWayland"
            );
            assert_ne!(
                status.detection,
                ProbeOutcome::Absent,
                "{app_id:?}: el portal está; lo que falla es el app-id"
            );
            assert_ne!(
                status.detection,
                ProbeOutcome::Unknown,
                "{app_id:?}: sabemos exactamente qué pasó con el app-id"
            );
            assert_eq!(status.detection, detection);
        }
    }

    #[test]
    fn un_app_id_sin_resolver_no_promete_activo_aunque_el_trigger_coincida() {
        let status = derive_shortcut_status(
            SessionKind::Wayland { xwayland: false },
            ProbeOutcome::Present {
                version: 2,
                app_id: AppIdState::Missing,
            },
            TriggerMatch::Same,
        );
        assert_eq!(
            status.state,
            ShortcutCapability::Unavailable,
            "sin app-id no hay sesión de portal: no se puede prometer el atajo"
        );
    }

    #[test]
    fn el_app_id_resuelto_es_el_unico_que_habilita_la_comparacion() {
        assert!(AppIdState::Resolved.is_resolved());
        assert!(!AppIdState::Missing.is_resolved());
        assert!(!AppIdState::Rejected.is_resolved());
        assert!(!AppIdState::RegistryUnavailable.is_resolved());
    }

    // --- Comparación del trigger: tres valores, no dos (#312, S12) ----------------

    /// El caso central de S12: sin poder comparar, el estado **no** afirma que
    /// el escritorio haya reasignado nada.
    #[test]
    fn comparacion_desconocida_no_afirma_reaasignacion() {
        let status = derive_shortcut_status(
            SessionKind::Wayland { xwayland: false },
            ProbeOutcome::Present {
                version: 2,
                app_id: AppIdState::Resolved,
            },
            TriggerMatch::Unknown,
        );
        assert_ne!(
            status.state,
            ShortcutCapability::Remapped,
            "no se pudo comparar no es \"el escritorio asignó otra tecla\""
        );
        assert_eq!(
            status.state,
            ShortcutCapability::Active,
            "el portal registró el atajo: la app no puede afirmar que sea el preferido, ni que se haya reasignado"
        );
    }

    /// La comparación sólo pesa con el portal resuelto: con `Absent` o
    /// `Unknown` no hay trigger que comparar y manda la sesión.
    #[test]
    fn la_comparacion_solo_cuenta_con_el_portal_resuelto() {
        let sin_portal = derive_shortcut_status(
            SessionKind::X11,
            ProbeOutcome::Absent,
            TriggerMatch::Different,
        );
        assert_eq!(
            sin_portal.state,
            ShortcutCapability::Active,
            "sin portal no hay trigger que comparar: la diferencia es un valor que no aplica"
        );
        let desconocido = derive_shortcut_status(
            SessionKind::X11,
            ProbeOutcome::Unknown,
            TriggerMatch::Different,
        );
        assert_eq!(desconocido.state, ShortcutCapability::Active);
    }

    // --- Versión de la interfaz ---------------------------------------------

    /// La versión del portal sólo habilita `ConfigureShortcuts`: no decide si
    /// se puede comparar el trigger (#312, S14).
    #[test]
    fn la_version_solo_habilita_configure_shortcuts() {
        assert!(ProbeOutcome::Present {
            version: PORTAL_VERSION_CONFIGURE,
            app_id: AppIdState::Resolved
        }
        .supports_configure());
        assert!(!ProbeOutcome::Present {
            version: 1,
            app_id: AppIdState::Resolved
        }
        .supports_configure());
        assert!(!ProbeOutcome::Absent.supports_configure());
        assert!(!ProbeOutcome::Unknown.supports_configure());
    }
}
