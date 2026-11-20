# Linux release attach (v0.9.0)

Manual workflow that builds the Linux `.deb` and `.AppImage` from an existing release's exact source commit and attaches them to that release, so v0.9.0 gets an official Linux installer without a new version.
Owner: @egdev6. Branch: `ci/linux-release-attach`. Risk: item 5 (release delivery / CI).

## Specs

- S1. Goal, from the owner: «hay que sacar la 0.10.0 para poder oficializar el instalador de linux? no podemos arreglar lo que queda e inclurlo en la 0.9.0?» → Linux installers are attached to the already published `v0.9.0`; no new version.
- S2. Accepted proposal («haz el workflow»): a new `.github/workflows/linux-release.yml`, following the macOS pattern:
  - manual `workflow_dispatch` only, from `main`, with inputs `version` and `source_sha`;
  - verifies the release already exists;
  - checks out that exact commit;
  - builds the `.deb` and `.AppImage` on Ubuntu;
  - attaches them to the release without overwriting anything.
- S3. Reuse what already works: the Linux system dependencies, build and clean-container verification steps of `linux-ci.yml` (`Install Tauri 2 Linux system dependencies`, `Build Linux bundles (deb + AppImage)`, `Verify bundles in clean Ubuntu 22.04` / `scripts/verify-linux-bundles`), on `ubuntu-22.04` like `linux-ci.yml`.
- S4. Safety, mirroring `macos-release.yml` / `scripts/macos-release-preflight.mjs` / `scripts/macos-release-resume-publish.mjs`:
  - refuse unless `github.ref == refs/heads/main`;
  - validate `version` (stable SemVer) and `source_sha` (40 lowercase hex, ancestor of `origin/main`, manifests at that SHA declare `version`) before building;
  - the release `v<version>` must already exist (published or draft) and its tag must point to `source_sha`;
  - inputs reach shell only through `env`, never interpolated into `run:`;
  - actions pinned by full SHA as in the existing workflows; `permissions: contents: read` at workflow level, `contents: write` only in the attach job; no other secrets than `GITHUB_TOKEN`;
  - never create or move tags, never edit the release body, never touch `latest.json` or updater files;
  - attach only `Quorb_<version>_amd64.deb`, `Quorb_<version>_amd64.AppImage` and one `.sha256` per file; if any of those names already exists on the release, fail without overwriting; on a partial upload failure, delete only the assets this run uploaded.
- S5. Tests in the repo's existing style (`node --test`, like `scripts/macos-release-workflow.test.mjs` and `scripts/macos-release-preflight.test.mjs`): structural workflow assertions (trigger, ref guard, permissions, pinned actions, no input interpolation, attach-only names) and unit tests of the preflight/attach scripts, wired into `npm test`.
- S6. Document how to run it (inputs, what it attaches, manual updates on Linux, AppImage FUSE caveat) in `docs/release-linux.md`.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S2–S6 | gentle-ai-worker | c04641a, 5bac5ea, 5bd5fdc |
| T2 | S1–S6 | gentle-ai-verify (Risk: item 5) | fix in this commit |
| T3 | S1 | parent, after the owner runs the workflow: release notes, README Linux row | — |

## Log

- L1 (2026-11-20, owner): «habría que añadir los links de descarga de linux al readme. Puedes hacer que los links descarguen la latest y no haya que cambiarlo manualmente en cada despliegue? Hazte pull antes»
- L2 (owner): «el instalador ya está para linux no? que la descarga apunte a él» — evidence: no release v0.1.1–v0.9.0 has Linux assets; `release.yml` is Windows-only; Linux bundles are private `linux-ci.yml` artifacts.
- L3 (owner): «a ver aclarémonos...hay que sacar la 0.10.0 para poder oficializar el instalador de linux? no podemos arreglar lo que queda e inclurlo en la 0.9.0?»
- L4 (owner): «haz el workflow»
- L5 (verify): S3–S6 pass; B1 blocker: `runner.temp` in job-level `env:` (not allowed by GitHub). `scripts/verify-linux-bundles` does not exist; `.testcontainer` (used by linux-ci) is the equivalent.
- L6 (parent): B1 fixed (build: `$RUNNER_TEMP` via `$GITHUB_ENV`; attach: step-level env, keeping a single `run:`), regression test added (RED then GREEN). Focused 21/21, `npm test` exit 0 (vitest 1241, node 329), actionlint v1.7.7 exit 0. Slices: c04641a (preflight), 5bac5ea (attach), 5bd5fdc (workflow + docs).
