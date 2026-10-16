# Quorb macOS preview / Preview de macOS

Experimental ARM64 preview targeting macOS 15+. Download/install and GUI operation
are not yet validated on a real Mac. This is not a production release.
No Developer ID signing; not notarized. This does not rule out ad-hoc signing.
Only manual updates; no automatic updater or application expiry policy.

## EN — Get, verify, report

1. When an approved preview run succeeds, open its GitHub Actions page.
   GitHub login and repository read access are required, even for public artifacts;
   public-repository artifacts are not privately hidden from other authorized readers.
   Download `quorb-macos-preview-<full-source-SHA>` and extract the ZIP.
   Expect exactly one DMG, `manifest.json` and this `README.md`.
2. Check `manifest.sourceSha` against the run's full main commit SHA and
   `manifest.version` against that commit's `package.json`. Use the manifest version,
   not a version assumed from this static guide. Check `manifest.dmg.name` and size.
   In the extracted folder, replace the example filename with that manifest name:
   `shasum -a 256 'Quorb.dmg'`
   Compare the result with `manifest.dmg.sha256`, not the artifact ZIP digest.
   A matching hash proves integrity only: not proof of safety or notarization.
3. Preserve quarantine. If macOS blocks opening, stop and report the exact alert
   to the owner; consult https://support.apple.com/en-us/102445 before proceeding.
   Only if you independently trust the source, consider Apple's conditional manual
   exception for an unidentified developer/unnotarized app. No automatic bypass.
   A malware or damaged-app alert is NOT a normal unsigned-app warning: do not dismiss it.
4. Report the run URL, full SHA, version, Mac architecture, macOS version and exact
   alert/observed behavior, without credentials or personal data. Do not assume GUI works.

Artifacts expire after 14 days (not application expiry). If unavailable, ask the
owner for a new approved preview; do not substitute an unrelated download.
Real browser-download/quarantine and GUI smoke testing remain pending separate approval.

## ES — Obtener, verificar e informar

Inicio de sesión en GitHub y acceso de lectura necesarios, también en repos públicos.
Descarga el artifact del SHA completo; verifica versión/SHA del manifiesto y hash DMG
con el comando anterior. El hash no acredita seguridad ni notarización. Actualización manual.
No elimines la cuarentena. Ante bloqueo, detente, informa al responsable y consulta Apple;
una excepción manual solo es opcional si confías en la fuente. No ignores alertas de malware
ni de app dañada. Informa URL/SHA/versión, Mac/macOS y alerta exacta, sin datos personales.
Los 14 días limitan el artifact, no la vida de la app. Instalación y GUI siguen sin validar.
