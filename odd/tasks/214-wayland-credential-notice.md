# ODD · #214 — Wayland nativo: no aparece el aviso de proveedor sin credencial

Issue: https://github.com/egdev6/quorb/issues/214
Label: `type:bug` (única; sin assignee ni plan aprobado aún).
Detectado por SrStamm durante la validación manual de #210; NO es regresión de esa rama
(aparece con y sin el cambio de arrastre).

**Estado: aprobado — elegida C con ajustes del mantainer (2026-10-31); implementación
C en rama `fix/214-wayland-detail-transient` (2026-11-01).** Investigación
cerrada en entorno del reporter (2026-10-30): evidencia runtime + candidata C validada
con parche temporal (sin commits, revertida con `git restore`). El reporter decidió
«vamos con C; si no convence el trade-off, se evalúa B» — la aceptación formal del
cambio de producto sigue siendo decisión del mantenedor sobre el resultado real.

## Progreso de implementación (2026-11-01)

- Rama `fix/214-wayland-detail-transient` desde `origin/main` (commit base `4d21f66`).
- **RED**: test `the_detail_anchors_to_the_widget_only_under_native_wayland` en
  `widget_placement_test.rs` fallando antes de la lógica (la función no existía).
- **GREEN**: decisión pura `should_anchor_detail_to_widget(DisplayKind) -> bool`
  (`widget_placement.rs`, junto a `kind_from_type_name`; Wayland → sí, X11/Unknown →
  no). Sonda real: `display_kind` cacheada (`OnceLock`, hilo de UI) pasó a `pub(crate)`;
  en `lib.rs` (setup, `#[cfg(target_os = "linux")]`) el builder de `detail` aplica
  `transient_for_raw(&widget.gtk_window())` sólo con backend Wayland y GtkWindow de la
  tira disponible (sin eso, best-effort: sin anclaje, igual a hoy). Comentarios con la
  semántica honesta exigida: relación de ventana padre, sin promesas. X11 intacto.
- **Checks**: `cargo fmt --all` (sin diffs extra), `cargo test --locked` 404 passed /
  0 failed, `npm test` 298 pass / 0 fail, `npm run typecheck` ✓.
- **Inventario i18n** (`docs/i18n-inventory.md`): sin drift — el cambio no agrega
  textos de cara al usuario (los comentarios no cuentan) y `node
  scripts/i18n-inventory.mjs --check` (el mismo gate del CI) pasa.
- **Commits**: unidad `6cba469` (fix + test), doc ODD `dec1c25`
  (`fix/214-wayland-detail-transient` sobre `4d21f66`); el amend del doc creó un
  snapshot de candidato nuevo (`fdbc7e48…`), cuyo START también devolvió
  consentimiento declinado (sin lineage).
- **Validación manual (reporter, 2026-11-01, Wayland nativo, `npm run app:dev`)**:
  (1) el aviso aparece **junto/sobre la tira**, no en el centro de pantalla (el fix
  funciona); el dialog translúcido centrado por Mutter **tapa la tira** mientras está
  abierto — trade-off declarado de C. (2) El popup **no** queda sobre otras apps
  (una terminal lo tapa): esperado por la semántica de `transient_for` (relación con el
  padre, sin promesa de visibilidad sobre apps ajenas — ajuste 2 del mantenedor) y por
  `always_on_top` no-op en Wayland (tao, #180); una observación similar del parche
  temporal («firme sobre la pila») fue evidencia de esa sesión, no criterio válido.
  (3) Recorrido UX en Wayland: hover → popup → **ESC cierra** sin problemas, cierre y
  reapertura correctos. (4) `GDK_BACKEND=x11`: comportamiento intacto.
- **Review**: switch de review desactivado por decisión del usuario
  (`gentle-ai review mode disable --scope clone`, 2026-11-01); los START previos de
  esta unidad ya habían vuelto consentimiento declinado (ámbito-de-candidato, sin
  lineage). Un acuse de candidato doc-only (`review-8adb864bb59b1bc0`) ardió con
  aprobación; la entrega sigue por política ordinaria. El fix queda **sin review
  nativo**: la revisión es el trabajo manual documentado aquí y los checks del repo.
- **Comentario en la issue publicado** (2026-11-01, gh#6559764767): resumen de C con
  gating, semántica, checks, validación manual y el trade-off del solapado dejado como
  decisión del mantenedor; PR propuesto a la espera de luz verde. Restan: abrir PR con
  autorización explícita (paso 8).
- **Review nativo (historial previo a la decisión de apagar el switch)**: switch de
  review `on` (global); START para la unidad devolvió el consentimiento **declinado
  para este candidato** (`consent-declined-this-candidate`, riesgo medio; sin lineage
  creado, nada quemado).
- **Feedback del mantenedor en la PR #230** (2026-11-01, gh#6560260168, sobre
  `e6fb2d5`): código correcto y checks verdes. Pide: (1) `#[test]` duplicado en
  `widget_placement_test.rs:679` (warning en CI de Linux, test ejecutado dos veces);
  (2) «mapera» → «mapea» y reformular «gtk_window() infallible fall-back» en
  `lib.rs` (la llamada puede fallar y entonces no se ancla); (3) evidencia del
  cierre al salir (mover el puntero fuera del panel y de la tira, sin ciclo de
  reapertura por hover; cambio de proveedor por hover con la tira parcialmente
  tapada; anclaje por clic de #170); (4) actualizar la descripción de la PR: el
  trade-off ya está aceptado como degradación limitada a Wayland nativo.
- **Folow-up aplicado (rama, 2026-11-01)**: `#[test]` duplicado eliminado (403
  passed / 0 failed / 4 ignored, `cargo test --locked`; era 404 con el test
  registrado dos veces), warning `duplicated attribute` ausente tras
  recompilación, `cargo fmt --all` sin diffs e `node scripts/i18n-inventory.mjs
  --check` verde (los comentarios no alteran textos inventariados). Comentarios de
  `lib.rs` corregidos (ortografía y honestidad sobre la falla de `gtk_window()`).
- **Pendiente**: (a) evidencia manual del cierre al salir en la máquina del
  reporte (punto 3 del feedback, requiere sesión Wayland interactiva del
  contribuidor y no es verificable desde CLI); (b) actualizar el cuerpo de la PR;
  los demás ajustes pedidos quedan aplicados.
- **Evidencia manual del cierre (2026-11-01, sesión Wayland nativa del
  contribuidor) — hallazgo negativo**: al mover el puntero fuera del panel, el
  popup **no se cierra** con apertura por hover **ni** con apertura por clic
  (#170); ESC cierra y la reapertura anda bien. Además, el panel translúcido
  cubre por completo la tira: el cambio de proveedor por hover es imposible y
  el clic sobre otro orbe no es alcanzable mientras el popup está abierto. El
  "cierre sin ciclo de reapertura" que pidió el mantenedor no se cumple y la
cobertura real es completa, peor que la "parcial" del trade-off declarado.
  Reportar con honestidad en #230; el caso a favor de la candidata B (render
  inline en la tira) se refuerza.

## Problema

En sesión Wayland nativa (Ubuntu + GNOME/Mutter), al activar un proveedor que requiere
credencial sin configurarlo, el aviso **no aparece** al pasar el cursor sobre el orbe.
Con `GDK_BACKEND=x11` (XWayland), misma máquina y configuración, **sí aparece**.
El usuario Wayland nativo no se entera de que falta la credencial.

Hipótesis del mantenedor en la issue (sin verificar): el aviso depende de posicionar o
redimensionar una ventana, operación sin efecto bajo Wayland (contexto: #180).

## Qué es «el aviso» (verificado)

El aviso vive en el **panel de detalle** (ventana Tauri independiente `label="detail"`),
no en la tira:

- `src/components/ProviderCard.tsx:115` — `eg-notice` con `report.message` para estados
  no-OK; `:37` aviso rojo `role="alert"` con `error`; chips de estado (`needsLogin`/
  `unconfigured`) en `:69`.
- La ventana `detail` se crea en `src-tauri/src/lib.rs:1045-1059` con
  `WebviewWindowBuilder`: 330×260, sin decoraciones, transparente, `skip_taskbar`,
  `resizable(false)`, `focused(false)`, **`visible(false)`** y sin posición inicial.
  Solo `widget` está declarado en `tauri.conf.json`; `detail`/`settings`/`overlay` se
  construyen en código.

## Cadena de apertura del popup (verificada en main)

1. Hover en orbe → `Widget.tsx:764 openFor` → `setHovered(id)` → estado de detalle en
   `Widget.tsx:700-702` → `emitTo(DETAIL_WINDOW, DETAIL_EVENTS.state, state)`
   (`Widget.tsx:1181` conecta `onHover`).
2. `src/DetailPanel.tsx` recibe el estado → `useLayoutEffect` → calcula
   `physicalPanelBounds(detailBounds(...))` (`src/lib/detail-panel.ts:101,119`).
3. `DetailPanel.tsx:104-118` (cola `enqueue`):
   - `await api.setDetailBounds(physical)` → comando `set_detail_bounds`
     (`lib.rs:74-86`) → `detail_geometry::apply` → en no-Windows:
     `window.set_position(...)` + `window.set_size(...)`
     (`src-tauri/src/detail_geometry.rs:75-84`).
   - `clipSurfaceSafely(...)` → `set_surface_clip` (no-op defensivo en Linux,
     `window_clip.rs`; valida `normalized()`).
   - `setPositioned(true)` → el panel pasa a `visibility: visible`
     (`DetailPanel.tsx:158`; hasta entonces `visibility: hidden`).
   - `await api.showDetail()` → comando `show_detail` (`lib.rs:844-857`): comprueba
     `widget.is_visible()`; si la tira está visible, `detail.show()`.

**Hallazgo clave del gate:** en `DetailPanel.tsx` el contenido solo se vuelve visible
tras `positioned=true`, y `showDetail()` se ejecuta DESPUÉS de `await setDetailBounds`.
Si `setDetailBounds` rechaza en runtime, la cola muere vía `.catch(console.warn)` y
`showDetail()` **nunca se ejecuta** → la ventana queda `visible=false` → el aviso no
aparece. Es el mecanismo candidato más fuerte para «no aparece» (vs. «aparece en el
lugar equivocado»).

## Comportamiento tao 0.37.1 bajo Wayland (verificado en fuentes del crate)

- `set_outer_position` (`platform_impl/linux/window.rs:472`) → `WindowRequest::Position`
  → `gtk_window_move()` = **no-op silencioso** bajo xdg-shell (Mutter wonfix; tao#566;
  contexto #180). El error, si llega, solo se loguea; la API es fire-and-forget.
- `set_inner_size` (`window.rs:505`) → `window.resize()` — resize cliente sí funciona
  bajo xdg-shell.
- `set_always_on_top`: marcado **Unsupported** en Linux/Wayland (#180 §4). La ventana
  `detail` se construye con `.always_on_top(cfg.always_on_top)` (`lib.rs:1054`): en
  Wayland no opera → el popup podría mapearse detrás de otras ventanas.
- El builder de ventanas Linux de tao sí acepta `.transient_for(&parent)`
  (`window.rs:92`) — vía candidata a popup anclado (ver soluciones).

## Hipótesis rankeadas (sin confirmar en runtime)

1. **H1 — La cadena muere antes de `showDetail`** (fuerte): `setDetailBounds` rechaza
   en Wayland → `positioned` nunca es true → ventana jamás visible. Nota: por lectura
   de tao, `set_position`/`set_size` son infallibles fire-and-forget, así que el rechazo
   tendría que venir de otra parte (`validate`, `run_on_main_thread`, canal). **Requiere
   verificación runtime**: logging temporal en la cola de `DetailPanel.tsx` bajo Wayland
   nativo (¿llega a `showDetail`? ¿qué devuelve `setDetailBounds`?).
2. **H2 — El popup se muestra pero en el lugar equivocado** (posible): `set_position` es
   no-op → el compositor elige posición (centro/cascada); sin `always_on_top` podría
   quedar detrás de otras ventanas → el usuario lo reporta como «no aparece».
3. **H3 — Quirks de `show_detail`** (débil): `widget.is_visible()` o foco/stacking en
   Mutter; sin evidencia todavía.

Diferenciador H1 vs H2: en XWayland `set_position` funciona (X11 permite posicionamiento
de cliente), por eso el aviso aparece «pegado» a la tira; en Wayland nativo el mismo
código hace no-op. Ambas hipótesis explican la diferencia de backend.

## Candidatas de solución (para proponer al mantenedor tras verificar)

- **A — Degradación acoplada al surface `window_positioning`** (infra ya existe desde
  #180: `wm_compat.rs:91` `surfaces.window_positioning`, `src/lib/wm-detect.ts`): si es
  `limited`, no exigir posicionamiento para mostrar el aviso — desacoplar `showDetail`
  del éxito de `setDetailBounds` (mostrar el popup donde lo coloque el compositor en
  lugar de no mostrarlo). Mínima y honesta.
- **B — Render inline en la tira en Wayland**: mostrar el aviso dentro de la ventana
  del widget (que sí puede redimensionarse vía xdg-shell). Precedente: infra de peek
  window `usesPeekWindow`/`peekRect` (`src/lib/auto-hide.ts:30,50`;
  `Widget.tsx:518,553`). Refactor mayor.
- **C — `detail` transient-for `widget`**: tao builder soporta `transient_for`
  (window.rs:92) → el popup se mapea como hija/anclada a la tira bajo Wayland. **Pendiente
  de verificar**: Tauri 2.12.1 estable ¿expone transient_for en `WebviewWindowBuilder`?
  Si no, requeriría feature upstream o acceso raw.
- **D — layer-shell**: descartado (Mutter no implementa `zwlr_layer_shell_v1`, ya
  establecido en #180).
- **E — xdg_positioner/parent popup**: requiere API de parent window no expuesta por
  Tauri hoy; depende de C.

## Evidencia runtime (máquina local del reporter, reprueba directa) — 2026-10-30

Máquina local = máquina del reporter: Ubuntu, GNOME Shell 50.1, Wayland nativo
(`wayland-0`; XWayland presente). Se probó con app `npm run app:dev`, parche temporal
`/[TEMP-214]/` en `lib.rs`, sin commits.

**H1 — DESCARTADA.** Logs de `set_detail_bounds`/`show_detail` durante hover real en
Wayland nativo:

- `set_detail_bounds ... native result=Ok(())` siempre (6+ eventos de hover).
- `show_detail called widget_visible=true` → `detail.show()` devolvió `Ok`.

La cola completa llega a `showDetail` sin rechazos: los setters GTK/tao en Linux son
fire-and-forget por canal y el `Result` de Tauri solo refleja ese send (verificado en
fuentes de `tauri-runtime-wry 2.12.1` y `tao 0.37.1`; `set_position`/`set_size` nunca
devuelven error por posicionamiento). El `.catch(console.warn)` de `DetailPanel.tsx`
no entra en juego bajo Wayland nativo.

**H2 — CONFIRMADA.** Mismo log: `outer_position={0,0}` con tamaño correcto
(GTK desconoce/ignora la posición pedida: el pequeño `move` es no-op y el compositor
elige el lugar). En observación visual del reporter: el popup con el aviso de falta de
credencial **aparece en el medio de la pantalla**, no pegado a la ni encima del tira.
`always_on_top` no-op elegante: cero warning de GDK/GTK, coincide con lo visto en
la sonda GTK autónoma (`AT-SPI` reporta root coords `(0,0)` aunque se pida `(120,120)`;
las ventanas de la sonda sí mapean).

**Candidata C — VALIDADA con app real.** Parche temporal Linux-only en `lib.rs:
`detail_builder.transient_for_raw(&widget.gtk_window())` (Tauri 2.12.1 expone
debidamente `transient_for`/`transient_for_raw`, `webview_window.rs:755/771`).
Resultado al hover en Wayland nativo (reporter):

- El popup aparece **anclado a la tira** (encima de ella), no en el centro.
- El popup queda **siempre por encima de la tira** (incluso con la terminal sobre
todas las demás ventanas el mensaje quedava firme sobre la pila).
- Costo declarado: el dialog se centra en el padre y lo **tapa** mientras está
abierto (Mutter centra dialogs respecto del padre; xdg no ofrece offset para
toplevels). Estilismo/degrado antes que “aparece en el medio”.
- En este build log a观望 las mediciones: `outer_position` tras show a veces read
`0,0` y size temporalmente `0×0` (compositor aún no configuró): benigno.

**A (decouple showDetail) — NO APLICABLE a este bug.** Pre-condition de A era un H1
que ya no existe.

## Respuesta del mantenedor (consulta a GitHub 2026-11 — egdev6)

El diagnóstico le es consistente con el código actual (llega a `showDetail()`; no
depende de que el compositor conceda coordenadas); no reprodujo la sesión gráfica.
**Recomienda C**, con tres ajustes obligatorios antes de dar conformidad al alcance:

1. **Gating por backend GDK efectivo Wayland**, no `cfg(target_os = "linux")` (también
   tocaría X11/XWayland) y **nunca por `XDG_SESSION_TYPE`**. → El repo ya tiene la
   primitiva: `widget_placement::display_kind()` (sonda GTK cacheada del display real,
   `gdk::Display::default().type_().name()`), usada por #180; decidir por esa lectura
   en runtime (Wayland únicamente; `X11`/`Unknown` → sin anclaje, comportamiento
   X11 intacto).
2. **Semántica honesta de `transient_for`**: relaación con ventana padre; ni anclaje
   preciso ni garantía de centrado/visibilidad sobre apps ajenas. Lo observado en
   Mutter es evidencia local, no promesa. → Comentarios y docs sin promesas.
3. **Validar el recorrido UX completo bajo Wayland nativo** (y contrastar XWayland):
   hover → entrar al popup → salir/cierre → reapertura → cambio de proveedor →
   ocultación de la tira; el solapamiento (popup tapa la tira mientras abre) puede
   romper el flujo; Linux no tiene muestreo nativo de presencia como macOS.

Trade-off «popup centrado tapando la tira»: **no aceptado por el mantainer** —
`detail` contiene todo el panel, no solo el aviso; B queda como alternativa separada
(refactor mayor, no en este alcance).

## Plan ODD de C (aprobado 2026-11 por el reporter)

Pre-condición por skill `odd-contribute`: reasignación/claim verificado en GitHub
antes de tocar código (issue abierta, sin assignee, sin PR solapada). Checks del
repo: `npm test`, `npm run typecheck`, `cd src-tauri && cargo test` + `cargo fmt`.

1. **Claim y preflight** — releer GitHub (estado, assignees, PRs abiertas),
   `gh issue edit 214 --repo egdev6/quorb --add-assignee SrStamm`, verificar.
2. **Rama de feature** — `fix/214-wayland-detail-transient` desde `main` (la
   implementación nunca va directo a default branch).
3. **TDD de la decisión de gating (RED/GREEN)** — función pura, testable con
   `cargo test` p.ej. en `widget_placement.rs`/`detail_geometry.rs`: dada la sonda del
   backend efectivo, decide si se ancla `detail` (Wayland → sí; X11/Unknown → no).
   Red observes un test fallando antes de escribir la lógica; el comportamiento
   GTK/compositor no es unit-testeable y queda para validación manual (paso 6).
4. **Implementar el anclaje (GREEN)** — en el setup de `lib.rs` (`#[cfg(target_os
   = "linux")]`), con la sonda del display real: si backend == Wayland y
   `app.get_webview_window(WIDGET)` expone su GtkWindow, aplicar
   `transient_for_raw` al builder de `detail` (sin `eprintln!` TEMP-214). Comentarios
   que `transient_for` es relación de padre, sin promesas de anclaje/centrado.
5. **Checks** — `cargo fmt --all` (commit de formato separado si mueve líneas),
   `npm test`, `npm run typecheck`, `cargo test --locked`. Si el inventario i18n
   cambia (los comentarios no cuentan), regenerar con
   `node scripts/i18n-inventory.mjs`.
6. **Validación manual en la máquina del reporter** — Wayland nativo: popup anclado
   a la tira + encima; `GDK_BACKEND=x11`: posicionamiento preciso intacto (X11
   idéntico a hoy). Recorrido UX completo del ajuste 3 del mantainer, con el popup
   tapando la tira. Documentar evidencia (logs + capturas).
7. **Docs + commit de unidad** — comentarios honestos, doc del trade-off límite de
   `transient_for` (ingles/convención repo; textos de UI intactos), Conventional
   Commit `fix(linux/wayland): anchor detail popup to widget bar under native Wayland
   (#214)`; commit con tests + docs junto al comportamiento.
8. **Revalidar GitHub y proponer el PR** — releer issue/PR solapadas, resumir
   aceptación + evidencia; abrir PR con autorización explícita del reportero (el PR
   va como propuesta; el mantainer revisa el trade-off sobre el resultado real).

Fuera de alcance: cambiar Win/macOS; el render inline de B salvo decisión posterior;
posición con offset en Wayland (xdg no lo ofrece para toplevels).

## Notas de contexto

- El `show_detail` solo exige que la tira sea visible (`lib.rs:844-857`); no hay gating
  de hover por `window_positioning` en `openFor` — el popup intenta abrirse igual en
  ambos backends; la diferencia está en la cadena nativa.
- `set_surface_clip` en Linux es no-op con validación defensiva; no es candidato.
- Repo local: rama `main`, remotos `origin` (egdev6/quorb) y `fork` (SrStamm/quorb).
- Patrones de ODD previos relacionados: `odd/tasks/180-wayland-compositor-drag.md`,
  `odd/tasks/181-linux-degradation-reporting.md`.
