# L1 — Evidencia de verificación en Linux real (issue #106, W3)

> Evidencia ejecutada en runner Ubuntu 22.04 (hosted GitHub Actions) para la
> issue #106 (`quorb-linux-local-v1`, ODD L1/verificación). Registra qué se
> comprobó realmente, con qué resultado y qué queda fuera.
> Fecha: 2026-10-21/22. Workflow: `.github/workflows/linux-ci.yml`.

---

## 1. Resumen

| Objetivo de la issue | Estado | Evidencia |
|---|---|---|
| Rutas y precedencia config ↔ defaults Linux | ✅ cubierto por tests | `session_file_main_uses_credentials_path_or_home_default`, `session_file_preserves_paths_with_non_ascii`, `resolve_path_error_lists_candidate_paths`, `auth_path_keeps_explicit_credentials_path_priority` (todo verde en `cargo test`) |
| Secret Service / keyring en sesión real | ✅ **validado en runner** | Smoke `linux_secret_service_round_trip` (solo `#[ignore]`) ejecutado en `39698848192` con `dbus-run-session` + `gnome-keyring`: **1 passed** (guardar → leer → borrar un valor de prueba vía backend `linux-native`) |
| Login CLI seguro y verificable | ✅ cubierto por tests | `split_login_command_*` (comillas desbalanceadas → fail-closed, backslash, metacaracteres como argv literal), `terminal_invocation_passes_login_as_argv_not_shell_code`, `macos_script_*` (ESPACIOS/no-ASCII/controles). Sin processes en macOS |
| Build del binario y arranque en Linux | ✅ **validado en runner** | Run `39800266204` (`with_bundle=bundle`): `npm run app:build` → `.deb` + `.AppImage`; AppImage arranca vía FUSE 60 s; `.deb` instalado en Ubuntu 22.04 limpia arranca 60 s |
| Proveedores comprobados en Linux real | ⚠️ parcial | Tests unitarios cubren los proveedores con sesión de archivo (claude/codex/gemini/cursor); la **lectura de sesiones reales** de cada CLI depende de que el usuario tenga las credenciales en su máquina — no automatizable en runner anónimo |

## 2. Runs de referencia

| Run | `ref` | `with_bundle` | Resultado |
|---|---|---|---|
| `39698848192` | `feat-linux-l1-106-retake` | `tests` | ✅ `npm test` (628 vitest + 221 node) · `npm run build` · `cargo test --locked` (233 passed, **1 ignored** = smoke, ejecutado aparte OK) · **smoke Secret Service: 1 passed** |
| `39800266204` | `feat-linux-l1-106-retake` | `bundle` | ✅ todo lo anterior + build de bundles + arranque verificado de `.deb` y `.AppImage` en Ubuntu 22.04 limpia |

Artefactos: `quorb-linux-manual-feat-linux-l1-106-retake` (ID `12436632928`, 87 MB),
contiene `Quorb_0.7.0_amd64.deb` (4.63 MB) y `Quorb_0.7.0_amd64.AppImage` (79.57 MB).

## 3. Smoke de Secret Service (lo que faltaba)

El test `secrets::tests::linux_secret_service_round_trip` (en `src-tauri/src/secrets.rs`)
está marcado `#[ignore = "requiere escritorio Linux con D-Bus + Secret Service"]` para
no romper el `cargo test` de CI. Este lab lo levanta explícitamente:

```bash
dbus-run-session -- bash -c '
  eval $(printf "%s" "$PASS" | gnome-keyring-daemon --unlock --components=secrets)
  cd src-tauri
  cargo test --locked linux_secret_service_round_trip -- --ignored --nocapture
'
```

Lo que demuestra (criterio 2 de #106):
- La clave se **guarda** en el Secret Service real (backend `linux-native` del crate `keyring`, vía libsecret/D-Bus).
- Se **recupera** con el mismo valor.
- Se **borra** (`set(&key, "")` → `get` devuelve `None`).
- Usa la misma vía `entry()`/`scoped()` que la app, con una clave de la allowlist — no escribe en disco ni en texto plano.

Dependencias añadidas al runner: `libsecret-1-dev`, `gnome-keyring`, `dbus`, `dbus-x11`, `xvfb`.

## 4. Corrección aplicada al gate de bundles (bug encontrado)

**Síntoma**: el build-verify de `.testcontainer/verify.sh` imprimía
`✔ Build-verify OK` sin haber arrancado nada — los scripts buscaban
`/artifacts/quorb_*.deb` y `/artifacts/quorb_*.AppImage` (minúscula), pero Tauri
produce `Quorb_0.7.0_amd64.*` (Q mayúscula + versión). Ambos checks se saltaban
con `exit 0` y el orquestador declaraba éxito sobre un set vacío.

**Causa**: glob con minúscula sobre un nombre de artefacto con Q mayúscula.

**Corrección** (commit `d7a0f8c`):
1. `verify-deb.sh` y `verify-appimage.sh` localizan los bundles con
   `find /artifacts -maxdepth 1 -type f -iname '*.deb'` /
   `-iname '*.AppImage'` (case-insensitive).
2. `verify.sh` falla con `exit 1` si no hay **ningún** bundle en `/artifacts`,
   en vez de declarar «OK» sobre un set vacío.

**Verificación**: el run `39800266204` muestra los bundles encontrándose y la app
arrancando de verdad (`.deb` → `/usr/bin/quorb` vivo 60 s; `.AppImage` → vivo 60 s).

## 5. Qué NO cubre esta evidencia (límites honestos)

- **Sesiones reales de CLI**: no hay credenciales de Claude/Codex/Gemini en un
  runner anónimo; los tests verifican el parseo y la precedencia de rutas, no una
  sesión viva de cada proveedor.
- **Escritorio real**: el runner usa Xvfb + D-Bus session bus, no un compositor
  de escritorio Wayland/X11 con sesión de usuario (fuera del alcance L1 de #106;
  corresponde a la matriz física del PRD Wayland, ya cubierta en su propio lab).
- **Distribución**: solo `ubuntu-22.04` (el mismo runner de `windows-latest` que
  usa el resto de CI). Otras distribuciones no están en la matriz.
- **Sin cobertura de logout/login en graphical-session con pkexec**.

## 6. Reproducir

```bash
gh workflow run linux-ci.yml --repo sosan/quorb --ref feat-linux-l1-106-retake \
  --field ref=feat-linux-l1-106-retake --field with_bundle=bundle
```

Requiere el workflow en la rama destino; los runs son `workflow_dispatch`
(manuales, por ref), no se disparan con PR/push.