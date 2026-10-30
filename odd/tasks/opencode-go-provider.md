# opencode-go-provider

Provider **OpenCode Go** para Quorb: cuotas de 5 h, semanal y mensual — issue [#187](https://github.com/egdev6/quorb/issues/187).

> Estado: **plan v2 consolidado aprobado por el mantenedor** (2026-10-28, [issuecomment-6472310756](https://github.com/egdev6/quorb/issues/187#issuecomment-6472310756)): «Plan aprobado: OK de arranque de T7», con 4 notas no bloqueantes (todas incorporadas, ver Log L8).
> Fuente única del contrato: **S1–S4 más abajo** (sincronizada con el comentario v2 de #187).
> La asignación no autoriza merge ni release.
> Espejo en Engram bajo `odd/opencode-go-provider/tasks`.

## Objetivo

Que Quorb muestre el consumo de OpenCode Go ($10 / $40) como proveedor de suscripción,
con las tres ventanas que expone la API, sin abrir Console a mano ni esperar al primer `429`.

## Evidencia validada

### Payload real (captura propia 2026-10-27, key real, sin IDs de cuenta/org)

```json
{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-10-27T18:58:40.827Z"},"weekly":{"status":"ok","percent":1,"resetsAt":"2026-11-02T00:00:00.000Z"},"monthly":{"status":"ok","percent":24,"resetsAt":"2026-11-17T21:06:53.000Z"}}}
```

- `GET https://opencode.ai/zen/go/v1/usage` con **solo** `Authorization: Bearer <opencode-go API key>` → `200`,
  sin `x-opencode-org-id`. Observación de **esta cuenta**; no se generaliza.
- Credencial: API key `opencode-go` del Console (Console → subscribe → copy API key; `/connect` en el TUI).
  **Distinta** de la key Zen PAYG (`opencode`) y del OAuth de Console.
- `percent`: consumo del período 0–100, enteros; un `0%` puede ser <1 % ya usado. Mismos números que el
  dashboard de OpenCode. Agregado **a nivel de cuenta**; la regla de agregación entre modelos **no está
  documentada** → la UI dirá «consumo del período (contabilidad de OpenCode, igual que el dashboard)».
- `rolling` = ventana de 5 h. `weekly` = lunes 00:00 UTC (`2026-11-02T00:00:00Z` es lunes ✓).
  `monthly` = **ciclo de facturación anclado** (`2026-11-17T21:06:53Z`), no mes calendario ni 30 días fijos.
- Cada ventana trae además `status` («ok» en la captura).

### Estados y ausencia de datos (con procedencia marcada)

| Caso | Evidencia | Body / comportamiento |
|---|---|---|
| `401` clave rechazada | **captura propia en vivo** (con y sin header) | `{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}` → `Unconfigured` |
| `403` sin suscripción | **documentado, no capturado** (sin key válida sin Go); body de los tests de openusage | `EntitlementError` → `Warning` |
| `429` HTTP | **no reproducido** (30 seq + 10 paralelo → 200); fixture sintético marcado basta (confirmado por el mantenedor) | → `Warning` |
| `rate-limited` de negocio | **segunda mano**: en el campo `status` **por ventana** (fixture openusage: `monthly: {"status":"rate-limited","percent":100,...}`) | → `Status::Warning` nombrando la ventana; medidores conservados |
| ventana no iniciada | **captura propia** (`percent: 0` con reset ≈ +5 h); que la ventana **no esté iniciada** es una interpretación **no confirmada** (nota 1 del mantenedor) | reset mostrado tal cual (S1b fuera; ver S1) |
| `resetsAt` nulo / ventana ausente / forma malformada | **fixtures sintéticos marcados** | no inventar 0 % ni fechas |

### S1b («ventana no iniciada») — FUERA de esta entrega

Se muestra el reset recibido **tal cual**; no se suprime un reset válido solo porque el porcentaje sea cero.
Si se retoma después: heurística **declarada** (tolerancia 2 s contra el header `Date` del servidor, no el
reloj local; descarte solo en `rolling` con `percent == 0` y `|resetsAt − (Date + 5 h)| ≤ 2 s`; weekly y
monthly hacen opt-out), con evidencia de lecturas espaciadas que confirme que el `resetsAt` avanza.

### Fuentes externas

- `https://opencode.ai/docs/go/` (tres ventanas, límites por modelo en USD; no documenta esta API).
- `https://github.com/robinebers/openusage` (mismo endpoint, mismo contrato; mapper con la heurística).
- Origen del comportamiento: `anomalyco/opencode` @ `51f93ee…` — `usage-limits.ts` (`readGo()`), schema
  `Meter { percent, limited, resetsAt }`. OpenCode solo consulta el uso con OAuth de Console; la key de Go
  basta para este endpoint (demostrado en vivo), así que Quorb no necesita OAuth ni workspace ID.
- Precedente en Quorb: `src-tauri/src/providers/zai.rs` (`Kind::Subscription`, API key, tres medidores,
  parseo tolerante) — plantilla.

## Alcance

- Provider nativo `opencode_go` (`Kind::Subscription`, grupo «sub»), API key de Go.
- Backend `src-tauri/src/providers/opencode_go.rs`: fetch, parseo tolerante por ventana, tres medidores.
- Config `opencodeGo: { enabled }` + secreto `opencode_go_api_key` + cuentas adicionales (`Who::extra`).
- UI: pestaña «OpenCode Go» en Suscripciones, campo de API key, enlace a Console, logo/alias.
- Tests deterministas con fixtures (sin red), config, visibilidad y estados de error.

## No-alcance

Desglose por modelo · saldo Extra Usage/créditos/gasto USD · detección Go vs Go Plus · leer SQLite de
OpenCode · OAuth de Console · heurística «ventana no iniciada» (S1b, fuera de esta entrega) · cambiar
roadmap. La asignación no autoriza merge ni release.

## Contrato de implementación (S1–S4)

### S1 — Backend `opencode_go.rs`

- `fetch(cfg: &OpenCodeGoConfig, who: Who<'_>, http) -> UsageReport`; URL `https://opencode.ai/zen/go/v1/usage`
  con `bearer_auth(key)` y `Accept: application/json`. Sin `x-opencode-org-id`.
- Medidores con **ids estables**: `five_hour` («Cuota · 5 h», `window_seconds = 18000`),
  `weekly` («Cuota · semana», `604800`), `monthly` («Cuota · ciclo de facturación», `None`).
- **Validación de `percent`**: solo número **finito en [0, 100]**; fuera de rango o no numérico →
  diagnosticado, sin conversión silenciosa a 0 %. Un cero recibido y válido se conserva.
- **Validación de `resetsAt` (independiente)**: inválido o ausente **no elimina** un `percent` válido —
  porcentaje intacto, reinicio desconocido y limitación **dentro del `Warning` combinado** (nota 2 del
  mantenedor, verificada por test). Guard de informe vacío solo si no queda ningún dato interpretable.
- **Degradación parcial explícita**: ventana falta / malformada / `status` desconocido → se conservan las
  ventanas válidas **y** se emite `Warning` nombrando la ventana afectada. Un informe parcial **nunca** se
  presenta como éxito completo.
- **Composición de diagnósticos**: varios diagnósticos simultáneos → **un único `Warning`** cuyo mensaje
  nombra **todas** las ventanas afectadas (caso combinado cubierto por test). Los errores HTTP tienen
  **precedencia** sobre los diagnósticos de parseo (el cuerpo no se interpreta en ese camino). Ventana
  **sin campo `status`** → diagnosticada como desconocida, no aceptada (la captura real siempre lo incluye).
- Estados: sin key → `Unconfigured`; `401` → `Unconfigured` («API key rechazada»); `403` +
  `EntitlementError` → `Warning` («sin suscripción Go activa»); `403` genérico → `Unconfigured` (justificado:
  el fallo más probable y accionable es la credencial; Console es donde se regenera); `429` → `Warning`
  (fixture sintético marcado); otro HTTP / respuesta no JSON → `Error`; JSON sin medidores → `Warning`.
  `plan: None` (no se inventa; no se muestra «Go» vs «Go Plus»).
- Registro en `providers/mod.rs`: módulo, `fetch_all`, `fetch_one`, `fetch_account` (`enabled: true` para
  cuentas extra) — hecho en el mismo commit T7 para evitar `dead_code` en clippy (nota 4 del mantenedor).

### S2 — Config y secretos (checklist del mantenedor desde el primer commit)

- `OpenCodeGoConfig { enabled: bool }` en `config.rs` (camelCase serde) + `Default` + campo en `AppConfig`
  + entrada en `ACCOUNT_PROVIDERS` (11 → 12).
- `OPENCODE_GO_API_KEY` en `secrets.rs`: const, `ALL` (13 → 14) y `for_provider("opencode_go")`.
- `src/lib/types.ts`: `opencodeGo: { enabled }`, `AccountProvider` + `SecretKey`.
- `src/lib/settings-visibility.ts`: `MainKey` + `CONFIG_KEY`.
- `src/lib/widget-refresh.ts`: `dataKey` con `c.opencodeGo`.
- `src/lib/accounts.ts`: `ACCOUNT_SECRETS` y `accountReady` con `opencode_go_api_key`.

### S3 — UI

- `PROVIDER_TABS`: `{ id: 'opencode_go', name: 'OpenCode Go', group: 'sub', desc: 'Go / Go Plus · cuotas de 5 h, semanal y mensual' }`.
- `mainState`: `on(cfg.opencodeGo.enabled, !!s.opencode_go_api_key)`. Sección con `Toggle` de visibilidad,
  campo `SecretInput`, `HealthStep` y enlace `https://opencode.ai/console`.
- `AccountEditor`: rama `a.provider === 'opencode_go'` con clave scoped (aislamiento por cuenta).
- `order.ts` `OFFICIAL_USAGE_URL`: `opencode_go → https://opencode.ai/console`.
- `ProviderLogo.tsx`: monograma para `opencode_go` (sin SVG de marca, como Grok/z.ai).
- README.md / README.es.md: fila en la tabla de proveedores.
- Porcentajes etiquetados «consumo del período (contabilidad de OpenCode, igual que el dashboard)», sin
  insinuar desglose por modelo.

### S4 — Tests

- Fixture con la captura real de tres ventanas (+ `status`).
- `rate-limited` por ventana; `status` desconocido; ventana **sin** campo `status`.
- `401` (cuerpo AuthError real), `403` EntitlementError (documentado, marcado), `403` genérico, `429`
  sintético (marcado), HTTP 500, JSON vacío/renombrado — vía función pura `status_for_http` (sin red,
  patrón del repo: `zai.rs` no tiene mock HTTP).
- Validación de `percent`: límites 0, 100, >100, negativo, no numérico, nulo.
- Combinaciones parciales `percent`/`resetsAt`: `%` válido + reset inválido/ausente; reset válido + `%` inválido.
- Degradación parcial mixta: dos ventanas válidas + una ausente; dos válidas + una malformada; dos válidas
  + una con `status` desconocido — medidores conservados **y** diagnóstico emitido.
- Composición: caso combinado `rate-limited` + ventana ausente → **un único** `Warning` nombrando ambas;
  precedencia de error HTTP sobre diagnósticos de parseo.
- Cuentas adicionales: `for_provider` + scoped key; toggle de visibilidad.

## Criterios de aceptación

1. Con API key válida, el orbe muestra 5 h, semana y ciclo de facturación con % y reinicio.
2. Sin key → `Unconfigured` con UI en «Falta conectar»; no rompe otros informes.
3. `401` y `403`/EntitlementError se distinguen con mensajes accionables.
4. Formato cambiado → ventanas válidas conservadas **y** un único `Warning` que nombra todas las ventanas
   afectadas; nunca panic, informe vacío silencioso ni éxito completo ante degradación parcial.
5. `percent` solo aceptado si es número finito en `[0, 100]`; fuera de rango o no numérico → diagnosticado,
   sin relleno silencioso a 0 %; un cero recibido y válido se conserva.
6. `resetsAt` inválido o ausente **no elimina** un `percent` válido: porcentaje intacto, reinicio
   desconocido y limitación advertida; el guard de informe vacío aplica solo si no queda ningún dato.
7. `rate-limited` por ventana → `Warning` nombrando la ventana, con los medidores válidos que devuelva.
8. Composición de diagnósticos: errores HTTP con precedencia sobre parseo; ventana sin `status`
   diagnosticada como desconocida; el caso combinado está cubierto por test.
9. Toggle persiste, proveedor en la tira, cuentas adicionales con claves aisladas.
10. S1b queda fuera: el reset recibido se muestra tal cual, sin suprimirlo por un cero redondeado.
11. `npm test`, `npm run typecheck`, `cargo test`, `cargo fmt --check`, clippy limpio en el archivo nuevo
    e inventario i18n en verde. No afirmar verificación Windows desde Linux.

## Tareas

- [x] T1 · Validar endpoint con key real; sin `x-opencode-org-id`.
- [x] T2 · Sin duplicada ni entrada en el roadmap #45.
- [x] T3 · Estimar sobre `zai.rs` y el wiring de proveedores.
- [x] T4 · Issue publicada como #187.
- [x] T5 · Aprobación de producto + cierre de las 3 observaciones del mantenedor.
- [x] T6 · Plan publicado y ajustado (v1 → v2 consolidado).
- [x] T6b · Revisión del plan v2 por el mantenedor: **aprobado, OK de arranque de T7**
      ([issuecomment-6472310756](https://github.com/egdev6/quorb/issues/187#issuecomment-6472310756)),
      con 4 notas no bloqueantes incorporadas (ver Log L8).
- [x] T7 · S1: backend `opencode_go.rs` + tests de parseo/estados/composición. 15 tests propios; módulo
      registrado en `mod.rs` en el mismo commit (nota 4).
- [x] T8 · S2+S3: config, secretos, wiring, tipos, UI, logo, README. Commit `0aec041` (12 archivos,
      +112/−18). Notas: `accountReady` con rama `opencode_go` (exigida por el plan; la ausencia en zai es
      un gap preexistente), monograma explícito `OC` (Grok usa `grok.svg` en este repo, no monograma),
      `OFFICIAL_USAGE_URL → https://opencode.ai/console` según S3 aprobado. Verificado: npm test 225 OK,
      typecheck limpio, inventario i18n OK, cargo test 322 OK, fmt/clippy limpios.
- [x] T9 · S4+verificación: suite completa en verde (7/7, ver L12); evidencia preparada para la PR.
      Abrir PR requiere autorización explícita.
- [x] T10 · **BLOCKER del review egdev6 #201**: validar `resetsAt` con `chrono::parse_from_rfc3339`
      (patrón cursor/grok); inválido → porcentaje conservado, `resets_at: None`, aviso; + test con
      strings no interpretable. Commit `cd70933`.
- [x] T11 · Refuerzo de cobertura S4 (mismo review): caso `percent: 100`; JSON vacío/renombrado;
      aserciones estrictas en `rate_limited_window_warning_keeps_meters`,
      `percent_validation_bounds` y `unknown_status_or_missing_status`; extraído `build_report`
      del tramo final de `fetch` y verificado el `Status::Warning` final sin red; corregida la
      procedencia del comentario del 403 (documental, no sintético). Commit `cd70933`.
- [x] T12 · Copy (sugerencias del review): avisos con la etiqueta del medidor (no claves internas
      `rolling`/`monthly`); «Límite de uso alcanzado en…» para rate-limited; pestaña unificada a
      «ciclo de facturación» (Settings.tsx) + tests actualizados para afirmar por etiqueta.
      Commits `cd70933` (Rust) y `82b8613` (Settings.tsx).
- [x] T13 · Verificación 7/7 post-feedback: cargo test 326 OK (19 del módulo, +4), fmt OK, clippy
      limpio en `opencode_go.rs`, npm test 715 vitest + 240 node OK, typecheck limpio, inventario
      i18n `--check` OK (ver L14). Commits de unidad de trabajo: `cd70933`, `82b8613`; doc en
      commit propio. Push y respuesta en la PR quedan con el usuario.

## Estimación

~300–350 líneas autoradas (Rust ~140, config/secretos ~45, tipos/visibilidad ~15, Settings ~110, docs ~10).
Orientativa, **no un techo que obligue a recortar tests**; el tamaño real se revisa sobre el diff. Con la
cobertura de S4 puede superarse: decidimos sobre el diff real y, si hace falta, PRs encadenadas sin recortar
tests (nota 3 del mantenedor).

## Riesgos

- **Endpoint no documentado**: puede cambiar → parseo tolerante, `Warning` ante formato desconocido o
  parcial, enlace a Console como fallback.
- **Semántica agregada**: no insinuar desglose por modelo en la UI; presentar los % como contabilidad de OpenCode.
- **Monthly variable**: es el ciclo de facturación; mostrar el reinicio, no calcular ritmo con 30 días.
- **Sin plan**: no mostrar «Go» vs «Go Plus».
- **Placeholder**: S1b fuera; se muestra el reset recibido. Si se retoma, heurística declarada con evidencia.
- **Marca**: logo oficial solo si el repo acepta el asset; si no, monograma.
- **i18n**: #199 migró solo secciones no-proveedor de Ajustes; re-verificar inventario y catálogos contra
  el `main` vigente al integrar.
- **Merge/release**: no autorizados por esta issue; quedan para la PR y su revisión.

## Log

- L1 (2026-10-26): auditoría de roadmap/backlog; endpoint localizado en `anomalyco/opencode`.
- L2: validación en vivo → `200`, sin `x-opencode-org-id`.
- L3: issue #187 publicada y etiquetada `status:approved` por el mantenedor.
- L4 (2026-10-27): comentario del mantenedor — aprobación condicionada a cerrar contrato de payload.
- L5: respuesta con captura anonimizada, tipo de credencial y matriz de estados con procedencia.
- L6: comentario final del mantenedor — alcance aprobado, issue asignada, ajuste de «ventana no iniciada»,
  mensual = ciclo de facturación, 429/403 con fixtures marcados, checklist de integración desde el primer commit.
- L7 (2026-10-27): plan de tareas publicado como comentario en #187.
- L8 (2026-10-28): plan v2 consolidado publicado y **aprobado** por el mantenedor (OK de arranque de T7).
  Notas no bloqueantes: (1) corregir la etiqueta de evidencia de «ventana no iniciada» — la captura muestra
  `percent: 0` + reset ≈ +5 h, la no-iniciada es interpretación no confirmada; (2) explicitar que un
  `resetsAt` inválido/ausente con `percent` válido entra en el `Warning` combinado, verificado por test;
  (3) no comprometer de antemano PR única sin `size:exception` — decidir sobre el diff real; (4) registrar
  el módulo en `mod.rs` en T7 para evitar `dead_code` en clippy. Las cuatro incorporadas.
- L9 (2026-10-28): T7 implementado en `feat/opencode-go` — `opencode_go.rs` con `fetch`, `status_for_http`
  (mapeo HTTP puro testeable), `parse_usage` (validación de `percent`/`resetsAt` independiente, degradación
  parcial, un único Warning combinado) + 15 tests; registro en `providers/mod.rs` (`fetch_all`, `fetch_one`,
  `fetch_account`). Commit `1191259`; `cargo test` 322 en verde, `cargo fmt --check` OK, clippy limpio
  en el archivo nuevo.
- L10 (2026-10-28): T8 implementada por writer delegado en dos pasadas (la primera se detuvo por un gap
  de superficie en `types.ts`/`settings-visibility.ts` del trabajo previo incompleto; aprobado completarlas
  siguiendo el patrón z.ai 7043a84). S2 restante (`widget-refresh`, `accounts.ts`) + S3 completo (pestaña,
  sección Settings, AccountEditor, `OFFICIAL_USAGE_URL`, monograma `OC`, READMEs). Commit `0aec041`.
  El `it.each` de settings-visibility ya cubre y pasa la entrada nueva (toggle de visibilidad funcional).
- L11 (2026-10-28): **Smoke en vivo del usuario con su API key real de Go: OK** — el orbe muestra las
  tres ventanas con datos sin problemas (criterio de aceptación 1 verificado funcionalmente fuera de
  los tests). Captura de evidencia visual: la aporta el usuario en el comentario de evidencia.
- L12 (2026-10-28): **T9 cerrada — verificación final 7/7 PASS** (verificador read-only sobre HEAD
  `df35ca8`): `cargo test` 322 OK · `cargo fmt --check` OK · clippy sin warnings en `opencode_go.rs`
  (27 preexistentes en otros archivos) · `npm test` 688 vitest + 225 node OK · `typecheck` limpio ·
  inventario i18n regenerado y commiteado (`58bcaee`; React 610/762, Rust 347/421) · inventario git:
  5 commits sobre el punto de branch, diff real three-dot **15 archivos, +766/−20** (el two-dot de 46
  archivos incluía avances de main).
- **Rebase hecho (2026-10-28)** sobre `origin/main` (#186/#195/#199/#200) con conflicto solo en
  `docs/i18n-inventory.md`. Re-verificación completa post-rebase: todo verde (cargo test 322, fmt,
  clippy sin warnings en `opencode_go.rs` y sin warnings en los archivos tocados, npm test 715 vitest
  + 240 node, typecheck, spot-check de Settings.tsx intacta) con un bloqueo: **drift del inventario
  i18n** detectado por el contrato CI de #186 (los 6 textos React nuevos de la UI no estaban en el
  inventario). Resuelto con `acae551`: React 770/915 → 776/930; `i18n-inventory.mjs --check` en verde.
  Branch final: 6 commits, diff three-dot 15 archivos +770/−12. La PR abre solo con autorización
  explícita; el comentario de evidencia con captura lo publica el usuario en #187.
- L14 (2026-10-28): **Feedback del review del mantenedor en PR #201 incorporado** (T10–T13).
  Cambios: (1) bloqueante de `resetsAt` — validación RFC3339 con `chrono` (patrón cursor/grok),
  inválido/ausente conservan el porcentaje, dejan reinicio desconocido y emiten aviso (criterio 6),
  test-first con RED observado; (2) persistencia de avisos revisada — usan la etiqueta visible del
  medidor (label_of) y «Límite de uso alcanzado en…» para rate-limited; (3) `build_report` extraída
  del tramo final de `fetch` para verificar el Estado final sin red (nota 2 del plan); (4) cobertura
  S4 ampliada y aserciones más estrictas (percent 100, JSON vacío/renombrado con composición de las
  tres ventanas, medidores conservados/no creados, ambas ventanas diagnósticas); (5) pestaña
  unificada a «ciclo de facturación»; (6) comentario del 403 con procedencia documental. el guard
  de informe vacío quedó documentado como rama defensiva inalcanzable hoy.
  Verificación 7/7: cargo test 326 OK (19 del módulo), fmt OK, clippy limpio en el archivo,
  npm test 715 vitest + 240 node OK, typecheck limpio, inventario i18n `--check` OK.
  Nota de verificación: las suites corridas inline con salida acotada (tail/counts); el próximo
  ciclo pasa por el verificador read-only. Commits `cd70933` y `82b8613`.
- L13 (2026-10-28): **PR #201 abierta** con autorización explícita del usuario:
  https://github.com/egdev6/quorb/pull/201 (`SrStamm:feat/opencode-go` → `egdev6:main`, título
  `feat(providers): provider OpenCode Go con cuotas 5 h/semana/ciclo (#187)`, body según plantilla con
  issue, plan v2 y evidencia enlazados). Branch pusheda al fork. Label `type:feature` y assignee NO
  aplicados: 403 — SrStamm sin permiso de triage en el upstream (precedente #183/#184: los etiqueta
  el mantenedor). CI en curso al abrir: secrets-scan PASS; resto pending. En #187 el usuario publicó
  el comentario de evidencia con captura (issuecomment-6473938160). El estado de la PR (merge, labels,
  revisiones) queda en manos del mantenedor.
