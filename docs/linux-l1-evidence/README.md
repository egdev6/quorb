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
| Secret Service / keyring en sesión real | ✅ **validado en runner** | Smoke `linux_secret_service_round_trip` (solo `#[ignore]`) ejecutado en `39698848192` y `39837767677` con `dbus-run-session` + `gnome-keyring`: **1 passed** (guardar → leer → borrar un valor de prueba vía backend `linux-native`) |
| Login CLI seguro y verificable | ✅ cubierto por tests | `split_login_command_*` (comillas desbalanceadas → fail-closed, backslash, metacaracteres como argv literal), `terminal_invocation_passes_login_as_argv_not_shell_code`, `macos_script_*` (ESPACIOS/no-ASCII/controles). Sin processes en macOS |
| Build del binario y arranque en Linux | ✅ **validado en runner** | Run `39800266204` (`with_bundle=bundle`): `npm run app:build` → `.deb` + `.AppImage`; AppImage arranca vía FUSE 60 s; `.deb` instalado en Ubuntu 22.04 limpia arranca 60 s |
| Proveedores comprobados en Linux real | ✅ **fixtures de sesión real** | `parses_real_session_fixture` (claude/codex) + `parses_real_session_fixture_returns_valid_token_without_http` (gemini) verifican el parseo de la estructura exacta que escribe cada CLI tras el login, sin credenciales en el runner (verde en `39837767677`). La **lectura de una sesión viva** sigue dependiendo de que el usuario tenga las credenciales en su máquina |

## 2. Runs de referencia

| Run | `ref` | `with_bundle` | Resultado |
|---|---|---|---|
| `39698848192` | `feat-linux-l1-106-retake` | `tests` | ✅ `npm test` (628 vitest + 221 node) · `npm run build` · `cargo test --locked` (233 passed, **1 ignored** = smoke, ejecutado aparte OK) · **smoke Secret Service: 1 passed** |
| `39837767677` | `feat-linux-l1-106-retake` | `tests` | ✅ `npm test` (657 vitest + 221 node) · `npm run build` · `cargo test --locked` (249 passed, 1 ignored) — incluye los **3 fixtures de sesión real** (`parses_real_session_fixture` × 2 + `parses_real_session_fixture_returns_valid_token_without_http`) · **smoke Secret Service: 1 passed** |
| `39800266204` | `feat-linux-l1-106-retake` | `bundle` | ✅ todo lo anterior + build de bundles + arranque verificado de `.deb` y `.AppImage` en Ubuntu 22.04 limpia |

Artefactos: `quorb-linux-manual-feat-linux-l1-106-retake` (ID `12436632928`, 87 MB),
contiene `Quorb_0.7.0_amd64.deb` (4.63 MB) y `Quorb_0.7.0_amd64.AppImage` (79.57 MB).

## 3. Fixtures de sesión real por proveedor (criterio 4)

Los tres proveedores con sesión de archivo leen la sesión que escribe su CLI
tras el login oficial. Antes los tests usaban JSON de juguete; ahora cada
proveedor tiene un fixture con la estructura real (valores de ejemplo, ninguna
credencial) y un test determinista con reloj inyectado.

| Proveedor | Fichero real | Fixture | Test |
|---|---|---|---|
| Claude | `~/.claude/.credentials.json` | `fixtures/claude-credentials.json` | `claude::tests::parses_real_session_fixture` |
| Codex | `$CODEX_HOME/auth.json` | `fixtures/codex-auth.json` | `codex::tests::parses_real_session_fixture` |
| Gemini | `~/.gemini/oauth_creds.json` | `fixtures/gemini-oauth_creds.json` | `gemini::tests::parses_real_session_fixture_returns_valid_token_without_http` |

Cobertura:

- **Claude**: parsea `claudeAiOauth.accessToken` y `subscriptionType`, y
  comprueba `is_expired(now_ms)` en tres casos: vigente, expirado y token sin
  expiry (que nunca expira).
- **Codex**: parsea `tokens.access_token` y `account_id`, y valida
  `parse_validity` sobre el `id_token` (JWT): `exp`, `chatgpt_account_id`,
  `chatgpt_plan_type` y `subscription_active_until`. El `account_id` del claim
  tiene que coincidir con el del archivo; si no, la sesión no vale.
- **Gemini**: verifica la decisión pura `token_needs_refresh(creds, now_ms)`:
  vigente no refresca, pasado refresca, sin `access_token` siempre. No hace
  HTTP; el refresh real queda como gap declarado.

**Dónde vive la sesión de Claude según la plataforma** (estructura documentada de
Claude Code v2.1.x, revisada en el lab): macOS → Keychain, servicio
`Claude Code-credentials` (el JSON `~/.claude/.credentials.json` se borra al
migrar); Linux, WSL y Windows nativo → `~/.claude/.credentials.json` (en Windows,
`%USERPROFILE%\.claude\`). El fixture de arriba es el layout Linux/WSL/Windows.
Quorb ya cubre el caso macOS con `keychain_fallback` → `security
find-generic-password -s "Claude Code-credentials" -w` (timeout de 5 s y solo para
la sesión principal sin ruta explícita), con tests
`keychain_fallback_only_for_main_session_without_explicit_path` y
`parses_keychain_secret_and_rejects_garbage`.

Run `39837767677` (commit `43caa59`), log leído directamente: los 3 tests
aparecen como `ok` (`249 passed; 0 failed; 1 ignored`) y el ignored es el smoke
de la sección 4, ejecutado aparte y también `ok`.

El refactor que lo hizo testeable sin red: la decisión de refresco salió de
`access_token` a `token_needs_refresh` (`gemini.rs:75`), igual que ya hacían
`is_expired` (Claude) y `parse_validity` (Codex).

## 4. Smoke de Secret Service (lo que faltaba)

El test `secrets::tests::linux_secret_service_round_trip` (en `src-tauri/src/secrets.rs`)
está marcado `#[ignore = "requiere escritorio Linux con D-Bus + Secret Service"]` para
no romper el `cargo test` de CI. Este lab lo levanta explícitamente:

```bash
dbus-run-session -- bash -c '
  eval $(printf "%s" "$KEYRING_PASS" | gnome-keyring-daemon --unlock --components=secrets)
  cd src-tauri
  cargo test --locked linux_secret_service_round_trip -- --ignored --nocapture
'
```

`KEYRING_PASS` es una contraseña de prueba propia del runner (en el workflow,
`quorb-ci-testpass`, fija): el keyring es efímero de la sesión `dbus-run-session`
y no contiene datos reales. Documentado aquí como variable para que el comando
sea reproducible sin depender del valor interno.

Lo que demuestra (criterio 2 de #106):
- La clave se **guarda** en el Secret Service real (backend `linux-native` del crate `keyring`, vía libsecret/D-Bus).
- Se **recupera** con el mismo valor.
- Se **borra** (`set(&key, "")` → `get` devuelve `None`).
- Usa la misma vía `entry()`/`scoped()` que la app, con una clave de la allowlist — no escribe en disco ni en texto plano.

**Migración del servicio legacy — ejercitada (criterio 2, revisión del owner 2026-10-28)**:
la migración (`migrate_legacy()` en `secrets.rs`: copia un secreto de
`LEGACY_SERVICE` al servicio actual y borra el antiguo) queda validada por el
smoke `linux_legacy_migrate_once_then_legacy_is_gone` en el run
[`40651008234`](https://github.com/sosan/quorb/actions/runs/40651008234)
(SHA `0c75fab`), log: `linux_legacy_migrate_once_then_legacy_is_gone ... ok`.
Qué verifica:
- Escribe **directamente** en `LEGACY_SERVICE` (`es.egdev.ai-usage`) una clave
  base de la allowlist (`nan_session`, sin `@` — las claves con `@` no migran
  por diseño de `get()`), sin pasar por `set`/`get`.
- `get()` con el destino actual vacío la recupera **por la vía de migración**
  (se lee una vez).
- El valor queda reescrito en el **destino actual** (`es.egdev.quorb`),
  comprobado leyendo el entry actual sin volver a migrar.
- El legado desaparece de lecturas directas posteriores (**`NoEntry`**).
- Sin imprimir valores; `CleanupGuard` limpia ambos servicios al terminar.

**Ejecución segura (aislamiento obligatorio)**: el smoke escribe en la clave
real `nan_session` del llavero, así que **solo se ejecuta en el entorno
aislado del CI** — `dbus-run-session` + `gnome-keyring` efímero con
`QUORB_SECRETS_SMOKE_ISOLATED=1` (var definida únicamente dentro de esa sesión
en `linux-ci.yml`). Sin esa variable, el smoke **falla antes de tocar nada**:
no debe ejecutarse a mano en un escritorio con llavero real. El `CleanupGuard`
se crea antes de cualquier lectura y su limpieza solo corre en ese entorno
aislado, así que nunca borra datos reales. Los smokes de llavero (round trip y
migración) se ejecutan únicamente vía el paso "Secret Service smoke" de
`linux-ci.yml`, no como ejecución manual en escritorio.

Dependencias añadidas al runner: `libsecret-1-dev`, `gnome-keyring`, `dbus`, `dbus-x11`, `xvfb`.

## 5. Corrección aplicada al gate de bundles (bug encontrado)

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

**Endurecimiento posterior (revisión del owner, 2026-10-23)**: cada
`verify-deb.sh`/`verify-appimage.sh` ahora falla con `exit 1` si falta **SU
propio** tipo (antes hacía `exit 0` con «AVISO»), así que el gate solo pasa si
**ambos** bundles están presentes y arrancan.

**Verificación**: el run `39800266204` muestra los bundles encontrándose y la app
arrancando de verdad (`.deb` → `/usr/bin/quorb` vivo 60 s; `.AppImage` → vivo 60 s).

## 6. Qué NO cubre esta evidencia (límites honestos)

- **Sesiones vivas de CLI**: los fixtures (sección 3) cubren el parseo de la
  estructura real de cada sesión, pero no hay credenciales en el runner anónimo:
  no se hace ninguna llamada autenticada a un proveedor.
- **Escritorio real**: el runner usa Xvfb + D-Bus session bus, no un compositor
  de escritorio Wayland/X11 con sesión de usuario (fuera del alcance L1 de #106;
  corresponde a la matriz física del PRD Wayland, ya cubierta en su propio lab).
- **Distribución**: solo `ubuntu-22.04` (el mismo runner de `windows-latest` que
  usa el resto de CI). Otras distribuciones no están en la matriz.
- **Token por variable de entorno**: si el usuario exporta
  `CLAUDE_CODE_OAUTH_TOKEN` (override silencioso del CLI), Quorb no lo lee —
  solo archivo y Keychain.
- **Sin cobertura de logout/login en graphical-session con pkexec**.

## 7. Reproducir

```bash
gh workflow run linux-ci.yml --repo sosan/quorb --ref feat-linux-l1-106-retake \
  --field ref=feat-linux-l1-106-retake --field with_bundle=bundle
```

Requiere el workflow en la rama destino; los runs son `workflow_dispatch`
(manuales, por ref), no se disparan con PR/push.