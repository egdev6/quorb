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

- [x] T1 — S1-S8 — Crear este documento de feature. Route: inline. Commit: `22220fb`
- [x] T2 — S5 — RED: test puro del contrato del binding con tuplas reales (`y=0`, origen `(0,0)`, coordenadas negativas, `y` no nulo, escala, retorno no significativo) en `widget_placement_test.rs` y `detail_placement_test.rs`. Route: inline. Commit: `386e33f`
- [x] T3 — S1, S2, S3, S5 — GREEN: seam puro + consumo correcto de la tupla en los dos lectores (`widget_placement.rs:840-842`, `detail_placement.rs:510-512`); se retira la rama de error del origen. Route: inline. Commit: `386e33f`
- [x] T4 — S4 — Corregir comentarios que describen el flag y el test que lo fijaba (`widget_placement_test.rs:642`); comprobar que los tests del ciclo siguen verdes. Route: inline. Commit: `386e33f`
- [x] T5 — S6 — Traza X11 con la corrección: arranque + un movimiento; capturar `origin()` crudo contra `tao` outer/inner y `gdk position`, y el `Report` resultante (`read_back: true`, `bounds` con el origen real). Instrumentación desechable, sin commit. Route: inline. Commit: —
- [x] T6 — S7 — Checks: `cargo fmt --all`, `cargo test` (src-tauri), `npm test`, `npm run typecheck`, `npx biome ci`. Route: inline. Commit: —
- [x] T7 — S7, S8 — Commit + push al fork + PR a `egdev6/quorb` con la plantilla completa (alcance, exclusiones, coordinación, aceptación, evidencia de checks) y `Refs #314`; asignar la PR a @DonatoSilva. Route: inline. Commit: —

## Riesgo

- **item 3** — el contrato compartido que cambia es `Report.reason`, que alimenta la lógica del front (`src/detail-placement.ts:69` ramifica por `read_failed`; `src/lib/widget-placement.ts:167` reintenta por `not_viewable`). El diff cambia qué `reason` emite el camino Linux: `ReadFailed` → `Applied`/`Limited` con geometría real, y en Linux el front pasa a cachear la posición efectiva. En Windows y macOS no cambia nada.
- Verificación: `gentle-ai-verify` independiente sobre el diff + los tests del ciclo (36 en `widget_placement_test.rs` y 23 en `detail_placement_test.rs`).
- Lo que no se cubre: Windows ni la experiencia real de compositor. Los checks de Linux no validan Windows (CONTRIBUTING, "Pull requests"), y la sonda de finales de línea que corría en Linux se retiró con los pines (`1d41503`): la ejecución en Windows sigue sin cubrirse, y con ella sus finales de línea.

## Estrategia de entrega

- Una rama: `fix/314-gdk-origin-readback`, base `upstream/main` 61c4813, publicada en el fork `DonatoSilva/quorb`; la PR se abre contra `egdev6/quorb:main` (no hay permiso de push al upstream: `permissions.push = false`).
- Unidades de commit: T2+T3+T4 en un commit de comportamiento (`fix(linux): leer el origen de la ventana en el orden del binding`), T5 como evidencia en el cuerpo de la PR, T6 sin commit, T7 con la PR.
- El doc se actualiza con el commit que contiene cada tarea.

## Log

- L1: el trabajo arranca sobre la issue #314, verificada como propia y asignada a @DonatoSilva, en estado `OPEN`, con las labels `type:bug` y `status:approved`, y sin PR solapada (abiertas: #317 y #318 de @DonatoSilva sobre #312, #311 y #303 de @sosan sobre #276 y #281).
- L2: el owner ya había aprobado el alcance de la PR1 en la issue (PR1 acotada al defecto de lectura, issue a `status:approved` con ese alcance y asignada al contributor), así que no hace falta responderle ni pedir permiso; la PR sale desde el fork porque `push` al upstream es `false`.
- L3: el plan se pide con el flujo y el paso del ciclo de vida que el cambio toca; de ahí la sección "Mecanismo".
- L7: evidencia del maintainer — "la versión fijada, `gdk 0.18.2`, devuelve `(retorno, x, y)` en `Window::origin()` (`src/auto/window.rs:497–503`). En cambio, `widget_placement.rs:840–842` y `detail_placement.rs:510–512` la desempaquetan como `(ox, oy, rooted)`" (S1).
- L8: evidencia del maintainer — "GDK documenta el retorno como «Not meaningful, ignore», así que no basta con reordenar y seguir usando `retorno != 0` como indicador de éxito" (S2, D1).
- L9: evidencia del contributor — traza de una colocación real: `gdk_window.origin()=(1,1220)` con `rooted=false` para una ventana realmente en `(1220,0)`, mientras `tao_outer`, `tao_inner` y `gdk position` coinciden con la petición ("Mecanismo").
- L10: evidencia del contributor — la pantalla X11 no coincide con el escritorio del compositor (`xrandr` `eDP-1 +0+0` vs Hyprland `0x0`; un cliente en X `x` aparece en Hyprland en `x - 4480`). Es material de PR2, no de PR1 (S8).
- L14: **traza A/B** (T5). Con `GDK_BACKEND=x11`: antes `(1, 4432, 379)` → desempaquetado viejo `ox=1 oy=4432 rooted=379` → origen `(1, 4432)` → `Limited`/`PositionRefused`; después → origen `(4432, 379)` → `Applied`/`read_back: true`. Instrumentación desechable, revertida y verificada por md5 (sin líneas `TRACE-314` en el árbol final).
- L15: **unidades medidas** con `GDK_SCALE=2`: el binding devolvió `(2192, 141)` para una posición de dispositivo de `(4384, 282)` — GDK devuelve píxeles de aplicación. Confirma que `to_physical(origin, scale)` es la conversión correcta (y la preexistente), y que `tao::outer_position()` (físicos) no era un sustituto equivalente.
- L17: los tests `email::tests::*_over_http` fallan de forma **no determinista** y **preexistente**: dos corridas idénticas en el mismo árbol dieron 5 fallos (5,13 s) y 0 fallos (29,72 s). No lo introduce el diff de colocación (no toca `src-tauri/src/email.rs`) pero hay que declararlo en la PR como check no confiable del entorno.
- L18: discrepancia detectada por el worker y **no forzada**: la consigna decía que la tira convierte el origen con el factor de la petición, pero el código real usa `window.scale_factor()` en los dos lectores (el factor de la petición sólo se usa en las peticiones de tamaño y posición). Se mantuvo el comportamiento tal cual estaba; sólo se movió la conversión al seam. La consigna era incorrecta, no el código.
- L20: el owner aprobó la PR #319 (2026-11-26T19:39:53Z) y dejó cinco cambios menores, textuales: (1) acotar el pin de orden al cuerpo de `read_geometry`, porque la búsqueda sobre el archivo entero encontraba primero la mención `gdk_window_is_viewable()` del doc del módulo y el pin pasaba siempre; (2) corregir el pin de detalle, que comparaba el re-export del seam consigo mismo y sólo podía fallar al compilar; (3) reubicar el comentario de la conversión de escala, que había quedado encima del doc del pin, y documentar el test de escala; (4) declarar en el cuerpo de la PR el cambio observable en Linux (`ReadFailed` → `Applied`/`Limited` y el frontend pasa a cachear la geometría); (5) dejar este documento como documento de proyecto, sin anexos de publicación, registro de chat ni claves de memoria. Los puntos 1, 2, 3 y 5 se aplican como seguimiento de la PR1; el punto 4 es texto de la PR.
- L21: la review del 2026-11-27T08:09Z pidió retirar los pins de código fuente: para fijar dos líneas que la PR no cambia se habían añadido ~980 líneas de test con un analizador de Rust propio, y con huecos (comentarios de bloque anidados, `'\u{…}'` o `'\x41'` leídos como lifetimes, `br"…"`). Se retiraron los pins y sus sondas en `widget_placement_test.rs` y el pin del detalle en `detail_placement_test.rs`; con ellos se va también la sonda del final de línea. La producción no cambia respecto de `386e33f`. Commit `1d41503`.
- L22: el inventario i18n se regenera después de retirar los tests: las 67 entradas nuevas eran fragmentos de código de los pins (`docs/i18n-inventory.md` −71/+3). Commit `ce1baae`; `node scripts/i18n-inventory.mjs --check` vuelve a dar 0.

- L23: la rama se puso al día con `main` (`f0abbbe`, merges de #317 y #318) por **merge**, no por rebase, para no reescribir `1d41503` ni `22220fb`, que este documento cita. La review del 2026-11-27T19:06Z pidió tres restos de forma y nada de comportamiento: el doc comment de 22 líneas del pin retirado —pegado ahora a un test que no documenta— más su `#[test]` duplicado en `detail_placement_test.rs`; `:108` remitiendo a la sonda de finales de línea que ya no existe; y T1 sin el commit en que entró el documento. Con eso el owner aprueba y mergea con squash.
- L24: **autorización del contributor** (verbatim): «vale vamos en orden entonces se mergio el slice 1 del 312... siendo el caso vamso a eliminar la rama mergeada la de nuestro formk... vamso amergear main a main de fork y mergear la rama dodne estamos trabajando el pr 319 cuando termines eso explicame por favor que fue loq ue dijo el owner en el 319 vale gracias» y «pues si mergeamos main de upscreamt osea la del owner a nuestra main y luego nuestra main a la fix/314-gdk-origin-readback te parece ese orden ??». Alcance autorizado: borrar la rama ya mergeada del fork, poner `main` al día con `upstream/main`, traer `main` a esta rama. **Publicar (push de la rama y comentario en la PR) no está autorizado**: ver L25. Ejecutado: `feat/312-shortcut-capability-seam` borrada en local y en el fork, worktree `.wt/312-slice1` retirado, `main` en `f0abbbe`, merge de `main` en esta rama `f27430b`, restos de la review en `e6896a4` y `2346d65`.
- L25: **corrección del contributor** (verbatim): «era una conformacion era una pregunta sarcastica por nunca te dije que si». La pregunta «cuando te dije que hacer en el 319 no recuerdas?» fue **irónica**, no una autorización: el contributor no autorizó publicar. Se corrige L24, que daba por autorizado el push y el comentario en la PR. Estado real: todo el trabajo de esta vuelta (merge de `main` `f27430b`, restos de la review `e6896a4`, inventario `2346d65`) está **sólo en local**; `origin/fix/314-gdk-origin-readback` sigue en `db11c5d` y la PR no tiene ningún comentario nuevo. El push y el comentario esperan un sí explícito.
