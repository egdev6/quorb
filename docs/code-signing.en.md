# Code signing policy

[Español](./code-signing.md) · [Privacy policy](./privacy.en.md)

## Current status

Quorb is MIT-licensed and its source is public. Windows and macOS ARM64 are on
[GitHub Releases](https://github.com/egdev6/quorb/releases).
This page describes signing configuration and macOS evidence observed as of
**2026-10-31**; it does not certify the current state of external accounts or services.

The [release workflow](../.github/workflows/release.yml) requires Tauri minisign
signing for updater artifacts and creates a draft from a validated SHA.
That signature protects updater integrity; **it is not Windows Authenticode**.
The workflow does not configure Authenticode for the app or installers; Windows
may show an unknown-publisher warning. The runtime enables the native updater
on Windows/Linux, which does not establish signed/published Linux releases.

On macOS, updates are manual: the updater does not check, download or install.
The [preview workflow](../.github/workflows/macos-preview.yml) prepares a preview
without Developer ID or notarization; its configuration does not prove execution,
an available download or validated GUI. Minisign does not replace those controls.

[Issue #20](https://github.com/egdev6/quorb/issues/20), approved as signing background,
does not establish a completed integration. This document does not apply to
SignPath or establish sponsorship, an Authenticode certificate, compliance or
closure of that issue.

## macOS Developer ID release

[v0.8.0](https://github.com/egdev6/quorb/releases/tag/v0.8.0) includes the signed,
notarized ARM64 DMG and `.dmg.sha256`, for **macOS 15+, Apple Silicon (M1+)**.
[Producer 41067808525](https://github.com/egdev6/quorb/actions/runs/41067808525)
prepared and submitted the checkpoint. [Diagnostics 41230153171](https://github.com/egdev6/quorb/actions/runs/41230153171)
confirmed `Accepted`, `jobId` `e7b22172-716e-4176-a023-2d1d916d6823` and submitted-DMG SHA-256:
`224b37f9b3e6d134f7d408ed06995792af73fa05c41ee79eb2e20edc476800be`.
[Resume 41233474221](https://github.com/egdev6/quorb/actions/runs/41233474221)
completed verification, stapling, final staging and publication, including
Gatekeeper on the CI runner, not a real-Mac GUI test.

The [separate macOS workflow](../.github/workflows/macos-release.yml), materialized
byte-for-byte from `.github/security-drafts/macos-release.yml`, accepts only
`workflow_dispatch` from `main`. It takes a stable version of an existing Windows
release (draft allowed) and its full source SHA. Before secrets are reachable,
a job without the signing environment validates the ref, `package.json` version
at that SHA, ancestry in `origin/main`, release/tag and absence of asset collisions.
For a draft without a tag, `target_commitish` must equal the full SHA, not a branch.
It does not modify the Windows workflow or create releases or tags.

The dependent signing job retains the protected `macos-signing` environment
(reviewer `egdev6`, branch `main`), without changing its rules. The build receives
only `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and
`APPLE_SIGNING_IDENTITY`. Its child environment removes all `APPLE_API_*`,
`APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` credentials: Tauri signs but skips
automatic notarization. Builds target ARM64 and minimum macOS 15.0.

After verifying app and DMG Developer ID signatures, authority and team
`SRD8T33RU5`, it retains only the signed DMG and strict manifest **before** writing
any `.p8` or submitting to Apple. Immutable checkpoint:
`macos-notary-checkpoint-<run_id>-<attempt>`, retention **14 days**. It then submits
the outer DMG once without `--wait`, storing the UUID and a separate
`macos-notary-receipt-<run_id>-<attempt>` with checkpoint artifact ID/digest.
**Stopping after submit is normal, not a completed release.** No submit retries.
Only the submit step receives `APPLE_API_KEY_P8`, `APPLE_API_KEY` and
`APPLE_API_ISSUER`; exclusive `0600` key under `RUNNER_TEMP`, cleanup on exit and
`always()` fallback. No secrets at job/workflow level.

The [separate resume workflow](../.github/workflows/macos-release-resume.yml)
accepts producer run ID, attempt, version and source SHA. Before Apple credentials,
it authenticates own-repository/main/workflow/approved-SHA provenance, fatal ZIP
digest, extraction allowlist and manifest against external trusted values. It
needs no private Developer ID certificate and never rebuilds, re-signs or
resubmits. `In Progress` or Accepted without an available log is **pending**, with
no publication; rejection reports sanitized issues and fails. Accepted requires
Apple log `jobId` and `sha256` to match the UUID and original DMG. Beyond the synthetic
fixture, real diagnostics confirmed that field and resume verified the binding; absence fails closed.

It staples only the retained DMG, checks signature/ticket and Gatekeeper, mounts
readonly using a real plist parser, and verifies the contained `Quorb.app`
(authority/team, bundle ID, version, ARM64, minimum OS, paths/symlinks and
Gatekeeper). It always attempts detach, never repackages the app. Final SHA256 is
separate from input DMG hash and artifact ZIP digest. The documented certificate
expires **2027-11-28**, without asserting current validity.

`publish` defaults to **false**: dispatch alone is not publication authorization.
Only explicit `publish: true`, verified Accepted outcome and Environment approval
enable the sole `contents: write` job; other jobs are read-only. It revalidates
release ID and asset collisions and attaches only `Quorb_<version>_aarch64.dmg`
and `.dmg.sha256` without overwrite. Rollback can delete only its own newly
uploaded asset ID, never preexisting names. No `latest.json` or updater changes;
macOS updates remain **manual**.

A canceled producer with a valid checkpoint is recoverable without an overall
successful run. If interrupted submit is ambiguous before receipt persistence,
investigate via diagnostics/history/info/log: **never resubmit or link by name**.
Optional recovery `submission_id` authorizes continuation only after Apple log
UUID/hash binding. Expired/deleted artifacts require a separate recovery decision,
not an automatic rebuild. See [the operational guide](./build-macos.md#release-macos-reanudable-operación-y-evidencia).

Native evidence complements the simulated Linux tests; first browser download,
quarantine, installation and GUI on a real Mac remain pending in
[#118](https://github.com/egdev6/quorb/issues/118); do not remove quarantine.
CI success does not certify universal or future certificate validity, nor imply
new secrets or Environment changes. Future runs and publication require separate
approval.

## Responsibilities

The maintainer is [Enrique Gómez Navarro (@egdev6)](https://github.com/egdev6).
For a future Authenticode integration, confirm who reviews external contributions
and who approves each signing request; no operational Authenticode approver is
designated here. The macOS environment is described above.
MFA for the repository and signing service must be verified as a prerequisite:
this local review does not check whether it is enabled on any account.

## Signing commitments

Proposed requirements for a future Authenticode integration, **not controls
already implemented**:

- Sign only project-owned binaries built from the public repository, not
  third-party executables as if they were Quorb.
- Review external contributions, including build scripts and CI.
- Bind each request to a verifiable automated build and its source commit.
- Require manual approval by the confirmed responsible person for each request.
- Enforce product name `Quorb` and consistent version metadata.
- Verify returned signatures before publishing; produce updater signatures and
  checksums from final Authenticode-signed artifacts, not earlier bytes.
- Keep signing credentials out of the repository and application.

If SignPath approves the project, publish its required attribution on the home
and download/release pages: “Free code signing provided by
[SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org)”.
This is **future attribution**, not a statement of current sponsorship.

## Before applying or integrating

Confirm dependency licenses, [privacy](./privacy.en.md), installation disclosures
and uninstall behavior against [SignPath's conditions](https://signpath.org/terms.html).
Verify current requirements and publish the policy on the home and download/release
pages before claiming compliance. External links have not been checked over the
network. Integration and publication require separate approval.

SignPath decides acceptance; under that arrangement, the publisher would be
SignPath Foundation, not the maintainer personally. A valid signature does not
guarantee the absence of every Windows warning.

## Contact

[egdev6@gmail.com](mailto:egdev6@gmail.com) for signing or security concerns.
Do not include private keys, passwords or provider tokens.
