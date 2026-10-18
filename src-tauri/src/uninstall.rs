//! Explicit NSIS delete-data helper, dispatched before Tauri/plugins start.
//! No config/session contents are loaded and no credential values are read.
use crate::channel::Profile;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq)]
enum Failure {
    Arguments,
    Paths,
    Credentials,
    Files,
}
impl Failure {
    fn exit_code(&self) -> i32 {
        match self {
            Self::Arguments => 2,
            Self::Paths => 3,
            Self::Credentials => 4,
            Self::Files => 5,
        }
    }
}

struct Plan {
    roots: [PathBuf; 3],
}
impl Plan {
    fn new(profile: &Profile, home: &Path, roaming: &Path, local: &Path) -> Result<Self, Failure> {
        if !matches!(
            (profile.identifier, profile.home_dir),
            ("es.egdev.quorb", ".quorb")
        ) || [home, roaming, local].iter().any(|p| !p.is_absolute())
        {
            return Err(Failure::Paths);
        }
        Ok(Self {
            roots: [
                roaming.join(profile.identifier),
                local.join(profile.identifier),
                home.join(profile.home_dir),
            ],
        })
    }
    // Reject links/junctions in roots, ancestors AND children before any writes.
    // remove_dir_all itself does not follow symlinks; no configured paths are used.
    fn preflight(&self) -> Result<(), Failure> {
        for root in &self.roots {
            for ancestor in root.ancestors() {
                match fs::symlink_metadata(ancestor) {
                    Ok(meta) if is_link(&meta) || !meta.is_dir() => return Err(Failure::Paths),
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(Failure::Paths),
                }
            }
            let mut pending = vec![root.clone()];
            let mut count = 0;
            while let Some(dir) = pending.pop() {
                let entries = match fs::read_dir(&dir) {
                    Ok(entries) => entries,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return Err(Failure::Paths),
                };
                for entry in entries {
                    let entry = entry.map_err(|_| Failure::Paths)?;
                    let meta = fs::symlink_metadata(entry.path()).map_err(|_| Failure::Paths)?;
                    count += 1;
                    if count > 100_000 || is_link(&meta) || !(meta.is_file() || meta.is_dir()) {
                        return Err(Failure::Paths);
                    }
                    if meta.is_dir() {
                        pending.push(entry.path());
                    }
                }
            }
        }
        Ok(())
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn purge(plan: &Plan, credentials: impl FnOnce() -> Result<(), Failure>) -> Result<(), Failure> {
    plan.preflight()?;
    // If vault access/deletion fails, preserve files and stop the uninstaller.
    credentials()?;
    for root in &plan.roots {
        match fs::remove_dir_all(root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Failure::Files),
        }
    }
    Ok(())
}

fn owned_target(target: &str, identifier: &str) -> bool {
    let Some(key) = target.strip_suffix(&format!(".{identifier}")) else {
        return false;
    };
    let (base, account) = key
        .split_once('@')
        .map_or((key, None), |(base, id)| (base, Some(id)));
    crate::secrets::ALL.contains(&base) && account.is_none_or(crate::config::is_account_id)
}

#[cfg(windows)]
fn delete_credentials(identifier: &str) -> Result<(), Failure> {
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND},
        Security::Credentials::{
            CredDeleteW, CredEnumerateW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC,
        },
    };
    let mut count = 0;
    let mut entries: *mut *mut CREDENTIALW = std::ptr::null_mut();
    // Enumerate metadata only. Never dereference CredentialBlob or UserName.
    if unsafe { CredEnumerateW(std::ptr::null(), 0, &mut count, &mut entries) } == 0 {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
            Ok(())
        } else {
            Err(Failure::Credentials)
        };
    }
    struct Guard(*mut *mut CREDENTIALW);
    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                CredFree(self.0.cast());
            }
        }
    }
    let _guard = Guard(entries);
    let mut failed = false;
    for i in 0..count {
        let entry = unsafe { &**entries.add(i as usize) };
        if entry.Type != CRED_TYPE_GENERIC || entry.TargetName.is_null() {
            continue;
        }
        let mut len = 0;
        while len <= 32767 && unsafe { *entry.TargetName.add(len) } != 0 {
            len += 1;
        }
        if len > 32767 {
            failed = true;
            continue;
        }
        let target =
            String::from_utf16(unsafe { std::slice::from_raw_parts(entry.TargetName, len) })
                .map_err(|_| Failure::Credentials)?;
        if owned_target(&target, identifier)
            && unsafe { CredDeleteW(entry.TargetName, CRED_TYPE_GENERIC, 0) } == 0
            && unsafe { GetLastError() } != ERROR_NOT_FOUND
        {
            failed = true;
        }
    }
    if failed {
        Err(Failure::Credentials)
    } else {
        Ok(())
    }
}

fn authorized(args: &[String], identifier: &str) -> bool {
    args == [
        "--quorb-uninstall-cleanup",
        "--delete-data",
        "--channel",
        identifier,
    ]
}

/// None = ordinary app launch. Some = helper exit code; never initializes Tauri.
pub fn dispatch(args: &[String]) -> Option<i32> {
    if !args.iter().any(|arg| arg == "--quorb-uninstall-cleanup") {
        return None;
    }
    let profile = crate::channel::current();
    if !authorized(args, profile.identifier) {
        return Some(Failure::Arguments.exit_code());
    }
    #[cfg(windows)]
    {
        let result = (|| {
            let home = dirs::home_dir().ok_or(Failure::Paths)?;
            let roaming = dirs::config_dir().ok_or(Failure::Paths)?;
            let local = dirs::data_local_dir().ok_or(Failure::Paths)?;
            purge(&Plan::new(profile, &home, &roaming, &local)?, || {
                delete_credentials(profile.identifier)
            })
        })();
        Some(result.err().map_or(0, |e| e.exit_code()))
    }
    #[cfg(not(windows))]
    {
        Some(Failure::Arguments.exit_code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::STABLE;
    use std::sync::atomic::{AtomicU64, Ordering};

    const FOREIGN: Profile = Profile {
        identifier: "org.example.foreign",
        home_dir: ".foreign-app",
        name: "Foreign fixture",
        migrate_legacy: false,
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "quorb-uninstall-fixture-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            // The OS temporary directory may itself have a linked ancestor
            // (for example /var -> /private/var on macOS). Tests of unsafe links
            // create those links explicitly beneath this real fixture root.
            Self(p.canonicalize().unwrap())
        }
        fn plan(&self) -> Plan {
            Plan::new(
                &STABLE,
                &self.0.join("home"),
                &self.0.join("roaming"),
                &self.0.join("local"),
            )
            .unwrap()
        }
        fn seed(&self, plan: &Plan) {
            for root in &plan.roots {
                fs::create_dir_all(root.join("accounts/test")).unwrap();
                fs::write(
                    root.join("accounts/test/auth.json"),
                    "synthetic fixture, not a credential",
                )
                .unwrap();
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn requires_explicit_delete_and_matching_compiled_identity() {
        let flags = |id: &str| {
            vec![
                "--quorb-uninstall-cleanup".into(),
                "--delete-data".into(),
                "--channel".into(),
                id.into(),
            ]
        };
        assert!(authorized(&flags(STABLE.identifier), STABLE.identifier));
        assert!(!authorized(&flags(FOREIGN.identifier), STABLE.identifier));
        for len in 0..4 {
            assert!(!authorized(&flags(STABLE.identifier)[..len], STABLE.identifier));
        }
        for switch in ["/UPDATE", "/P", "/S", "_?=C:\\fixture"] {
            let mut extra = flags(STABLE.identifier);
            extra.push(switch.into());
            assert!(!authorized(&extra, STABLE.identifier));
        }
    }
    #[test]
    fn deletes_stable_only_and_preserves_foreign_and_external_data() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        let foreign = Plan {
            roots: [
                fixture.0.join("roaming").join(FOREIGN.identifier),
                fixture.0.join("local").join(FOREIGN.identifier),
                fixture.0.join("home").join(FOREIGN.home_dir),
            ],
        };
        fixture.seed(&plan);
        fixture.seed(&foreign);
        let preserved = [
            "home/.claude/session.json",
            "home/.codex/auth.json",
            "home/.gemini/oauth.json",
            "home/custom-sessions/auth.json",
            "home/.tauri/quorb.key",
            "home/Downloads/installer.exe",
            "roaming/es.egdev.ai-usage/config.json",
            "local/es.egdev.ai-usage/history.json",
        ];
        for relative in &preserved {
            let file = fixture.0.join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "external synthetic fixture").unwrap();
        }
        assert_eq!(purge(&plan, || Ok(())), Ok(()));
        assert!(plan.roots.iter().all(|p| !p.exists()));
        assert!(foreign.roots.iter().all(|p| p.exists()));
        assert!(preserved.iter().all(|p| fixture.0.join(p).exists()));
        assert_eq!(purge(&plan, || Ok(())), Ok(())); // absent data is idempotent
    }
    #[test]
    fn credential_failure_preserves_all_files() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        fixture.seed(&plan);
        assert_eq!(
            purge(&plan, || Err(Failure::Credentials)),
            Err(Failure::Credentials)
        );
        assert!(plan.roots.iter().all(|p| p.exists()));
    }
    #[test]
    fn file_instead_of_root_aborts_before_credentials() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        fs::create_dir_all(plan.roots[0].parent().unwrap()).unwrap();
        fs::write(&plan.roots[0], "fixture").unwrap();
        assert_eq!(
            purge(&plan, || panic!("credentials must not be touched")),
            Err(Failure::Paths)
        );
    }
    #[test]
    fn credential_selector_is_exact_and_includes_owned_extra_accounts_only() {
        for key in crate::secrets::ALL {
            assert!(owned_target(
                &format!("{key}.{}", STABLE.identifier),
                STABLE.identifier
            ));
            assert!(!owned_target(
                &format!("{key}.{}", FOREIGN.identifier),
                STABLE.identifier
            ));
        }
        assert!(owned_target(
            "openrouter_api_key@openrouter:a1b2c3.es.egdev.quorb",
            STABLE.identifier
        ));
        for target in [
            "unknown.es.egdev.quorb",
            "nan_session.es.egdev.quorb.other",
            "nan_session.es.egdev.ai-usage",
            "nan_session@../../outside.es.egdev.quorb",
            "nan_session@unknown:a1b2c3.es.egdev.quorb",
            "nan_session@openrouter:.es.egdev.quorb",
            "nan_session@openrouter:a1b2c3@extra.es.egdev.quorb",
        ] {
            assert!(!owned_target(target, STABLE.identifier));
        }
    }
    #[cfg(unix)]
    #[test]
    fn linked_root_child_or_ancestor_never_reaches_external_data() {
        use std::os::unix::fs::symlink;
        for position in ["root", "child", "ancestor"] {
            let fixture = Fixture::new();
            let plan = fixture.plan();
            fixture.seed(&plan);
            let external = fixture.0.join("external");
            fs::create_dir(&external).unwrap();
            fs::write(external.join("keep"), "fixture").unwrap();
            match position {
                "root" => {
                    fs::remove_dir_all(&plan.roots[0]).unwrap();
                    symlink(&external, &plan.roots[0]).unwrap();
                }
                "child" => symlink(&external, plan.roots[0].join("link")).unwrap(),
                _ => {
                    let parent = plan.roots[0].parent().unwrap();
                    fs::remove_dir_all(parent).unwrap();
                    symlink(&external, parent).unwrap();
                }
            }
            assert_eq!(
                purge(&plan, || panic!("no credential mutation")),
                Err(Failure::Paths)
            );
            assert!(external.join("keep").exists());
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_junction_rejected_before_credential_or_external_data_mutation() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        fixture.seed(&plan);
        let external = fixture.0.join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("keep"), "fixture").unwrap();
        let link = plan.roots[0].join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&external)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "could not create synthetic junction fixture"
        );
        assert_eq!(
            purge(&plan, || panic!("no credential mutation")),
            Err(Failure::Paths)
        );
        assert!(external.join("keep").exists());
        fs::remove_dir(&link).unwrap();
    }
    #[test]
    fn unknown_identity_and_relative_roots_rejected() {
        let fixture = Fixture::new();
        let mismatched = Profile {
            identifier: STABLE.identifier,
            home_dir: FOREIGN.home_dir,
            name: "fixture",
            migrate_legacy: false,
        };
        for profile in [&FOREIGN, &mismatched] {
            assert!(Plan::new(profile, &fixture.0, &fixture.0, &fixture.0).is_err());
        }
        assert!(Plan::new(&STABLE, Path::new("relative"), &fixture.0, &fixture.0).is_err());
    }
}
