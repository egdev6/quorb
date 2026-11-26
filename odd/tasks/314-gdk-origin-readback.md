# 314-gdk-origin-readback

> Issue: https://github.com/egdev6/quorb/issues/314 — `type:bug`, `status:approved`; autor y assignee: @DonatoSilva. El owner aprobó el alcance de la PR1 el 2026-11-25 (L2, S1-S8) y la PR1 en sí el 2026-11-26 (L20).
> Rama: `fix/314-gdk-origin-readback` (desde `upstream/main` 61c4813). Fork: `DonatoSilva/quorb` → base `egdev6/quorb:main`. PR: **#319** (publicada el 2026-11-26, `Refs #314`, no cierra la issue — S7).
> Alcance: el defecto de lectura del origen en los dos lectores X11 (tira y detalle). Recuperación, monitor de respaldo y recolocación al relanzar: PR2 (S8).
> Riesgo: item 3 (contrato `Report.reason` compartido con el front) → verificación independiente.

## Specs

- S1: "Corregir el consumo de la tupla y la interpretación del retorno en los dos lectores existentes, tira y detalle." — el binding fijado `gdk 0.18.2` devuelve `(retorno, x, y)` en `Window::origin()` (`src/auto/window.rs:497-503`), y el código lo desempaqueta como `(ox, oy, rooted)` en `widget_placement.rs:840-842` y `detail_placement.rs:510-512`.
- S2: "GDK documenta el retorno como «Not meaningful, ignore», así que no basta con reordenar y seguir usando `retorno != 0` como indicador de éxito." — el `ret` no puede seguir siendo el flag de "hay origen".
- S3: "No hace falta sustituir la API por `tao::outer_position()` ni introducir otra capa de adaptadores." — el arreglo se queda en el consumo de la tupla que ya existe.
- S4: "Corregir los comentarios y tests que asumen ese flag." — comentarios en `widget_placement.rs:23,225,227,831` y `detail_placement.rs:29,507`; test del helper `rooted_origin` en `widget_placement_test.rs:642`.
- S5: "Añadir regresiones con tuplas reales del binding: `y=0`, origen `(0,0)`, coordenadas negativas, `y` no nulo, conversión de escala y retorno no significativo. El `Fake` actual entrega geometría ya decodificada y no cubre esta frontera." — hace falta un seam puro que reciba la tupla cruda; el `Fake` (`widget_placement_test.rs:110`, `detail_placement_test.rs:92`) no llega a esa frontera.
- S6: "Repetir la traza X11 con la corrección para comprobar la lectura concedida." — evidencia de validación que va en la PR.
- S7: "La PR1 debe usar `Refs #314`, no cerrarla" / "sin cambios en el gate de #180" / "macOS fuera de alcance salvo evidencia" / "El detalle entra en esta PR1 porque tiene exactamente el mismo defecto de lectura, no para ampliar su política de recuperación."
- S8: "La recuperación, el monitor de respaldo y la recolocación al relanzar siguen pendientes de definición para la PR2" — fuera de alcance de PR1.
- S9: el cambio debe quedar explícito "en que paso del ciclo de vida del software estamos agregando o quitando" — esta doc declara el paso tocado: **read-back (paso 6 del ciclo de colocación)** y su consecuencia en el **reporte (paso 8)**.
- S10: "unifica la validacion en los sistemas operativos soportados ?" / "Por que linux no deberia tener auditoria de recuperacion ?" — esta doc declara qué está unificado (el contrato) y qué no (el mecanismo), y por qué Linux no puede reusar la auditoría de Windows tal cual (D4, D5).
- S11: "el flujo de validacion y read-back depende del sistema ?? osea no podemos unificar el flujo logico para no repetir codigo??" — esta doc declara el estado de la unificación del flujo lógico y qué parte queda deliberadamente fuera de PR1 (D6).

## Mecanismo (medido)

Contrato del binding (`gdk-0.18.2/src/auto/window.rs:497-503`):

```rust
pub fn origin(&self) -> (i32, i32, i32) { … (ret, x.assume_init(), y.assume_init()) }
```

⇒ hoy `ox = ret`, `oy = x`, `rooted = y`. Traza de una colocación real (comentario del contributor en la issue):

```
MOVE pide=(1220,0) -> lógico=(1220,0)   monitor GDK: eDP-1 origin=(0,0)
READ posición real=(1220,0)  tao_outer=(1220,0)  tao_inner=(1220,0)  gdk position=(1220,0)
     gdk_window.origin()=(1,1220)   rooted=false
```

El read-back es el único roto: `tao` outer, `tao` inner y `gdk_window.position()` coinciden con la petición.

Efecto del desempaquetado sobre el ciclo, según la posición real:

| Caso | Tupla cruda | Interpretación actual | Informe (paso 8) |
| --- | --- | --- | --- |
| Tira docked arriba (`y = 0`) | `(1, 1220, 0)` | `rooted = 0` → `None` | `Unverified` / **`ReadFailed`** |
| Tira docked abajo/lateral (`y ≠ 0`) | `(1, 3537, 42)` | origen = `(ret, x)` transpuesto | `Limited` / **`PositionRefused`** |

⇒ En Linux el paso 8 nunca puede decir "aplicado y verificado", aunque la ventana esté exactamente donde se pidió; y el front nunca cachea geometría real (`src/lib/widget-placement.ts:130-140` sólo cachea con `read_back === true`).

Lo que PR1 **no** arregla (PR2): la pantalla X11 no coincide con el escritorio del compositor — `xrandr` da `eDP-1 +0+0` / `HDMI-A-1 +1920+0`, Hyprland da `0x0` / `-2560x0`; un cliente en X `x` aparece en Hyprland en `x - 4480`. La auditoría de recuperación es hoy Windows-only (`src/lib/widget-recovery.ts:41-43`).

## Evidencia (traza X11 en esta máquina)

Mismo equipo, misma configuración (`dockEdge: right`, `dockMonitor: HDMI-A-1`), misma instrumentación desechable en las dos versiones. La app corre con `GDK_BACKEND=x11` (XWayland); con el backend Wayland el ciclo X11 no corre y no hay read-back por diseño.

**ANTES** (`upstream/main`):

```
origin crudo = (1, 4432, 379)
desempaquetado VIEJO = ox=1  oy=4432  rooted=379   <- el 3º valor es la Y, no un flag
origen leído (VIEJO) = (1, 4432)
Report = { status: Limited,  bounds: (x: 1, y: 4432),  reason: PositionRefused, read_back: true }
```

La app informaba la tira en **(1, 4432)** —el código de retorno en la X y la X real en la Y— y acusaba al gestor de negarle la posición. La ventana real estaba en **(4432, 379)**.

**DESPUÉS** (esta PR1):

```
origin crudo = (1, 4432, 379)
origen leído (físicos) = (4432, 379)
Report = { status: Applied, bounds: (x: 4432, y: 379), reason: None, read_back: true }
```

Misma tupla cruda, misma ventana, informes opuestos. El tamaño leído (48×194) coincide con el cliente que reporta el compositor.

**Unidades** (experimento con `GDK_SCALE=2`):

| | `GDK_SCALE=1` | `GDK_SCALE=2` |
| --- | --- | --- |
| `origin()` (GDK) | `(1, 4403, 436)` | `(1, 2192, 141)` |
| `gdk_window.position()` | `(4403, 436)` | `(2192, 141)` |
| `tao::outer_position()` | `(4403, 436)` | `(4384, 282)` |
| `window.scale_factor()` | 1 | 2 |

⇒ GDK devuelve **píxeles de aplicación** (2192 = 4384/2): la conversión a físicos con el factor de la ventana es la correcta, y es la que ya aplicaba el lector antes. Además, `tao::outer_position()` devuelve **píxeles físicos**: no era un sustituto equivalente del read-back de GDK (mezclaría dos unidades con el tamaño, que viene de `gdk_window_geometry()` en lógicos).

## Decisiones

- D1: La garantía de "hay origen" pasa a ser **`is_viewable()`**, que el lector ya consulta (`widget_placement.rs:829`, `detail_placement.rs` equivalente) antes de leer. Es la única lectura compatible con S2: el `ret` no significa nada, pero una ventana visible está mapeada y por lo tanto tiene posición en raíz.
- D2: El seam es una **función pura**: `rooted_origin(raw: (i32, i32, i32), scale: f64) -> (i32, i32)`. Recibe la tupla cruda, **ignora el `ret` por contrato** (documentado en el doc-comment: es lo que permite fijar "el retorno no significa nada" con un caso de regresión propio) y devuelve el origen en **píxeles físicos**. La conversión de escala vive dentro del seam a propósito: el caso "conversión de escala" de S5 sólo es ejecutable por la interfaz pública si la conversión está en el seam (los lectores son GTK-only y el `Fake` entrega geometría ya decodificada).
- D7: El seam conserva el nombre `rooted_origin`: lo que se elimina es el **flag**, no el hecho de que el origen sea **relativo a la raíz** (esa es la razón de no usar el respaldo `gdk_window_get_geometry`, que es relativo al padre). El nombre se queda para que el diff sea revisable; el doc-comment deja explícito que ya no hay «rooted» que verificar.
- D3: Desaparece la rama `Err("the native window origin could not be read")` y con ella el `ReadFailed` espurio. El `Err` que queda en `read_geometry` es el del cierre/timeout de la llamada nativa, que es un camino distinto y ya está cubierto (`widget_placement_test.rs:280`).
- D4: **PR1 no unifica la validación entre los sistemas operativos.** Lo que ya está unificado es el *contrato*: `Status` / `Reason` / `Report` (`widget_placement.rs:49-96`) se compilan sin ningún `#[cfg(target_os)]` y el front consume el mismo vocabulario sin saber de qué SO vino el informe (`src/lib/widget-placement.ts:122-140`, `src/detail-placement.ts:56-79`). Lo que no está unificado es el *mecanismo*: sólo X11 tiene read-back nativo (ciclo `drive()`); Linux/Wayland nativo va por `window_fit::fit_plan`/`fit_widget` sin read-back (`widget_placement.rs:500-528`); Windows y macOS caen en `detail_geometry::apply_widget` con `read_back: false` (`widget_placement.rs:606-620`). PR1 arregla el único read-back que existe y **habilita** la fuente que después permite una auditoría de recuperación en Linux; no la crea (S8).
- D5: Linux **no puede reusar la auditoría de Windows tal cual** — no por política, sino por su fuente de lectura: en xdg-shell `outerPosition()` es `(0,0)` por diseño y el sizing de GTK difiere, así que cada tick vería "ventana sana desplazada" y la recolocaría en bucle (el parpadeo y la tira que desaparece de #168/#148). Evidencia en el repo: `src/Widget.tsx:837-839`, `src/lib/widget-recovery.ts:30-39`, fijado por `src/lib/widget-recovery.test.ts:139-147`. El pin WU3 de `odd/tasks/180-wayland-compositor-drag.md:92-96` protege contra *reactivar la auditoría de Windows en la rama Wayland*, no contra construir una auditoría Linux con la fuente correcta. Wayland nativo y macOS quedan fuera por no tener geometría absoluta, no por decisión.
- D6: El **flujo lógico ya está unificado**: un solo `trait Surface` (`widget_placement.rs:144-171`), una sola `drive()` (`:282-374`), un solo vocabulario `Status`/`Reason`/`Report` (`:49-96`, sin `cfg` por SO), y el read-back como **método del trait** (`read_geometry`), no como una rama por SO. No hay un flujo por sistema operativo: hay dos ejes distintos — dentro de Linux, X11 vs Wayland (`Transport`, `display_kind()`), y fuera de Linux, la ruta sin read-back (`detail_geometry::apply_widget`, `read_back: false`). Lo que sí está duplicado, y en tres puntos: (a) la bifurcación de transporte dentro de `place()` (`:569`); (b) **la posición nativa se lee por dos canales distintos** — el front pide `outerPosition()` a la webview (`src/Widget.tsx`, `src/lib/widget-recovery.ts`) y el Rust lee GDK (`read_geometry`) — y en Linux esos canales no pueden coexistir porque el del front miente; (c) `widget_placement.rs` y `detail_placement.rs` son dos copias casi idénticas del mismo ciclo (`drive`, `request_size_checked`, `report_of`, `failed_report`, `rooted_origin`, `read_geometry`), y por eso PR1 toca dos lectores. Hay tres unificaciones posibles, y **PR1 no hace ninguna**: **U1** — un módulo común de colocación parametrizado por la superficie, para eliminar (c): refactor grande, fuera del alcance aprobado ("chica y testeable"); candidato a issue propia. **U2** — un único canal de "posición nativa ahora" que usen tanto la verificación (push, Rust) como la auditoría (pull, TS), para eliminar (b): es el camino natural de PR2, y convertiría `shouldAuditNativePosition` de "¿es Windows?" en "¿este SO tiene fuente de posición nativa confiable?". **U3** — que la ruta sin read-back también pase por `drive()` con una superficie que reporte "no hay posición disponible", en vez de construir el informe a mano (`widget_placement.rs:615-617`): barato, pero toca la ruta de Windows y roza el gate de #180, así que tampoco entra en PR1. **U1 queda para una issue aparte, NO abierta**: el usuario pidió sacarla del alcance y conservarla en memoria —no en el repo— hasta que la pida.

## Tasks

- [x] T1 — S1-S11 — Crear este documento de feature. Route: inline. Commit: —
- [x] T2 — S5 — RED: test puro del contrato del binding con tuplas reales (`y=0`, origen `(0,0)`, coordenadas negativas, `y` no nulo, escala, retorno no significativo) en `widget_placement_test.rs` y `detail_placement_test.rs`. Route: inline. Commit: —
- [x] T3 — S1, S2, S3, S5 — GREEN: seam puro + consumo correcto de la tupla en los dos lectores (`widget_placement.rs:840-842`, `detail_placement.rs:510-512`); se retira la rama de error del origen. Route: inline. Commit: —
- [x] T4 — S4 — Corregir comentarios que describen el flag y el test que lo fijaba (`widget_placement_test.rs:642`); comprobar que los tests de pin del ciclo siguen verdes. Route: inline. Commit: —
- [x] T5 — S6 — Traza X11 con la corrección: arranque + un movimiento; capturar `origin()` crudo contra `tao` outer/inner y `gdk position`, y el `Report` resultante (`read_back: true`, `bounds` con el origen real). Instrumentación desechable, sin commit. Route: inline. Commit: —
- [x] T6 — S7, S9, S10, S11 — Checks: `cargo fmt --all`, `cargo test` (src-tauri), `npm test`, `npm run typecheck`, `npx biome ci`. Route: inline. Commit: —
- [x] T7 — S7, S8 — Commit + push al fork + PR a `egdev6/quorb` con la plantilla completa (alcance, exclusiones, coordinación, aceptación, evidencia de checks) y `Refs #314`; asignar la PR a @DonatoSilva. Route: inline. Commit: —

## Riesgo

- **item 3** — el contrato compartido que cambia es `Report.reason`, que alimenta la lógica del front (`src/detail-placement.ts:69` ramifica por `read_failed`; `src/lib/widget-placement.ts:167` reintenta por `not_viewable`). El diff cambia qué `reason` emite el camino Linux: `ReadFailed` → `Applied`/`Limited` con geometría real, y en Linux el front pasa a cachear la posición efectiva. En Windows y macOS no cambia nada.
- Verificación: `gentle-ai-verify` independiente sobre el diff + los tests de pin del ciclo (los ~20 de `widget_placement_test.rs` y ~17 de `detail_placement_test.rs`).
- Lo que no se cubre: Windows ni la experiencia real de compositor. Los checks de Linux no validan Windows (CONTRIBUTING, "Pull requests"). El **camino de finales de línea** de Windows sí quedó cubierto por una regresión que corre en Linux (L22): lo que sigue sin cubrir es la ejecución en Windows.

## Estrategia de entrega

- Una rama: `fix/314-gdk-origin-readback`, base `upstream/main` 61c4813, publicada en el fork `DonatoSilva/quorb`; la PR se abre contra `egdev6/quorb:main` (no hay permiso de push al upstream: `permissions.push = false`).
- Unidades de commit: T2+T3+T4 en un commit de comportamiento (`fix(linux): leer el origen de la ventana en el orden del binding`), T5 como evidencia en el cuerpo de la PR, T6 sin commit, T7 con la PR.
- El doc se actualiza con el commit que contiene cada tarea.
- **Corte de commits de la PR1:** `fdad9cd` — código y tests (4 archivos de Rust, el cambio de comportamiento); `343af25` — doc de la feature; `4b6b984` — anexo con los textos de publicación (235 líneas, sólo documentación). El anexo se retiró del documento en el seguimiento de la PR: los textos de publicación viven en la PR, no en el repo.

## Log

- L1: el trabajo arranca sobre la issue #314, verificada como propia y asignada a @DonatoSilva, en estado `OPEN`, con las labels `type:bug` y `status:approved`, y sin PR solapada (abiertas: #317 y #318 de @DonatoSilva sobre #312, #311 y #303 de @sosan sobre #276 y #281).
- L2: el owner ya había aprobado el alcance de la PR1 en la issue (PR1 acotada al defecto de lectura, issue a `status:approved` con ese alcance y asignada al contributor), así que no hace falta responderle ni pedir permiso; la PR sale desde el fork porque `push` al upstream es `false`.
- L3: el plan se pide con el flujo y el paso del ciclo de vida que el cambio toca; de ahí S9 y la sección "Mecanismo".
- L4: el usuario pregunta si la validación se unifica entre los sistemas operativos soportados; respuesta: el contrato está unificado (`Status`/`Reason`/`Report`, sin `cfg` por SO), el mecanismo no; PR1 no unifica (D4).
- L5: el usuario pregunta por qué Linux no debería tener auditoría de recuperación; respuesta: Linux X11 sí debería (es la mitad "no se recupera" del issue, PR2), pero no puede reusar la auditoría de Windows porque su fuente (`outerPosition()`) es `(0,0)` por diseño en xdg-shell y produciría un bucle de recolocación (#168/#148); el pin WU3 de #180 protege contra reactivar esa auditoría en Wayland, no contra construir una Linux con la fuente correcta (D5).
- L6: el usuario pregunta si el flujo de validación y read-back depende del sistema y si se puede unificar el flujo lógico para no repetir código; corrección aplicada a este documento: D4 reescrito (no es una prohibición de auditar Linux, es que la fuente de Windows es inválida en xdg-shell), D5 y D6 añadidos.
- L7: evidencia del maintainer — "la versión fijada, `gdk 0.18.2`, devuelve `(retorno, x, y)` en `Window::origin()` (`src/auto/window.rs:497–503`). En cambio, `widget_placement.rs:840–842` y `detail_placement.rs:510–512` la desempaquetan como `(ox, oy, rooted)`" (S1).
- L8: evidencia del maintainer — "GDK documenta el retorno como «Not meaningful, ignore», así que no basta con reordenar y seguir usando `retorno != 0` como indicador de éxito" (S2, D1).
- L9: evidencia del contributor — traza de una colocación real: `gdk_window.origin()=(1,1220)` con `rooted=false` para una ventana realmente en `(1220,0)`, mientras `tao_outer`, `tao_inner` y `gdk position` coinciden con la petición ("Mecanismo").
- L10: evidencia del contributor — la pantalla X11 no coincide con el escritorio del compositor (`xrandr` `eDP-1 +0+0` vs Hyprland `0x0`; un cliente en X `x` aparece en Hyprland en `x - 4480`). Es material de PR2, no de PR1 (S8).
- L11: el usuario decide sacar la hiper-refactorización (U1) a una issue aparte, **sin abrirla**: queda en memoria y se consulta cuando él lo pida. U2 (canal único de posición nativa) es el camino de la PR2; U3 se parte en un constructor único del informe (pequeño) y el ruteo por `drive()` (refactor, fuera).
- L12: Publicación de la PR1 (2026-11-26, con OK explícito del contributor al texto final): **PR #319** contra `egdev6/quorb:main`, con `Refs #314`, un comentario técnico en la PR y un aviso en la issue. Tres ajustes editoriales antes de publicar: el cuerpo de la PR declaró este documento ODD como documento del proyecto (en vez de "not applicable"); el comentario técnico de la PR se redujo a los diez puntos agrupados en cuatro bloques (la versión punto por punto repetía la tabla de unidades que el cuerpo ya declara); el aviso de la issue bajó a 438 caracteres, con el registro que el contributor usa en sus avisos (link, qué trae, qué queda, revisión cuando pueda). El hallazgo del desfase de 4480 px entre la superficie X y el escritorio del compositor sale del comentario de la issue y queda sólo acá, como insumo de la PR2: no se abre conversación sobre el orden de la PR2.
- L13: handoff del worker (T2→T4) y revisión del padre. RED observado: `cargo test --lib widget_placement_test::the_raw_binding_tuple_is_read_as_the_origin` falla con `left: None / right: Some((1220, 0))` (el consumo anterior leía `y == 0` como «no hay origen»), y el juego de regresiones escrito contra el contrato final ni compilaba contra la firma vieja (`error[E0061]: this function takes 3 arguments but 2 arguments were supplied`). GREEN: `cargo test --lib widget_placement` 36 passed / 0 failed / 1 ignored; `cargo test --lib detail_placement` 23 passed / 0 failed / 1 ignored; `cargo fmt --all -- --check` exit 0 sin diff. Verificado por el padre: `is_viewable()` se consulta **antes** de leer en los dos lectores (`widget_placement.rs:829`, `detail_placement.rs:505`), así que D1 se sostiene; `to_physical` redondea bien; no queda ningún consumidor del flag retirado.
- L14: **traza A/B** (T5). Con `GDK_BACKEND=x11`: antes `(1, 4432, 379)` → desempaquetado viejo `ox=1 oy=4432 rooted=379` → origen `(1, 4432)` → `Limited`/`PositionRefused`; después → origen `(4432, 379)` → `Applied`/`read_back: true`. Instrumentación desechable, revertida y verificada por md5 (sin líneas `TRACE-314` en el árbol final).
- L15: **unidades medidas** con `GDK_SCALE=2`: el binding devolvió `(2192, 141)` para una posición de dispositivo de `(4384, 282)` — GDK devuelve píxeles de aplicación. Confirma que `to_physical(origin, scale)` es la conversión correcta (y la preexistente), y que `tao::outer_position()` (físicos) no era un sustituto equivalente.
- L16: **verificación independiente** (`gentle-ai-verify`, obliged por el `Risk: item 3`). Veredicto: el diff cumple el alcance aprobado. Hallazgos atendidos: (a) ALTO — el árbol estaba en el estado transitorio de la traza "antes" y no compilaba: restaurado y verificado (37+23 tests verdes, `cargo fmt --check` limpio); (b) MEDIO — el doc-comment afirmaba unidades que GTK3 no documenta: corregido y **medido** (L15); (c) MEDIO — hueco de cobertura: nada fijaba que los lectores pasen la tupla cruda al seam: agregado el pin `the_readers_consume_the_raw_binding_tuple_through_the_seam`; (d) BAJO — el pin `fn_addr_eq` era tautológico: renombrado y comentado como lo que prueba (que no hay copia); (e) BAJO — D3 citaba la cobertura del `Err` restante en el test equivocado: corregido a `widget_placement_test.rs:518` y `detail_placement_test.rs:546`. La segunda verificación (L20) encontró que dos de esos pins seguían siendo vacíos: el de orden y el del seam.
- L17: los tests `email::tests::*_over_http` fallan de forma **no determinista** y **preexistente**: dos corridas idénticas en el mismo árbol dieron 5 fallos (5,13 s) y 0 fallos (29,72 s). No lo introduce el diff de colocación (no toca `src-tauri/src/email.rs`) pero hay que declararlo en la PR como check no confiable del entorno.
- L18: discrepancia detectada por el worker y **no forzada**: la consigna decía que la tira convierte el origen con el factor de la petición, pero el código real usa `window.scale_factor()` en los dos lectores (el factor de la petición sólo se usa en las peticiones de tamaño y posición). Se mantuvo el comportamiento tal cual estaba; sólo se movió la conversión al seam. La consigna era incorrecta, no el código.
- L19: el pin del detalle (`fn_addr_eq`) fija que el detalle **no tiene copia** del seam, no que «el lector del detalle lo llame» (eso no es observable sin una ventana GDK): el doc-comment y el nombre del test se ajustaron a lo que realmente prueba.
- L20: el owner aprobó la PR #319 (2026-11-26T19:39:53Z) y dejó cinco cambios menores, textuales: (1) acotar el pin de orden al cuerpo de `read_geometry`, porque la búsqueda sobre el archivo entero encontraba primero la mención `gdk_window_is_viewable()` del doc del módulo y el pin pasaba siempre; (2) corregir el pin de detalle, que comparaba el re-export del seam consigo mismo y sólo podía fallar al compilar; (3) reubicar el comentario de la conversión de escala, que había quedado encima del doc del pin, y documentar el test de escala; (4) declarar en el cuerpo de la PR el cambio observable en Linux (`ReadFailed` → `Applied`/`Limited` y el frontend pasa a cachear la geometría); (5) dejar este documento como documento de proyecto, sin anexos de publicación, registro de chat ni claves de memoria. Los puntos 1, 2, 3 y 5 se aplican como seguimiento de la PR1; el punto 4 es texto de la PR.
  - **Seguimiento de los cinco cambios**: una verificación independiente posterior (10 mutaciones sobre el código real) encontró que el punto 1 **seguía sin resolverse de verdad**: el pin de orden buscaba `is_viewable()` dentro del cuerpo de `read_geometry`, pero ese cuerpo lo **menciona** en un comentario antes de la lectura, así que el pin pasaba igual con la comprobación de visibilidad borrada o con la comprobación movida después de leer el origen. El mismo verificador encontró que el pin del seam de la tira buscaba `rooted_origin(` en el **archivo** entero, donde lo satisfacía la propia definición del seam (`pub fn rooted_origin(`), de modo que un lector que desempaquetara la tupla a mano pasaba el pin. Los dos pins se corrigieron para que miren el **cuerpo** del lector y **sin comentarios**: el de orden exige que la llamada a `is_viewable()` exista y preceda a la lectura del origen; el del seam exige la llamada canónica dentro de `read_geometry` (la ruta canónica en el detalle), con la tupla cruda y una sola lectura del origen, y que el seam tenga una sola definición en el código Rust del crate. Cada pin tiene ahora sus tests-sonda, que mutan el archivo del lector y tienen que verlos caer.
  - El punto 5 se había pasado de rosca: la limpieza se llevó por delante la decisión D7, la sección «Evidencia» y las entradas de este Log (L13–L19). Se restauraron (son decisiones y evidencia, no transcripción de chat ni claves de memoria) y se corrigieron dos citas: el commit del anexo de publicación es `4b6b984` —`914c3fa` no existe en la rama— y la referencia de `is_viewable()` es `widget_placement.rs:829`.
- L21: **tercera verificación de los pines** (segunda pasada de la revisión independiente). Encontró cinco defectos, todos en los pines (archivos de test) y en las frases que los acompañan; **ninguno en la producción**, que queda intacta respecto de `fdad9cd`. (a) MEDIO — los pines todavía podían satisfacerse con **texto de comentario**: la firma del lector se buscaba en el archivo crudo, así que una firma mencionada en un doc-comment desplazaba el recorte y el enmascarado ya no veía el `//` (el `mask_non_code` ya no alcanzaba el `//` del comentario y el texto contaba como código). El arreglo: enmascarar el archivo **entero** y buscar el cuerpo sobre el texto enmascarado —los offsets se preservan—, de modo que la firma buscada sólo pueda aparecer en código. (b) LOW — «una sola definición en el repositorio» no era lo que se comprobaba (el conteo era por archivo, y una copia del seam en otro módulo pasaba): ahora el pin mira **todas** las fuentes Rust del crate (`src/`, `examples/`, `build.rs`), y las tres redacciones —test, doc-comment y esta doc— dicen lo mismo. (c) LOW — dos comprobaciones del pin principal iban sobre el archivo crudo, así que un comentario que mencionara el desempaquetado viejo rompía el CI: ahora van sobre el código enmascarado. (d) LOW — el enmascarado confundía un **lifetime** con un literal de carácter y apagaba código real (`<'a, 'b>`): ahora se distinguen por el cierre, y hay un test que lo fija. (e) LOW — el mensaje del pin de orden afirmaba más de lo que comprueba: ahora dice lo que comprueba (una llamada a `is_viewable()` antes de `.origin()`, no que su valor se use). Sondas nuevas (RED antes del arreglo, GREEN después): un lector con la firma, la visibilidad y la llamada al seam **sólo en un doc-comment** daba los dos pins por cumplidos; el lector de verdad tiene que consultar la visibilidad y llamar al seam.
- L22: **el job de Windows de la PR #319 falló** (726 pasaron, 4 fallaron, exit 101): las cuatro sondas del pin de orden. Causa raíz: el checkout de Windows trae los fuentes con `\r\n` y las sondas sustituyen bloques exactos escritos con `\n`; la sustitución no encontraba su bloque, la sonda no mutaba nada y el pin se daba por cumplido con un lector roto. En tres de ellas el síntoma era `assert_ne!` ("no se encontró el bloque de visibilidad"); en la cuarta —la del doc-comment— la sustitución del comentario sí aplicaba y el pin pasaba, que es el panic del log de CI. Las sondas del seam pasaban porque sus bloques son de una línea. **Reproducción local (RED)**: con el fuente real convertido a CRLF, el binario de tests da exactamente las cuatro fallas (68 passed / 4 failed, exit 101); la regresión nueva `the_order_pin_probes_see_the_same_with_crlf_line_endings` falla con "CRLF: no se encontró el bloque de visibilidad". **Arreglo**: un **único punto de normalización** (`normalize_line_endings`, CRLF → LF) aplicado **antes** del enmascarado (`mask_non_code`, que preserva offsets), `read_source` (lee y normaliza) para todo el texto que entra al camino de los pines, y `replace_block` (sustituye un bloque escrito con `\n` usando el final de línea del archivo). Las mutaciones de las sondas se extrajeron a funciones compartidas (`without_visibility_check`, `with_manual_unpacking`, …) para que las sondas y la regresión apliquen **exactamente** la misma mutación. **GREEN**: la regresión pasa con LF y con CRLF (orden y seam), y el binario de tests contra un checkout CRLF de los dos fuentes da 74 passed / 0 failed (exit 0), contra los 68 passed / 4 failed (exit 101) del código anterior. Las cuatro mutaciones del owner (orden invertido, comprobación ausente, copia local del seam, tupla desempaquetada a mano) siguen dando ROJO, con LF y con CRLF. Checks: `i18n-inventory --check` exit 0, `biome ci` exit 0 (225 warnings preexistentes), `cargo fmt --check` exit 0, `cargo build --locked` exit 0, `cargo test --locked -- --skip email` 734 passed / 0 failed, `--lib widget_placement` 51 passed, `--lib detail_placement` 23 passed. Sin commit: el fix queda en el worktree para el commit del padre.

