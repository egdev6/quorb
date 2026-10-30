# Code signing policy

[Español](./code-signing.md) · [Privacy policy](./privacy.en.md)

## Current status

Quorb is MIT-licensed and its source is public. Windows distribution is
referenced on [GitHub Releases](https://github.com/egdev6/quorb/releases).
This page describes signing configuration, including the new, unexecuted macOS
workflow; it does not certify published artifacts or the current state of
external accounts or services.

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

## macOS Developer ID release (execution pending)

The [separate macOS workflow](../.github/workflows/macos-release.yml), materialized
byte-for-byte from `.github/security-drafts/macos-release.yml`, accepts only
`workflow_dispatch` from `main`. It takes a stable version of an existing Windows
release (draft allowed) and its full source SHA. Before secrets are reachable,
a job without the signing environment validates the ref, `package.json` version
at that SHA, ancestry in `origin/main`, release/tag and absence of asset collisions.
For a draft without a tag, `target_commitish` must equal the full SHA, not a branch.
It does not modify the Windows workflow or create releases or tags.

The dependent signing job uses the protected `macos-signing` environment (reviewer
`egdev6`, deployment branch `main`). Its secrets are `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`,
`APPLE_API_KEY` and `APPLE_API_KEY_P8`. They are exposed only to the key preparation
and build/sign steps, never at job or workflow level. The `.p8` content is written
to a private `0600` file under `RUNNER_TEMP`, passed to Tauri as
`APPLE_API_KEY_PATH` and removed even after failure.

It builds the validated SHA for ARM64 with minimum macOS 15.0, signs with Developer
ID, notarizes and staples the DMG ticket. Before upload it requires
`codesign --verify --deep --strict`, the app's `Developer ID Application` authority
and team `SRD8T33RU5`, `spctl` assessment of the app and DMG, and
`xcrun stapler validate` on the DMG. The documented Developer ID certificate expires
on **2027-11-28**. After revalidating the release, it attaches only
`Quorb_<version>_aarch64.dmg` and its `.dmg.sha256` file without overwriting assets;
it does not modify `latest.json` or updater artifacts. macOS updates remain
**manual**.

**This workflow has not been executed yet.** Actual signing/notarization,
Gatekeeper validation of the downloaded DMG on a real Mac, and the first-open
check with quarantine from [#118](https://github.com/egdev6/quorb/issues/118) remain
pending. Do not remove quarantine to pass that check. Configuration does not prove
support, installation or GUI functionality; running the workflow, creating tags
or publishing assets requires separate approval.

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
