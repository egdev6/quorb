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
/// El orden coincide con el de `i18n::tray_labels` (toggle, refresh,
/// settings, quit) para casar id con label localizada.
pub const HUB_IDS: [&str; 3] = ["toggle", "refresh", "settings"];

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
}
