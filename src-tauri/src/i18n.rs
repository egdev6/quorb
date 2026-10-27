//! Catálogos tipados es/en para los textos nativos: bandeja, títulos de las
//! ventanas creadas en Rust y diálogo de consentimiento de Codex.
//!
//! Sin crate de i18n (decisión A de #66): un `Msg` por texto y un `match`
//! exhaustivo por locale — añadir una variante sin traducirla no compila, y
//! `ALL_MSGS` recorre la paridad de catálogos en los tests. El español nace de
//! los literales actuales, byte a byte (R6).

/// Idioma de la interfaz. Espejo Rust de `AppConfig.locale` (config.rs), que
/// ya llega saneado a `es|en`; el parseo tolera espacios/capitalización.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    Es,
    En,
}

/// Un texto nativo por variante.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Msg {
    /// Bandeja: «Mostrar / ocultar widget».
    TrayToggle,
    /// Bandeja: «Actualizar ahora».
    TrayRefresh,
    /// Bandeja: «Ajustes…».
    TraySettings,
    /// Bandeja: «Salir».
    TrayQuit,
    /// Prefijo del título de Ajustes: «Ajustes · {canal}».
    SettingsTitle,
    /// Sufijo del título del panel de detalle: «{canal} · detalle».
    DetailTitle,
    /// Sufijo del título de la ventana de efectos: «{canal} · efectos».
    OverlayTitle,
    /// Diálogo de Codex: título.
    CodexConsentTitle,
    /// Diálogo de Codex: mensaje (anclas de canal y carpeta gestionada).
    CodexConsentMessage,
    /// Diálogo de Codex: botón de confirmación.
    CodexConsentInstall,
    /// Diálogo de Codex: botón de cancelación.
    CodexConsentCancel,
}

/// Todas las variantes: los tests de paridad recorren esta lista y el match
/// exhaustivo de `text` obliga a que ninguna quede sin traducir.
#[cfg(test)]
pub const ALL_MSGS: &[Msg] = &[
    Msg::TrayToggle,
    Msg::TrayRefresh,
    Msg::TraySettings,
    Msg::TrayQuit,
    Msg::SettingsTitle,
    Msg::DetailTitle,
    Msg::OverlayTitle,
    Msg::CodexConsentTitle,
    Msg::CodexConsentMessage,
    Msg::CodexConsentInstall,
    Msg::CodexConsentCancel,
];

/// Texto original del diálogo de consentimiento de Codex, byte a byte (nace de
/// codex_setup.rs). Las sustituciones de canal y carpeta se aplican encima en
/// `codex_consent_message`.
pub const CODEX_CONSENT_MESSAGE_ES: &str = "Se instalará el CLI oficial de Codex solo para Quorb.\n\n\
• Paquete: @openai/codex@0.162.1 (versión fijada)\n\
• Registro canónico de npm: https://registry.npmjs.org/\n\
• Carpeta gestionada: ~/.quorb/tools/codex-0.162.1 (fuera del registro global)\n\
• Requisito: Node.js 22 o superior ya instalado (no se instala Node ni se pide elevación)\n\
• Se descargará el binario nativo y se verificará antes de activarlo\n\n\
No se modifica el registro global de npm, no se cambia el PATH del sistema ni de otros programas, y no se inicia sesión ni se guardan credenciales: el acceso con tu cuenta de ChatGPT lo haces después con «Iniciar sesión».\n\n\
¿Instalar Codex ahora?";

pub fn text(locale: Locale, msg: Msg) -> &'static str {
    match (locale, msg) {
        (Locale::Es, Msg::TrayToggle) => "Mostrar / ocultar widget",
        (Locale::En, Msg::TrayToggle) => "Show / hide widget",
        (Locale::Es, Msg::TrayRefresh) => "Actualizar ahora",
        (Locale::En, Msg::TrayRefresh) => "Refresh now",
        (Locale::Es, Msg::TraySettings) => "Ajustes…",
        (Locale::En, Msg::TraySettings) => "Settings…",
        (Locale::Es, Msg::TrayQuit) => "Salir",
        (Locale::En, Msg::TrayQuit) => "Quit",
        (Locale::Es, Msg::SettingsTitle) => "Ajustes",
        (Locale::En, Msg::SettingsTitle) => "Settings",
        (Locale::Es, Msg::DetailTitle) => "detalle",
        (Locale::En, Msg::DetailTitle) => "details",
        (Locale::Es, Msg::OverlayTitle) => "efectos",
        (Locale::En, Msg::OverlayTitle) => "effects",
        (Locale::Es, Msg::CodexConsentTitle) => "Instalar Codex",
        (Locale::En, Msg::CodexConsentTitle) => "Install Codex",
        (Locale::Es, Msg::CodexConsentMessage) => CODEX_CONSENT_MESSAGE_ES,
        (Locale::En, Msg::CodexConsentMessage) => CODEX_CONSENT_MESSAGE_EN,
        (Locale::Es, Msg::CodexConsentInstall) => "Instalar",
        (Locale::En, Msg::CodexConsentInstall) => "Install",
        (Locale::Es, Msg::CodexConsentCancel) => "Cancelar",
        (Locale::En, Msg::CodexConsentCancel) => "Cancel",
    }
}

/// Traducción inglesa del diálogo de consentimiento. Mismas anclas de
/// sustitución que el original («only for Quorb.», «~/.quorb/») y mismo
/// formato de viñetas y saltos que el español.
pub const CODEX_CONSENT_MESSAGE_EN: &str = "The official Codex CLI will be installed only for Quorb.\n\n\
• Package: @openai/codex@0.162.1 (pinned version)\n\
• Canonical npm registry: https://registry.npmjs.org/\n\
• Managed folder: ~/.quorb/tools/codex-0.162.1 (outside the global registry)\n\
• Requirement: Node.js 22 or newer already installed (Node is not installed and no elevation is requested)\n\
• The native binary will be downloaded and verified before being activated\n\n\
The global npm registry is not modified, the system PATH is not changed for this or any other program, and no sign-in happens nor are credentials stored: you sign in with your ChatGPT account afterwards, using “Sign in”.\n\n\
Install Codex now?";

/// El config guarda el locale ya saneado, pero se aceptan espacios y cualquier
/// capitalización: lo desconocido vuelve a `Es` (decisión B de #66).
pub fn locale_from_config(raw: &str) -> Locale {
    match raw.trim().to_ascii_lowercase().as_str() {
        "en" => Locale::En,
        _ => Locale::Es,
    }
}

/// Etiquetas de la bandeja, en orden: toggle, refresh, settings, quit.
pub fn tray_labels(locale: Locale) -> [&'static str; 4] {
    [
        text(locale, Msg::TrayToggle),
        text(locale, Msg::TrayRefresh),
        text(locale, Msg::TraySettings),
        text(locale, Msg::TrayQuit),
    ]
}

/// Título de la ventana de Ajustes: «Ajustes · {canal}».
pub fn settings_title(locale: Locale, channel: &str) -> String {
    format!("{} · {channel}", text(locale, Msg::SettingsTitle))
}

/// Título del panel de detalle: «{canal} · detalle».
pub fn detail_title(locale: Locale, channel: &str) -> String {
    format!("{channel} · {}", text(locale, Msg::DetailTitle))
}

/// Título de la ventana de efectos: «{canal} · efectos».
pub fn overlay_title(locale: Locale, channel: &str) -> String {
    format!("{channel} · {}", text(locale, Msg::OverlayTitle))
}

/// Botones del diálogo de Codex: (confirmar, cancelar).
pub fn codex_consent_buttons(locale: Locale) -> (&'static str, &'static str) {
    (
        text(locale, Msg::CodexConsentInstall),
        text(locale, Msg::CodexConsentCancel),
    )
}

/// Mensaje del diálogo de consentimiento con el nombre del canal y la carpeta
/// gestionada ya sustituidos (mismas anclas que el texto original).
pub fn codex_consent_message(locale: Locale, channel: &str, home_dir: &str) -> String {
    let raw = text(locale, Msg::CodexConsentMessage);
    let (only_anchor, only_with_channel) = match locale {
        Locale::Es => ("solo para Quorb.", format!("solo para {channel}.")),
        Locale::En => ("only for Quorb.", format!("only for {channel}.")),
    };
    raw.replace(only_anchor, &only_with_channel)
        .replace("~/.quorb/", &format!("~/{home_dir}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Paridad de catálogos: todo texto existe y no está vacío en ningún idioma.
    /// `ALL_MSGS` + el match exhaustivo de `text` cubren el alta de variantes.
    #[test]
    fn every_message_has_non_empty_es_and_en() {
        for &msg in ALL_MSGS {
            assert!(!text(Locale::Es, msg).is_empty(), "{msg:?} sin texto en es");
            assert!(!text(Locale::En, msg).is_empty(), "{msg:?} sin texto en en");
        }
    }

    /// R6 (#66): el español nace de los literales actuales, byte a byte.
    /// Cualquier cambio accidental del texto original se detecta aquí.
    #[test]
    fn spanish_texts_are_the_current_literals_verbatim() {
        let es = |msg| text(Locale::Es, msg);
        assert_eq!(es(Msg::TrayToggle), "Mostrar / ocultar widget");
        assert_eq!(es(Msg::TrayRefresh), "Actualizar ahora");
        assert_eq!(es(Msg::TraySettings), "Ajustes…");
        assert_eq!(es(Msg::TrayQuit), "Salir");
        assert_eq!(es(Msg::SettingsTitle), "Ajustes");
        assert_eq!(es(Msg::DetailTitle), "detalle");
        assert_eq!(es(Msg::OverlayTitle), "efectos");
        assert_eq!(es(Msg::CodexConsentTitle), "Instalar Codex");
        assert_eq!(es(Msg::CodexConsentInstall), "Instalar");
        assert_eq!(es(Msg::CodexConsentCancel), "Cancelar");
        assert_eq!(es(Msg::CodexConsentMessage), CODEX_CONSENT_MESSAGE_ES);
    }

    /// Parseo del locale guardado: known → su variante; desconocido → `Es`.
    #[test]
    fn locale_parses_es_en_and_falls_back_to_es() {
        assert_eq!(locale_from_config("es"), Locale::Es);
        assert_eq!(locale_from_config("en"), Locale::En);
        // Tolerante a espacios y capitalización (el config ya llega saneado).
        assert_eq!(locale_from_config("EN"), Locale::En);
        assert_eq!(locale_from_config(" en "), Locale::En);
        assert_eq!(locale_from_config("Es"), Locale::Es);
        // Desconocido/ausente/vacío → español.
        for raw in ["fr", "en-US", "es_ES", "", "   "] {
            assert_eq!(locale_from_config(raw), Locale::Es, "locale {raw:?}");
        }
    }

    /// Etiquetas de la bandeja por idioma, en el orden del menú.
    #[test]
    fn tray_labels_match_locale() {
        assert_eq!(
            tray_labels(Locale::Es),
            [
                "Mostrar / ocultar widget",
                "Actualizar ahora",
                "Ajustes…",
                "Salir"
            ]
        );
        assert_eq!(
            tray_labels(Locale::En),
            ["Show / hide widget", "Refresh now", "Settings…", "Quit"]
        );
    }

    /// Títulos de ventanas nativas por idioma (los puntos medios se conservan).
    #[test]
    fn window_titles_match_locale() {
        assert_eq!(settings_title(Locale::Es, "Quorb"), "Ajustes · Quorb");
        assert_eq!(settings_title(Locale::En, "Quorb"), "Settings · Quorb");
        assert_eq!(detail_title(Locale::Es, "Quorb"), "Quorb · detalle");
        assert_eq!(detail_title(Locale::En, "Quorb"), "Quorb · details");
        assert_eq!(overlay_title(Locale::Es, "Quorb"), "Quorb · efectos");
        assert_eq!(overlay_title(Locale::En, "Quorb"), "Quorb · effects");
    }

    /// Título y botones del diálogo de consentimiento de Codex por idioma.
    #[test]
    fn codex_consent_texts_match_locale() {
        assert_eq!(text(Locale::Es, Msg::CodexConsentTitle), "Instalar Codex");
        assert_eq!(text(Locale::En, Msg::CodexConsentTitle), "Install Codex");
        assert_eq!(codex_consent_buttons(Locale::Es), ("Instalar", "Cancelar"));
        assert_eq!(codex_consent_buttons(Locale::En), ("Install", "Cancel"));
    }

    /// El mensaje ensamblado con la identidad estable ("Quorb", ".quorb") es el
    /// literal original byte a byte; en inglés se aplican las mismas
    /// sustituciones de canal y carpeta.
    #[test]
    fn codex_consent_message_applies_channel_and_home_dir() {
        assert_eq!(
            codex_consent_message(Locale::Es, "Quorb", ".quorb"),
            CODEX_CONSENT_MESSAGE_ES
        );
        // Con otro canal/carpeta (identidad ficticia, no la retirada Dev),
        // ambos textos sustituyen por las mismas anclas.
        for locale in [Locale::Es, Locale::En] {
            let msg = codex_consent_message(locale, "Quorb Beta", ".quorb-beta");
            assert!(
                !msg.contains("solo para Quorb."),
                "{locale:?}: canal sin sustituir"
            );
            assert!(
                !msg.contains("only for Quorb."),
                "{locale:?}: canal sin sustituir"
            );
            assert!(
                !msg.contains("~/.quorb/"),
                "{locale:?}: carpeta sin sustituir"
            );
            assert!(
                msg.contains("~/.quorb-beta/tools/"),
                "{locale:?}: carpeta sustituida"
            );
        }
        let en = codex_consent_message(Locale::En, "Quorb Beta", ".quorb-beta");
        assert!(
            en.contains("only for Quorb Beta."),
            "inglés sin canal sustituido"
        );
        assert!(
            en.contains("Install Codex now?"),
            "inglés sin pregunta final"
        );
    }
}
