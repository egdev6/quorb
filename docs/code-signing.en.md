# Code signing policy

[Español](./code-signing.md) · [Privacy policy](./privacy.en.md)

## Current status

Quorb is MIT-licensed and its source is public. Windows distribution is
referenced on [GitHub Releases](https://github.com/egdev6/quorb/releases).
This page describes configuration reviewed at `d097bc3`; it does not certify
published artifacts or the state of external accounts or services.

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
SignPath or establish sponsorship, a certificate, compliance or closure of that issue.

## Responsibilities

The maintainer is [Enrique Gómez Navarro (@egdev6)](https://github.com/egdev6).
Before integrating signing, confirm who reviews external contributions and who
approves each signing request; no operational approver is designated here.
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
