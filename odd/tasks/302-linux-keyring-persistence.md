# Linux credential persistence (#302)

Linux credentials are stored with `keyring` `linux-native` (kernel keyutils), which is in-memory and lost on reboot. Switch to keyutils + Secret Service persistence for 0.9.1.
Owner: @egdev6. Branch: `fix/302-linux-keyring-persistence`. Risk: items 2 (credential storage) and 5 (dependencies / CI).

## Specs

- S1. Problem (issue #302, keyring docs quoted): `linux-native` = «access to the `keyutils` storage on Linux»; keyutils «is completely in-memory and will not persist across reboots». README promises «on Linux, Secret Service».
- S2. Fix: in `src-tauri/Cargo.toml`, replace `linux-native` with `linux-native-sync-persistent` («Uses both `keyutils` and `sync-secret-service` for storage»), keeping `windows-native` and `apple-native` unchanged. Windows and macOS behavior and their `Cargo.lock` resolution must not change beyond what the feature switch requires. Choose the crypto/vendoring sub-features the crate requires for `sync-secret-service`, preferring system `libdbus` (no vendored C code) unless the crate docs require otherwise; justify the choice.
- S3. Existing keys stored in keyutils must still be readable after updating (until the next reboot), and nothing may be written in plain text or degrade silently: a missing Secret Service must surface as an explicit error, as today.
- S3b. Promotion: when a read finds a value only in keyutils (absent from Secret Service), Quorb copies it into Secret Service once, so users who update and then reboot without re-saving keep their keys. A failed promotion must not lose or change the keyutils value nor fail the read; it is retried on a later read. No value is ever logged. Promotion must never overwrite or resurrect a value saved or deleted concurrently through `set` (process-wide serialization of promotion and `set`; Quorb is single-instance), and Secret Service is checked at most once per key per process after a successful check or promotion, so plain reads do not trigger repeated Secret Service lookups or unlock prompts.
- S4. Tests: a Linux-only `#[ignore]` smoke, run in the isolated CI Secret Service environment (same `assert_smoke_isolation()` gate as `linux_secret_service_round_trip`), proving that after `set` the value is stored in Secret Service itself (read back through the crate's Secret Service store directly, not through the keyutils cache), plus deletion. Wire it into the existing "Secret Service smoke" step of `linux-ci.yml`. Existing tests keep passing (`cargo test --locked`, `npm test`).
- S5. Build dependencies: add what the new backend needs to compile (e.g. `libdbus-1-dev`, `pkg-config`) wherever Linux builds run: `.github/workflows/linux-ci.yml`, `.github/workflows/linux-pr-ci.yml`, `.github/workflows/linux-release.yml`, and the devcontainer/Makefile/docs dependency lists that enumerate Linux build packages. Keep actions pinned and inputs untouched.
- S6. Docs: correct the Linux secret-store wording in `README.md`, `README.es.md` and `docs/build-linux.md` (Secret Service persistent store with kernel keyutils as cache; requires a running Secret Service such as GNOME Keyring or KWallet).

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S2–S6, S3b | gentle-ai-worker | 986517e (ci deps), 14fa47f (fix + tests), cdaac14 (docs) |
| T2 | S1–S6 | gentle-ai-verify (Risk: items 2, 5) | verified twice (L5, L7) |
| T3 | — | parent: CI run of linux-ci with Secret Service smoke, PR | — |

## Log

- L1 (owner, after the evidence in #302 was presented: «¿Abro la issue del bug y arranco el arreglo para la 0.9.1?»): «si»
- L2 (parent): evidence — `src-tauri/Cargo.toml:39` `keyring = { version = "3", features = ["windows-native", "apple-native", "linux-native"] }`; `secrets.rs` uses `keyring::Entry::new` with no custom builder; the CI smoke is a same-process round trip and passes with keyutils. No workflow installs `libdbus-1-dev`.
- L3 (worker T1): keyring 3.6.3's default persistent builder only builds `SsCredential`; Quorb builds the combined credential explicitly. Existing keyutils-only values are readable until reboot but not promoted. `zbus`/`secret-service` appear in Cargo.lock but `cargo tree --target all` compiles neither (only `dbus-secret-service` 4.1.0). Parent checks: `npm test` exit 0 (vitest 1241, node 329), `cargo test --locked` 734 passed, `cargo fmt` ok.
- L5 (verify T2): S1–S6 and S3b pass, no blockers; Windows/macOS dependency trees identical to baseline; no vendored C. Advisories: promotion check-then-write race with concurrent `set`/delete (stale value or resurrected deleted key); every `get` now queries Secret Service (possible unlock prompt). Real Secret Service smokes need linux-ci.
- L6 (parent): S3b extended with serialization and once-per-key check to resolve both advisories.
- L4 (parent): added S3b (promotion on read) — without it, users who update to 0.9.1 and reboot before re-saving still lose their keys.
- L7 (re-verify T2): S3 and S3b met, no blockers. `cargo test --locked` 741 passed; race tests 20/20; 16-thread probe finished (no deadlock); poisoning recovered. Minor, follow-up: a dismissed unlock prompt is retried on every refresh; absent keys still search Secret Service each read; UI can wait on an open unlock prompt (lock held across the D-Bus call); legacy-service migration keeps its pre-existing check-then-write.
