# Code signing policy — Política de firma de código

[English](./code-signing.en.md) · [Política de privacidad](./privacy.md)

## Estado actual

Quorb tiene licencia MIT y su código es público. Windows y macOS ARM64 están en
[GitHub Releases](https://github.com/egdev6/quorb/releases).
Esta página describe la configuración de firma y la evidencia macOS observada a
**2026-10-31**; no certifica el estado actual de cuentas ni servicios externos.

El [workflow de release](../.github/workflows/release.yml) exige firma minisign de
Tauri para los artefactos del updater y crea un borrador desde un SHA validado.
Esa firma protege la integridad del updater; **no es Authenticode de Windows**.
El workflow no configura Authenticode para la app ni los instaladores; Windows
puede mostrar un aviso de editor desconocido. El runtime habilita el updater
nativo en Windows/Linux, sin que eso acredite releases Linux firmadas/publicadas.

En macOS, el updater es manual: no busca, descarga ni instala actualizaciones.
El [workflow de preview](../.github/workflows/macos-preview.yml) prepara una preview
sin Developer ID ni notarización; su configuración no prueba que se haya ejecutado
ni que exista una descarga o una GUI validada. Minisign no sustituye esos controles.

La [issue #20](https://github.com/egdev6/quorb/issues/20), aprobada como antecedente
de firma, no acredita una integración completada. Este documento no solicita
SignPath ni acredita patrocinio, certificado Authenticode, cumplimiento o cierre
de esa issue.

## Release macOS con Developer ID

[v0.8.0](https://github.com/egdev6/quorb/releases/tag/v0.8.0) publica el DMG ARM64
firmado/notarizado y `.dmg.sha256`, para **macOS 15+, Apple Silicon (M1+)**.
El [productor 41067808525](https://github.com/egdev6/quorb/actions/runs/41067808525)
preparó y envió el checkpoint. El [diagnóstico 41230153171](https://github.com/egdev6/quorb/actions/runs/41230153171)
confirmó `Accepted`, `jobId` `e7b22172-716e-4176-a023-2d1d916d6823` y SHA-256 del DMG enviado:
`224b37f9b3e6d134f7d408ed06995792af73fa05c41ee79eb2e20edc476800be`.
El [resume 41233474221](https://github.com/egdev6/quorb/actions/runs/41233474221)
completó verificación, stapling, staging final y publicación, incluido Gatekeeper
en el runner CI, no la prueba GUI en un Mac real.

El [workflow macOS separado](../.github/workflows/macos-release.yml), materializado
byte a byte desde `.github/security-drafts/macos-release.yml`, solo admite
`workflow_dispatch` desde `main`. Recibe una versión estable de la release Windows
ya existente (borrador permitido) y su SHA completo. Antes de acceder a secretos,
un job sin entorno de firma valida ref, versión de `package.json` en ese SHA,
ancestría en `origin/main`, release/tag y ausencia de colisiones de assets. Para
un borrador sin tag exige `target_commitish` igual al SHA completo, no una rama.
No modifica el workflow Windows ni crea releases o tags.

El job de firma depende de ese preflight y conserva el Environment protegido
`macos-signing` (reviewer `egdev6`, rama `main`), sin cambiar sus reglas. El build
solo recibe `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` y
`APPLE_SIGNING_IDENTITY`. Elimina del proceso hijo todas las credenciales
`APPLE_API_*`, `APPLE_ID`, `APPLE_PASSWORD` y `APPLE_TEAM_ID`: Tauri firma pero
omite su notarización automática. Build ARM64, mínimo macOS 15.0.

Verifica firmas Developer ID de app y DMG, autoridad y team `SRD8T33RU5`, y retiene
solo DMG firmado y manifiesto estricto **antes** de escribir `.p8` o enviar a Apple.
Checkpoint inmutable `macos-notary-checkpoint-<run_id>-<attempt>`, retención **14 días**.
Después envía el DMG exterior una vez sin `--wait`, guarda UUID y recibo separado
`macos-notary-receipt-<run_id>-<attempt>` con artifact ID/digest. **Terminar tras
submit es normal: no significa release completa.** No reintenta submit.
`APPLE_API_KEY_P8`, `APPLE_API_KEY` y `APPLE_API_ISSUER` solo llegan al step de envío;
clave exclusiva `0600` en `RUNNER_TEMP`, cleanup al salir y `always()`.

El [resume separado](../.github/workflows/macos-release-resume.yml) recibe run ID,
intento, versión y source SHA. Valida productor propio/main/workflow/SHA aprobado,
ID/digest ZIP autenticado, allowlist de extracción y manifiesto ligado a valores
externos antes de acceder a API Apple. No requiere certificado privado, recompila,
re-firma ni reenvía. `In Progress` o Accepted sin log disponible queda **pending**,
sin publicación; rechazo muestra issues saneados y falla. Accepted exige `jobId`
y `sha256` del log iguales al UUID y DMG original. Además del fixture sintético,
el diagnóstico real confirmó ese campo y el resume verificó el vínculo; ausente falla cerrado.

Solo grapa el DMG retenido, verifica firma/ticket y Gatekeeper, monta readonly con
plist real y valida la `Quorb.app` contenida (autoridad/team, bundle ID, versión,
ARM64, mínimo macOS, rutas/symlinks y Gatekeeper); siempre intenta desmontar. No
repaqueta la app. Calcula SHA256 final distinto del hash de entrada y digest ZIP.
El certificado documentado caduca **2027-11-28**, sin certificar su validez actual.

`publish` es **false** por defecto: dispatch no autoriza por sí solo publicación.
Solo `publish: true`, verificación Accepted y Environment aprobado habilitan el
job con `contents: write`; los demás jobs son de lectura. Revalida release ID y
colisiones; adjunta únicamente `Quorb_<version>_aarch64.dmg` y `.dmg.sha256`, sin
overwrite. Rollback solo borra el ID propio recién subido. No modifica
`latest.json` ni updater; las actualizaciones macOS siguen **manuales**.

Cancelación tras checkpoint puede recuperarse sin exigir run exitoso. Si submit
quedó ambiguo antes del recibo, investigar con diagnostics/history/info/log:
**no reenviar ni enlazar por nombre**. `submission_id` opcional solo autoriza
continuación si el log Apple coincide con UUID y hash retenido. Artifacts
caducados/borrados requieren decisión separada, no rebuild automático. Detalles
y pasos en [build-macos.md](./build-macos.md#release-macos-reanudable-operación-y-evidencia).

La evidencia nativa complementa los tests Linux simulados; no demuestra la primera
descarga por navegador, cuarentena, instalación ni GUI en un Mac real, pendientes
en [#118](https://github.com/egdev6/quorb/issues/118); no quitar cuarentena.
El éxito en CI no certifica validez universal o futura del certificado ni implica
secretos nuevos o cambios de Environment. Futuras ejecuciones y publicaciones
requieren autorización separada.

## Responsabilidades

El mantenedor es [Enrique Gómez Navarro (@egdev6)](https://github.com/egdev6).
Para una futura integración Authenticode hay que confirmar quién revisa las
contribuciones externas y quién aprueba cada solicitud; no se presenta aquí un
aprobador operativo de Authenticode. El entorno macOS se describe arriba.
MFA para el repositorio y el servicio de firma debe verificarse como requisito
previo: esta revisión local no comprueba que esté activado en ninguna cuenta.

## Compromisos de firma

Requisitos propuestos para una futura integración Authenticode, **no controles
ya implantados**:

- Firmar solo binarios propios compilados desde el repositorio público, no
  ejecutables de terceros como si fueran Quorb.
- Revisar contribuciones externas, incluidos scripts de build y CI.
- Vincular cada solicitud a una compilación automatizada verificable y su commit.
- Exigir aprobación manual del responsable confirmado para cada solicitud.
- Exigir producto `Quorb` y versiones coherentes en los metadatos.
- Verificar las firmas recibidas antes de publicar; generar firmas del updater y
  checksums sobre los artefactos finales con Authenticode, no los bytes anteriores.
- Mantener credenciales de firma fuera del repositorio y la aplicación.

Si SignPath aprueba el proyecto, publicar su atribución requerida en las páginas
principal y de descarga/release: «Free code signing provided by
[SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org)».
Es una **atribución futura**, no una declaración de patrocinio actual.

## Antes de solicitar o integrar

Confirmar licencias de dependencias, [privacidad](./privacy.md), avisos de instalación
y desinstalación frente a las [condiciones de SignPath](https://signpath.org/terms.html).
Verificar sus requisitos vigentes y publicar la política en las páginas principal
y de descarga/release antes de afirmar cumplimiento. Los enlaces externos no se
han comprobado por red. Integración y publicación requieren aprobación separada.

SignPath decide la aceptación; bajo esa modalidad, el editor sería SignPath
Foundation, no el mantenedor personalmente. Una firma válida no garantiza la
ausencia de todos los avisos de Windows.

## Contacto

[egdev6@gmail.com](mailto:egdev6@gmail.com) para dudas sobre firma o seguridad.
No incluyáis claves privadas, contraseñas ni tokens de proveedores.
