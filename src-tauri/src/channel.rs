//! Identity is frozen from Tauri's build config, never selected by a runtime toggle.
use std::path::{Path, PathBuf};

pub struct Profile {
    pub identifier: &'static str,
    pub name: &'static str,
    pub home_dir: &'static str,
    pub migrate_legacy: bool,
}

pub const STABLE: Profile = Profile {
    identifier: "es.egdev.quorb",
    name: "Quorb",
    home_dir: ".quorb",
    migrate_legacy: true,
};

pub fn current() -> &'static Profile {
    match option_env!("QUORB_IDENTIFIER").unwrap_or(STABLE.identifier) {
        "es.egdev.quorb" => &STABLE,
        _ => panic!("Unsupported Quorb build identity"),
    }
}

pub fn home_root(home: &Path) -> PathBuf {
    home.join(current().home_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_identity_is_preserved() {
        assert_eq!(STABLE.identifier, "es.egdev.quorb");
        assert_eq!(STABLE.name, "Quorb");
        assert_eq!(STABLE.home_dir, ".quorb");
        assert!(STABLE.migrate_legacy);
    }
    #[test]
    fn runtime_owned_paths_follow_build_identity() {
        assert_eq!(
            home_root(Path::new("/home/test")),
            Path::new("/home/test").join(current().home_dir)
        );
    }
}
