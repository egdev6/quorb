# ODD — #214 B mínima: indicador de falta de credencial en el orbe

Issue: https://github.com/egdev6/quorb/issues/214 (labels `status:approved`, `type:bug`)
Assignee verificado: SrStamm (Mirko Alexander Stamm). Decisión del mantenedor (#214, 2026-11-01): **no integrar C** (`transient_for`, rama `fix/214-wayland-detail-transient` de #230); ir con la **versión mínima de B**, con el ajuste aprobado: badge ámbar para `needsLogin` **y** `unconfigured`; `error` queda solo con motivo en texto accesible.

## Diseño aprobado por el mantenedor

- Badge visual **ámbar** (`data-kind='action'`, ya definido en `src/styles.css:185`) cuando `status === 'needsLogin'` o `status === 'unconfigured'`. Solo los estados que tienen acción asociada (`model.rs:120-124`: `needsLogin → 'login'`, `unconfigured → 'settings'`).
- Se suma al atenuado, no lo reemplaza: el orbe sigue con `is-muted` (clases en `gaugeState`, `ProviderGauge.tsx`).
- `aria-label` y `title` incorporan el motivo para los tres estados atenuados (`needsLogin`, `unconfigured`, `error`) reusando `details.status.*` de `src/i18n/es.ts:477-481` y `src/i18n/en.ts:452-456`. Orden del título: `[nombre, motivo, validez, reinicios]`.
- `title` deja de condicionarse solo a `account || validity || resets`: con motivo presente siempre se incluye.
- Badge decorativo (`aria-hidden`), esquina superior derecha, escala con `calc(9px * var(--k))`. Validar a mano que no choque con el chip de cuenta (`.orb__acct`) ni con `ValidityBadge` en 24/48/56 px.
- Plataformas: **todas** (el estado viene del modelo, no del compositor). Sin código Wayland-específico, sin Rust, sin ventanas nuevas, sin tocar `DetailPanel` ni `widget_placement`.

## Alcance por archivo

| Archivo | Cambio |
| --- | --- |
| `src/components/ProviderGauge.tsx` | Badge `<span class="orb__badge" data-kind='action' aria-hidden>` con `needsLogin`/`unconfigured`; `accessibleTitle` incorpora el motivo (`t(locale, 'details.status.<status>')` para estados atenuados); `title` se muestra siempre que haya motivo |
| `src/styles.css` | Sin cambios (`.orb__badge` ya existe; solo si la validación manual pide un ajuste mínimo) |
| `src/i18n/es.ts`, `src/i18n/en.ts` | Sin cambios (claves reutilizadas) |
| `src/components/ProviderGauge.test.tsx` | Tests RED/GREEN del punto de tests |
| `docs/i18n-inventory.md` | Sin cambios |

No-goals: C (`transient_for`), detalle B completo (panel inline en la tira), cambios Rust/i18n.

## Tareas

1. **[x] Tests RED** en `ProviderGauge.test.tsx`
   - Rojo observado (vitest): 3 fallidos — falta badge en `needsLogin`/`unconfigured` y motivo en los tres estados atenuados; caso `ok` pasa como guardia de regresión del comportamiento actual.
   - Bloque: `describe('ProviderGauge credential status badge')` (4 tests, estilista `renderToStaticMarkup` igual que el resto del archivo).
   - La tarea original decía: (estilo `renderToStaticMarkup` existente):
   - `needsLogin`: badge ámbar presente + motivo «Sin sesión» en `aria-label`.
   - `unconfigured`: badge ámbar presente + motivo.
   - `error`: motivo en `aria-label`/`title` pero **sin** badge.
   - `ok`: ni badge ni motivo; título igual que hoy.
2. **[x] Implementación** en `src/components/ProviderGauge.tsx`: bloque `STATUS_REASON` (mapa cerrado `needsLogin`/`unconfigured`/`error` → `details.status.*`), `reason` entra al título accesible entre nombre y validez, `title` condicionado también por motivo, badge `<span class="orb__badge" data-kind="action" aria-hidden="true" />` solo para `needsLogin`/`unconfigured`. Verde: 23/23 en `ProviderGauge.test.tsx`.
3. **[x] Checks del repo**:
   - `npm test`: 68 archivos vitest / **904 passed, 0 failed** + scripts node --test / **298 pass, 0 fail**.
   - `npm run typecheck`: OK.
   - `cargo test --locked` (desde `src-tauri/`): **402 passed, 0 failed**; `cargo fmt --check`: OK.
   - `node scripts/i18n-inventory.mjs --check`: exit 0 (sin cambios de texto).
4. **[x] Validación manual** con `npm run app:dev` (máquina del reporte, Wayland nativo):
   - `needsLogin`: tooltip con motivo, badge ámbar visible.
   - `unconfigured` (proveedor con API key sin clave): «funciona bien» (badge + tooltip).
   - `error` (red cortada a proveedor con credencial): tooltip «Provider · Error» y **sin badge**, según diseño.
   - Nota observada: al abrir el panel por hover el tooltip desaparece y el panel sigue apareciendo centrado en Wayland nativo — limitación conocida de `main`, fuera de alcance de este cambio (decisión #230: sin C).
   - Halo rojo al hover identificado como dependiente del color de aro elegido en Ajustes (`--ring-1`), no un estado.
   - Tamaños: el punto escala y se ve bien; `GDK_BACKEND=x11` intacto.
5. **[x] Commit de unidad** en rama propia desde `main`: `fix/214-orb-status-badge` → commit `94e7334` (`fix(widget): el orbe avisa la falta de credencial con badge y motivo (#214)`; 3 archivos, +111/-3: implementación, tests y este documento).
6. **[ ] Evidencia y PR**: presentar evidencia al mantenedor en #214 y abrir la PR autorizada (ya con luz verde por el mantenedor: «Con ese ajuste… Adelante con la PR»), asignada a SrStamm, con la validación manual documentada; revalidar assignees/estado antes de abrir.

## Notas

- Evidencia del diagnóstico previo en #214: la ventana `detail` sí mapea en Wayland nativo; Mutter la centra y queda tapada (ubicación decide el compositor). Queda como contexto; este ODD no toca el detalle.
- La sonda de backend disponible (`display_kind()`, de #180) no se usa acá: `needsLogin`/`unconfigured` vienen del modelo.
- Mantenedor confirmó la cobertura de `unconfigured`: los proveedores con API key (`Status::Unconfigured`) son el caso concreto de los pasos de la issue.
