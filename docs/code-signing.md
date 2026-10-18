# Code signing policy — Política de firma de código

[English](./code-signing.en.md) · [Política de privacidad](./privacy.md)

## Estado actual

Quorb tiene licencia MIT y su código es público. La distribución Windows se
referencia en [GitHub Releases](https://github.com/egdev6/quorb/releases).
Esta página describe la configuración revisada en `d097bc3`, no certifica
artefactos publicados ni el estado de cuentas o servicios externos.

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
SignPath ni acredita patrocinio, certificado, cumplimiento o cierre de esa issue.

## Responsabilidades

El mantenedor es [Enrique Gómez Navarro (@egdev6)](https://github.com/egdev6).
Antes de integrar firma hay que confirmar quién revisa contribuciones externas y
quién aprueba cada solicitud de firma; no se presenta aquí un aprobador operativo.
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
