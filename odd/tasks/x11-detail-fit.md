# x11-detail-fit

Ajuste de la geometría nativa de la ventana `detail` (aviso de API key / panel) bajo Linux/X11/XWayland — issue #215; alcance aprobado por el mantenedor (egdev6) en el hilo de la issue. Diagnóstico y A/B medidos por SrStamm en la misma sesión (comentario del 2026-10-30).

## Problema

Con `GDK_BACKEND=x11` (XWayland en GNOME), la tira ya está limpia tras #205, pero el aviso de API key muestra la caja translúcida de la ventana contenedora: `detail` nace `resizable(false)` + `inner_size(330, 260)`; GTK retiene un piso `PMinSize` sticky y `XResizeWindow` es rechazado en ancho ⇒ ventana `330×379` con contenido de 314 ⇒ banda de ~16 px. A/B: con `resizable(true)` la ventana queda `314×379` exacto.

## Specs (del mantenedor en #215)

- S1: limitar el arreglo a X11/XWayland; Windows, macOS y Wayland nativo sin cambios. Reutilizar las primitivas de #205.
- S2: no conectar el ciclo del widget tal cual — validación exclusiva de `widget`, anclaje propio y generación global de cancelación no compartibles con `detail`.
- S3: preservar la primera apertura: `DetailPanel.tsx` aplica los bounds antes de `showDetail()`; el read-back no debe bloquear la apertura esperando visibilidad ni cachear como confirmada una geometría meramente solicitada.
- S4: no dejar `resizable(true)` permanentemente.
- S5: aceptación = geometría efectiva ajustada al contenido, sin caja, sin resize manual, permiso de resize cerrado, evidencia visual en GNOME/XWayland.

## Decisiones (validadas por el usuario)

- D1: módulo **nuevo** `src-tauri/src/detail_placement.rs`; no extender `widget_placement.rs`.
- D2: `set_detail_bounds` devuelve el **informe** `{status, bounds, reason, read_back}` (espejo de `set_widget_bounds`). Justificación: con `void` el frontend sólo puede cachear la solicitud, exactamente lo que S3 prohíbe; el informe alimenta la caché con la geometría del read-back y da señal para el reintento tras `show()`.
- D3: asignación de #215: `SrStamm` no puede autoasignarse (permiso denegado); la hace el mantenedor. Se avisa al cierre de la implementación.

## Diseño

Reusar de `widget_placement.rs` las primitivas ya genéricas: `transport_from_type_name`, `set_size_constraints`, `fix_size`, `to_logical`/`to_physical`, `size_matches`/`position_matches`. Lo propio del detalle:

- **Generación propia** (static separado del `GENERATION` del widget): una colocación posterior del detalle invalida a la anterior; comprobar antes de cada fase nativa.
- **Un solo tamaño por llamada al hilo de UI**: size request + pistas `min == max == pedido` + `resizable(true)` + resize + `resizable(false)`, confirmado `!is_resizable()` (D1 de #205).
- **Sin anclaje**: `set_position` posterior con `x,y` físicos explícitos; origen por `gdk_window_get_origin` con su valor de retorno.
- **Read-back con ventana oculta**: presupuesto acotado (`READS=4 / SETTLE=15 ms`); si no es legible aún, informe blando sin bloquear la apertura (`unverified`/`read_failed`; `size_refused` si visible pero no concedido).
- **Escala**: factor del `WebviewWindow` del detalle para pedido y read-back; tolerancia ±1 pxphys sólo sobre geometría con read-back (JD-A-006 de #205).
- **Frontend**: cachear `lastAppliedRef` sólo con geometría efectiva; si el informe no confirma, re-pedir la colocación después de `show()`. Dedup `samePhysical` conservado.
- **Motivos**: códigos ASCII sin texto de UI (sin regenerar inventario i18n salvo cambio de catálogo).

## Base y contexto

- Rama `fix/x11-detail-window-fit`, base `origin/main@83b0792` (fijar el sha real en el cierre).
- `origin` = egdev6/quorb (upstream); `fork` = SrStamm/quorb.
- #221 (último upstream) cambia el reintento de `not_viewable` tras `show()` en el widget: leer su patrón en `widget_placement.rs`/`Widget.tsx` antes de escribir el ciclo del detalle.

## Tareas

- T0: rama + este artefacto. ✔ (commit pendiente al cierre)
- T1: backend — `detail_placement.rs` con ciclo X11 del detalle + informe.
- T2: contrato IPC — `set_detail_bounds` devuelve informe; `src/lib/api.ts` tipado.
- T3: frontend — `DetailPanel.tsx` consume informe, cachea geometría efectiva, reintenta tras `show()`.
- T4: tests TDD — Rust deterministas + 1 en vivo ignorada (`GDK_BACKEND=x11`); vitest de apertura/reducción/crecimiento/reapertura/DPI; clippy/fmt/typecheck sin avisos nuevos.
- T5: evidencia en sesión real GNOME/XWayland (`xwininfo` + `xprop`), según S5.
- T6: commits por unidad + PR (sólo con autorización del usuario; asignación de la issue por el mantenedor).

## Evidencia de sesión (T5, GNOME/XWayland real, `GDK_BACKEND=x11`, app de esta rama con config del usuario)

Validación visual humana (SrStamm): aviso de API key abierto, **sin caja translúcida alrededor** (antes: banda de ~16 px a la derecha); captura propia del usuario + captura objetiva del servidor X (`import -window <id>`, sonda fuera del repositorio). Medición instrumental con la ventana aviso abierta:

| ventana | id X11 | geometría (`xwininfo -stats`) | `WM_NORMAL_HINTS` (`xprop`) |
| --- | --- | --- | --- |
| tira (widget) | `0xa00019` | `61×238+0+273` | — |
| detail (aviso) | `0xa0009d` | `314×379+69+258`, IsViewable | mínimo = máximo = base = **314×379** |

`314 = panelWidthFor(48)`: geometría exacta al contenido, min == max == pedido ⇒ el gestor rechaza cualquier resize y no hay superficie sobrante. Prueba en vivo del backend (commit `f56138c`) en verde con webview real: tamaño concedido exacto, permiso cerrado y size request conservando el tamaño tras la retirada.

## Log

- L0 (T0): diagnóstico del A/B tomado del comentario de SrStamm en #215; alcance del mantenedor aprobado en su respuesta (dos cuidados: S2/S3). Plan explicado y validado por el usuario; D1–D3 decididas.
- L1 (T1, commit `9a6622d`): backend con TDD — `detail_placement.rs` nuevo (generación propia, `size_call` única con pistas + permiso confirmado cerrado, posición explícita, read-back acotado tras el cierre del permiso, informe espejo del widget) + 17 tests deterministas con RED observado (16/17 en rojo contra el stub) y 1 prueba en vivo ignorada; `set_detail_bounds` devuelve el informe; no Linux conserva la ruta de `detail_geometry::apply` con `unverified` y `bounds=null`. Verificación: `cargo test --locked --offline` 384→401 (0 fallos, 4 ignorados), fmt limpio, clippy con los mismos avisos de la base (0 en `detail_placement*`); verificador independiente sin hallazgos bloqueantes (nota informativa: si ambos reintentos del `close_permission` informan «no cerrado», el ciclo aborta con informe fallido — cubierto por test). Comentarios en español alineados al estilo de `widget_placement.rs`. Pendiente T2/T3 frontend y T5 evidencia en sesión.
- L2 (T2/T3, commit `15aea55`): frontend con TDD — `detail-placement.ts` nuevo (indecisión de caché: sólo geometría con read-back se cachea; `confirmDetailPlacement`/`retryDetailPlacement` reutilizando `readPlacementWithRetries` de #221), `DetailPanel.tsx` consume el informe, cachea con un `lastAppliedReadBackRef` nuevo, reintenta en silencio tras `showDetail()` sólo en `not_viewable` y aborta por `disposed`/cierre; orden inline place → clip → positioned → show intacto (columnas estructurales de `ui-theme.test.ts`). `api.ts` tipado con el informe. RED observado (24 fallas contra el stub; 4 en la etapa intermedia sin adaptador de reintento) → GREEN. Verificación: vitest 822 (+75) / 65 files, node 298, typecheck limpio; verificador independiente sin bloqueantes (caché vacía en unverified es por diseño: repedida en paths no X11). DECISIÓN (commit `a5bdd48`): `docs/i18n-inventory.md` regenerado — el `--check` fallaba ya en `9a6622d` por strings de error/test de Rust visibles al escáner (nada de interfaz); inventarios de `9a6622d` y HEAD idénticos en el árbol frontend.
- L3 (T5, commit `f56138c`): primera ejecución real de la prueba en vivo (el writer no la corrió) halló un defecto del fixture: pedía `(1859,899)` con una ventana 314×379, fuera de pantalla, y Mutter la reubicaba a `(1606,701)` (= clamp 1920−314 / 1080−379). Arreglado con `(100,100)`: verde con webview real (`GDK_BACKEND=x11` sobre el XWayland de la sesión GNOME): tamaño exacto concedido, permiso cerrado y el tamaño sobrevive a la retirada. Suites completas re-verificadas tras el arreglo: 401 + 4 ignoradas, fmt limpio.
- L4 (T5 cierre): validación visual humana por SrStamm en la app de la rama con config real: aviso de API key abierto **sin caja translúcida** (ver «Evidencia de sesión»: detail `314×379+69+258`, pistas min == max == base 314×379, tira intacta `61×238`; captura propia del usuario + captura del servidor X en `/tmp`, fuera del repositorio). S5 acreditado en GNOME/XWayland para el aviso; los cambios de proveedor/DPI quedan cubiertos por tests deterministas y el dedup del read-back.
