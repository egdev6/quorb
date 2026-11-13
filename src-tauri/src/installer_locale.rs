//! One-shot installer-locale handoff from the Windows NSIS installer (#233).
//!
//! After a successful interactive install, NSIS writes `installer-locale` into
//! the app config directory (`$APPDATA\<bundle id>`) with two lines: the chosen
//! locale and the installer version. On Windows startup the app reads it and
//! always removes it; it applies the choice only to a fresh configuration, so an
//! existing, legacy or unreadable config is never overwritten.

use crate::config::{self, AppConfig, ConfigOrigin};
use std::path::Path;

pub const FILE: &str = "installer-locale";
const MAX_BYTES: u64 = 64;

/// Reads the handoff and always removes it. Returns the locale only when it is
/// supported and was written by this exact version.
pub fn take(dir: &Path, version: &str) -> Option<String> {
    let path = dir.join(FILE);
    let text = read_bounded(&path);
    let _ = std::fs::remove_file(&path);
    parse(&text?, version)
}

fn read_bounded(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn parse(text: &str, version: &str) -> Option<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    match lines.as_slice() {
        [locale, written_by] if *written_by == version && config::LOCALES.contains(locale) => {
            Some((*locale).to_string())
        }
        _ => None,
    }
}

/// Applies a handoff choice only to a fresh Windows configuration without a
/// selected locale. Returns whether the configuration changed.
pub fn apply(os: &str, cfg: &mut AppConfig, origin: ConfigOrigin, handoff: Option<&str>) -> bool {
    os == "windows"
        && origin == ConfigOrigin::Missing
        && !cfg.locale_selected
        && handoff.is_some_and(|locale| cfg.choose_locale(locale).is_ok())
}

/// Loads `config.json` and, on Windows, consumes the installer handoff. An
/// applied choice is saved before the caller decides on the picker or the UI;
/// if saving fails, the shared picker asks instead.
pub fn startup_config(os: &str, config_dir: &Path, version: &str) -> (AppConfig, ConfigOrigin) {
    let path = config_dir.join("config.json");
    let (mut cfg, origin) = config::load(&path);
    if os != "windows" {
        return (cfg, origin);
    }
    let handoff = take(config_dir, version);
    let before = cfg.clone();
    if apply(os, &mut cfg, origin, handoff.as_deref()) {
        if let Err(err) = config::save(&path, &cfg) {
            eprintln!("quorb: could not save the installer locale choice: {err}");
            return (before, origin);
        }
    }
    (cfg, origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERSION: &str = "0.8.0";

    struct Dir(std::path::PathBuf);

    impl Dir {
        fn new(tag: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "quorb-installer-locale-{tag}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn handoff(&self) -> std::path::PathBuf {
            self.0.join(FILE)
        }

        fn config(&self) -> std::path::PathBuf {
            self.0.join("config.json")
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn take_returns_supported_locale_for_this_version_and_removes_file() {
        for (raw, expected) in [("es\r\n0.8.0\r\n", "es"), ("en\n0.8.0", "en")] {
            let dir = Dir::new("valid");
            std::fs::write(dir.handoff(), raw).unwrap();
            assert_eq!(take(&dir.0, VERSION).as_deref(), Some(expected), "{raw:?}");
            assert!(!dir.handoff().exists(), "{raw:?}");
        }
    }

    #[test]
    fn take_rejects_and_removes_invalid_or_stale_handoffs() {
        let oversized = format!("es\n{VERSION}\n{}", "x".repeat(80));
        for raw in [
            "fr\n0.8.0\n",
            "EN\n0.8.0\n",
            "es\n0.7.0\n",
            "es\n",
            "",
            "es\n0.8.0\nextra\n",
            oversized.as_str(),
        ] {
            let dir = Dir::new("invalid");
            std::fs::write(dir.handoff(), raw).unwrap();
            assert_eq!(take(&dir.0, VERSION), None, "{raw:?}");
            assert!(!dir.handoff().exists(), "{raw:?}");
        }
        let dir = Dir::new("absent");
        assert_eq!(take(&dir.0, VERSION), None);
    }

    #[test]
    fn fresh_windows_install_saves_handoff_choice_before_ui_without_picker() {
        let dir = Dir::new("fresh");
        std::fs::write(dir.handoff(), "en\r\n0.8.0\r\n").unwrap();

        let (cfg, origin) = startup_config("windows", &dir.0, VERSION);

        assert_eq!(origin, ConfigOrigin::Missing);
        assert_eq!((cfg.locale.as_str(), cfg.locale_selected), ("en", true));
        assert!(!crate::locale_picker_needed_on("windows", &cfg, origin));
        assert!(!dir.handoff().exists());
        let (saved, saved_origin) = config::load(&dir.config());
        assert_eq!(saved_origin, ConfigOrigin::Existing);
        assert_eq!(saved, cfg);
    }

    #[test]
    fn fresh_windows_install_without_valid_handoff_keeps_the_shared_picker() {
        for raw in [None, Some("en\n0.7.0\n"), Some("fr\n0.8.0\n")] {
            let dir = Dir::new("no-handoff");
            if let Some(raw) = raw {
                std::fs::write(dir.handoff(), raw).unwrap();
            }

            let (cfg, origin) = startup_config("windows", &dir.0, VERSION);

            assert_eq!(cfg, AppConfig::default().sanitized(), "{raw:?}");
            assert!(
                crate::locale_picker_needed_on("windows", &cfg, origin),
                "{raw:?}"
            );
            assert!(!dir.handoff().exists(), "{raw:?}");
            assert!(!dir.config().exists(), "{raw:?}");
        }
    }

    #[test]
    fn existing_or_unreadable_windows_config_is_never_overwritten_by_handoff() {
        for raw in [
            &br#"{"locale":"es","localeSelected":true,"refreshMinutes":7}"#[..],
            &br#"{"locale":"es","refreshMinutes":7}"#[..],
            &b"{not json"[..],
        ] {
            let dir = Dir::new("existing");
            std::fs::write(dir.config(), raw).unwrap();
            std::fs::write(dir.handoff(), "en\n0.8.0\n").unwrap();
            let (before, _) = config::load(&dir.config());

            let (cfg, origin) = startup_config("windows", &dir.0, VERSION);

            assert_eq!(origin, ConfigOrigin::Existing);
            assert_eq!(cfg, before);
            assert!(!crate::locale_picker_needed_on("windows", &cfg, origin));
            assert_eq!(std::fs::read(dir.config()).unwrap(), raw);
            assert!(!dir.handoff().exists());
        }
    }

    #[test]
    fn linux_and_macos_startup_ignore_the_handoff_file() {
        for os in ["linux", "macos"] {
            let dir = Dir::new(os);
            std::fs::write(dir.handoff(), "en\n0.8.0\n").unwrap();

            let (cfg, origin) = startup_config(os, &dir.0, VERSION);

            assert_eq!(cfg, AppConfig::default().sanitized(), "{os}");
            assert!(crate::locale_picker_needed_on(os, &cfg, origin), "{os}");
            assert_eq!(std::fs::read(dir.handoff()).unwrap(), b"en\n0.8.0\n");
            assert!(!dir.config().exists(), "{os}");
        }
    }

    #[test]
    fn apply_only_changes_fresh_unselected_windows_config() {
        let mut cfg = AppConfig::default().sanitized();
        assert!(!apply(
            "windows",
            &mut cfg.clone(),
            ConfigOrigin::Existing,
            Some("en")
        ));
        assert!(!apply(
            "linux",
            &mut cfg.clone(),
            ConfigOrigin::Missing,
            Some("en")
        ));
        assert!(!apply(
            "windows",
            &mut cfg.clone(),
            ConfigOrigin::Missing,
            None
        ));
        let before = cfg.clone();
        assert!(!apply(
            "windows",
            &mut cfg,
            ConfigOrigin::Missing,
            Some("fr")
        ));
        assert_eq!(cfg, before);
        assert!(apply(
            "windows",
            &mut cfg,
            ConfigOrigin::Missing,
            Some("en")
        ));
        assert_eq!((cfg.locale.as_str(), cfg.locale_selected), ("en", true));
    }
}
