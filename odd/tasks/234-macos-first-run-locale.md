# #234 — macOS first-run locale selection
Branch: `feat/234-macos-first-run-locale`; baseline: `2da297d1e32e7c60f28fcbf7b151ce2eefed9d3f`; delivery: `ask-on-risk`, one cohesive unit, implementation unit: 180 authored changed lines, including tracking.
Checks: Cargo unit tests, Vitest/Node, TypeScript, formatting, i18n inventory; native macOS acceptance is separate.

## Specs

- **S1 — Resume and coordinate (user, verbatim):** «Retomemos Quorb #234. Recupera el handoff de Engram 7140, reconcilia el estado actual y coordina el reparto con la sesión de apoyo 01a1d049-109d-7252-bc0d-7c7caf8c9b1a antes de empezar».
- **S2 — Approved implementation (user, verbatim):** «me parece correcto adelante». The accepted scope is the upstream #234 agreement identified in L2; this approval does not add new installer, translation, provider, or release work.
- **S3 — Feature branch:** Keep the work on `feat/234-macos-first-run-locale`.
- **S4 — Verification and commit restriction (user, verbatim):** «autorizo al nuevo intento y no comitees hasta que yo haga la prueba visual».
- **S5 — Deferred translation issue (user, verbatim):** «memoriza lo de la traducción para generar una issue cuando terminemos».
- **S6 — ODD tracking:** Maintain the feature document, Engram recovery copy and visible task projection.

## Tasks

- **T1 [S1, S3, S6] — done — parent:** Reconcile scope, feature branch and support agreement; create truthful ODD tracking and Engram mirror. Commit: `bd3af49`.
- **T2 [S2] — done — writer `mwdp1m9u-2-6xuh`, parent integration:** Extend locale eligibility to macOS, preserve Linux/Windows policy, tests and macOS documentation. Evidence: RED/GREEN and 66 additions / 13 deletions across two files, detailed in L4. Commit: `bd3af49`; human visual acceptance confirmed in L8.
- **T3 [S2, S4] — done — independent verifier `mwdpp1ev-5-pegr`, parent spot-check:** Verify isolated automated behavior. Evidence: 16 tests passed and typecheck passed; previous preparation failure remains recorded in L5. Commit: `bd3af49`.
- **T4 [S2, S4] — done — human visual acceptance:** Initial picker, persistence, close-without-choice, surface order and Settings language changes confirmed by the human in L6/L8. No reinstall was performed. Commit: `bd3af49`.
- **T5 [S2] — done — parent:** Inventory generated with the canonical scanner/renderer from the staged source blobs, then CLI-checked against the committed candidate, exit 0. Header-only hash refresh; texts unchanged. Commit: `bd3af49`.
- **T6 [S5] — blocked — parent:** Await explicit confirmation to discover duplicates and publish the separate Claude error i18n issue to `github.com/egdev6/quorb` as `ludevdot`, per issue-creation policy. Do not mix its fix into this feature. Commit: not applicable.

## Log

### L1 — Original request (verbatim)

> Retomemos Quorb #234. Recupera el handoff de Engram 7140, reconcilia el estado actual y coordina el reparto con la sesión de apoyo 01a1d049-109d-7252-bc0d-7c7caf8c9b1a antes de empezar

### L2 — Reconciled scope and coordination

Engram handoff 7140 and support map 7142 were read. Upstream issue: https://github.com/egdev6/quorb/issues/234. Proposal: https://github.com/egdev6/quorb/issues/234#issuecomment-6827052716. Owner approval: https://github.com/egdev6/quorb/issues/234#issuecomment-6827094767, literal «me parece correcto @ludevdot ». At revalidation the issue was OPEN, assigned only to authenticated user `ludevdot`, with local/upstream main both at the baseline above. No open PR dedicated to #234 was identified; overlapping file surfaces of other open PRs were not established.

Accepted upstream scope: keep DMG; explicit Español / English as the first own UI on fresh macOS launch, before normal surfaces; reuse existing persistence/application flow; preserve an existing choice across reinstall/upgrade with configuration retained; retain Settings language changes. OS dialogs are external. Windows/Linux behavior must not change. New installer, complete translation work, credentials/providers, signing/notarization/publication are excluded.

Support session `01a1d049-109d-7252-bc0d-7c7caf8c9b1a` explicitly accepted a read-only lifecycle/risk-map role and completed it. Parent accepted integration, implementation, tests, docs and verification coordination. Support is now standby with no task. It did not substitute for required independent verification.

### L3 — Work unit and branch

The parent owns integration, and the bounded writer owns the implementation unit. Implementation is committed on `feat/234-macos-first-run-locale` as `bd3af49`. The work unit includes `src-tauri/src/lib.rs`, `docs/build-macos.md`, `docs/i18n-inventory.md` and this feature document. No remote delivery has occurred.

### L4 — Implementation and writer evidence

`locale_picker_needed_on(os, cfg)` admits macOS and Linux only before an explicit choice; the production wrapper uses `std::env::consts::OS`, and setup calls that wrapper. Tests cover fresh macOS, fresh/chosen platform policy and compiled-host wiring. Existing picker, save-before-main-UI pipeline, second-instance routing and deferred window/tray creation are reused unchanged. No new Reopen handler or native-menu translation was introduced. The reported Reopen concern was conditional on introducing a handler, not a reproduced current bypass.

Worker first ended by stall timeout without its final report. Evidence-only continuation `mwdpdhxb-3-urfa` recovered observed results without rerunning anything:
- RED: `cargo test locale_picker -- --nocapture`, exit 101, 1 passed / 1 failed; runnable fresh-macOS assertion against the old helper's macOS input, not a GUI test.
- GREEN: same focused command, exit 0, 3 passed.
- `cargo test`: exit 0, 561 passed / 1 ignored out of 562; ignored Linux desktop-session diagnostic. Main/doc targets had zero tests.
- `npm test`: exit 0, 988 Vitest tests / 75 files, plus 298 Node tests. Nonfatal duplicate ZIP fixture warning.
- Typecheck, inventory check against existing HEAD, formatting and diff whitespace: exit 0. The inventory check did NOT cover the uncommitted Rust tree.
- One helper-level differential compared Linux/Windows policy against the baseline, exit 0. Its second-instance label stub incorrectly used `locale-picker` instead of production `locale`; printed label output is not production-label proof. No differential retry was performed. Actual constants and the unchanged routing test were subsequently independently inspected/executed.

Risk: item 3 — shared startup eligibility also serves Linux/Windows. No GUI execution by any agent.

### L5 — Independent verification and assessment

Native assessment: RDD on, native medium, high verification tier through item-3 agent escalation; `reviewDue: false`, under budget, `independentVerifier: true`. No native inspect/start/consent/lineage or review capture was run. This assessment is not a review approval or delivery grant.

First verifier `mwdpg4hy-4-2hxq` failed in its preparation helper: Python `import tomllib` raised `ModuleNotFoundError`, exit 1. Zero tests, no scratch directory. This was a verifier setup defect, not a Quorb failure or a successful independent check. No automatic retry followed.

Human then explicitly authorized one new attempt and prohibited commits until visual testing. The parent removed the auxiliary tomllib prerequisite, established payload/dependencies/capacity and confirmed no active/uncertain children. New verifier `mwdpp1ev-5-pegr` prepared once, offline in isolated state, then ran all authorized checks successfully:
- Locale policy: 3 passed.
- Deferred-widget creation: 1 passed.
- Second-instance target: 1 passed, using actual production labels.
- LocalePicker frontend: 11 passed.
- TypeScript: exit 0.

Total: 16 independent tests passed, zero failed. Native surface order, actual locale application and reinstall are not proved by these unit tests. Final parent spot-check `npm run typecheck` and `git diff --check`: exit 0. The previous failed attempt remains failed.

### L6 — Human visual observations and remaining acceptance

User report, verbatim:

> al arrancar abre el selector de idioma
> al reabrir la misma isntancia, mantiene el idioma seleccionado
> al abrir instancia nueva, abre selector, si cierro sin seleccionar y reabro, vuelve a aparecer el selector de idioma.

These observations followed a guide using temporary HOME directories. They support initial picker, persisted choice with reused configuration, and closing without selecting. They do not establish native single-instance/Dock behavior, update/reinstall, every surface's ordering, or Settings language changes. Capture `/Users/ludev/Desktop/locale-error.png` was read only; it shows an English panel with an existing Spanish backend error. No image was copied into Git or published.

Subsequent human confirmation of surface order and Settings persistence is recorded in L8. No native reinstall/upgrade exercise is claimed. Agents did not start the app or reset real preferences.

### L7 — Deferred pre-existing translation defect

With English selected, Claude's missing-credentials error remains Spanish. Source: `src-tauri/src/providers/mod.rs:477` and `src-tauri/src/providers/claude.rs` append the hardcoded Spanish text. Both literals were confirmed in the baseline commit, so this is existing Quorb i18n debt, not a macOS-provided message or a #234 regression. The temporary credentials path does not prove that an old Claude Code installation was detected.

User instruction, verbatim:

> memoriza lo de la traducción para generar una issue cuando terminemos

Follow up after #234; check duplicates first, redact paths as `<test-home>`, and do not publish the original desktop capture by inference. No fix is authorized inside #234.

### L8 — Human visual acceptance

User confirmation, verbatim:

> 1. Que antes de elegir no aparece la tira, el panel ni la bandeja. (confirmado)
> 2. Que desde Ajustes puedes cambiar entre Español e English y se conserva al reiniciar.(confirmado)

Together with L6, this completes the requested development-run visual acceptance. It does not claim a DMG reinstall or upgrade exercise. The restriction against committing before visual testing is satisfied. Inventory refresh and local work-unit commit completed on the feature branch; no remote delivery is inferred.

### L9 — Local delivery and inventory evidence

Commit `bd3af4999d7bf1fa95a7810694c5cf18ec028c15` — `feat(macos): choose language before first-run interface` — contains the four expected paths, 166 additions / 14 deletions. Staging guards confirmed the exact feature branch and paths; whitespace checks passed. The canonical inventory scanner/renderer consumed the staged Rust blob and actual staged source-tree hashes without a temporary commit. Only the generated hash header changed; texts and totals did not. After commit, `node scripts/i18n-inventory.mjs --check` passed against HEAD.

Source trees: `src/` = `c74ee76d4442caa2381254aa550cd15dbeb9254e`; `src-tauri/src/` = `2a94ec7b848fea1770c301516b7bc8b88daefdc7`.

Committed-range native assessment against baseline: native medium, high verification tier from item-3 escalation, independent verification already completed for this unchanged source candidate, `reviewDue: false` (`under_budget`). No native review was started; no review approval or consumed authority is claimed. No DMG build/install, Linux/Windows GUI exercise, push, PR or merge was performed. The follow-up translation issue remains separate and awaits destination/session confirmation.
