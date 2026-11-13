# Finish PR253 WSL review
Objective: finish the accepted PR253 review corrections, without merging. Branch: `sync/pr253-main`; baseline: `b79fd3c9972ff73bb50195685ba6eb63446b9f5f`; delivery: existing PR253 (`single-pr`).
Runners: direct local Vitest/TypeScript, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`, repository script tests; native Windows/live-login evidence stays distinct from Linux or synthetic tests.

## Specs

S1. Authorization: user said **“lo terminas?”**, accepting completion of the pending points for https://github.com/egdev6/quorb/pull/253.

S2. Accepted review, presence ordering: “Con dos respuestas controladas (llega primero `true` del segundo sondeo y luego `false` del primero) se entrega `[true, false]` en vez de `[true]`.” “Falta descartar respuestas de peticiones anteriores del mismo poller y un test que cubra esa secuencia.” Preserve current failure-to-unknown and stop/restart behavior through the exported poller.

S3. Accepted review, host compatibility: “El nombre de archivo estándar sigue siendo obligatorio también en host, así que `C:\work\auth-work.json` con un comando avanzado que genera ese archivo se rechaza antes de ejecutar.” “La restricción tiene sentido en el guest, pero en host rompe una configuración que antes funcionaba.” Preserve standard-file session-directory derivation and guest path validation.

S4. Accepted review, WSL normalization: “`is_wsl_command` sigue usando `program_of` de host antes del tokenizador POSIX, así que `'wsl' codex login` evade la detección.” “Conviene comprobar el mismo programa normalizado que después se ejecuta, y añadir ese caso al test.” Test detection and launch rejection without guest CLI probes; preserve host parsing and ordinary guest argv handling.

S5. Accepted review, synthetic laboratory safety: “GAP4 (`login.rs:2216-2294`) no la aporta.” “Es un test ignorado que ejecuta un shim del CLI con `wsl.exe` directamente, sin pasar por el lanzamiento del terminal de la app ni por un login interactivo.” Correct the identified problems: “si falla, imprime el contenido completo de `.credentials.json` en el log”; “usa una cuenta fija (`claude:w2`) en la distro que se le pase, sin aislarla”; “no borra el archivo antes de comprobar el marcador, así que un archivo de una ejecución anterior lo da por bueno.” Do not execute the unsafe existing laboratory or access real credential material.

S6. Accepted review, real acceptance evidence: “Para cerrar #92 sigue haciendo falta evidencia censurada de un login real de una cuenta adicional dentro de la distro con este flujo.” A shim, compiled ignored test, or file-presence check is not real interactive login proof. Never read, print, copy, transmit, or commit secrets or private credentials.

## Tasks

- T1 | S2 | gentle-ai-worker (runtime context backstop after parent authored RED cases) | done | commit: f1dbcdb07fb61b5138843af176561d3c679e57f6 | RED: 2 stale-result/rejection failures (then 4 with added overlap coverage); GREEN: focused 23/23, frontend 1028/1028, typecheck; diff check OK | Risk: item 4 (ordering concurrent poll responses).
- T2 | S3 | gentle-ai-worker (runtime context backstop; sequential login.rs ownership) | done | commit: pending recording after commit | RED: 3 passed/1 failed; GREEN: 4 main-account tests, 48 login tests, fmt/diff OK | Risk: item 3 (restore advanced host configuration compatibility).
- T3 | S4 | inline parent (same login module ownership) | pending | commit: pending | RED/GREEN: pending | Risk: item 2 (normalized WSL execution guard).
- T4 | S5 | inline parent (same login module ownership) | pending | commit: pending | synthetic safety checks: pending | Risk: item 2 (prevent credential exposure and isolate test effects).
- T5 | S1-S5 | parent suites, then one independent gentle-ai-verify over the final correction slice | pending | commit: pending | focused/full suites, typecheck, shared-path differential, inventory, Windows applicability: pending.
- T6 | S6 | human-assisted real Windows/WSL login with the identified candidate | pending | commit: not applicable | real sanitized login evidence: pending after the candidate exists.

## Log

L1. Original current request, verbatim: “lo terminas?” Previous request, verbatim: “esta pr estaba lista para merge? https://github.com/egdev6/quorb/pull/253”.

L2. Accepted context is the four outstanding points in the preceding answer, not approval or merge. Parent response: “Sí. Voy a corregir los puntos pendientes y verificar la PR. Si falta una prueba de login real que requiera tu intervención, te voy a indicar exactamente qué validar. No la mergeo.”

L3. Exploration: configured read-only explorer `mwf5zlaq-2-oxlf` mapped the corrections. Parent read the exact accepted formal review from `/home/egdev/proyectos/quorb-review-253-272.eAGPDL/pr253/review-body.md`. GitHub refresh job-2 confirmed OPEN, head b79fd3c9972ff73bb50195685ba6eb63446b9f5f, maintainerCanModify=true, BLOCKED/CHANGES_REQUESTED, head repository sosan/quorb, branch feat/wsl-login-92. Worktree `/home/egdev/proyectos/quorb-pr253-sync` is clean and registered. Canonical main is stale and is not modified.

L4. Classification: large because the original short request and a code diff alone cannot recover the accepted historical review or external real-login proof. Estimated correction slice about 400 authored changed lines, excluding generated inventory; keep coherent behavioral commits in the already-open PR. No parallel writer: poller fix is a small unit; Rust corrections and laboratory share login.rs. Parent owns all source edits. RDD is off; no native assessment or native review is started. Named risks 2/3/4 require one independent verifier after implementation.

L6. Runtime context backstop fired after the parent added the two overlapping-poll regression cases, before running them. Delegate the remaining T1 reads/RED/fix/checks to the bounded worker; future multi-step units use the same trigger. Parent retains tracking, commits and the final seam check. No writer has run yet.

L7. Worker mwf680uh-3-e5hn returned interaction_required before running RED: the symlinked node_modules cache/config-loader writes would be outside its Allowed edit surfaces. No worker source edits and zero tests run; preliminary git diff --check passed. Worker proposed A: replace exact Vitest commands with --no-cache --configLoader runner, or B: stop. This is a user-facing blocking envelope, so the parent relays it without selecting for the human; no dependent work starts. Existing cache is preserved.

L8. Human selected the closed-envelope answer “A — Replace the RED and GREEN commands” (opaque value A). The replacement uses --no-cache --configLoader runner for both Vitest commands, preserving the timeout and subsequent diff check. Return T1 to in_progress and deliver this answer exactly once to the same finished worker. No child is active or uncertain: the worker returned its final interaction_required result.

L5. Verification policy: observe one meaningful RED per requested deterministic rule, then GREEN and existing touched-path coverage. Run a scratch differential against b79fd3c for unrequested behavior sharing changed helpers; do not commit history-dependent tests. Use existing on-disk Cargo target (not the previously exhausted /tmp target). Do not run the unsafe GAP4 or inspect actual credential files. Tests use synthetic, isolated data only; real login remains a separate human action.

L9. T1 completed by worker mwf6hlhl-4-28zw: RED exit1 with the two reported stale-order failures, expanded RED four failures; GREEN exit0, focused23/frontend1028 (76 files), TypeScript OK, diff check OK. Parent inspected the full T1 diff and committed f1dbcdb07fb61b5138843af176561d3c679e57f6. T2 starts with narrow sequential ownership of login.rs. Final independent verification remains T5.

L10. Delivery slice starts at b79fd3c9972ff73bb50195685ba6eb63446b9f5f; T1 correction133 authored changed lines including tracking. Runtime's2417-line branch warning includes114 inherited PR commits, not only these corrections. Preserve the accepted existing-PR single-pr strategy; no new PR chain or merge is created.
