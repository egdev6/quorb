# Compilación y comprobación de macOS ARM64

## Estado y alcance

El workflow está en `.github/workflows/macos-ci.yml`, materializado desde
`.github/security-drafts/macos-ci.yml` mediante un plan de bootstrap aprobado.
Las pruebas exigen igualdad exacta entre esa fuente revisada y el workflow.
No cambia CI de Windows, Rust ni los iconos.

## Actualizaciones en macOS

Todos los builds actuales de macOS usan actualización manual: Ajustes muestra la
versión actual, sin buscar, instalar ni sondear actualizaciones. La política viene
del binario; el plugin updater no se registra y sus permisos solo se conceden en
Windows/Linux. Windows conserva su updater nativo. Si la política no se puede
resolver, las acciones quedan bloqueadas hasta reiniciar.
Esto no publica una preview descargable ni acredita funcionamiento de la GUI.

## Fundamentos de preview: preparatorio, no operativo

La configuración macOS fija `bundle.macOS.minimumSystemVersion` en **15.0**.
El verificador exige el mismo `LSMinimumSystemVersion` en `Info.plist` y lo reporta.
Es un objetivo de compilación macOS 15+, no evidencia de instalación ni de GUI; no acredita soporte para macOS 12.
La biblioteca pura `scripts/macos-preview-policy.mjs` valida datos inyectados de fuente y checks,
construye un manifiesto determinista unsigned-preview y compara readback y SHA-256 de bytes del DMG.
Exige main, versión exacta y SHA fuente = workflow = HEAD; solo autoriza los cuatro checks nombrados,
completos, únicos, exitosos y de GitHub Actions. No verifica todas las protecciones de GitHub.
El adaptador `scripts/macos-preview-preflight.mjs` obtiene HEAD real y checks REST antes de autorizar la fuente.
El contrato fija ARM64, actualización manual, sin Developer ID ni notarización y retención de 14 días:
la retención del artifact/manifiesto no implica que la aplicación expire; el digest del ZIP no es el hash del DMG.
Pruebas sin red ni GUI: `node --test scripts/macos-preview-policy.test.mjs scripts/verify-macos-bundle.test.mjs scripts/macos-ci.test.mjs`.
El workflow de preview solo se materializa tras aprobar su plan; uploads y readback real requieren ejecución autorizada.
Estos fundamentos no publican una preview descargable ni una Release, ni acreditan una preview macOS lista.

## Preflight de fuente: CLI preparatoria

`node scripts/macos-preview-preflight.mjs` requiere `GITHUB_REPOSITORY=egdev6/quorb`, `GITHUB_REF=refs/heads/main`,
`GITHUB_SHA`, `PREVIEW_SOURCE_SHA`, `PREVIEW_VERSION` y `GH_TOKEN` de solo lectura suministrado en runtime al futuro step.
Exige SHA iguales a HEAD y versión estable exacta de `package.json`; consulta una vez los checks de GitHub, sin redirects.
La lectura tiene límite de 1 MiB y plazo de 10 segundos; falla cerrada ante respuestas incompletas o checks no válidos.
Devuelve únicamente JSON con `sourceSha` y `version`, o error saneado con salida no cero; no escribe archivos.
Las pruebas usan Git/API inyectados, sin red real: esta sesión no acredita una consulta GitHub real.
No habilita workflows ni entrega una preview operativa; no crea tokens, artifacts, manifiestos ni uploads.

## Staging y readback local: CLI preparatoria

`node scripts/macos-preview-artifact.mjs stage` prepara solo un bundle ya compilado y verificado; no construye ni sube nada.
El modo `readback` solo lee una descarga ya existente: no descarga artifacts ni consulta GitHub.
Ambos exigen las variables de fuente del preflight (sin `GH_TOKEN`), HEAD real y versión exacta de `package.json`.
Productor fijo: `src-tauri/target/macos-preview-upload`; descarga separada: `src-tauri/target/macos-preview-download`.
Exigen DMG, `manifest.json` y `README.md` sin extras/symlinks; staging exclusivo, sin sobrescribir ni limpiar fallos parciales.
El README fuente es [la guía bilingüe de preview](macos-preview-README.md); staging copia sus bytes sin alterarlos.
Readback compara manifiesto canónico, bytes/hash DMG y README con la fuente; devuelve solo SHA y versión validados.
Estas pruebas de filesystem simulado no acreditan uploads, descargas reales, GUI ni una preview operativa.

## Preview manual: activación controlada por plan

`.github/security-drafts/macos-preview.yml` es la fuente revisable; el destino
`.github/workflows/macos-preview.yml` solo puede crearse tras aprobar el plan/hash de bootstrap.
El contrato exige igualdad byte a byte entre fuente y activo, sin omitir la integración.
Solo ejecución manual en main, versión estable exacta de `package.json` y SHA completo de HEAD main.
Preflight antes de Rust/instalación/build exige los cuatro checks del SHA exacto; no espera ni repite suites.
`npm run app:build:mac` usa Tauri; `beforeBuildCommand` ya ejecuta `npm run build` (TypeScript/Vite).
Después: staging, upload inmutable de tres archivos, download por nombre en el mismo run y readback.
Solo `contents: read`/`checks: read`; `GH_TOKEN` solo en preflight, checkout sin persistencia y retención de 14 días.
No se ha ejecutado este workflow ni realizado uploads/descargas, instalación o prueba GUI en Mac real.
La guía enlazada describe cómo obtener/verificar/informar sin quitar cuarentena; no acredita seguridad.

## Release macOS firmada: configurada, todavía no ejecutada

El workflow manual [macos-release.yml](../.github/workflows/macos-release.yml) se
materializa byte a byte desde `.github/security-drafts/macos-release.yml`.
Es independiente de `release.yml`: recibe `version` estable y `source_sha` de la
release Windows `v<version>` ya existente (también admite su borrador). Solo se
lanza desde `main`; no crea releases, tags ni publica un borrador.

Un job de preflight sin entorno de firma valida el ref, los formatos estrictos,
la pertenencia de `source_sha` al historial de `origin/main` y la versión de
`package.json` leída con `git show` en ese commit. Consulta la API de GitHub con
paginación para encontrar releases, incluidos borradores, y sus assets. Resuelve
el tag real, tanto ligero como anotado, hasta el commit exacto. Si GitHub todavía
no ha creado el tag de un borrador Windows, solo admite `target_commitish` igual
al SHA completo validado, nunca una rama móvil. Rechaza un DMG o checksum con el
nombre destino ya ocupado. A diferencia de la preview, no impone otra lista de
checks: este preflight protege la fuente y la release existente, no sustituye
las protecciones de `main` ni su revisión.

El job dependiente usa el entorno protegido `macos-signing`, con aprobación de
`egdev6` y despliegue limitado a `main`. Los únicos secretos Apple requeridos son
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_API_ISSUER`, `APPLE_API_KEY` y `APPLE_API_KEY_P8` (sin valores en el repo).
Solo los steps de preparación de la clave y build/firma reciben secretos, nunca
el workflow ni el job completo. La clave `.p8` se escribe de forma exclusiva con
permisos `0600` en `RUNNER_TEMP`, se pasa como `APPLE_API_KEY_PATH` y se elimina
mediante el único step `if: always()`, también si falla el build.

Compila el SHA validado con `npm run app:build:mac` en `macos-15`, Node 22 y Rust
stable nativos ARM64, con objetivo mínimo macOS **15.0**. Tauri firma con Developer
ID y notariza; después se solicita explícitamente la notarización del DMG y se
pega el ticket con `stapler`. Antes de subir nada se verifica el bundle ARM64,
`codesign --verify --deep --strict`, autoridad `Developer ID Application` y team
`SRD8T33RU5`, evaluación `spctl` de la app y del DMG, y `xcrun stapler validate`
del DMG. El certificado documentado caduca el **2027-11-28**; esto no acredita
que se haya usado correctamente ni que un artefacto publicado esté firmado.

Tras volver a validar la identidad de la release y sus colisiones, solo adjunta
`Quorb_<version>_aarch64.dmg` y `Quorb_<version>_aarch64.dmg.sha256`, calculado sobre
los bytes finales con ticket. No sobrescribe assets, no toca `latest.json` ni
artefactos del updater. **Las actualizaciones de macOS siguen siendo manuales.**

El intento 3 de la ejecución `40949608906` firmó la app, pero quedó esperando en
`Notarizing` hasta su cancelación, sin respuesta visible de Apple; no publicó el
DMG. Siguen pendientes la validación de Gatekeeper del DMG descargado en un Mac
real y la comprobación de primera apertura
con cuarentena de [#118](https://github.com/egdev6/quorb/issues/118), sin retirar
la cuarentena. No acredita instalación, GUI ni un rango de macOS soportado.
Ejecutar firma/notarización, crear tags, lanzar Release o publicar assets requiere
aprobación separada; escribir esta configuración no autoriza esas operaciones.

## Consultar una notarización sin reenviarla

El workflow manual `.github/workflows/macos-notary-diagnostics.yml` consulta
Apple sin compilar, firmar, enviar nuevos paquetes ni publicar assets. Solo corre
en `main`, con `contents: read`, aprobación del Environment `macos-signing` y
las tres credenciales de API existentes; no recibe el certificado de firma.

1. Una vez integrado, ejecutar **macOS notarization diagnostics** desde Actions
   sobre `main`, dejando `submission_id` vacío para listar hasta 20 envíos recientes
   con sus IDs, fechas, nombres y estados. Esto requiere aprobación separada para
   usar las credenciales; preparar el workflow no autoriza ejecutarlo.
2. Localizar el envío por nombre y fecha, no asumir que el más reciente es Quorb.
   Ejecutar de nuevo con su UUID en `submission_id` para consultar `info` y, si
   terminó (`Accepted`, `Invalid` o `Rejected`), su `log`.
3. Si sigue `In Progress`, conservar el ID y consultar más tarde, sin reenviar.
   Si es rechazado, revisar el log antes de cambiar firma o credenciales.

Cada consulta tiene un límite de 120 segundos; el job, 10 minutos. La clave `.p8`
temporal se crea con permisos `0600` y se elimina al salir y en un step de limpieza
`always()`. No se imprimen credenciales ni stderr crudo de la herramienta. Los
resultados de Apple quedan en el log del job (visibilidad del repositorio): no
pegar allí ni en los inputs claves o valores secretos. Un resultado `Accepted`
solo describe ese envío: no publica el DMG ni reemplaza las verificaciones del
workflow de release ni la prueba real de Gatekeeper. Este diagnóstico todavía
no se ha ejecutado contra Apple. Sus tests locales requieren Python 3 además de
Node y simulan `notarytool`, sin usar secretos reales ni acceder a la red.

## Ejecución prevista de CI macOS (sin cambios)

- PR (incluidos forks), push a `main` y ejecución manual; permiso `contents: read`.
- Runner `macos-15` nativo ARM64, Node 22 y Rust stable; límite de 30 minutos.
- Cancela ejecuciones obsoletas del mismo workflow/ref; sin caché ni credenciales persistidas.
- Registra SHA, sistema y versiones; exige `uname -m = arm64`, Node `arm64` y host Rust `aarch64-apple-darwin` antes de instalar dependencias.
- Ejecuta `npm ci`, `npm test`, `npm run typecheck`, `npm run build` y `cargo test --locked` en `src-tauri`.
- Construye con `npm run app:build:mac`, sin sustituir sus targets; después ejecuta `node scripts/verify-macos-bundle.mjs`.
- No firma, publica, sube artifacts ni usa secretos. No configura ni desbloquea Keychain.
- Los tests existentes de Keychain usan su propia clave y deben fallar normalmente si encuentran un problema.

## Evidencia y límites

El verificador exige exactamente una `.app` y una `.dmg` en `src-tauri/target/release/bundle`.
Comprueba versión de `package.json`, identificador `es.egdev.quorb`, nombre seguro del ejecutable y cabecera Mach-O ARM64 nativa; rechaza symlinks en las rutas comprobadas.
Lee `Info.plist` con `plutil`; ejecuta `hdiutil verify` sin montar el DMG y registra su SHA-256 junto al SHA fuente de 40 hexadecimales (`GITHUB_SHA`).
No abre ni ejecuta la aplicación. La integridad del DMG **no demuestra** que contenga esa `.app`, ni que funcione la GUI.
Las pruebas locales usan fixtures en memoria y comandos inyectados: `node --test scripts/verify-macos-bundle.test.mjs scripts/macos-ci.test.mjs`.
No se ha ejecutado macOS localmente; la compilación y las herramientas reales deben validarse en la ejecución nativa de la PR. Un workflow configurado no acredita por sí solo un resultado verde.
Esto no acredita un rango de versiones de macOS soportadas ni constituye una preview o release.
