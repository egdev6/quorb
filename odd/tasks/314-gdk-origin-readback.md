# 314-gdk-origin-readback

> Issue: https://github.com/egdev6/quorb/issues/314 — `type:bug`, `status:approved`; autor y assignee: @DonatoSilva. El owner aprobó el alcance de la PR1 el 2026-11-25 (L2, S1-S8) y la PR1 en sí el 2026-11-26 (L13).
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

## Decisiones

- D1: La garantía de "hay origen" pasa a ser **`is_viewable()`**, que el lector ya consulta (`widget_placement.rs:821`, `detail_placement.rs` equivalente) antes de leer. Es la única lectura compatible con S2: el `ret` no significa nada, pero una ventana visible está mapeada y por lo tanto tiene posición en raíz.
- D2: El seam es una **función pura** que recibe la tupla cruda `(ret, x, y)` y devuelve el origen. El `ret` queda como parámetro explícito e ignorado por contrato, documentado en el doc-comment: es lo que permite fijar "el retorno no significa nada" con un caso de regresión propio.
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
- Lo que no se cubre: Windows ni la experiencia real de compositor. Los checks de Linux no validan Windows (CONTRIBUTING, "Pull requests").

## Estrategia de entrega

- Una rama: `fix/314-gdk-origin-readback`, base `upstream/main` 61c4813, publicada en el fork `DonatoSilva/quorb`; la PR se abre contra `egdev6/quorb:main` (no hay permiso de push al upstream: `permissions.push = false`).
- Unidades de commit: T2+T3+T4 en un commit de comportamiento (`fix(linux): leer el origen de la ventana en el orden del binding`), T5 como evidencia en el cuerpo de la PR, T6 sin commit, T7 con la PR.
- El doc se actualiza con el commit que contiene cada tarea.
- **Corte de commits de la PR1:** `fdad9cd` — código y tests (4 archivos de Rust, el cambio de comportamiento); `343af25` — doc de la feature; `914c3fa` — anexo con los textos de publicación (235 líneas, sólo documentación). El anexo se retiró del documento en el seguimiento de la PR: los textos de publicación viven en la PR, no en el repo.

## Log

- L1: el trabajo arranca sobre la issue #314, verificada como propia y asignada a @DonatoSilva, en estado `OPEN`, con las labels `type:bug` y `status:approved`, y sin PR solapada (abiertas: #317 y #318 de @DonatoSilva sobre #312, #311 y #303 de @sosan sobre #276 y #281).
- L2: el owner ya había aprobado el alcance de la PR1 en la issue (PR1 acotada al defecto de lectura, issue a `status:approved` con ese alcance y asignada al contributor), así que no hace falta responderle ni pedir permiso; la PR sale desde el fork porque `push` al upstream es `false`.
- L3: el plan se pide con el flujo y el paso del ciclo de vida que el cambio toca; de ahí S9 y la sección "Mecanismo".
- L4: el owner pregunta si la validación se unifica entre los sistemas operativos soportados; respuesta: el contrato está unificado (`Status`/`Reason`/`Report`, sin `cfg` por SO), el mecanismo no; PR1 no unifica (D4).
- L5: el owner pregunta por qué Linux no debería tener auditoría de recuperación; respuesta: Linux X11 sí debería (es la mitad "no se recupera" del issue, PR2), pero no puede reusar la auditoría de Windows porque su fuente (`outerPosition()`) es `(0,0)` por diseño en xdg-shell y produciría un bucle de recolocación (#168/#148); el pin WU3 de #180 protege contra reactivar esa auditoría en Wayland, no contra construir una Linux con la fuente correcta (D5).
- L6: el owner pregunta si el flujo de validación y read-back depende del sistema y si se puede unificar el flujo lógico para no repetir código; corrección aplicada a este documento: D4 reescrito (no es una prohibición de auditar Linux, es que la fuente de Windows es inválida en xdg-shell), D5 y D6 añadidos.
- L7: evidencia del maintainer — "la versión fijada, `gdk 0.18.2`, devuelve `(retorno, x, y)` en `Window::origin()` (`src/auto/window.rs:497–503`). En cambio, `widget_placement.rs:840–842` y `detail_placement.rs:510–512` la desempaquetan como `(ox, oy, rooted)`" (S1).
- L8: evidencia del maintainer — "GDK documenta el retorno como «Not meaningful, ignore», así que no basta con reordenar y seguir usando `retorno != 0` como indicador de éxito" (S2, D1).
- L9: evidencia del contributor — traza de una colocación real: `gdk_window.origin()=(1,1220)` con `rooted=false` para una ventana realmente en `(1220,0)`, mientras `tao_outer`, `tao_inner` y `gdk position` coinciden con la petición ("Mecanismo").
- L10: evidencia del contributor — la pantalla X11 no coincide con el escritorio del compositor (`xrandr` `eDP-1 +0+0` vs Hyprland `0x0`; un cliente en X `x` aparece en Hyprland en `x - 4480`). Es material de PR2, no de PR1 (S8).
- L11: el usuario decide sacar la hiper-refactorización (U1) a una issue aparte, **sin abrirla**: queda en memoria y se consulta cuando él lo pida. U2 (canal único de posición nativa) es el camino de la PR2; U3 se parte en un constructor único del informe (pequeño) y el ruteo por `drive()` (refactor, fuera).
- L12: Publicación de la PR1 (2026-11-26, con OK explícito del contributor al texto final): **PR #319** contra `egdev6/quorb:main`, con `Refs #314`, un comentario técnico en la PR y un aviso en la issue. Tres ajustes editoriales antes de publicar: el cuerpo de la PR declaró este documento ODD como documento del proyecto (en vez de "not applicable"); el comentario técnico de la PR se redujo a los diez puntos agrupados en cuatro bloques (la versión punto por punto repetía la tabla de unidades que el cuerpo ya declara); el aviso de la issue bajó a 438 caracteres, con el registro que el contributor usa en sus avisos (link, qué trae, qué queda, revisión cuando pueda). El hallazgo del desfase de 4480 px entre la superficie X y el escritorio del compositor sale del comentario de la issue y queda sólo acá, como insumo de la PR2: no se abre conversación sobre el orden de la PR2.
- L13: el owner aprobó la PR #319 (2026-11-26) y dejó cinco cambios menores, textuales: (1) acotar el pin de orden al cuerpo de `read_geometry`, porque la búsqueda sobre el archivo entero encontraba primero la mención `gdk_window_is_viewable()` del doc del módulo y el pin pasaba siempre; (2) corregir el pin de detalle, que comparaba el re-export del seam consigo mismo y sólo podía fallar al compilar; (3) reubicar el comentario de la conversión de escala, que había quedado encima del doc del pin, y documentar el test de escala; (4) declarar en el cuerpo de la PR el cambio observable en Linux (`ReadFailed` → `Applied`/`Limited` y el frontend pasa a cachear la geometría); (5) dejar este documento como documento de proyecto, sin anexos de publicación, registro de chat ni claves de memoria. Los puntos 1, 2, 3 y 5 se aplican como seguimiento de la PR1; el punto 4 es texto de la PR.
