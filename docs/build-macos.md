# Compilación y comprobación de macOS ARM64

## Estado y alcance

El workflow está en `.github/workflows/macos-ci.yml`, materializado desde
`.github/security-drafts/macos-ci.yml` mediante un plan de bootstrap aprobado.
Las pruebas exigen igualdad exacta entre esa fuente revisada y el workflow.
No cambia CI de Windows, Rust ni los iconos.

**Estado observado a 2026-10-31:** [v0.8.0](https://github.com/egdev6/quorb/releases/tag/v0.8.0)
publica `Quorb_0.8.0_aarch64.dmg` y `Quorb_0.8.0_aarch64.dmg.sha256`,
con Developer ID y notarización, para **Apple Silicon (M1+), macOS 15+**.
El [productor 41067808525](https://github.com/egdev6/quorb/actions/runs/41067808525)
preparó y envió el checkpoint firmado. El [diagnóstico 41230153171](https://github.com/egdev6/quorb/actions/runs/41230153171)
confirmó `Accepted`, `jobId` `e7b22172-716e-4176-a023-2d1d916d6823` y SHA-256 del DMG enviado:
`224b37f9b3e6d134f7d408ed06995792af73fa05c41ee79eb2e20edc476800be`.
El [resume 41233474221](https://github.com/egdev6/quorb/actions/runs/41233474221)
completó verificación, stapling, staging final y publicación. Gatekeeper pasó en
el runner CI; no equivale a descarga por navegador, cuarentena, instalación ni GUI
en un Mac real, pendientes en [#118](https://github.com/egdev6/quorb/issues/118).

## Actualizaciones en macOS

Todos los builds actuales de macOS usan actualización manual: Ajustes muestra la
versión actual, sin buscar, instalar ni sondear actualizaciones. La política viene
del binario; el plugin updater no se registra y sus permisos solo se conceden en
Windows/Linux. Windows conserva su updater nativo. Si la política no se puede
resolver, las acciones quedan bloqueadas hasta reiniciar.
Esta política de actualizaciones no publica por sí misma una preview ni acredita funcionamiento de la GUI.

## Fundamentos del mecanismo de preview unsigned

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
Este contrato de preview unsigned es independiente de la release firmada descrita arriba; sus pruebas no acreditan por sí mismas una preview macOS lista.

## Preflight de fuente: CLI preparatoria

`node scripts/macos-preview-preflight.mjs` requiere `GITHUB_REPOSITORY=egdev6/quorb`, `GITHUB_REF=refs/heads/main`,
`GITHUB_SHA`, `PREVIEW_SOURCE_SHA`, `PREVIEW_VERSION` y `GH_TOKEN` de solo lectura suministrado en runtime al futuro step.
Exige SHA iguales a HEAD y versión estable exacta de `package.json`; consulta una vez los checks de GitHub, sin redirects.
La lectura tiene límite de 1 MiB y plazo de 10 segundos; falla cerrada ante respuestas incompletas o checks no válidos.
Devuelve únicamente JSON con `sourceSha` y `version`, o error saneado con salida no cero; no escribe archivos.
Las pruebas usan Git/API inyectados, sin red real: no acreditan por sí mismas una consulta GitHub real.
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
La configuración y las pruebas de este mecanismo de preview no acreditan por sí solas su ejecución ni uploads/descargas reales. No confundirlo con la release firmada.
La guía enlazada describe cómo obtener/verificar/informar sin quitar cuarentena; no acredita seguridad.

## Release macOS reanudable: operación y evidencia

Los workflows [prepare/submit](../.github/workflows/macos-release.yml) y
[resume](../.github/workflows/macos-release-resume.yml) tienen fuentes revisables
byte a byte en `.github/security-drafts/`. Solo admiten dispatch manual desde
`main`, con el Environment existente `macos-signing` (reviewer `egdev6`, rama
`main`). Esta corrección no cambia ese Environment ni autoriza ejecuciones.

### 1. Preparar y enviar una vez

`macos-release.yml` recibe `version` estable y `source_sha` de la release Windows
`v<version>` existente (borrador permitido). El preflight sigue sin secretos:
comprueba ref, versión con `git show`, ancestría en `origin/main`, release/tag
(incluidos tags anotados), ID de release y colisiones de DMG/checksum. Para un
borrador todavía sin tag exige `target_commitish` igual al SHA completo, no una
rama. No crea releases/tags ni cambia Windows/updater.

El build ARM64 nativo usa macOS 15, Node 22, Rust stable y mínimo macOS **15.0**.
Solo recibe certificado, contraseña e identidad Developer ID. El helper elimina
del entorno hijo **todas** las variables `APPLE_API_*`, `APPLE_ID`,
`APPLE_PASSWORD` y `APPLE_TEAM_ID`, incluso si fueran heredadas. Según el código
Tauri CLI 2.12.1 / bundler 2.10.1 revisado, la app se firma antes de detectar
credenciales ausentes y omitir notarización; el DMG se firma por separado.

Tras verificar metadata/ARM64, integridad del DMG y firmas Developer ID de app y
DMG (team `SRD8T33RU5`), guarda solo DMG firmado + `manifest.json` en
`macos-notary-checkpoint-<run_id>-<attempt>`. Upload inmutable, retención **14 días**,
antes de escribir `.p8` o llamar a Apple. El manifiesto liga repositorio, workflow
path/SHA, source SHA, versión, release ID, run/attempt, nombre, tamaño y SHA256 de
los bytes enviados. No contiene claves ni certificado privado.

Solo después del upload, `notarytool submit` envía ese mismo DMG exterior sin
`--wait`, sin polling ni retries. Es normal que el workflow **termine aquí**, no
es una release completada. El UUID se imprime y resume; el artifact separado
`macos-notary-receipt-<run_id>-<attempt>` guarda UUID, hash DMG y artifact ID/digest
del checkpoint devueltos por upload. La `.p8` exclusiva `0600` en `RUNNER_TEMP` se
elimina al salir y mediante cleanup `always()`. No hay permiso `contents: write`.

### 2. Reanudar sin compilar ni volver a enviar

Usar `macos-release-resume.yml` con `source_run_id`, `source_run_attempt`, la misma
`version` y `source_sha`; normalmente dejar `submission_id` vacío. Requiere nueva
autorización para consultar Apple. No requiere certificado Developer ID privado,
solo las tres credenciales API en el step de consulta.

Antes de usar esas credenciales valida el run propio/headrepo, `main`, evento,
workflow path/ID y SHA ancestro aprobado; exige además bytes del workflow productor
iguales a la fuente revisada actual. No acepta un productor antiguo/incompatible.
Resuelve artifacts por run/attempt, nombre único, ID, vínculos API, tiempos de
intento y expiración; **un run cancelado con checkpoint válido es recuperable**.
Exige run terminado, no conclusión `success`. Descarga ZIP crudo con API autenticada,
verifica fatalmente su digest antes de extraer y admite solo archivos esperados:
sin rutas, symlinks, duplicados, extras, bombas o tamaños excesivos (DMG ≤512 MiB).
No usa el comportamiento warning-only de download-artifact. Compara manifiesto con
valores externos de run/preflight, no con sus propias declaraciones.

- `In Progress`: outcome **pending**, sin staple ni publicación; consultar después.
- `Accepted` sin log disponible: **pending**, no release completada.
- `Invalid`/`Rejected`: muestra issues JSON acotados/saneados y falla; no reenvía.
- `Accepted`: el log debe contener `jobId` igual al UUID y `sha256` igual al DMG
  **previo** al staple. Ausente o distinto falla cerrado. Además del fixture
  sintético, el diagnóstico real enlazado arriba confirmó ese campo y el resume
  verificó el vínculo UUID/hash; nunca omitir el gate para conseguir verde.

Después de Accepted grapa **solo el DMG retenido**; Apple procesa tickets de los
contenedores anidados. No recompila, re-firma, pega tickets a la app ni reempaqueta.
Verifica firma/ticket del DMG y Gatekeeper; lo monta con `hdiutil attach -readonly
-nobrowse -plist` en un directorio controlado. Analiza plist real, valida entidades
y solo la `Quorb.app` contenida: rutas/symlinks, Developer ID/team, bundle ID
`es.egdev.quorb`, versión, ARM64 y mínimo macOS 15.0; exige Gatekeeper de esa app.
Siempre intenta desmontar. Un error de red/Gatekeeper o cleanup falla cerrado.

### 3. Autorizar publicación por separado

Dispatch manual **no basta**: `publish` es `false` por defecto. Solo con
`publish: true`, outcome Accepted verificado y Environment aprobado puede arrancar
el job de publicación, único con `contents: write`. Los demás jobs usan lectura.
Un ZIP final inmutable se vuelve a validar por ID/digest y hash final ligado a
outputs del job verificador. Revalida release ID y colisiones justo antes de
adjuntar exclusivamente DMG y `.dmg.sha256`, sin overwrite. Si falla checksum,
rollback solo puede borrar el ID del DMG subido por esa invocación, nunca un asset
preexistente. Una respuesta ambigua requiere inspección manual.

Son tres hashes distintos: **ZIP del artifact**, **DMG enviado**, **DMG final con
ticket**. No toca `latest.json`; **updates macOS siguen manuales**. Una ejecución
solo de verificación conserva el artifact final, no publica. Para publicar más
tarde se autoriza otro resume con `publish: true`, repitiendo todas las puertas.

### Cancelación, ambigüedad y expiración

Conservar run ID/attempt, checkpoint ID/digest y UUID. Si se interrumpe submit antes
del recibo, el checkpoint sigue retenido: usar diagnostics/history/info/log para
investigar, **no rerun/retry de submit** ni asumir vínculo por nombre/fecha. El
UUID candidato se puede pasar como `submission_id` únicamente para recuperación;
solo el log Apple con UUID y hash coincidentes puede autorizar continuación.

Tras **14 días**, o si el artifact fue borrado, resume falla: no reconstruye ni
sustituye bytes automáticamente. Acordar recuperación por separado. El intento 3
del run `40949608906`, anterior a este protocolo, esperó en Tauri `Notarizing`
hasta cancelación y no publicó DMG; no se presume que tenga checkpoint recuperable.

Las pruebas Linux con procesos/HTTP/filesystem y ZIP/plist sintéticos se complementan
con la ejecución nativa enlazada arriba: firma, Apple, artifacts y Gatekeeper en CI.
Certificado documentado: caduca **2027-11-28**; el éxito de ese run no certifica su
validez universal o futura. Siguen pendientes primera descarga por navegador,
cuarentena, instalación y GUI en Mac real de [#118](https://github.com/egdev6/quorb/issues/118),
sin retirar cuarentena. Esta evidencia no implica secretos nuevos ni cambios de
Environment; futuras ejecuciones y publicaciones requieren autorización separada.

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
workflow de release ni Gatekeeper en un Mac real. El diagnóstico enlazado arriba
sí consultó Apple y confirmó `Accepted` con UUID/hash; la publicación la completó
el resume, no diagnostics. Los tests locales requieren Python 3 además de Node
y simulan `notarytool`, sin usar secretos reales ni acceder a la red.

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
La release enlazada aporta compilación y herramientas nativas en CI, no ejecución local de la GUI. Un workflow configurado no acredita por sí solo un resultado verde.
Este verificador aislado no acredita un rango de versiones de macOS soportadas ni constituye por sí mismo una preview o release.
