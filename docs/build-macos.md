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
