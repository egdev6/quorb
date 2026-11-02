# 228-windows-text-scale

Strip and detail windows are undersized on Windows when Accessibility "Text size" is above 100 %: geometry mixes CSS px with monitor units. Issue egdev6/quorb#228, spec approved by the maintainer (egdev6) in the issue thread on 2026-11-01. Branch `fix/228-windows-text-scale`, base `upstream/main@4d21f66`.

## Specs

- S1 (factor, from the approved proposal): "El factor que no depende del monitor es la escala de texto, que en Windows es global: `t = window.devicePixelRatio / await getCurrentWindow().scaleFactor()`". Never `dpr / geo.sf`.
- S2 (invariant, approved proposal): "La geometría se calcula en unidades de monitor. Los px CSS solo entran multiplicando por `t` y solo salen a CSS dividiendo por `t`. A físico se pasa una sola vez, con `geo.sf`, como ahora."
- S3 (pure module, approved proposal): "Un módulo puro nuevo, `src/lib/text-scale.ts`, con `textScale(dpr, sf)` (con guardas: valores no finitos o ≤ 0 dan `1`, y redondeo a 4 decimales para que el ruido de coma flotante no dispare recolocaciones), `toMonitor(css, t)` y `toCss(monitor, t)`."
- S4 (maintainer addition): "`devicePixelRatio` se lee de forma síncrona y `scaleFactor()` es asíncrono, así que durante un cambio de monitor podrían leerse en momentos distintos y producir un `t` transitorio incorrecto. Conviene recalcularlo cuando el cambio de escala se haya asentado y descartar valores fuera del rango posible de Windows (100–225 %), conservando el último válido."
- S5 (strip sites, approved proposal table): `stripRect` size via `toMonitor(stripSize, t)`; `peekRect` constants `48` / `24` "`× t` (recibe `t`)"; `setPos` "`toCss(…, t)`, **sigue en CSS**"; orb `anchorRel` via `toMonitor`; placement clip "`t × geo.sf` (no el `dpr` vivo, porque la ventana aún puede estar en el otro monitor)".
- S6 (drag, approved proposal): drag clip scale "`devicePixelRatio` actual"; drag delta "`geo.sf × t` capturado en pointerdown"; grip centre on drop "`devicePixelRatio` actual en el drop (la ventana puede estar ya en otro monitor)".
- S7 (detail, approved proposal): `fitPanel(placement, layoutHeight, base, t)` with `natural = layoutHeight × base × t`, `zoom = base × factor` (no `t`), `width = placement.width × t × factor`, `height = scaled ? maxHeight : ceil(natural)`; "El detalle usa **su propio `t`**, medido en su ventana"; clip "`next.zoom × t × data.scaleFactor`".
- S8 (live change, approved proposal): "Hook `useTextScale()` con `matchMedia('(resolution: Xdppx)')` (rearmándolo en cada cambio) más `onScaleChanged`. `t` entra en las dependencias de la colocación de la tira y del layout del detalle." Strip state goes in a ref or after existing `useState` slots (test harness mocks by slot index).
- S9 (unchanged, approved proposal): `physicalPanelBounds`, `Placement.scale = geo.sf`, Rust, `dockOffset`, gap 8, effects overlay, orb reordering stay as they are.
- S10 (tests, approved proposal + maintainer): `textScale` guards and rounding; strip "anclada a **derecha** e **inferior** conservando el borde exacto"; `fitPanel` threshold, width/height and verbatim `maxHeight`; `detailBounds` "`y + h = strip.y - 8`, `x + w = strip.x - 8`"; clip scale; drag delta "`= delta CSS × sf × t`"; no-regression table "`t = 1` y `sf ∈ {1, 1,25, 1,5, 2}` que da exactamente lo mismo que ahora"; pairs `(1,0812, 1,02)`, `(1,25, 1)`, `(1,5, 1,25)`, `(2,25, 1,5)`.
- S11 (manual validation on Windows, approved): step 0 measures `devicePixelRatio`, `scaleFactor()` and a `screenX` delta while dragging; then 102 % / 106 %, 100 % / 100 %, live text-size change, drag follows cursor, 3 monitors with different scales.
- S12 (maintainer): "Ancho máximo: de acuerdo con dejarlo fuera de esta issue, pero abre una issue de seguimiento para que no se pierda." / "Alcance: de acuerdo con una sola PR para tira, detalle, arrastre y hook."

## Tasks

- T0 · S11 step 0 · user on Windows (remote debugging of installed v0.8.0) · no commit
- T1 · S1-S4, S8, S10 · inline · text-scale module + hook · done f5c872a
- T2 · S2, S5, S9, S10 · worker · strip geometry · done dae140d
- T3 · S6, S10 · worker · drag · done c24eb0b
- T4 · S7, S8, S10 · worker · detail panel · done 8981e95
- T5 · S12 · follow-up issue · done egdev6/quorb#229
- T6 · S11 · Windows build + manual validation (user)
- T7 · S12 · PR · draft egdev6/quorb#231

## Log

- L1 (user, original request): "Mira como se me ve [captura] Ves que parece que se corta a un tamaño de ancho fijo, tanto el widget como el panel flotante de cada provider?"
- L2: root cause confirmed on the user's machine: custom scale 102 % + text size 106 %; setting text size to 100 % and pressing "Aplicar" fixes it.
- L3: maintainer flow (Discord): issue + debate until spec closes, then PR.
- L4: maintainer review 1 replaced "positions with sf, sizes with dpr" by normalizing before geometry; proposal refined it to `t` (S1).
- L5: maintainer approved the spec with S4, assigned matraket, label `status:approved` (2026-11-01).
- L6: delivery strategy: one PR (S12) made of per-task commits; the branch passes ~400 authored lines after T4 (484, mostly tests), accepted because the maintainer asked for a single PR and each commit stays reviewable alone.
- L7 (T0, user on Windows, installed v0.8.0, text size 106 %, remote debugging): `{"dpr": 1.059999942779541, "sf": 1, "screenX": 2390.566162109375, "physX": 2534, "ratio": "1.0600"}`. `screenX` is CSS px (physical / dpr), so the drag delta must be `Δcss × sf × t` (S6 confirmed). Custom scale 102 % is not active on that monitor (sf = 1); dpr carries float32 noise that `textScale` rounding absorbs.
- L8: follow-up issue for the detail max width published as egdev6/quorb#229 (user approved). Branch at 575 authored lines after T3, still one PR per S12.
- L9 (T6, user on Windows, local build of ef3a3e3 `quorb.exe --no-bundle`, text size 106 %, one monitor, strip on the right edge): strip complete (three rings, actions, rounded corners) and Claude detail complete in width and height (percentages, bars, history expanded, footer, four rounded corners). Checks 1-2 of S11 pass; pending: drag, live text-size change, 100 % no-regression, 3 monitors at work.
- L10 (T6, user on Windows, same local build): S11 checks 3-5 pass: drag follows the cursor and snaps to the edge; live text-size change re-places without restart; 100 % looks like the installed v0.8.0. Extra: text size 140 % applied live, strip scaled and complete on the right edge. Pending: 3 monitors with different scales (at work).
- L11 (T6, video /mnt/c/Users/acester/Videos/arrastre-tira.mp4, 8.8 s, frames at 5 fps): during the whole horizontal sweep the cursor stays on the grip (no cumulative drift, so the delta scale is right); only in the fastest frames (1.0-1.2 s, moving right) the cursor runs ~30 px ahead of the grip, the usual rAF + IPC lag, which recovers in the next frame.
- L12 (T7): draft PR egdev6/quorb#231 opened with user authorization; npm test (vitest 898, node 298), typecheck and cargo test --locked on Windows (404 passed, 1 ignored) green. Pending: 3-monitor validation, attach drag video.
- L13: independent verifier (gentle-ai-verify): PASS WITH NOTES; S1-S10 and S12 PASS, S11 PARTIAL (3 monitors pending). Advisory low notes: startup placement at t = 1 before the first read, no ordering guard between overlapping reads, an in-range mixed sample is corrected on the next change event, live text changes rely on the matchMedia query (confirmed manually in L10). Boundary tests for S4 added on its suggestion.
- L14: maintainer review of bdf30ae on #231: spec followed; blocking: regenerate i18n inventory (header tree hash only) in its own commit, done 0efe246 (check exit 1 before, 0 after). Non-blocking, to observe in the 3-monitor validation: first placement at t = 1 before the first read (if visible, do not place until the first valid read), and an in-range transient when the monitor scale changes before devicePixelRatio. Maintainer runs CI when the PR is marked ready. Note: the inventory header hashes the src/ tree, so any later src change needs the inventory regenerated again.
