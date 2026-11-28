//! Política de la integración con el hub de Nexo (#281), aislada de Tauri.
//!
//! Todo lo que decide qué ítems expone Quorb al hub y cómo se traducen los
//! clics del hub a acciones nativas vive aquí, puro y testeable en cualquier
//! plataforma. La parte que depende de Tauri (construir el plugin, crear el
//! icono, mediar la visibilidad) queda en `lib.rs` con `#[cfg(windows)]`.
//!
//! El menú del hub reutiliza los **ids** del menú nativo de la bandeja y sus
//! labels localizadas (`i18n::tray_labels`). El hub añade por su cuenta sus
//! entradas «Open» (show) y «Quit», así que Quorb no las declara aquí: el
//! protocolo exige excluirlas.

/// Los ids que Quorb declara en el menú del hub. Son un subconjunto de los de
/// la bandeja nativa: «quit» queda fuera porque el hub añade su propio Quit.
///
/// Es el contrato canónico que verifican los tests; la construcción real del
/// menú usa `hub_labels`, que fija el id junto a su label explícita.
#[cfg_attr(not(test), allow(dead_code))]
pub const HUB_IDS: [&str; 3] = ["toggle", "refresh", "settings"];

/// Construye las entradas del menú del hub con labels suministradas por
/// significado, no por posición en el array del menú nativo. Esto evita que
/// un cambio de orden en `tray_labels` despareje ids y textos.
pub fn hub_labels<'a>(
    toggle: &'a str,
    refresh: &'a str,
    settings: &'a str,
) -> [(&'static str, &'a str); 3] {
    [
        ("toggle", toggle),
        ("refresh", refresh),
        ("settings", settings),
    ]
}

/// Acciones que produce un clic, tanto en el menú nativo como en el del hub.
/// `Quit` no llega desde el hub (su Quit es propio y va por el protocolo),
/// pero la bandeja nativa sí lo usa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Toggle,
    Refresh,
    Settings,
    Quit,
}

/// Traduce el id de un menú (nativo o del hub) a su acción. Ids desconocidos
/// se ignoran: los labels cambian con el idioma, los ids no.
pub fn tray_action(id: &str) -> Option<TrayAction> {
    match id {
        "toggle" => Some(TrayAction::Toggle),
        "refresh" => Some(TrayAction::Refresh),
        "settings" => Some(TrayAction::Settings),
        "quit" => Some(TrayAction::Quit),
        _ => None,
    }
}

/// Estado de la ventana de Ajustes que el frontend comunica al decidir un «Salir».
///
/// El frontend es la única fuente de verdad: Rust no puede saber si hay un
/// borrador sin guardar ni un guardado en curso (#281).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsState {
    /// No hay cambios sin guardar ni guardados en curso.
    Clean,
    /// Hay cambios sin guardar: salir los perdería.
    Dirty,
    /// Hay un guardado en curso: salir lo dejaría a medias.
    Saving,
    /// Un autoguardado falló y sigue sin resolverse: el cambio no está persistido.
    Failed,
    /// Un efecto nativo falló tras persistir: la configuración está guardada, pero
    /// el ajuste no llegó a aplicarse (p. ej. «siempre encima»).
    ApplyFailed,
}

/// Motivo por el que Ajustes bloquea la salida.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitBlock {
    /// Hay cambios sin guardar o un guardado en curso.
    PendingChanges,
    /// Un autoguardado falló y sigue pendiente de reintento.
    SaveFailed,
    /// Un efecto nativo falló tras persistir: el dato está guardado, el efecto no.
    ApplyFailed,
}

/// Qué debe hacer el host ante un «Salir» del hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPlan {
    /// Aceptar y salir: no hay nada en juego.
    Accept,
    /// Preguntar antes al frontend de Ajustes.
    Ask,
}

/// Plan de «Salir» según si la ventana de Ajustes está abierta.
///
/// Con Ajustes cerrada no hay nada que perder, así que se acepta sin preguntar:
/// el hub no debe quedarse esperando por una ventana que no existe. Con Ajustes
/// abierta la única fuente de verdad es el frontend, así que se le pregunta.
pub fn quit_plan(settings_open: bool) -> QuitPlan {
    if settings_open {
        QuitPlan::Ask
    } else {
        QuitPlan::Accept
    }
}

/// Única ventana que puede responder a una petición de «Salir» del hub.
///
/// El frontend de Ajustes es quien sabe si hay cambios sin guardar, así que es
/// el único que puede responder con el estado real. Cualquier otra webview de
/// Quorb que invoque el comando podría contestar «no hay nada pendiente» y
/// dejar salir a la app con trabajo sin guardar, así que se usa el mismo
/// patrón que `install_codex` con `settings_window_ok`.
pub fn quit_answer_window_ok(label: &str) -> bool {
    label == crate::SETTINGS
}

/// Estado de Ajustes a partir de lo que reporta el frontend.
///
/// Un guardado en curso tiene prioridad sobre un fallo previo, y ambos sobre un
/// borrador: mientras se escribe o queda algo sin persistir, salir dejaría la
/// configuración a medias.
pub fn settings_state(
    dirty: bool,
    saving: bool,
    failed: bool,
    apply_failed: bool,
) -> SettingsState {
    if saving {
        SettingsState::Saving
    } else if failed {
        // Un autoguardado rechazado deja el saver en `saving:false`, así que este
        // caso necesita su propia señal: el cambio existió pero no se persistió.
        SettingsState::Failed
    } else if apply_failed {
        // El dato sí quedó guardado: lo que falló fue aplicarlo.
        SettingsState::ApplyFailed
    } else if dirty {
        SettingsState::Dirty
    } else {
        SettingsState::Clean
    }
}

/// Motivo con el que Ajustes bloquea la salida, o `None` si se puede salir.
///
/// Un guardado en curso o un autoguardado fallido también bloquean: cortarlos
/// deja la configuración a medias o pierde el cambio.
pub fn quit_block(state: SettingsState) -> Option<QuitBlock> {
    match state {
        SettingsState::Clean => None,
        SettingsState::Failed => Some(QuitBlock::SaveFailed),
        SettingsState::ApplyFailed => Some(QuitBlock::ApplyFailed),
        SettingsState::Dirty | SettingsState::Saving => Some(QuitBlock::PendingChanges),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{self, Locale, Msg};

    #[test]
    fn hub_ids_are_the_native_ids_without_quit() {
        // El hub añade su propio Quit; declararlo aquí duplicaría la entrada.
        assert_eq!(HUB_IDS, ["toggle", "refresh", "settings"]);
        assert!(!HUB_IDS.contains(&"quit"));
        for (id, expected) in [
            ("toggle", TrayAction::Toggle),
            ("refresh", TrayAction::Refresh),
            ("settings", TrayAction::Settings),
        ] {
            assert_eq!(tray_action(id), Some(expected), "id {id}");
        }
    }

    #[test]
    fn hub_ids_respect_protocol_limits() {
        // El protocolo permite hasta 20 ítems y pide ids únicos.
        assert!(HUB_IDS.len() <= 20);
        for (i, id) in HUB_IDS.iter().enumerate() {
            assert!(!HUB_IDS[..i].iter().any(|prev| prev == id));
        }
    }

    #[test]
    fn tray_action_maps_all_native_ids_and_ignores_unknown() {
        for (id, expected) in [
            ("toggle", Some(TrayAction::Toggle)),
            ("refresh", Some(TrayAction::Refresh)),
            ("settings", Some(TrayAction::Settings)),
            ("quit", Some(TrayAction::Quit)),
        ] {
            assert_eq!(tray_action(id), expected, "id {id}");
        }
        assert_eq!(tray_action("open"), None);
        assert_eq!(tray_action(""), None);
        assert_eq!(tray_action("unknown"), None);
    }

    #[test]
    fn quit_plan_asks_the_frontend_only_when_settings_is_open() {
        // Sin Ajustes abierta no hay nada que perder: el hub no espera.
        assert_eq!(quit_plan(false), QuitPlan::Accept);
        assert_eq!(quit_plan(true), QuitPlan::Ask);
    }

    #[test]
    fn only_the_settings_window_may_answer_a_quit() {
        // Solo Ajustes conoce el estado real; otra webview podría responder
        // «no hay nada pendiente» y dejar salir la app con trabajo sin guardar.
        assert!(quit_answer_window_ok("settings"));
        for label in [
            "widget",
            "detail",
            "overlay",
            "locale",
            "",
            "Settings",
            "settings ",
        ] {
            assert!(!quit_answer_window_ok(label), "label {label:?}");
        }
    }

    #[test]
    fn quit_is_allowed_only_without_pending_changes_or_an_in_flight_save() {
        assert!(quit_block(SettingsState::Clean).is_none());
        assert!(quit_block(SettingsState::Dirty).is_some());
        assert!(quit_block(SettingsState::Saving).is_some());
        // Un autoguardado fallido deja el saver en `saving:false`; bloquearlo es
        // justo lo que evita perder el cambio al salir desde el hub.
        assert!(quit_block(SettingsState::Failed).is_some());
    }

    #[test]
    fn quit_block_explains_why_settings_blocks_the_exit() {
        assert_eq!(quit_block(SettingsState::Clean), None);
        assert_eq!(
            quit_block(SettingsState::Dirty),
            Some(QuitBlock::PendingChanges)
        );
        assert_eq!(
            quit_block(SettingsState::Saving),
            Some(QuitBlock::PendingChanges)
        );
        assert_eq!(
            quit_block(SettingsState::Failed),
            Some(QuitBlock::SaveFailed)
        );
        assert_eq!(
            quit_block(SettingsState::ApplyFailed),
            Some(QuitBlock::ApplyFailed)
        );
    }

    #[test]
    fn settings_state_maps_what_the_frontend_reports() {
        assert_eq!(
            settings_state(false, false, false, false),
            SettingsState::Clean
        );
        assert_eq!(
            settings_state(true, false, false, false),
            SettingsState::Dirty
        );
        assert_eq!(
            settings_state(false, true, false, false),
            SettingsState::Saving
        );
        assert_eq!(
            settings_state(false, false, true, false),
            SettingsState::Failed
        );
        assert_eq!(
            settings_state(false, false, false, true),
            SettingsState::ApplyFailed
        );
        // Prioridad: guardado en curso > fallo de escritura > fallo de efecto > borrador.
        assert_eq!(
            settings_state(true, true, true, true),
            SettingsState::Saving
        );
        assert_eq!(
            settings_state(true, true, false, false),
            SettingsState::Saving
        );
        assert_eq!(
            settings_state(true, false, true, true),
            SettingsState::Failed
        );
        assert_eq!(
            settings_state(true, false, false, true),
            SettingsState::ApplyFailed
        );
    }

    #[test]
    fn hub_menu_fits_the_protocol_limits_in_every_locale() {
        // El menú real de cada idioma tiene que caber en el protocolo: es lo que
        // valida el host al registrar el menú, y lo que decide si puede haber
        // menú del hub o hay que seguir sin él.
        for locale in [Locale::Es, Locale::En] {
            let items: Vec<nexo_protocol::MenuItem> = hub_labels(
                i18n::text(locale, Msg::TrayToggle),
                i18n::text(locale, Msg::TrayRefresh),
                i18n::text(locale, Msg::TraySettings),
            )
            .into_iter()
            .map(|(id, label)| nexo_protocol::MenuItem {
                id: id.to_string(),
                label: label.to_string(),
                enabled: true,
                checked: None,
            })
            .collect();
            let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
            assert_eq!(ids, HUB_IDS.to_vec(), "locale {locale:?}");
            // El hub añade su propio Quit: declararlo aquí lo duplicaría.
            assert!(!ids.contains(&"quit"), "locale {locale:?}");
            assert!(
                items.len() <= nexo_protocol::MAX_MENU_ITEMS,
                "locale {locale:?}"
            );
            assert!(
                nexo_protocol::encode(
                    nexo_protocol::PROTOCOL_VERSION,
                    &nexo_protocol::Message::Menu { items },
                )
                .is_ok(),
                "locale {locale:?}"
            );
        }
    }
}
