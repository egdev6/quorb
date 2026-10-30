# ODD · #180 — Wayland nativo: arrastre por compositor + estado de posicionamiento

Issue: https://github.com/egdev6/quorb/issues/180
Label: `status:approved` · `type:bug` · Assignee: SrStamm (verificado vía `gh api` 2026-10-30)
Contribuidor: SrStamm · Rama propuesta: `fix/180-wayland-compositor-drag` desde `origin/main` · PR desde fork `SrStamm/quorb` (convención del repo).

**Plan APROBADO** por egdev6 (comentario 2026-10-29T16:58 en #180) con corrección en WU1 y
WU4: la decisión de modo/superficie **no** se toma con el tipo de sesión, sino con el **backend
GDK efectivo** (runtime: tipo de display de GDK; si no se puede, `GDK_BACKEND`). Motivo:
`is_wayland_session_from_env` (`src-tauri/src/wm_compat.rs:509-513`, verificado) solo mira
`WAYLAND_DISPLAY`/`XDG_SESSION_TYPE` y **ignora `GDK_BACKEND=x11`** — si se quedara como estaba
el plan, en XWayland `dragMode()` devolvería `'compositor'` y se perdería imán y persistencia
justo en el modo donde las capturas del hilo mostraron que funcionan, rompiendo la propia
capa alternativa de la vía 3.

Base de la rama: `main` @ `a0e999b` (post #201). El `main` local ya está en `a0e999b` y al día
con `origin/main`; no hace falta rebase adicional al crear la rama.

## Alcance aprobado por el mantenedor (comentario final de egdev6, #180)

1. **Vía 1 limitada (Wayland nativo):** arrastre real con el gesto del compositor
   (`startDragging()` → `xdg_toplevel.move`) durante la sesión, **sin imán al soltar y sin
   persistir** `dockEdge`/`dockOffset`/`dockMonitor` en esa sesión (los datos calculados con
   coordenadas no fiables no deben entrar al `config.json` que también usa X11).
2. **Vía 3:** estado visible en «Sesión de escritorio» indicando que el posicionamiento no
   está disponible en este compositor. **La documentación de `GDK_BACKEND=x11` como
   alternativa queda condicionada a integrar #205** (que ajusta la ventana al tamaño de la
   tira): NO entra en esta entrega.
3. **Fuera de alcance:** layer-shell (Mutter no implementa `zwlr_layer_shell_v1`), selector de
   monitor (#113), márgenes de anclaje (#179/#205).

## Causa raíz (verificada por el reportero, el mantenedor y este repo)

`Widget.tsx` (`setPosition` del arrastre) y `detail_geometry.rs:56-84` (`set_position` del
anclaje) terminan en `gtk_window_move()`, que **no opera bajo xdg-shell** (tao 0.37.1 lo marca
Unsupported; Debian wonfix; tao#566). El cálculo funciona; el transporte es no-op. Única vía:
mover la ventana con el serial de un evento de entrada (`begin_move_drag`).

Sin imán al soltar: el cliente xdg-shell no conoce su posición absoluta; `e.screenX/Y` sin
posición de ventana no es coordenada global; y el `pointerup` del grab lo gestiona el
compositor. Persistir un borde calculado así podría corromper la config usada por X11.

## Evidencia de exploración (main, 2026-10-30)

- `src/Widget.tsx:791-827` `onGripDown` (origen sincrónico de `widgetBounds`; override async con
  `outerPosition()`), `:829-842` `onGripMove` (`setPosition` en rAF, `:837`), `:843-925`
  `onGripUp` (imán + `api.patchConfig({dockEdge, dockOffset, dockMonitor})` en `:880`).
- `src/lib/dock.ts:21-31` `nearestEdge(area, px, py)` — pura, usa punto del grip.
- `src/Widget.tsx:482` el efecto de colocación salta durante el drag; `:530-558` auditoría
  `widget-recovery` (`shouldAuditNativePosition` en `src/lib/widget-recovery.ts`).
- Detección: `src-tauri/src/wm_compat.rs` (`detect_wm_info_from_env`, `surfaces_for` con ramas
  X11/Hyprland/GNOME/KDE/genérica-Wayland en `:206-299`) → comando `get_wm_info` →
  `src/lib/wm-detect.ts:12-39` (`isWayland`, `isHyprland`, `surfaces`, `state: 'ok'|'limited'`).
- Bloque de sesión: `DesktopSessionNotice` (`src/Settings.tsx:1402-1421`), filas vía
  `desktopCompatRows` (`src/lib/desktop-compat.ts:16-41`), i18n `src/i18n/es.ts:154-178` /
  `en.ts:147-171`; inventario con `node scripts/i18n-inventory.mjs --out
  docs/i18n-inventory.md` (`--check` es gate de CI y **escanea src-tauri**, cambiar notas del
  backend lo invalida).
- Patrones de test: `src/Settings-providers-i18n.test.tsx:269-279` (render SSR de
  `DesktopSessionNotice`), `src/lib/shortcut-notices.test.tsx` (aviso Wayland, PR #183), tests
  Rust in-crate de `surfaces_for` (`wm_compat.rs:574`+).

## Plan de trabajo (work units, commits convencionales)

- **WU1 · Decisión de estrategia de arrastre (frontend/bridge, pure) — CORREGIDA por el mantenedor.**
  Clave: decidir con el **backend GDK efectivo**, no con el tipo de sesión.
  Preferente: comprobar en runtime el tipo de display de GDK (Wayland vs X11) — fuente única,
  sin ambiguos de env (`GDK_BACKEND` acepta listas tipo `"x11,*"`). Fallback si no es viable:
  leer `GDK_BACKEND` aplicando la semántica GTK (`x11` fuerza X11; unset/automático usa
  Wayland si está disponible → verificar con prueba). El backend efectivo se lee en un solo
  sitio y se inyecta a las superficies que lo necesitan, de modo que WU1/WU4 usen el mismo dato.
  (comando Rust o variable inyectada) para que WU1/WU4 usen el mismo dato.
  Nuevo módulo pequeño (propuesta: `src/lib/drag-session.ts`): `dragMode(effectiveBackend)`:
  `'native'` con display GDK X11; `'compositor'` con display GDK Wayland (incluye
  Hyprland/KWin — el gesto interactivo es protocolo xdg-shell y vale para todos).
  Tests deterministas explícitos:
  - sesión Wayland + display X11 (`GDK_BACKEND=x11`) → `native`, con snap y persistencia;
  - sesión Wayland sin override → `compositor`;
  - sesión X11 → `native`.
  API mínima `{mode, allowSnap, allowPersist}` (snap+persist solo con `mode==='native'`).
  Nota: `is_wayland_session_from_env` del backend quedó **fuera** de esta decisión.

- **WU2 · Widget.tsx: rama de arrastre por compositor.**
  `onGripDown` en modo compositor: llamar `getCurrentWindow().startDragging()` (serial del
  pointerdown) en lugar del pipeline delta/rAF; `onGripMove` no-op (el compositor mueve la
  ventana); `onGripUp`: **sin** `outerPosition()`, **sin** `nearestEdge`, **sin**
  `patchConfig`, **sin** `resolveGeo`; re-bloquear/limpiar timers igual que hoy. La colocación
  persistida vieja (si la hay) queda intacta; el tamaño/posición la decide el compositor.
  Tests: modo compositor nunca llama `setPosition` ni `patchConfig`; modo nativo mantiene el
  flujo actual (regresión).

- **WU3 · Auditoría de recuperación: exempt Wayland.**
  Aclaración del mantenedor (2026-10-29): ya existe — `src/lib/widget-recovery.test.ts:119-135`
  garantiza que `shouldAuditNativePosition` audita solo en Windows (Linux excluido: en Wayland
  `outerPosition()===(0,0)` haría que cada tick «corrigiera» una ventana sana). Verificar que
  la rama de WU2 no la reactiva y **añadir el test de regresión específico**, sin lógica nueva.

- **WU4 · Backend: superficie `windowPositioning` — CORREGIDA por el mantenedor.**
  Nuevo campo en `DesktopSurfaces` de `wm_compat.rs`, **también decidido por el backend GDK
  efectivo** (mismo dato inyectado que WU1). Bajo XWayland (`GDK_BACKEND=x11` / display GDK
  X11) debe reportar **`ok`**, no `limited`. Ramas objetivo:
  - display GDK X11 → `ok` (independiente del tipo de sesión);
  - display GDK Wayland, compositor GNOME → `limited` (nota Mutter: posicionamiento absoluto
    no disponible, arrastre por compositor);
  - display GDK Wayland, módulo KDE/Hyprland/genérica → `limited` (nota genérica; exacta por
    compositor a decidir en T4, postura conservadora).
  Tests Rust por rama (patrón `surfaces_for`), incluido: sesión Wayland + backend X11 → `ok`.

- **WU5 · Frontend: fila en «Sesión de escritorio» + i18n.**
  Mirror TS (`wm-detect.ts`), `SURFACE_LABELS` + clave `settings.shell.surfaces.windowPositioning`
  es/en, textos en tono declarado ("no disponible en este compositor"), render test SSR es/en
  (patrón `Settings-providers-i18n`), regenerar `docs/i18n-inventory.md`.

- **WU6 · Verificación y evidencia.**
  Suite: `npm test`, `npm run typecheck`, `cd src-tauri && cargo test` (y `node
  scripts/i18n-inventory.mjs --check`, cargo fmt clean en los archivos tocados).
  Smoke manual GNOME Wayland nativo: drag visible que mueve la tira, al soltar **sin** imán,
  `config.json` sin cambios en dockEdge/dockOffset (comparar bytes), indicador visible en
  Ajustes. Evidencia en el issue + PR acotada (sin #205/#179/#113).

## Interacciones y límites (de la PR)

- #205 (márgenes/ventana vs tira) sigue abierta: under XWayland/`GDK_BACKEND=x11` la doc de la
  alternativa **no** se incluye acá. El efecto de colocación (`setWidgetBounds`) aplica size
  pero posición es no-op en Wayland → debe quedar sin efecto visual adverso; verificado en
  smoke.
- #183 (PR abierta sobre degradaciones/avisos) no se toca; solo reutilizamos el patrón de su
  test, nada de su territorio.
- El gate `cargo fmt` ya está en CI desde #184: los archivos tocados quedan fmt-clean.
- `core:window:allow-start-dragging` **ya está** en `src-tauri/capabilities/default.json:8`:
  `startDragging()` no necesita cambios de permisos (mantenedor, 2026-10-29).
- Autodeclaración: la decisión de modo/superficie usa el **backend GDK efectivo** (tipo de
  display de GDK en runtime; fallback `GDK_BACKEND`), no el tipo de sesión ni `isWayland`
  (corrección del mantenedor en WU1/WU4 ver arriba).

## Criterios de aceptación

1. En Wayland nativo, el arrastre del asa mueve la ventana (compositor) y al soltar no cambia
   `config.json` (ni imán ni persistencia).
2. En XWayland (`GDK_BACKEND=x11`, sesión Wayland) se conserva el modo nativo: imán al soltar,
   persistencia en `config.json`, dragMode `native` y `windowPositioning` `ok`. Test explícito
   de sesión Wayland + `GDK_BACKEND=x11` → `native` con snap y persistencia (pedido por el
   mantenedor).
3. En X11 el comportamiento actual intacto.
2. «Sesión de escritorio» muestra la superficie nueva con estado coherente por compositor.
3. Tests deterministas de la decisión + detección de sesión (Rust + frontend); suite verde
   completa; inventario i18n `--check` verde.
4. Sin cambios de alcance (#205/#179/#113/layer-shell fuera). Manual smoke con evidencia en la PR.

## Estado

Orden de implementación ajustado a dependencias reales: WU4 (Rust provee el backend GDK efectivo) antes de WU1/WU2.

- [x] T4 (WU4) · Rust: DisplayBackend + windowPositioning + probe GDK — commit `9c3700f`
- [x] T1 (WU1) · drag-session.ts + tests RED→GREEN — commit `0cddf6f`
- [x] T2 (WU2) · Rama drag compositor en Widget.tsx — commit `a07a29f`
- [x] T3 (WU3) · Pin de regresión de la auditoría — commit `6baf9d1`
- [x] T5 (WU5) · Fila Ajustes + i18n + inventario — commit `e0ab9a3`
- [x] WU2 follow-up · Store de decisión a nivel de módulo (fix de 15 regresiones del harness SSR) — commit `98282a9`
- [x] T6 (WU6) · Suite verde (60 archivos vitest + 258 node:test, cargo 45 verde, inventario --check verde) + smoke manual COMPLETO (2026-10-30):
  - A (Wayland nativo): drag mueve la ventana (compositor); al soltar sin imán y config.json SIN CAMBIOS (diff antes/después → SIN CAMBIOS). Observación para el hilo: el contenedor (ventana 320×260) traspasa bordes y la pila no — territorio #179/#205.
  - B (XWayland con GDK_BACKEND=x11): imán funciona y persiste (dockEdge right→bottom, dockOffset 0.451→0.259); degradación derecha/abajo = #179 documentado en la nota de la superficie.
  - Fix intermedio importante: sonda GDK pasaba en spawn_blocking (UB de GTK fuera del hilo principal) — movida al hook setup con cache OnceLock (commit `4f48f5a`); ambos escenarios se repararon con ese cambio.
- [x] T7 · Push a fork + PR — PR #210 abierta (https://github.com/egdev6/quorb/pull/210) con autorización del usuario; evidencia del smoke publicada en el issue. Pendiente por permisos (SrStamm sin triage): asignar `type:bug` y la PR a SrStamm — debe hacerlo el mantenedor.

Evidencia del smoke lista para comentar en el issue (redactar contra los
checks básicos arriba). Decisions pendientes para el mantenedor en la PR:
tests DOM diferidos (jsdom/happy-dom).

## Avisos para la PR (decisiones para el mantenedor)

- Tests de eventos de puntero sobre `Widget.tsx` diferidos: el entorno de
  tests del repo no tiene DOM (sin jsdom/happy-dom en package.json; tests
  .tsx existentes solo SSR). Instalar un paquete DOM es cambio de
  dependencia que corresponde aprobar al mantenedor; la cobertura
  determinista pedida vive en WU1 (decisión) + Rust (detección e
  integración XWayland), y el cableado lo cubre el smoke manual exigido.
- Los mensajes de commit de esta rama están en español (convención del
  repo), decisión confirmada por el contribuidor.

## Revisión del mantenedor (PR #210, changes requested 2026-10-29)

- Review del mantenedor con 5 cambios: (1) rebase sobre `f71039b`; (2) una sola
  detección del backend GDK; (3) bug `dragging` pegado en compositor (salida
  robusta si no llega el pointerup; probar apertura del panel post-soltura);
  (4) condicionales a #205 (nota X11, 4 capturas GDK_BACKEND=x11, doc de la
  variable); (5) descope de `odd/tasks/184-rustfmt-ci-format-gate.md`.
- [x] (1) Rebase hecho sobre `f71039b` con backup `backup/fix-180-pr210-rebase`
  (=`e148f6a` pre-rebase). Conflictos: `Cargo.toml` (gtk 0.18 duplicado) y
  `docs/i18n-inventory.md` (regenerado con `node scripts/i18n-inventory.mjs`,
  `--check` verde).
- [x] (2) Unificación: la sonda WU1 en `setup` (commit `4f48f5a`) quedó
  eliminada como fuente duplicada; la fuente única es `widget_placement`:
  `display_kind()` (OnceLock, sólo hilo de UI) clasifica X11/Wayland/Unknown,
  `transport()` y `wm_compat::get_wm_info` derivan de esa misma caché. El
  command ahora sonda vía `display_backend_on_ui(&window)` (no spawn_blocking)
  y `Unknown`/fallo degrada al fallback por env `display_backend_from_env`
  (precedencia WU4 intacta). Verificación post-rebase: cargo 367 passed /
  3 ignored, cargo fmt --check limpio, vitest src 762 passed (0 failed),
  node --test scripts 0 fail, typecheck 0, i18n-inventory --check verde.
- [ ] (3) Bug `dragging` compositor: verificar `npm run app:dev` y
  `GDK_BACKEND=x11 npm run app:dev` (acordado con el usuario); añadir salida
  robusta si el `pointerup` no llega.
- [ ] Menores: fallback a `compositor` solo Linux; comentario `dragMode()`
  sobre `storedDragMode`; comentario huérfano en `Widget.tsx` ~219; enlace de
  aprobación en la descripción.
- [x] (5) Descope: `odd/tasks/184-rustfmt-ci-format-gate.md` fuera de la PR
  (abandon de `review-27bd42743acae960` autorizado por el usuario y commit de
  remoción; review nativo relanzado sobre el candidato corregido).

## Validación manual del usuario post-rebase (2026-10-29)

- Drag y reposicionamiento funcionan tras el rebase (ambos modos probó el usuario).
- Pila a la derecha con `GDK_BACKEND=x11`: el contenedor invisible traspasa hasta
  la mitad de la pila — territorio preexistente #179/#205 (ventana 320×260 vs
  tira), base-only, nunca introducido por esta rama.
- Sin caja translúcida del contenedor en general; visible SOLO mientras se
  muestra el aviso de API_KEY no aplicada para el proveedor detectado:
  nota de evidencia concreta para las capturas pedidas (punto 4 del review).

## Validación manual del usuario post-rebase, 2ª ronda (2026-10-29)

- Punto 3 (bug `dragging` pegado): NO reproducible — drag e inmediata apertura
  del panel de detalle en varias repeticiones (usuario, Wayland nativo).
  Decisión del review pedía fix sólo si el `pointerup` no llegaba; queda
  documentado como no reproducible + verificación pendiente de más intentos.
- Aviso de proveedor sin credencial NO configurada: en Wayland nativo NO
  aparece el error que sí aparece con `GDK_BACKEND=x11`. Hipótesis alineada
  con la superficie `windowPositioning` limitada: la ventana/mensaje que lo
  muestra se posiciona por X11 (`set_position` sin efecto en native Wayland,
  H1 del smoke #107) — base-only, atribución a confirmar con el mantenedor.
- El contenedor visible bloquea clicks detrás de él fuera de la pila:
  limitación declarada de click-through (documentada en Ajustes), territorio
  #179/#205, preexistente.
- [x] Red de seguridad del punto 3 agregada (commit posterior, decisión del
  usuario): efecto en `src/Widget.tsx` que en modo compositor limpia
  `setDragging(false)` al llegar un `pointermove` con `buttons === 0`
  (señal de soltura que la webview sí recibe tras terminar el grab). Sólo
  compositor: el pipeline nativo conserva su soltura en `onGripUp`. Verificación:
  typecheck 0 + vitest 762/61 verde (RED inaplicable — sin entorno DOM,
  decision jsdom/happy-dom sigue diferida al mantenedor); revalidación manual
  pendiente del usuario.
- [x] Menores del review (2026-10-29, empleado test-first en el store puro):
  (a) fallback por fallo de detección ahora Linux-only vía nueva
  `fallbackDragMode(platform)` en `drag-session.ts` (RED→GREEN: 3 aserciones;
  Windows/macOS conservan `native`/imán; Linux degrada a `compositor`), con
  consumo en el catch del efecto de decisión de `Widget.tsx`; (b) doc block de
  `dragMode()` reubicado sobre su función en `drag-session.ts`; (c) bloque de
  comentario huérfano `#/#180: drag strategy…` eliminado de `Widget.tsx`
  (la store ya vive en `drag-session.ts`); (d) link `issuecomment-*` literal
  de la descripción de la PR reemplazado por el comentario real de aprobación
  del alcance (6503078792). Verificación: typecheck 0; vitest 763/61; i18n
  regenerado al final (`c577e9a`).
- [x] (4) Punto 4 del review cerrado (2026-10-29): nota de la superficie X11
  sin los márgenes de #179 (resueltos por #205, nota viaja con referencia a
  #205) y documentación de `GDK_BACKEND=x11` como alternativa XWayland en
  `docs/build-linux.md` §6.1, con el aviso de colocar la variable en la
  misma línea del comando o exportarla (commits `6f55ceb` + inventario
  `b69c671`). Evidencia con capturas (4 bordes + aviso con contenedor
  visible) publicada por el usuario en issue #180, comentario 6509379529.
  Restante para integrar: force-push del fork (decisión del usuario).
- [x] Force-push al fork completado (2026-10-29, ejecutado por el usuario): PR #210 apuntando a `5cf41b7` (e148f6a...5cf41b7, forced update). Los 5 puntos del review y los 4 menores quedaron cerrados y verificados; pendiente solo la re-revision del mantenedor.
