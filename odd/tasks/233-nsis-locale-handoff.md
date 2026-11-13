# Issue #233 — NSIS language selector and one-shot installer-locale handoff (F0/F2/F3)
Branch: `feat/233-nsis-locale-handoff`; base: `52083f5`. Builds on F1 (PR #273: `ConfigOrigin`, Windows fresh-config picker gate).
Out of scope here: #271 (assigned to another contributor), native Windows installer runs (F4 manual evidence), signing/updater/release, macOS/Linux behavior.

## Specs

Source: owner-approved `quorb-233-language-v1`, https://github.com/egdev6/quorb/issues/233#issuecomment-6853931294, and the F0 decision in L2.

- S1: “NSIS interactivo pide una elección explícita ES/EN antes del resto del instalador; la detección del sistema no sustituye esa elección.”
- S2: “En una instalación nueva por NSIS, instalador y primer uso normal de la app respetan la elección; esta queda guardada antes de mostrar la UI normal y no aparece un segundo selector.”
- S3: “En una instalación nueva por MSI, el selector compartido aparece antes de la UI normal; elegir ES/EN se conserva y sigue siendo modificable desde Ajustes.”
- S4: “La instalación silenciosa/pasiva no abre diálogos de idioma; la primera apertura interactiva pregunta sólo cuando corresponda a una instalación nueva.”
- S5: “Actualizaciones/reinstalaciones conservan el idioma y los demás datos. Se mantiene la política actual para configuraciones legadas o ilegibles, sin tratarlas como nuevas.”
- S6: “El traspaso acepta sólo los idiomas soportados, no cruza usuarios/canales y no reutiliza elecciones abandonadas o canceladas.”
- S7: “Se mantienen ambos artefactos Windows y no cambia el comportamiento de primer inicio de macOS/Linux.”
- S8: “El instalador no reescribe `config.json` ni datos de la app. La app valida la elección y reutiliza `locale`, `localeSelected` y el arranque compartido.”
- S9 (F0, L2): Archivo de traspaso de un solo uso: “Solo al terminar bien una instalación interactiva, NSIS escribe $APPDATA\<bundle-id>\installer-locale con 'es' o 'en'. Al arrancar, la app lo lee y lo borra siempre; solo lo aplica (guarda locale + localeSelected, sin selector) si la config es nueva (Missing) y el valor es válido. Si se cancela o es silenciosa no se escribe nada, y una config existente nunca se pisa. No suma dependencias.”

## Tasks

- T1 | S1–S9 | parent inline + gentle-ai-explore | done | Mapped config dir (`%APPDATA%\es.egdev.quorb`, single stable channel), startup insertion after `config::load`, Tauri 2.12.1 NSIS template and installer tests. Commit: with T2.
- T2 | S2, S5, S6, S8, S9 | parent inline | done | `src-tauri/src/installer_locale.rs` (`take`/`apply`/`startup_config`) called from setup after migration. RED 6/7 failed (Linux/macOS preservation passed), GREEN 7/7, full library 591/0/8, fmt OK. Commit: `feat(i18n): consume the NSIS installer locale handoff on fresh Windows startup`.
- T3 | S1, S4, S6, S7, S9 | gentle-ai-worker (context backstop) | done | Installer: `bundle.windows.nsis.languages` ["English","Spanish"] + `displayLanguageSelector: true`; `NSIS_HOOK_POSTINSTALL` writes `$APPDATA\${BUNDLEID}\installer-locale` (`es` for $LANGUAGE 1034, else `en`; second line `${VERSION}`) only when not `${Silent}`, `$PassiveMode` <> 1 and `$UpdateMode` <> 1; in silent/passive/update it deletes a leftover handoff; `NSIS_HOOK_PREUNINSTALL` deletes the handoff outside update mode (abandoned choice). Never touch config.json. Keep existing uninstall data-protection hook semantics and tests; structural tests through file content. RED: 3/8 passed, 5 failed; GREEN: 26/26 passed; JSON parse passed. NSIS compilation unavailable. L4 limitations remain: passive can show the selector, and remembered language can skip it (S4 and S1 not fully satisfied).
- T4 | S1–S9 | parent inline + gentle-ai-verify | pending | Docs, i18n inventory, full checks, independent verification (Risk: item 3/5), PR.

## Log

L1 — User: “termina con la 233”.

L2 — F0 decision. Question: “F0: ¿cómo pasa el instalador NSIS el idioma elegido a la app?” User selected: “1. Archivo de traspaso de un solo uso (recomendado)” (text quoted in S9).

L3 — Design details within S9 (parent, from the T1 map): handoff format is two lines, locale then installer `${VERSION}`; the app accepts it only when the version equals its own `CARGO_PKG_VERSION` (bump keeps package.json and Cargo.toml in sync), so a choice left by an abandoned older install is never reused (S6). Files over 64 bytes or with extra lines are rejected; any read removes the file. Only Windows startup reads it; Linux/macOS never touch it (S7). A failed save of the applied choice falls back to the shared picker.

L4 — Tauri 2.12.1 template evidence (installer.nsi at tauri-cli-v2.12.1, MUI2 Localization.nsh): `displayLanguageSelector` runs `MUI_LANGDLL_DISPLAY` in `.onInit` before any page and before our hooks can act; it is skipped under `/S` (silent) and when HKCU `Installer Language` is remembered from an earlier install, but it is NOT skipped for `/P` (passive) when no language is remembered. Consequence for S4: a passive fresh install, or a passive upgrade from a version installed before this change, shows the language dialog once. The updater is not active (`createUpdaterArtifacts: false`), so passive runs are manual. Hooks cannot run before `.onInit`; avoiding this needs a custom NSIS template. Reported to the user at close as a decision, not hidden.

