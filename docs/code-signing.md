# Code signing policy — Política de firma de código

[English](./code-signing.en.md) · [Política de privacidad](./privacy.md)

## Estado actual

Quorb tiene licencia MIT y su código es público. La distribución Windows se
referencia en [GitHub Releases](https://github.com/egdev6/quorb/releases).
Esta página describe la configuración de firma, incluido el nuevo workflow macOS
no ejecutado; no certifica artefactos publicados ni el estado actual de cuentas
o servicios externos.

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

## Release macOS con Developer ID (pendiente de ejecución)

El [workflow macOS separado](../.github/workflows/macos-release.yml), materializado
byte a byte desde `.github/security-drafts/macos-release.yml`, solo admite
`workflow_dispatch` desde `main`. Recibe una versión estable de la release Windows
ya existente (borrador permitido) y su SHA completo. Antes de acceder a secretos,
un job sin entorno de firma valida ref, versión de `package.json` en ese SHA,
ancestría en `origin/main`, release/tag y ausencia de colisiones de assets. Para
un borrador sin tag exige `target_commitish` igual al SHA completo, no una rama.
No modifica el workflow Windows ni crea releases o tags.

El job de firma depende de ese preflight y usa el entorno protegido
`macos-signing` (aprobador `egdev6`, rama de despliegue `main`). Los secretos son
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_API_ISSUER`, `APPLE_API_KEY` y `APPLE_API_KEY_P8`. Solo se exponen en los
steps de preparación de clave y build/firma, nunca a nivel de job o workflow.
El contenido `.p8` se escribe en un archivo privado `0600` dentro de `RUNNER_TEMP`,
se entrega a Tauri como `APPLE_API_KEY_PATH` y se elimina incluso si hay un fallo.

Compila el SHA validado para ARM64 con mínimo macOS 15.0, firma con Developer ID,
notariza y pega el ticket al DMG. Antes del upload exige `codesign --verify --deep
--strict`, autoridad `Developer ID Application` y team `SRD8T33RU5` de la app,
evaluación `spctl` de app y DMG, y `xcrun stapler validate` del DMG. El certificado
Developer ID documentado caduca el **2027-11-28**. Tras revalidar la release,
adjunta únicamente `Quorb_<version>_aarch64.dmg` y su archivo `.dmg.sha256`, sin
sobrescribir assets; no modifica `latest.json` ni artefactos del updater.
Las actualizaciones de macOS siguen siendo **manuales**.

**El workflow todavía no se ha ejecutado.** La firma/notarización real, la
validación Gatekeeper del DMG descargado en un Mac real y la primera apertura con
cuarentena de [#118](https://github.com/egdev6/quorb/issues/118) siguen pendientes.
No se debe quitar la cuarentena para dar por superada esa prueba. Esta
configuración no demuestra soporte, instalación ni GUI; ejecutar el workflow,
crear tags o publicar assets requiere aprobación separada.

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
