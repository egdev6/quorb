# ODD — #263 email presentation
Branch: `feat/263-email-presentation`; scope: automatic ES/EN email content only. Delivery: single presentation unit as the approved issue requests, no push/PR; initial forecast ~350 authored changed lines plus generated inventory. Actual candidate: 543 lines including tracking (473 behavior/tests/docs); no artificial behavior split.
Checks: synthetic loopback HTTP (`cargo test --lib email::tests`), native i18n tests, frontend email/alerts regression, canonical inventory; RDD enabled.

## Specs

S1. «El owner ha confirmado los textos ES/EN y las variantes genéricas. La regla definitiva es truncar a dos decimales, sin ceros finales, NO redondear. Mantén la excepción superior a 100 y cubre los casos que exige su comentario.» Sources: issue #263, proposal comment 6798901588 and owner confirmation 6799388155 (confirmation overrides rounding). Cases: 89.996 → 89.99, 12.345 → 12.34, 99.999 → 99.99, exact 100, 100.001 → 100.01.
S2. «Siempre se muestran el proveedor y el porcentaje observado. Solo se añade una descripción del medidor cuando sea inequívoca; ante la duda, usa la variante genérica. El inventario de medidores está en Engram: 263-email-presentation/meter-inventory.»
S3. «Implementa con pruebas HTTP simuladas ES/EN que comprueben asuntos y cuerpos completos, variantes genéricas, porcentajes y la lista explícita de medidores con descripción inequívoca.»
S4. «Mantén intactos la detección, el contrato del evento y el correo de prueba. Regenera el inventario i18n por el procedimiento canónico.»
S5. «No realices envíos reales ni accedas al llavero personal. Las comprobaciones manuales de #245 quedan fuera. Sigue la política RDD vigente y no hagas push ni abras una PR en esta fase.»
S6. «Ambos archivos son locales: NO deben comitearse ni incluirse en la PR.» Applies to `HANDOFF-263.local.md` and `EMAIL-263-CRITERIA.local.md`.
S7. «Haz commits pequeños y coherentes siempre que sea posible, manteniendo juntos el comportamiento, sus tests y la documentación correspondiente. No amplíes el alcance para dividir artificialmente el trabajo.»
S8. «No des el trabajo por terminado mientras haya tareas de apoyo activas o con estado incierto.»

## Tasks

- T1 [S1–S7] done — parent inline: presentation unit implemented with HTTP RED (3 expected failures) then GREEN (email 20/20, i18n 8/8) and docs; commit pending. No parallel writer trigger; explorer mapping completed.
- T2 [S3–S5,S8] done — parent self-verification: frontend 43/43 + typecheck; safe Rust suite 535 pass/1 ignored/1 keychain test excluded; npm 968 Vitest + 298 Node pass; final HTTP 3/3 + fmt pass; native assessment medium/reviewDue=false. Authorized repaired differential PASS: exact ES/EN explicit-test HTTP payloads and accepted status unchanged, one request per locale on base/candidate. Prior setup failure preserved (0 tests).
- T3 [S4,S6,S7] in_progress — parent inline: materialize source commit, regenerate commit-anchored i18n inventory, check and commit generated delta; final clean-scope readback.

## Log

L1. Original user request (2026-11-11):

Retomamos la issue #263 y empezamos la implementación.

Lee primero:
- HANDOFF-263.local.md
- EMAIL-263-CRITERIA.local.md

Ambos archivos son locales: NO deben comitearse ni incluirse en la PR.

Consulta también la issue y la confirmación del owner:
https://github.com/egdev6/quorb/issues/263
https://github.com/egdev6/quorb/issues/263#issuecomment-6799388155

El owner ha confirmado los textos ES/EN y las variantes genéricas. La regla definitiva es truncar a dos decimales, sin ceros finales, NO redondear. Mantén la excepción superior a 100 y cubre los casos que exige su comentario.

Siempre se muestran el proveedor y el porcentaje observado. Solo se añade una descripción del medidor cuando sea inequívoca; ante la duda, usa la variante genérica. El inventario de medidores está en Engram: 263-email-presentation/meter-inventory.

Trabaja en una rama de feature, nunca en main. Ya se creó feat/263-email-presentation y aún no tiene commits de implementación: verifica su estado y úsala si sigue siendo la rama dedicada a esta issue.

Haz commits pequeños y coherentes siempre que sea posible, manteniendo juntos el comportamiento, sus tests y la documentación correspondiente. No amplíes el alcance para dividir artificialmente el trabajo.

Implementa con pruebas HTTP simuladas ES/EN que comprueben asuntos y cuerpos completos, variantes genéricas, porcentajes y la lista explícita de medidores con descripción inequívoca.
Mantén intactos la detección, el contrato del evento y el correo de prueba. Regenera el inventario i18n por el procedimiento canónico.

No realices envíos reales ni accedas al llavero personal. Las comprobaciones manuales de #245 quedan fuera. Sigue la política RDD vigente y no hagas push ni abras una PR en esta fase.

## Sesión de apoyo

Hay otra sesión disponible:
01a1cb2d-0a6b-773e-9f63-7c04ba166b1f

Puedes coordinarte con ella para exploración, implementación acotada y verificación. Antes de delegar, consulta su estado publicado y confirma su disponibilidad y capacidades; no presupongas qué perfiles tiene.

Tú eres la sesión principal y responsable de la integración:
- Asigna tareas concretas con alcance, archivos permitidos y comprobaciones esperadas.
- Evita escrituras simultáneas sobre los mismos archivos. Para implementación paralela, usa superficies disjuntas o worktrees separados del mismo clon.
- La sesión de apoyo debe devolver los cambios y la evidencia de sus comprobaciones, sin hacer commits, push ni abrir PR.
- Tú revisas e integras los cambios y haces los commits pequeños y coherentes.
- Tú tomas las decisiones técnicas importantes dentro del alcance aprobado. Si aparece una decisión de producto o un cambio de alcance no resuelto por la issue y el owner, consúltamelo.
- No des el trabajo por terminado mientras haya tareas de apoyo activas o con estado incierto.

Delega solo cuando aporte una ventaja real. Si las partes son muy dependientes, utiliza la sesión de apoyo para revisión o verificación en lugar de forzar implementación paralela.

L2. Verified branch `feat/263-email-presentation` at `0503147`, no branch-only commits and no tracked edits. Both local notes ignored by existing global `*.local.md`; never stage them. Live issue assigned to ludevdot, owner confirmation matches local notes. Explorer mapped surfaces; its claim that CONTRIBUTING was absent was corrected by parent direct read. Inventory is commit-anchored, necessitating a separate generated follow-up commit. RDD mode reads on. Support metadata inspected and availability requested; no work assigned yet.

L3. RED job-1 exit101: new generic percentage HTTP test fails against old technical content (0 pass/1 fail); command chaining did not run the other two. RED job-2 exit101: all three new rules fail (0 pass/3 fail). GREEN job-3 exit0: email HTTP suite 20/20 and native i18n 8/8. Frontend job-4 exit0: alerts/email/dispatch 43/43 plus typecheck. No production send, app launch or keychain access. Found existing macOS keychain test: explicitly exclude it from any wider suite. Native assess currently cannot assess because the new task file is untracked; inspect selected only that file (local notes remain excluded), no lineage created or consent inferred. Resolved by staging only the task document; final assessment succeeds: medium, 4 paths/543 changed lines, reviewDue=false (under_budget), writer self-verification, no independent verifier required. No native review lineage or consent created.

L4. Wider checks: job-5 exit0, Rust 535 pass/1 ignored (pre-existing desktop smoke)/1 explicitly filtered macOS keychain roundtrip; fmt pass. Job-6 exit0: full npm suite 968 Vitest/74 files + 298 Node, no skipped Node tests. Provider display names aligned with registry (NaN Builders, z.ai); job-8 exit0: the three HTTP rule tests pass after that alignment (3/3), fmt pass.

L5. Differential preparation failed: job-7 exit101 in archived base build, before executing any of the ES/EN explicit-test probes (0 tests run). Root cause confirmed: `src-tauri/tauri.conf.json` version references `../package.json`, omitted by the archive of `src-tauri` alone. All product suites above remain valid; the differential remains unverified. Prepared local-only `email-263-differential.local.md` (Python helper; ignored, never stage) now includes base package.json and asserts version, Cargo.lock and icon prerequisites. Python3.9-compatible extraction validates archived paths and rejects links; existing target/dependencies and 126GiB free capacity established. No automatic differential rerun; a new bounded attempt requires explicit human request after this setup failure. Explorer is completed, no child active; support has only a standby availability inquiry, no assigned work or changes. No source commits, inventory regeneration, push or PR yet.

L6. Bounded stop for missing differential proof. Proposed continuation: parent runs the repaired archive-based ES/EN explicit-test HTTP comparison against base0503147 and current candidate, comparing complete payloads, acceptance status and exactly one request per locale, with only synthetic keys and loopback endpoints. Then resume source commit, canonical generated inventory/check and generated follow-up commit under RDD; no push/PR. Product code is implemented, but completion/delivery remain blocked until this proof is available. Risk: none (presentation only; requested existing test-email behavior is pinned, gates/event validation/detection unchanged). Native risk medium, reviewDue=false.

L7. Human selected «Autorizar la nueva comprobación y continuar» (authorize_repaired_differential) through the focused decision prompt: authorize one new bounded base/candidate ES/EN explicit-test HTTP comparison with corrected preparation, then local commits/inventory if it passes; no push/PR. Prior failure preserved. Child list confirms only the completed explorer, no active/uncertain child. Preflight confirms package.json, Cargo manifests/lock, Tauri config and icon are present at base; scratch capacity remains sufficient.

L8. Authorized repaired differential job-9 exit0: base and candidate each execute the same synthetic explicit-test probe (ES and EN); complete from/to/subject/text and accepted status identical, exactly one captured request per locale. This resolves only the missing differential proof; job-7 remains a failed setup with zero tests. No child active; support never assigned a task. Proceed with one coherent source/tests/docs/tracking commit and a canonical generated inventory follow-up because the generator reads committed sources.
