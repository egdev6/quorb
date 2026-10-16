# Compilación y comprobación de macOS ARM64

## Estado y alcance

El workflow está en `.github/workflows/macos-ci.yml`, materializado desde
`.github/security-drafts/macos-ci.yml` mediante un plan de bootstrap aprobado.
Las pruebas exigen igualdad exacta entre esa fuente revisada y el workflow.
No cambia CI de Windows, Rust, los iconos ni la configuración de Tauri.

## Actualizaciones en macOS

Todos los builds actuales de macOS usan actualización manual: Ajustes muestra la
versión actual, sin buscar, instalar ni sondear actualizaciones. La política viene
del binario; el plugin updater no se registra y sus permisos solo se conceden en
Windows/Linux. Windows conserva su updater nativo. Si la política no se puede
resolver, las acciones quedan bloqueadas hasta reiniciar.
Esto no publica una preview descargable ni acredita funcionamiento de la GUI.

## Ejecución prevista

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
