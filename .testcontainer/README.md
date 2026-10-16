# Testcontainer de Quorb — build-verify

Contenedor que valida los **artefactos de build** de Quorb (`.deb` y `.AppImage`)
en una **Ubuntu 22.04 limpia** (sin toolchain: sin Node, sin Rust, sin
`build-essential`), replicando una máquina de usuario final.

Complementa al devcontainer (M0): el devcontainer verifica el *source code* y el
toolchain (`npm test`, `cargo test`, `app:dev`); este verifica **el bundle que se
publica** — que el `.deb` se instala y arranca, y que el `.AppImage` se extrae y
arranca — sin las deps de desarrollo que esconden los fallos de runtime.

## Atrapa estos fallos típicos

- Faltan deps de *runtime* de Tauri en la imagen limpia (`libwebkit2gtk-4.1-0`,
  no `-dev`) → "cannot open shared object file" al instalar el `.deb`.
- Scripts de `postinst` rotos, o un `.deb` que no deja `quorb` en el PATH.
- El binario crashea al arrancar sin display real.
- AppImage que depende de FUSE (no disponible en Docker) → se usa
  `--appimage-extract-and-run`.

## Uso

```bash
# 1. Generar los artefactos (primera compilación Rust puede tardar)
npm run app:build
# En Linux, produce src-tauri/target/release/bundle/deb/quorb_*.deb y
# src-tauri/target/release/bundle/appimage/quorb_*.AppImage

# 2. Construir el contenedor
docker build -t quorb-build-verify .testcontainer

# 3. Validar (mounta dist/ al /artifacts del contenedor)
docker run --rm \
  -v "$PWD/src-tauri/target/release/bundle/deb:/artifacts" \
  --platform linux/amd64 \
  quorb-build-verify
```

El entrypoint `verify.sh` corre `verify-deb.sh` y `verify-appimage.sh`; cada uno
instala/extrae el artefacto y lo arranca con `dbus-run-session -- xvfb-run -a`
(timeout 60s, exit 124 = la app seguía viva = OK). Cualquier fallo imprime el log
y falla cerrado.

## GUI → Wayland

Este contenedor usa X virtual (xvfb). Igual que el devcontainer, **no valida
compositores ni Wayland** — eso es la matriz física de F0 del PRD. Sí verifica
que el bundle arranca y mantiene la ventana, que es exactamente lo que se rompe
por deps de runtime faltantes o binarios rotos.

## Notas

- `--platform linux/amd64` fuerza la arquitectura (los bundles son x86_64).
- Si se añade `.rpm` en el futuro, el patrón es `verify-rpm.sh` con
  `rpm -i` / `dnf install`.
- Si F4 (CI matrix) adopta este contenedor, el job puede hacer `docker run`
  en el runner en vez de reescribir la lógica en YAML.