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
    fn hub_labels_match_explicit_i18n_messages_and_exclude_quit() {
        for locale in [Locale::Es, Locale::En] {
            let labels = hub_labels(
                i18n::text(locale, Msg::TrayToggle),
                i18n::text(locale, Msg::TrayRefresh),
                i18n::text(locale, Msg::TraySettings),
            );
            assert_eq!(
                labels,
                [
                    ("toggle", i18n::text(locale, Msg::TrayToggle)),
                    ("refresh", i18n::text(locale, Msg::TrayRefresh)),
                    ("settings", i18n::text(locale, Msg::TraySettings)),
                ]
            );
            assert!(!labels
                .iter()
                .any(|(_, label)| *label == i18n::text(locale, Msg::TrayQuit)));
        }
    }
}
