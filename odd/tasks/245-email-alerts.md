# ODD — #245: avisos por email con Resend
Objetivo: implementar y documentar el alcance aprobado de #245; rama `feat/245-email-alerts`, base `b82cf78`. T1–T3/T5, T6 y T7–T9 integradas en seis commits, con T1 separado; T10 reconcilia evidencia renombrada. El owner acepta manual + HTTP simulado (S23–S24), sin exigir tests de Ajustes montado. T4 sigue parcial; bloqueos históricos L11/L18 preservados.
Estado vigente L52: seis commits, HEAD saneado `33bc5d990f946594772ae1fe87d4aafe8655a8ea`; dos últimos locales, fork confirmado en a45f646. Amend local de sexta unidad autorizado L51, solo seis rutas privadas redactadas; cinco previos intactos. Revisión nativa del sexto original consumida, no trasladable al nuevo candidato. Guía versionada separada del informe/capturas de PR; cambios documentales pendientes preservados sin stage. npm/package-lock.json; sin push/force-push/PR hasta nueva aprobación, sin app/instalaciones/envíos. T4 parcial: aislamiento no acreditado, Windows/Linux pendientes de validación por un compañero solicitada en la PR, disposición final pendiente del owner; #245 no cerrada.

## Specs

Fuente A: [comentario aprobatorio del owner](https://github.com/egdev6/quorb/issues/245#issuecomment-6692283097), transcrito del contexto autorizado; no se ha consultado de nuevo GitHub. Las citas son literales; los identificadores S# son locales.

**S1 — Canal (A).**
> 1. **Canal: Resend para esta primera fase**, con la contrapartida declarada de posibles retrasos o filtrado del correo.

**S2 — Intentos (A).**
> 2. **Sin reintentos automáticos, sin cola ni replay.** Aprobada la restricción más estricta: un único intento por evento.

**S3 — Identidad y memoria (A).**
> 3. **Identidad del evento.** Reutiliza la que ya existe: proveedor, medidor, `windowKey(resetsAt)` (`src/lib/alerts.ts`) y tipo de evento (umbral o reinicio). El email debe tener exactamente la misma semántica de memoria que el aviso local de `detectAlerts`, sin añadir persistencia nueva.

**S4 — Lectura del secreto (A).**
> 4. **Clave ausente frente a fallo del llavero.** No cambies `secrets::get()`: la usan todos los proveedores y es un contrato compartido. Añade una función específica que devuelva `Result` y que use solo la integración de email.

**S5 — Linux (A).**
> 5. **Almacenamiento en Linux.** No bloquea esta issue; esa duda pertenece a #106. Si el backend efectivo es keyutils, la clave puede no sobrevivir a un reinicio: documéntalo como limitación conocida, sin resolverlo aquí y sin fallback a texto plano.

**S6 — Remitente (A).**
> 6. **Remitente.** Lo introduce el usuario. En pruebas, el remitente de pruebas de Resend hacia el email de su propia cuenta; para otros destinatarios, dominio verificado. Quorb no trae ningún remitente fijo.

**S7 — Unidad de seguridad (A, petición adicional).**
> Una petición para la PR: la nueva clave en la lista cerrada de `secrets.rs` y su almacenamiento tocan seguridad, así que llévalos en un commit propio para revisarlos por separado.

**S8 — Tests primero (A, cierre).**
> Con esto puedes empezar por los tests.

S8 es la autorización del mantenedor; L8 registra la autorización actual del usuario para iniciar la implementación.

Fuente B: restricciones anteriores del owner aceptadas en #245, citas exactas aportadas por el contexto de esta tarea; no se dispone aquí de otro permalink individual.

**S9 — Disponibilidad (B).**
> Límite del caso. Quorb tiene que estar abierto y el equipo despierto: si se suspende, no hay sondeo ni aviso. Debe quedar claro en la UI.

**S10 — Frontera de envío (B).**
> Dónde vive el envío. Hoy la detección de avisos está en el frontend (src/lib/alerts.ts, Widget.tsx), pero el envío debe hacerse en Rust: la CSP no permite que el webview haga peticiones HTTP, y la API key debe guardarse en el llavero (secrets.rs), nunca en el frontend.

**S11 — Eventos existentes (B).**
> Un aviso por evento. Reutiliza la detección actual (cruce del umbral, reinicio) para enviar una sola vez por evento, no en cada sondeo.

**S12 — Consentimiento (B).**
> Privacidad. El mensaje sale hacia un tercero con proveedores y porcentajes: tiene que ser opt-in explícito y con un contenido mínimo y documentado.

**S13 — Fallos y prueba (B).**
> Fallos. Que se vean en Ajustes, sin reintentos en bucle, y con un botón de «enviar prueba».

**S14 — Integración concreta (B).**
> Sobre la sección «Integraciones»: de momento empezaría con la integración concreta, sin una capa genérica de proveedores. Si más adelante llegan otras, se extrae.

Fuente C: detalles del cuerpo de issue aceptado según el contexto aportado; citas conservadas en el [borrador local de issue](../../docs/integraciones-email-resend-issue.md). El borrador completo sigue siendo histórico: sus reservas y alternativas obsoletas no son requisitos vigentes.

**S15 — Activación y eliminación (C).**
> Email desactivado por defecto; activación con consentimiento explícito sobre los datos enviados.
> Guardar configuración no lo activa. Desactivar conserva la clave; eliminarla impide nuevos envíos.

**S16 — Prueba explícita (C).**
> Configurar API key oculta, remitente y destinatario, con acción explícita de email de prueba y aceptación/error sanitizado visible. La prueba requiere consentimiento y configuración válida, puede usarse con Alertas global desactivado y no activa el envío automático.

**S17 — Credenciales (C).**
> Reutilizar `secrets`/`keyring`, sus comandos y `SecretInput`, con una clave propia de Resend.
> Sin clave en JSON, logs o lectura del valor guardado desde el frontend, sin fallback a texto plano.

**S18 — Interruptores y regresión local (C).**
> Enviar por HTTP desde Rust/Tauri, sin ampliar la CSP. Reutilizar los eventos de `alerts.ts` despachados por `Widget.tsx`, conservando su semántica de umbral, reinicio y memoria. El envío automático requiere Alertas global y email habilitados, con configuración válida, el interruptor de notificación nativa solo gobierna el aviso local.
> El fallo nunca bloquea avisos locales.

**S19 — Payload y datos personales (C).**
> El contenido se limitaría a proveedor, medidor/ventana, porcentaje y tipo de evento (umbral o reinicio). Resend también procesa remitente y destinatario, que son datos personales.
> Explicarlo antes del consentimiento. Sin prompts, código, identificadores de cuenta, usuarios, secretos ni contenido de sesiones, no exportar objetos completos ni registrar direcciones o payloads.

**S20 — Aceptación, no entrega (C).**
> No se garantiza entrega exactamente una vez, un timeout puede dejar incierto si Resend aceptó la solicitud.
> Mostrar «Solicitud aceptada por Resend», no «entregado en la bandeja de entrada»

**S21 — Traducciones (usuario, L25; trabajo para próxima sesión).**
> todo lo que hicimos necesita traducciones, no se si se añadió todos los idiomas o si los textos estan "hardcoded"

**S22 — Feedback de prueba en Alertas (usuario, L25; corregido y verificado en L28).**
> por otro lado en en "Alertas" deberñia salir una notificacion de que el envio de prueba ha sido exitoso o fallido.

**S23 — Lógica de interruptores fuera de la UI (owner, fuente D, L29).**
> 1. **La lógica de interruptores, fuera de la UI.** Guardar no activa, desactivar conserva la clave, eliminar impide enviar, Alertas global + email gobiernan el envío, el aviso nativo no influye y la prueba exige consentimiento y configuración válida. Si esas reglas viven en funciones puras (o un reducer) con sus tests, la comprobación manual queda solo para lo visual y el cableado.

**S24 — Comprobación manual repetible, no limitada a una plataforma (owner, fuente D, L29).**
> 2. **Comprobación manual repetible y no limitada a una plataforma.** Déjala en la PR como checklist con capturas, con el estado y las credenciales separados que propones. El guardado de la clave conviene comprobarlo también en Windows, porque el almacén de `keyring` cambia por sistema operativo. Si no tienes acceso a Windows, indícalo en la PR y lo verificamos nosotros.

S23-1: la prueba de Ajustes montado queda fuera de esta issue — sin `jsdom`, `happy-dom`, `@testing-library/*` ni `mockIPC`, exige dependencias nuevas y una decisión transversal; posible issue propia futura. S23-2: sin acceso a Windows verificado, la PR lo indicará para que el owner lo compruebe.

Fuente D: [respuesta del owner](https://github.com/egdev6/quorb/issues/245#issuecomment-6716512919) a la [consulta de validación](https://github.com/egdev6/quorb/issues/245#issuecomment-6711649488): combinación manual + automatizada es suficiente.

**S25 — Refuerzo de pruebas y evidencia (usuario, L32).**
> adelante con la recomendacion

Recomendación aceptada: probar el guardado/desactivación sin eliminación de clave en el coordinador real existente; precisar el test Rust y contar dos peticiones; sustituir la ventana HTTP de 350 ms por cierre explícito con timeout de seguridad; alinear checklist manual/HTTP simulado y Windows; corregir afirmaciones de cierre; ejecutar checks aplicables. Sin nuevas dependencias, reglas de producto ni pruebas de Ajustes montado.

**S26 — Ayuda de email más clara (usuario, L40).**
> usa tu propuesto pero no comitees. el texto"Linux: si el backend es keyutils, la clave puede no sobrevivir a un reinicio. Su resolución corresponde a #106; nunca se usa texto plano." creo que en la ui decir backend, no es correcto sino explicarlo y en la ui referenciar a una issue no tiene sentido

Propuesta aceptada: explicitar `onboarding@resend.dev` solo para pruebas hacia el correo de la cuenta Resend, sin valor predeterminado; ayuda de prueba más breve conservando guardado/envío, consentimiento y clave; aviso Linux comprensible solo en Linux, explicación técnica/#106 en documentación. Traducciones es/en y tests; sin commits.

**S27 — Preparación documental de evidencia existente (usuario, L43; aclaración L46).**
> Pero ya te dije y debe estar registrado que no trabajo en una VM sino en mi Mac local

Entorno confirmado por el usuario: Mac local, sin VM. No tratarlo como dato desconocido ni confundirlo con la separación de configuración/llavero no acreditada.
> Continuemos con la preparación documental de la evidencia manual:
>    revisa las capturas y README-evidencia-245.md en
>    [external-screenshots] y prepara
>    docs/email-alerts-validation.md, actualizando ODD y Engram.

> Distingue lo observado en imágenes, lo confirmado por mí y lo
>    no acreditado. No inventes versión de macOS ni el artefacto probado.
>    Las capturas anteriores muestran textos previos a T7.

> Windows sigue pendiente del owner. No declares cerrada #245.

**S28 — Actualización de evidencia renombrada (usuario, L49).**
> Actualiza docs/email-alerts-validation.md, docs/email-alerts.md,
> ODD y Engram, distinguiendo observado, confirmado y no acreditado.
> No nuevos envíos, arranque de app, instalaciones ni datos personales.
> Usa npm/package-lock.json para el trabajo actual.

Petición completa y restricciones de publicación: L49. Conservar originales externos, identificar ayuda T7 por contenido y registrar procedencia humana sin convertirla en hash de binario observado.

**S29 — Privacidad del contenido público y amend local (usuario, L51).**
> nunca en una pr debe existir datos del desarrollador
> permito amend, el force push lo haremos cuando de el ok y este todo revisado. mi ultimo commit en mi fork fue: a45f646ca046d9ac86fd6bd29ba177085b15f566

Anonimizar rutas personales en contenido versionado e historia local publicable. No push ni force-push; preservar los commits anteriores y cambios pendientes. Las citas que contenían rutas privadas se redactan en este archivo público; originales conservados solo en memoria/respaldo privado.

**S30 — Commit documental y validación pendiente Windows/Linux (usuario, L53).**
> nos quedaria hacer el commit de lo que tenemos ahora. Windows/Linux continua pendiente, y se pedirán en la PR para que un compañero lo valide

Commit local de los tres documentos pendientes, preservando privacidad e historia saneada; sin push ni PR en este turno. Solicitar validación de ambas plataformas en la futura PR, sin declarar comprobaciones ya realizadas ni ampliar #245 para resolver #106.

## Tasks

- **T12** — S28–S30: integrar guía reutilizable, consistencia documental y pendientes Windows/Linux en un commit documental local; ruta inline; estado: cambios documentales comprobados, integración en unidad `docs(alerts): clarify validation evidence and platform checks`, padre33bc5d9; checks estructurales exit0 y assess passive/reviewDuefalse (L54). Materialización/hash y cierre postcommit se registran en Engram sin amend autorreferencial. Sin pruebas históricas ni publicación.

- **T11** — S29: sanear rutas privadas del sexto commit local mediante amend autorizado, sin incorporar cambios documentales pendientes; preservar cinco commits previos y comprobar contenido/historia con verificador acotado independiente. Ruta inline; estado: completada en alcance de saneamiento local L52; commit: `33bc5d990f946594772ae1fe87d4aafe8655a8ea`, sustituye sexto local7aeb329 con parent3efb171 intacto; verificación independiente nueva acotada sin bloqueadores y spot-check parent exit0; Risk: item 2 (evitar exposición de rutas personales en contenido publicable). Sin publicación ni verificadores históricos.

- **T10** — S24, S27–S28: reconciliar capturas renombradas y procedencia, actualizar ambos documentos, ODD y espejo Engram, comprobar enlaces/estructura/preservación; ruta inline tras explorador read-only y spot-check parent; estado: completada en alcance documental, checks L50 exit0 y espejo Engram íntegro comprobado al finalizar; commit: ninguno, commit/push/PR se abordan después por petición L49. Sin verificadores históricos ni reutilización de autoridad.

- **T1** — S4, S5, S7, S8, S10, S17: ruta propuesta `src-tauri/src/secrets.rs`, puente existente de secretos y sus tests/docs; ampliar lista cerrada y almacenamiento reutilizando invariantes, accessor `Result` exclusivo de email sin cambiar `get`, tests ausencia/fallo y regresión de proveedores; riesgo de seguridad (ítem 2: clave/almacenamiento), commit propio separado; ruta: inline; estado: completada; RED salida 101 por símbolos ausentes, GREEN focalizado y suite Rust 501 correctas/1 ignorada/1 smoke real excluido, fmt correcto; verificación independiente sin defectos; commit: `6e52038190c968a0cd46245742320708f033cc40`. Revisión nativa medium aprobada y autoridad consumida (`review-8093e274bce430a3`).
- **T2** — S1, S2, S4, S6, S8, S10, S13, S17, S19, S20: ruta propuesta envío Rust/Tauri concreto y tests/docs asociados; HTTP simulado, remitente/configuración, cuerpo mínimo, timeout y errores sanitizados, un intento sin cola/replay, guardias de credenciales y CSP; ruta: inline; estado: completada; RED salida 101 por contrato ausente; 7 tests HTTP/gates y suite Rust 508 correctas, fmt correcto. Corregido el retorno Result requerido por comandos async Tauri tras error de compilación observado. Commit: `54d0534dffcb1adeda522485b171b9356667efb2`; verificación independiente de la integración en T4. Evaluación nativa no evaluable por inventario untracked ajeno, sin reviewDue emitido; revisión nativa no iniciada para T2. Unidad coherente de 536 líneas con HTTP simulado, sin división artificial ni decisión de PR.
- **T3** — S5, S6, S8–S10, S12–S17, S19–S22: ruta propuesta `src/Settings.tsx`, configuración/i18n existentes y tests/docs asociados; configuración concreta, opt-in, estado y botón de prueba, conservación/eliminación de clave y advertencias de disponibilidad, privacidad, Linux y entrega; unidad de commit 3; ruta histórica inline, ruta futura a reevaluar tras inspección acotada; estado: S21/S22 corregidas e incorporadas en la cuarta unidad `a45f646` (L28); cierre T4 pendiente, sin amend nuevo. Auditoría: catálogos es/en completos y paridad (inventario salida 0) para la UI; hallazgo real en backend (texto de email hardcoded, corregido); feedback reproducido con RED y corregido con el patrón `eg-notice`. Estado histórico: GREEN. RED observado (módulo ausente y UI sin textos email), GREEN 17 tests focalizados, typecheck, npm test (incluye 298 Node) y build correctos. Configuración concreta dentro de Alertas, sin Integraciones. Commit: `faf99c40871a952467faeec178f75c47547ba4fa`. Inventario i18n regenerado en esta misma unidad. Evaluación nativa no evaluable por inventario untracked ajeno; sin reviewDue emitido. Verificación independiente final en T4.
- **T5** — S2, S3, S8–S11, S18–S20: ruta propuesta `src/lib/alerts.ts`, `src/Widget.tsx` y tests/docs asociados; conectar avisos automáticos con identidad y memoria existentes sin persistencia nueva, global/email independientes de nativo, deduplicación y fallos remotos sin afectar avisos locales; unidad de commit 4, posterior a T3; ruta actual: worker por context backstop; estado: corrección S19 completada y verificada por checks propios; pendiente aprobación final T4. RED nuevo observado: 2 fallos/10 correctos; GREEN25 focalizados,930Vitest+298Node,typecheck/build. realMeterId separado del fallback local; diferencial80 fixtures/720 llamadas sin diferencias salvo metadato. Evidencia histórica: RED 7 fallos por dispatch ausente; GREEN 25 tests focalizados, typecheck, npm test (925 Vitest + 298 Node) y build correctos. Comparación diferencial con base b82cf78: mismos eventos previos (salvo metadatos nuevos), memoria, textos, efectos y gating nativo en 6 fixtures + 4 combinaciones. Sin nueva memoria de eventos ni persistencia. Commit: cuarta unidad `feat(alerts): reuse detected events for automatic email`, candidato corregido materializado en `78a3174` (amend siguiente solo de inventario/evidencia, mismo source tree `73a26a5ed34fcac98ce3aa8dbdf411f4006a7d2d`); evidencia histórica previa en `6839083e8e4b7d75a0381b6364a1e67bd6e04fa6` sustituida para la corrección por L17–L20; evaluación nativa no evaluable por inventario untracked ajeno, sin reviewDue emitido.
- **T4** — S1–S22: verificación final funcional/de seguridad; ruta verificador independiente por riesgo ítem2 + spot-check parent; estado: parcial; owner ya acepta manual + HTTP simulado (L29/S23–S24). Evidencia manual macOS recibida y revisada (L42), ahora inventariada en [validación documental](../../docs/email-alerts-validation.md) (T8/L45); con confirmación humana de cerrar/reabrir y conservar/eliminar clave; sin aislamiento acreditado. Actualización L49: macOS y commit/comando históricos confirmados por el usuario, capturas T7 identificadas por contenido; no equivalen a hash del binario observado. Siguen sin acreditarse aislamiento y trazabilidad independiente del artefacto; Windows/Linux pendientes de validación por un compañero solicitada en la PR, con disposición final del owner. No exigir VM, infraestructura de simulación integrada ni tests montados como requisitos nuevos; límites históricos L38 preservados y contextualizados por L42. Evidencia automatizada S21/S22 propia en L28, T6 verificada en L34. El PASS L23 cubre solo el candidato previo S1–S20; no aprueba cambios futuros. Nueva ejecución autorizada L21, preparación compatible L22 y PASS backend/lógica/seguridad contrato soportado L23; candidato28573d8, mismos source trees tras amend documental. 42 focalizados,930Vitest+298Node,508Rust (1 ignorado/1 smoke real filtrado),typecheck/build/fmt/inventario; diferencial160fixtures/1440llamadas y sondas independientes. S19 ejecutada correctamente: id vacío/label alice_private -> usage, sin cambiar identidad/memoria local. S13/S15/S16 y visibilidad/layout S9/S12/S14/S20 conservan gap de interacción UI montada, no cubierto por SSR. Bloqueos previos L11/L18 son históricos, no se borra evidencia ni reutiliza T1. Sin defecto de producto bloqueante reproducido. Commit: evidencia incorporada por amend documental de cuarta unidad, sin quinto commit artificial.

- **T6** — S15, S23–S25: refuerzo de conservación de clave en guardado, fixture HTTP determinista y evidencia/checklist precisa; ruta: worker por context backstop; estado: completada y verificada en alcance automatizado (L33–L34); 41 frontend y 11 Rust focalizados independientes, 4 probes TS y 5 probes de ciclo de vida; sin bloqueadores. commit: quinta unidad local `test(email): strengthen save coverage and HTTP fixture lifecycle`, hija directa de `a45f646ca046d9ac86fd6bd29ba177085b15f566`, que contiene esta evidencia y el inventario generado (materialización registrada en Engram al terminar); conservar los cuatro publicados sin amend. Risk: item 4 (sincronización y cierre de hilos del fixture de tests, no concurrencia de producto); verificación independiente limitada a T6 después de checks propios.

- **T7** — S26: ruta inline, superficie `src/Settings.tsx`, catálogos es/en, tests SSR de email y documentación/inventario; estado: implementada y checks propios completos; integración en sexta unidad local autorizada L47/T9 (hash definitivo en Engram), sin reejecutar verificadores históricos. Sin cambiar reglas de envío, credenciales, CSP, dependencias ni helpers compartidos. RED observado: 3 fallos/3 correctos; GREEN focalizados36, suite937Vitest+298Node, typecheck/build/diff correctos (L41). Actualización L49: capturas visuales nuevas identificadas como `1.png` y `2.png` por contenido; no acreditan nuevos envíos ni identidad independiente del binario. T4/Windows no cerradas. Risk: none (solo ayuda localizada y visibilidad del aviso específico de email; helper OS compartido sin cambios).

- **T9** — S26–S27: integrar T7 y evidencia documental en un sexto commit local autorizado por L47, con los nueve archivos acordados y validación del inventario definitivo; ruta inline; estado: integrada en sexta unidad local con checks precommit L48 (hash definitivo y comprobación postcommit en Engram); commit: sexta unidad `feat(settings): clarify email setup and document manual evidence`, hija directa de `3efb171441b31efba68c5c184172d21ebc4ab9f3`; sin amend/push/PR ni cierre de T4. Hash definitivo y comprobación postcommit se registrarán en Engram sin amend autorreferencial.

- **T8** — S24, S27: [evidencia manual existente](../../docs/email-alerts-validation.md) preparada con fuentes, resultados observados/confirmados/no acreditados, checklist reconstruida y pendientes; ruta worker por context backstop (`mw89mnxd-2-mc0j`, corrección documental `mw89sy2u-3-3w1f`) + readback/spot-check parent; estado: completada en alcance documental (L45); checks de estructura, enlaces y diff exit0; commit: sexta unidad local autorizada L47/T9, junto a T7; restricción L43 levantada solo para este commit. Archivo ya incorporado con seguimiento en sexta unidad `7aeb329` mediante add -f limitado a su path, sin cambiar ignore (L47–L48). No reabre T7 ni ciclos históricos de verificación; T4 parcial.

Las rutas quedan autorizadas por L8 para esta implementación; ejecución inline de unidades dependientes, con verificación independiente de seguridad. Orden previsto: T1 → T2 → T3 → T5 → cierre T4; se conservan los IDs anteriores y T5 separa la conexión automática de la antigua T3. Cuatro commits de comportamiento: credenciales (T1), envío Resend (T2), configuración/prueba (T3) y avisos automáticos (T5). Mantener tests y documentación de cada comportamiento junto a su unidad; T1 conserva el commit de seguridad separado exigido por S7. Trabajar test-first y commitear cada unidad coherente en GREEN; no separar artificialmente tests y código. Commits pequeños no implican varias PR: decidir el alcance de entrega según el diff acumulado y la política del repositorio, sin presuponer una PR única ni encadenadas.
Pruebas futuras: RED observado antes del código, GREEN focalizado y preservación de comportamiento existente, después suites completas autorizadas. Cubrir repeticiones/nuevas ocurrencias y memoria existente, global/email/nativo, consentimiento/prueba/eliminación, ausencia frente a fallo del llavero, privacidad y fallos HTTP/timeout sin reintentar.
Usar datos sintéticos y HTTP simulado; no hay correo real ni ejecución de aplicación en esta preparación. Una prueba real de Resend requerirá consentimiento explícito posterior del titular de cuenta/remitente y destinatario autorizado; aceptación no garantiza entrega.
La superficie de credenciales exige planificar verificación independiente para la implementación; no se declara hecha ni se convierte esta preparación documental en una ceremonia de revisión de código. T4 aportará evidencia, no resultados anticipados.

## Log

**L1 — Petición original del usuario (literal).**
> reconcilia la documentacion en un nuevo documento, fijate que siempre usamod odd, no se si el documento odd es ahora o mas tarde

**L2 — Comentario aprobatorio del owner (literal, fuente A).**
> 1. **Canal: Resend para esta primera fase**, con la contrapartida declarada de posibles retrasos o filtrado del correo.
> 2. **Sin reintentos automáticos, sin cola ni replay.** Aprobada la restricción más estricta: un único intento por evento.
> 3. **Identidad del evento.** Reutiliza la que ya existe: proveedor, medidor, `windowKey(resetsAt)` (`src/lib/alerts.ts`) y tipo de evento (umbral o reinicio). El email debe tener exactamente la misma semántica de memoria que el aviso local de `detectAlerts`, sin añadir persistencia nueva.
> 4. **Clave ausente frente a fallo del llavero.** No cambies `secrets::get()`: la usan todos los proveedores y es un contrato compartido. Añade una función específica que devuelva `Result` y que use solo la integración de email.
> 5. **Almacenamiento en Linux.** No bloquea esta issue; esa duda pertenece a #106. Si el backend efectivo es keyutils, la clave puede no sobrevivir a un reinicio: documéntalo como limitación conocida, sin resolverlo aquí y sin fallback a texto plano.
> 6. **Remitente.** Lo introduce el usuario. En pruebas, el remitente de pruebas de Resend hacia el email de su propia cuenta; para otros destinatarios, dominio verificado. Quorb no trae ningún remitente fijo.

> Una petición para la PR: la nueva clave en la lista cerrada de `secrets.rs` y su almacenamiento tocan seguridad, así que llévalos en un commit propio para revisarlos por separado.

> Con esto puedes empezar por los tests.

**L3 — Reconciliación documental, sin modificar las fuentes históricas.** Se leyeron el [borrador de issue](../../docs/integraciones-email-resend-issue.md), la [propuesta](../../docs/integraciones-email-resend-propuesta.md) y el [ODD #214](214-orb-status-badge.md) como referencia de convención. No se inspeccionó ni verificó el comportamiento del código en esta tarea.

| Borrador histórico / punto superado | Alcance vigente |
| --- | --- |
| Resend recomendado, pendiente de elección | Resend aprobado para primera fase (S1); diferir otros canales y framework (S14). |
| Omisión total de reintentos pendiente de aprobación | Un único intento, sin reintentos automáticos, cola ni replay (S2). |
| UUID opaco por ocurrencia y registro backend con retención nueva | Identidad existente proveedor/medidor/ventana/tipo y misma memoria de `detectAlerts`, sin persistencia nueva (S3); no trasladar aquel registro como requisito. |
| Resolver fallo de lectura mediante contrato compartido | Preservar `secrets::get()`; función `Result` exclusiva de email (S4). |
| Confirmación del almacenamiento Linux como condición previa | No bloquea #245; limitación keyutils documentada, resolución en #106, nunca texto plano (S5). |
| Ejemplo de dirección de pruebas susceptible de fijarse en Quorb | Remitente introducido por usuario; pruebas al email propio y dominio verificado para otros, sin remitente fijo (S6). |
| Borradores dicen «no aprobado» / próximo paso publicar propuesta | Alcance aprobado según comentario A y estado previo aportado; esta tarea solo prepara ODD, no implementa, publica ni crea rama. |

**L4 — Evidencia de esta preparación.** Validación estructural de S1–S20/T1–T4 y enlaces locales correcta; `git diff --check` correcto. No se ejecutaron tests, aplicación ni envíos: solo documentación. La evaluación nativa no pudo identificar el candidato por archivos sin seguimiento; no produjo un riesgo evaluable ni una aprobación de revisión. La creación y reconciliación de este documento está completada; las tareas de implementación describen trabajo futuro fuera del alcance de esta petición documental.

**L5 — Retomar.** Usar este archivo como referencia canónica local y el comentario A como autoridad remota; los dos documentos anteriores son borradores históricos, no instrucciones operativas. Antes de implementar, revalidar estado/asignación y acordar superficies, rama, comandos focalizados y entrega `ask-on-risk`; empezar T1 por RED. No presuponer cambios de fuente autorizados por este turno ni tareas terminadas; mantener la separación de seguridad y añadir evidencia real al avanzar.

**L6 — Revisión de unidades solicitada por el usuario (literal).**
> si lees la issue se remarca "Una petición para la PR: la nueva clave en la lista cerrada de secrets.rs y su almacenamiento tocan seguridad, así que llévalos en un commit propio para revisarlos por separado." creo que hacer commits más pequeños para que las revisiones sean más faciles sería interesante. no?

**L7 — Aceptación y cierre de preparación (literal).**
> perfecto doucmentalo y lo iniciaremos en una nueva sesion asi, que dame el prompt para continuar

Se divide la antigua T3 entre configuración/prueba (T3) y avisos automáticos (T5); T4 conserva su identidad de verificación final. Quedan cuatro unidades de commit con tests/docs asociados, más cierre sin commit artificial. Este turno documenta y entrega continuidad; por petición explícita del usuario, la implementación empezará en otra sesión. No hay rama de implementación creada por esta preparación, tests ejecutados ni commits de implementación.

**L8 — Inicio de implementación (petición actual literal).**
> Vamos a implementar la issue #245 de Quorb siguiendo ODD:
> https://github.com/egdev6/quorb/issues/245
>
> La referencia local vigente es:
> odd/tasks/245-email-alerts.md
>
> Recupera su contexto de Engram (topic odd/245-email-alerts/tasks), lee el documento completo y reconcilia el estado antes de escribir código. Los documentos de docs/ son antecedentes, no el alcance vigente.
>
> Autorizo consultar la issue y sus comentarios en github.com/egdev6/quorb con la cuenta ludevdot, sin cambiar de identidad. Revalida aprobación, asignación y posibles cambios del owner.
>
> Esta petición autoriza iniciar la implementación del alcance aprobado. Inspecciona primero rama, worktree y cambios existentes; preserva los cambios ajenos. Sigue ODD, actualiza el documento, su espejo y las tareas visibles. Empieza T1 con tests en RED.
>
> Trabaja en cuatro commits pequeños y coherentes:
> 1. T1: nueva clave y almacenamiento, lector Result exclusivo de email, sin modificar secrets::get(). Commit de seguridad separado, como exige el owner.
> 2. T2: envío Rust mediante Resend, errores y tests HTTP simulados.
> 3. T3: configuración concreta en Ajustes, consentimiento, estado y botón de prueba.
> 4. T5: conexión a los avisos automáticos existentes, con pruebas de identidad, memoria y regresión.
> Después, T4: verificación final funcional y de seguridad.
>
> Cada commit debe incluir sus tests y documentación, con checks en verde. No confundas commits pequeños con una decisión de crear varias PR.
>
> Respeta las decisiones del owner: Resend, un intento por evento, sin reintentos automáticos/cola/replay, misma identidad y memoria de detectAlerts sin persistencia nueva, remitente introducido por el usuario y Linux #106 fuera de esta implementación. Sin nueva sección Integraciones ni capa genérica.
>
> No hagas envíos reales, push ni crees PR sin autorización adicional. Respeta los consentimientos de revisión y seguridad que correspondan.

**L9 — Reconciliación de inicio.** GitHub consultado con la identidad activa `ludevdot`, sin cambiarla: OPEN, `status:approved`, asignación única; solo comentario aprobatorio del owner. Archivo y espejo coinciden, sin trabajo previo de implementación. Rama creada desde `b82cf78`; borradores docs con intent-to-add, auditorías y pnpm-lock preexistentes se preservan y se excluyen de commits. Cinco tareas, cuatro commits autorizados, sin decisión de PR. T1 seguridad (ítem 2), RED primero. RDD on; consentimientos no implícitos. Checks de Rust se ejecutarán sin correos reales y evitando smokes de llavero del usuario.

**L10 — Evidencia observada de implementación.** T1 RED salida 101 por símbolos ausentes; GREEN final 501 Rust, 1 ignorado y 1 smoke Keychain excluido; fmt correcto. Verificador T1 probó la API pública con almacén sintético aislado, sin defectos reproducidos. Se incorporó regresión pública subprocess-isolated. Revisión nativa T1 `review-8093e274bce430a3` medium, cuatro lentes aprobadas, acknowledgement completado y autoridad consumida; no autoriza entrega. T2 RED salida 101 por contrato ausente; primer GREEN falló compilando por el requisito Result de Tauri async, corregido y GREEN 7 tests HTTP/gates y 508 Rust, fmt correcto. T3 RED por módulo ausente/copia UI; GREEN 17 tests focalizados, 918 Vitest + 298 Node, typecheck/build correctos. T5 RED 7 tests por dispatch ausente; GREEN 25 focalizados, 925 Vitest + 298 Node, typecheck/build correctos. Comparación diferencial local con base b82cf78: mismo comportamiento previo del detector, memoria, texto y efectos en 6 fixtures y 4 combinaciones de avisos nativos. Ningún envío real. Inventario i18n regenerado según política, dentro de T3 y T5 mediante amend propio. Cuatro commits, no push/PR. Advertencias existentes de compilación Rust y warning de fixture Python ZIP duplicado no impidieron checks. El smoke real del llavero y comprobación visual/montada en navegador no se ejecutaron.

**L11 — Parada acotada T4: Needs your decision.** El único verificador final intentó preparar `/tmp/quorb-t4-WO3A7x`; su comando Python falló con salida 1 al ejecutar `cp -cR`: `cp: invalid option -- 'c'`. El entorno usa GNU cp, no el cp macOS esperado. No preparó candidato/base ni ejecutó tests, builds, HTTP o pruebas funcionales; no hay aprobación independiente final. Por protocolo no se relanza, repara ni sustituye este verificador en el mismo intento. Las pruebas GREEN del parent siguen siendo evidencia propia, no independiente. Se necesita entorno de verificación independiente operativo y evidencia del mantenedor antes de cerrar T4. No se ha borrado el scratch del verificador fuera del proyecto.

El verificador dejó una preocupación sin ejecutar (no un fallo reproducido): `meterId` usa `m.id || m.label`, y dispatch acepta cualquier valor con forma `[a-z0-9_]`; una etiqueta legacy configurable como `alice_private` puede pasar como identificador y exportarse. Pendiente reproducir este caso S19 y corregirlo con regresión sin cambiar la identidad/memoria local. La documentación describe la intención de no exportar etiquetas; no se declara cumplida ante esta frontera pendiente. No se hicieron correcciones ni nuevas verificaciones después del bloqueo de infraestructura. Las evaluaciones nativas T2/T3/T5 fallaron por declaración de untracked ajenos incluso con rango committed-only; no devolvieron reviewDue ni se declara revisión/aprobación de estas unidades. Esta limitación no sustituye la verificación independiente requerida. Rama y cambios ajenos preservados.

**L12 — Handoff solicitado por el usuario (literal).**
> prepara un handoff para la siguiente sesion y dame el prompt para iniciarla

Esta petición solo autoriza documentar el relevo; no corrige código, no relanza T4 ni concede consentimiento nativo. Se detiene el trabajo por esta petición explícita. El prompt propuesto para la siguiente sesión podrá conceder autorización nueva si el usuario lo envía; este registro histórico por sí solo no la concede.

### Handoff operativo

- **Referencia canónica:** este documento completo y su espejo Engram `odd/245-email-alerts/tasks` (observación 6953). `docs/integraciones-email-resend-{issue,propuesta}.md` son antecedentes, no alcance vigente. `docs/email-alerts.md` describe la implementación/intención, pero L11 deja abierta su frontera de privacidad.
- **Git revalidado al preparar el relevo:** rama `feat/245-email-alerts`, base `b82cf78a7eea996018065c501c72da3015538ebc`, HEAD `67678ed`. Cuatro commits: T1 `6e52038`, T2 `54d0534`, T3 `faf99c4`, T5 `67678ed`. El código final comprobado antes de añadir evidencia documental correspondía a `6839083`; el amend posterior solo cambió el ODD. No hay push ni PR.
- **Preservar estado ajeno:** dos borradores `docs/integraciones-email-resend-issue.md` y `docs/integraciones-email-resend-propuesta.md` con intent-to-add; sin seguimiento `AUDITORIA-QUORB.md`, `AUDITORIA-QUORB-2.md`. El `pnpm-lock.yaml` propio del usuario se retiró después por autorización L13, conservando backup verificado en `.git/npm-reconcile.jnwMcJ/pnpm-lock.yaml`. El handoff L12 queda como cambio documental local deliberado, fuera de los cuatro commits existentes, hasta que la siguiente sesión lo reconcilie. No usar add-all, restore, reset ni clean.
- **Recuperación:** `mem_context` → búsqueda por proyecto/topic → lectura completa de observación 6953 → lectura completa de este archivo; reconciliar ambos con rama/worktree/diff antes de escribir. Reconstruir las tareas visibles; T4 sigue bloqueada, no completada.
- **Siguiente corrección propuesta, aún no ejecutada:** reproducir con test RED `id: ''`, `label: 'alice_private'`. El payload debe llevar `meter: 'usage'`, sin etiqueta configurable ni identidad personal. Separar el ID real exportable de la clave/fallback local sin cambiar las decisiones, identidad ni memoria de `detectAlerts`. Verificar además ID real válido, etiquetas legacy con otros formatos y regresión del aviso local. Reabrir T5/S19 cuando se reproduzca el problema; no declarar RED retrospectivo.
- **Verificación pendiente:** el intento independiente T4 anterior falló preparando copia con `cp -cR` bajo GNU cp; ningún test independiente final ejecutado. No relanzar automáticamente por recuperar memoria. Con autorización nueva explícita, preparar una copia aislada portable (sin flags exclusivos de macOS, sin modificar el harness global) y ejecutar la nueva verificación independiente con datos sintéticos/HTTP simulado. No usar credenciales ni correos reales. El verificador debe devolver resultado por S1–S20. Resolver explícitamente la prueba montada/visual de Ajustes pendiente, sin inventar evidencia ni instalar herramientas fuera del alcance.
- **Checks propios que deben volver a corresponder al candidato corregido:** tests focalizados email/alerts/Settings; `npm test`; `npm run typecheck`; `npm run build`; desde `src-tauri`, `cargo test --lib -- --skip keychain_set_get_delete_roundtrip` y `cargo fmt --all -- --check`. Comprobar inventario con `node scripts/i18n-inventory.mjs --check`; si cambian árboles de fuente, regenerarlo según política del repositorio. Conservar test-first y actualizar documento/espejo/todo en cada transición.
- **Historial de revisión:** T1 aprobada y acknowledgement consumido, no reutilizar autoridad. T2/T3/T5 no tienen aprobación nativa; assess falló por inventario untracked ajeno, sin reviewDue. No ocultar ni retirar archivos ajenos para forzar evaluación; respetar el switch RDD y los consentimientos vigentes. Una corrección requiere evaluar su candidato actual, no heredar aprobación anterior.
- **Entrega:** mantener cuatro unidades coherentes, incorporar corrección y evidencia a la cuarta mediante amend propio solo si lo autoriza la nueva petición y se ha comprobado que sigue local/sin trabajo ajeno superpuesto. Mantener T1 separado. No convertirlo en varias PR ni publicar nada por inferencia. No declarar finalizada #245 hasta resolver S19 y T4.

**L13 — Reconciliación del gestor de paquetes (usuario, literal).**
> obviemos @pnpm-lock.yaml ya que el owner usa @package-lock.json yo lo hice por seguridad, me gusta mas pero para el desarrollo revirtamos eso e hagamos npm i para ver si siguen los fallos

Se adopta npm/package-lock.json para desarrollo. Tras confirmar que `pnpm-lock.yaml` era untracked y propio del usuario, se copió a `.git/npm-reconcile.jnwMcJ/pnpm-lock.yaml`, se verificó igualdad con `cmp` y se retiró únicamente ese archivo del worktree. `npm i` terminó con salida 0: 88 paquetes añadidos, 16 cambiados, auditoría de 105 paquetes y 2 vulnerabilidades moderadas notificadas. No se ejecutó `npm audit fix --force`. `package.json` y `package-lock.json` permanecen sin cambios. Comprobaciones completadas con salida 0: `npm ls` confirma `@tauri-apps/plugin-notification` 2.5.1; `tauri info` confirma Rust y JS ambos 2.5.1; `npm run typecheck` correcto. El desajuste de notificaciones queda resuelto en la instalación local sin modificar los manifiestos/lock canónicos. En estos comandos npm directos no aparecieron los avisos de configuración de la salida previa; no se comprobó el arranque anidado. `tauri info` señala Xcode completo ausente (Command Line Tools instalado), versiones más recientes disponibles y algunos wrappers JS no instalados; no se han instalado/actualizado ni se declaran bloqueos funcionales nuevos por esos diagnósticos. Los warnings Rust no se han corregido ni se ha ejecutado de nuevo `app:dev`; aplicación no arrancada para no causar envíos reales. Esto no relanza ni resuelve T4.

**L14 — Arranque aportado por el usuario y añadido al handoff.** El usuario ejecutó `npm run app:dev` tras L13 y pidió «y añadelo al handoff». Evidencia aportada por el usuario, no ejecución del agente: Vite 7.3.7 listo en 159 ms en `http://localhost:1430/`; Rust finalizó la compilación dev y lanzó el binario:

```text
warning: `quorb` (lib) generated 13 warnings (run `cargo fix --lib -p quorb` to apply 4 suggestions)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.53s
     Running `target/debug/quorb`
```

En esta salida ya no aparecen ni los avisos de configuración npm ni el error de versiones de `tauri-plugin-notification`. Se confirma el arranque hasta el lanzamiento del proceso, no una validación visual/funcional de Ajustes ni de envíos. No se dispone de código de salida final de la aplicación, que sigue en ejecución en la captura; no se infiere entrega de correos ni se afirma ausencia de actividad de red.

Persisten los **13 warnings Rust** siguientes; los archivos señalados no cambian entre la base `b82cf78` y los cuatro commits de #245, según comparación previa. Son antecedentes respecto a este diff, no defectos introducidos por él:

| Aviso | Ubicación en la salida |
| --- | --- |
| Import `std::path::Path` sin usar | `src-tauri/src/providers/claude.rs:16` |
| Import `std::path::Path` sin usar | `src-tauri/src/providers/gemini.rs:19` |
| Imports `SETTLE`, `rooted_origin`, `to_physical` sin usar | `src-tauri/src/detail_placement.rs:41` |
| `mut` innecesario en `child` | `src-tauri/src/cli_process.rs:70` |
| Función `split_login_command` sin usar | `src-tauri/src/login.rs:399` |
| Variantes `Paths`, `Credentials`, `Files` no construidas | `src-tauri/src/uninstall.rs:12` |
| Struct `Plan` no construida | `src-tauri/src/uninstall.rs:27` |
| Métodos `Plan::new`, `Plan::preflight` sin usar | `src-tauri/src/uninstall.rs:31` |
| Función `is_link` sin usar | `src-tauri/src/uninstall.rs:84` |
| Función `purge` sin usar | `src-tauri/src/uninstall.rs:96` |
| Función `owned_target` sin usar | `src-tauri/src/uninstall.rs:110` |
| Función `with_display_backend` sin usar | `src-tauri/src/wm_compat.rs:303` |
| Constante `SCRIPT_READ_PID` sin usar | `src-tauri/src/wsl/process.rs:98` |

No se ejecutó `cargo fix`, no se ocultaron avisos ni se autoriza una limpieza multi-plataforma por añadir esta evidencia. Su eventual corrección requiere revisar los `cfg` y usos por plataforma, evitando mezclar cambios ajenos en #245. **Estado de relevo vigente:** usar npm; incompatibilidad local de notificaciones resuelta; arranque aportado por el usuario alcanza `target/debug/quorb`; warnings Rust pendientes sin bloquear esa compilación. La preocupación de privacidad S19 y el bloqueo de verificación independiente T4 continúan abiertos, sin relanzamiento autorizado por esta petición documental.

**L15 — Reanudación y autorización actual (usuario, literal).**
> Retomemos la implementación ODD de Quorb #245: https://github.com/egdev6/quorb/issues/245
>
> La referencia local vigente es odd/tasks/245-email-alerts.md, incluido el handoff L12.
>
> Lee también L13 y L14, que actualizan el estado del entorno:
>
> - Usa npm y package-lock.json, como el owner; no uses pnpm para esta tarea.
> - El pnpm-lock.yaml local se retiró con autorización del usuario y se conserva una copia verificada en .git/npm-reconcile.jnwMcJ/pnpm-lock.yaml.
> - npm i terminó correctamente sin modificar package.json ni package-lock.json.
> - El desajuste del plugin de notificaciones está resuelto: Rust y JS usan 2.5.1.
> - El usuario ejecutó npm run app:dev: la compilación terminó y se lanzó target/debug/quorb. Ya no aparecen los warnings de configuración npm ni el error de versiones del plugin.
> - Persisten 13 warnings Rust, inventariados en L14, en archivos no modificados por los cuatro commits de #245. No ejecutes cargo fix ni amplíes esta tarea para limpiarlos.
> - npm notificó dos vulnerabilidades moderadas; no se ha ejecutado audit fix.
> - El arranque no equivale a validación funcional de Ajustes/email. La corrección de privacidad S19 y la verificación independiente T4 siguen pendientes.
> - El ODD contiene cambios documentales locales de handoff aún sin commit; reconcilia y preserva esas notas.
>
> Recupera primero Engram: mem_context, búsqueda del topic odd/245-email-alerts/tasks y lectura completa de su observación. Lee también el documento local completo y reconcilia ambos antes de escribir.
> Los borradores de docs/ son antecedentes, no el alcance vigente.
>
> Autorizo consultar la issue y sus comentarios en github.com/egdev6/quorb con la cuenta ludevdot, sin cambiar de identidad. Revalida aprobación, asignación y posibles cambios del owner.
>
> Inspecciona primero rama, worktree, commits y cambios existentes.
> El estado esperado es feat/245-email-alerts, HEAD 67678ed, con cuatro commits:
> - T1: 6e52038 — credenciales, separado por seguridad.
> - T2: 54d0534 — envío Rust mediante Resend.
> - T3: faf99c4 — configuración, consentimiento y prueba en Ajustes.
> - T5: 67678ed — conexión automática y evidencia del bloqueo T4.
>
> Hay un handoff documental local sin commit. Preserva los cambios ajenos enumerados en él; no uses add-all, restore, reset ni clean.
>
> Autorizo reproducir y corregir la preocupación de privacidad S19: un medidor legacy con id vacío y label "alice_private" podría exportar esa etiqueta como medidor. Empieza por un test RED observado. El email debe usar un identificador neutro como "usage", sin exportar etiquetas configurables.
> Distingue el ID real del fallback local sin cambiar las decisiones, identidad ni memoria de detectAlerts. Reabre T5 según la evidencia.
>
> T4 sigue bloqueada: el verificador anterior falló preparando el aislamiento porque GNU cp no admite "cp -cR"; no ejecutó pruebas ni emitió aprobación.
> Esta petición autoriza una nueva ejecución independiente de T4, después de la corrección, con preparación portable y estado aislado, sin modificar el harness global. No reutilices la aprobación de T1 para otro candidato.
> Resuelve también la evidencia funcional montada/visual de Ajustes pendiente; no inventes validaciones ni instales nuevas dependencias sin consultar.
>
> Ejecuta los checks aplicables sobre el candidato corregido, actualiza documento, espejo de Engram y tareas visibles. Mantén cuatro commits: autorizo incorporar la corrección y evidencia a la cuarta unidad mediante amend propio, tras comprobar que sigue local y sin trabajo ajeno superpuesto.
> Mantén intacta la separación del commit de seguridad T1.
>
> Respeta el alcance del owner: Resend, un intento por evento, sin reintentos automáticos/cola/replay, misma identidad y memoria de detectAlerts sin nueva persistencia, secrets::get() intacto, remitente introducido por el usuario, Linux #106 fuera de esta implementación, sin Integraciones ni capa genérica.
>
> No hagas envíos reales, push ni crees PR. Respeta el switch RDD y todos los consentimientos nativos y de seguridad. No declares completada la issue hasta resolver la frontera de privacidad y la verificación final T4

**L16 — Reconciliación actual.** Archivo y espejo 6953 coinciden salvo newline final; L12–L14 preservados. Git confirma HEAD `67678ede9a5225c867696ec6dc82dfc2c931e689`, cuatro commits y ningún cambio fuente superpuesto; índice sin cambios staged. Ramas remotas consultadas sin publicar: no existe `feat/245-email-alerts` en origin/upstream. GitHub con `ludevdot`: OPEN, `status:approved`, única asignación `ludevdot`, único comentario del owner sin novedades. Se conserva npm y backup de pnpm; sin cargo fix/audit fix. RDD on. T5 reabierta por autorización L15; ruta worker por context backstop, superficie estrecha de alerts/email/tests/docs. T4 pendiente después, un nuevo intento independiente autorizado, preparación portable; no hereda T1. Riesgo ítem 2: frontera de privacidad hacia tercero. Sin envíos reales ni publicación.

**L17 — Corrección S19 observada y checks propios.** Worker T5 reprodujo antes de implementar: vitest email-dispatch salió 1, 2 fallos/10 correctos, `alice_private` y `session` exportados en lugar de `usage`. Separó `realMeterId: m.id` de `meterId: meterKey(m)` sin modificar identidad/memoria local; email solo usa ID real válido o `usage`. Cinco casos de etiquetas, umbral/reset, memoria/texto y repetición verificados. GREEN25 focalizados;930Vitest+298Node,typecheck/build; warning ZIP sintético existente. Diferencial portable con HEAD67678ed:80fixtures/720llamadas, mismos eventos salvo nuevo metadato, memoria,texto,efectos,stdout/stderr/salida. Parent repitió focalizados:25 correctos, salida0. El inventario lee commits; requiere regenerar tras amend. Assess con escalado ítem2 exige independiente; nativeRisk unassessable por untracked ajenos, no reviewDue ni aprobación. No se eliminan archivos para forzarlo. Capacidades UI locales: sin playwright/puppeteer/@playwright/test/jsdom/happy-dom, sin playwright Python ni navegador Chromium en PATH; tests existentes SSR no equivalen a montado/visual. No se instalaron dependencias. T4 debe reportar límites explícitos.

**L18 — Nuevo bloqueo independiente T4 (autorización L15 consumida por este intento).** Verificador `mw6q956y-3-2ojr` preparó candidato con Python `shutil.copytree`, copia separada de npm, base mediante `git archive b82cf78...` y extracción `tarfile.extractall(..., filter='data')`. Scratch creado: `/tmp/quorb-t4-current-Vd3TJr`. Salida1: `TypeError: extractall() got an unexpected keyword argument 'filter'`. Falló preparando base, antes de cualquier prueba/build/HTTP/keyring independiente; logs scratch vacíos. No reparar/reintentar/reemplazar este intento, no tocar harness global ni limpiar scratch ajeno fuera del proyecto. Fingerprint read-only de archivos tracked candidato/copia idéntico: `7bc260b2ae476cc81db98f7868208273c66ae568c5cc93467114134a759f9523`; estado Git antes/después idéntico. S4/S5/S7/S9/S10/S14/S20 tienen apoyo estático, no reemplaza pruebas funcionales. S1–S20 sin aprobación funcional/de seguridad global; S19 estructuralmente corregida, no ejecutada independientemente. Tests focalizados email/alerts/Settings, npm test/typecheck/build, cargo test/fmt, HTTP/gates/keyring sintéticos, diferencial independiente y UI montada/visual NO ejecutados por este verificador. No hay defecto de código reproducido nuevo. La copia candidata llegó a completarse; la base no. No se reutiliza aprobación T1.

**L19 — Checks propios y disposición de entrega local.** Parent Rust: `cargo test --lib -- --skip keychain_set_get_delete_roundtrip` salida0,508 correctos/1 ignorado/1 filtrado; `cargo fmt --all -- --check` salida0. Sin cargo fix, cambios de warnings o llavero real. Worker frontend GREEN y diferencial L17 se mantienen como evidencia propia, NO independiente. Se corregió whitespace de formato en la cita L15 para `git diff --check`, sin cambiar sus palabras ni las notas L12–L14. La evaluación nativa actual no pudo identificar candidato por untracked ajenos; sin reviewDue ni aprobación nueva, no se inicia otra lineage por inferencia. RDD sigue on, T1 consumida se conserva. Cuarta unidad incorporará por amend propio exclusivamente corrección/tests/docs y handoff; rama remota ausente en origin/upstream al consultar y sin fuentes ajenas superpuestas. Inventario anclado se regenerará después de materializar el source tree. No push/PR/envíos reales. **Needs your decision:** proporcionar un entorno independiente con extracción compatible y autorizar nuevo intento (el actual queda detenido), y aportar prueba montada/visual aislada de Ajustes o autorizar una herramienta concreta sin instalar implícitamente. No declarar finalizada #245.

**L20 — Incorporación local e inventario.** Amend propio autorizado: cuarta unidad materializada como `78a3174`, manteniendo padres T1 `6e52038`, T2 `54d0534`, T3 `faf99c4`; exactamente cuatro commits desde base. Stage limitado a alerts/email/regresión/docs/ODD, sin cambios ajenos. Inventario regenerado automáticamente y comprobado con salida0 después de materializar fuentes: solo cambió ancla `src/` a `73a26a5ed34fcac98ce3aa8dbdf411f4006a7d2d`; Rust sigue `8193bd5f2a1df72686643c2c868e524adf92e301`. Se incorpora inventario/evidencia por amend documental de la misma cuarta unidad, sin cambiar el código comprobado ni T1. T5 corrección y checks propios completos; T4 continúa bloqueada por L18 y ausencia de prueba montada/visual. No aprobación final ni cierre de issue, no pruebas reales ni publicación. Los borradores intent-to-add y auditorías permanecen intactos.

**L21 — Autorización nueva del usuario (literal).**
> vamos a desbloquear, emppezamos con :Un entorno de preparación compatible y autorización explícita para otro intento independiente de T4

**L22 — Preparación comprobada antes del nuevo verificador.** Git revalidado: `feat/245-email-alerts`, HEAD `28573d8c8dcfbac13cbe8b52ea83313af7239cd2`, fuentes sin modificaciones e índice limpio; solo borradores/auditorías ajenos preservados. Engram6953 y documento coinciden salvo newline final. Runtime real: Python3.9.6 y `/usr/bin/tar` bsdtar3.5.3. Preflight parent salida0 en `.git/t4-portable.lEMc82`: `git archive --format=tar <HEAD/base> | /usr/bin/tar -xf - -C <dest>` para candidato y base; cmp de alerts/email idénticos; copia npm con `shutil.copytree(..., symlinks=True)` y resolución local Vitest/TypeScript correcta. Sin `cp -cR`, sin `tarfile.extractall`, sin dependencias instaladas ni harness cambiado. 131GiB libres. Artefacto parent excluido en .git, conservado como evidencia; no contiene configuración ni credenciales del usuario. Verificador nuevo usará scratch propio runtime, candidato comprometido28573d8, target Rust aislado y cargo offline/locked con caché de dependencias existente. Inventario --check requiere Git: comprobar en checkout real o con --ref explícito en repositorio original; no inferir Git dentro de archivo tar. Ruta verificador independiente por riesgo ítem2; la UI montada/visual continúa fuera de esta subdecisión y no se declara cubierta por SSR. Sin envíos reales, push/PR, instalaciones o limpieza de warnings.

**L23 — T4 independiente ejecutada con preparación compatible.** Nuevo verificador `mw6r3cc2-5-pd8w`, autorizado por L21, preparó candidato/base con git archive y tar nativo; npm copiado separadamente, HOME/TMPDIR/cache aislados y target Rust propio, cargo `--offline --locked` con cache existente. Candidato inmutable `28573d8c8dcfbac13cbe8b52ea83313af7239cd2`; source trees `src=73a26a5ed34fcac98ce3aa8dbdf411f4006a7d2d`, Rust `8193bd5f2a1df72686643c2c868e524adf92e301`; base b82cf78. Estado Git antes/después idéntico, sin modificaciones fuente del checkout. Scratch `/tmp/quorb-t4-independent.iQyAE7`, conservado, logs focused/npm-test/typecheck/build/cargo-test/cargo-fmt/i18n/independent-vitest/independent-rust*/differential. No se autoriza limpieza de scratch fuera del proyecto por inferencia.

Resultado independiente: **PASS backend/lógica/seguridad para contrato soportado**, no aprobación montada/visual ni cierre de #245. Salidas0: focalizados email/email-dispatch/alerts/Settings SSR 42/42; npm test 930Vitest+298Node; typecheck; build122módulos; cargo test508 correctos/1 ignorado/1 filtrado; fmt; inventario `--ref 28573d8... --check` ejecutado read-only desde checkout real, no desde archive sin Git. Sondas derivadas independientes:3tests TS correctos, sonda Rust pública de fronteras/HTTP correcta; diferencial160fixtures/1440llamadas base/candidato sin diferencias salvo metadatos añadidos. Parent repitió42 focalizados: salida0, fuentes siguen idénticas. Sin instalación, app launch, email real o llavero real.

Evidencia S#: S1/S2/S6/S10/S17/S19/S20 HTTP/DTO/llavero sintético/proyección mínimos; S3/S11/S18 memoria, eventos, gates y regresión diferencial; S4 accessor Result y `secrets::get()` byte-idéntico a base; S5 limitación Linux documentada, persistencia Linux real fuera de alcance; S7 separación Git; S8 RED histórico L10/L17 y GREEN nuevo observado; S9/S12/S14/S15/S16/S13 SSR/estático/lógica/backend según corresponda. S19: `alice_private` con ID vacío sale como `usage`, IDs reales válidos hasta64 conservados;65/mayúsculas/Unicode/colon/newline neutralizados; etiqueta/cuenta no salen, memoria/texto locales preservados. Fallo consumido no reintenta, reset y nuevo cruce elegibles. HTTP201/204/307/308/400/408/503 capturan una solicitud y estado sanitizado, clave ausente/blanca/vacía -> KeyMissing, DTO rechazado antes de acceso a secreto, configuración permanece byte-idéntica. CSP, Cargo manifiesto/lock y get() sin cambios respecto a base.

Incidencias conservadas, no ocultadas: wrapper focalizado inicial falló antes de ejecutar por `/` en nombre log; comando posterior salió0. Primera sonda HTTP adicional salió101 (AcceptanceUnknown en lugar de RequestRejected), fixture con350ms de vida antes de primera petición; diagnóstico posterior pasó, y fixture ajustada para iniciar plazo tras primera solicitud pasó todos los casos. No se estableció fallo producto; sonda auxiliar corregida solo en scratch, no se modificó implementación. Warnings Rust/ZIP existentes permanecen. Advisory no bloqueante: saltarse tipos con id undefined/null/número provoca coerción regex y no fallback usage; Rust Meter.id:String siempre se serializa y no se identificó ruta de usuario soportada. No ampliar alcance por hipótesis fuera de contrato. Sondas extra quedan en scratch, no se incorporan como cambios de producto opcionales ni se instala infraestructura.

**L24 — Frontera restante y entrega documental.** Bloqueo de preparación independiente resuelto. T4 ahora espera solo evidencia funcional montada/visual aislada de Ajustes (interacciones guardar/consentimiento/prueba/estado/eliminar y layout/visibilidad); SSR no la sustituye. Esta petición eligió empezar por entorno/T4, no autorizó dependencias ni correos reales. No declarar issue completada. Evidencia incorporada mediante amend documental propio de la cuarta unidad, manteniendo4 commits, T1/T2/T3 y ambos source trees intactos. RDD sigue on; evidencia independiente no es aprobación nativa ni reutiliza autoridad T1. Evaluación nativa previa unassessable por untracked ajenos, sin reviewDue; no se infiere nueva lineage. Se preservan borradores/auditorías y notas anteriores. Próxima decisión concreta: elegir prueba montada/visual aislada, manual con evidencia o herramienta previamente acordada.

**L25 — Petición actual del usuario, trabajo diferido (literal).**
> perfecto ahora si, funciona, al no tener dominio me faltaba eso. añade para la siguiente sesión dos cosas. 1. todo lo que hicimos necesita traducciones, no se si se añadió todos los idiomas o si los textos estan "hardcoded" y por otro lado en en "Alertas" deberñia salir una notificacion de que el envio de prueba ha sido exitoso o fallido.

**L26 — Handoff para próxima sesión.** Este turno solo documenta y guarda continuidad, por petición expresa «añade para la siguiente sesión dos cosas». No implementa, no ejecuta nuevos envíos ni instala herramientas. HEAD `0be370e`, cuatro commits intactos; estas notas quedan locales sin commit. T3 reabierta y pendiente para la próxima sesión; T4 sigue sin cierre global.

**L27 — Petición actual del usuario (literal).**
> Retomemos Quorb #245 siguiendo ODD: https://github.com/egdev6/quorb/issues/245
>
> La referencia canónica es odd/tasks/245-email-alerts.md. Lee el documento completo, especialmente L21–L26 y los nuevos requisitos S21/S22.
>
> Recupera primero Engram: 1. mem_context. 2. Búsqueda del topic odd/245-email-alerts/tasks. 3. Lectura completa de la observación 6953. 4. Lectura del documento local y reconciliación de ambos antes de escribir.
>
> Estado esperado: rama feat/245-email-alerts; HEAD 0be370ee2bbd4b9a62cf9739397b64632ec2ceb7; cuatro commits: T1: 6e52038, seguridad y credenciales; T2: 54d0534, envío Rust mediante Resend; T3: faf99c4, configuración y prueba en Ajustes; T5: 0be370e, conexión automática, corrección S19 y evidencia. El ODD tiene notas locales sin commit, S21/S22 y L25/L26. Presérvalas. Usa npm y package-lock.json, no pnpm. Inspecciona rama, worktree, índice y cambios existentes antes de modificar nada. No uses add-all, restore, reset ni clean.
>
> Autoridad remota: autorizo consultar #245 y sus comentarios con la cuenta ludevdot, sin cambiar de identidad. Revalida aprobación, asignación y novedades del owner, especialmente su respuesta a la consulta sobre validación manual aislada en macOS frente a automatización montada. El usuario confirmó que publicó esa consulta; no presupongas que el owner la aceptó.
>
> Trabajo autorizado en esta sesión, T3 reabierta: 1. S21: auditar todos los textos incorporados por #245 en los idiomas realmente soportados. Detectar textos hardcoded, claves ausentes y traducciones incompletas; corregir según las convenciones existentes. No añadir idiomas nuevos por inferencia. 2. S22/S13/S20: reproducir el feedback del botón «Enviar prueba» en Alertas. Debe aparecer una notificación visible de aceptación o fallo. Si falta o falla, observa RED antes de corregir. Usa el patrón existente de feedback, mensajes traducidos y errores sanitizados. El éxito debe expresar «Solicitud aceptada por Resend», no garantizar entrega al buzón.
>
> No des por hecho que los textos están hardcoded ni que el feedback no existe: inspecciona y reproduce primero. Usa Tauri/HTTP simulados para cubrir ambas respuestas sin envíos reales.
>
> Después de corregir, ejecuta los checks aplicables al nuevo candidato, actualiza ODD, Engram y tareas, y completa la verificación final aplicable. Respeta RDD y todos los consentimientos nativos. No reutilices la aprobación consumida de T1. No instales dependencias ni modifiques el harness global sin consultar.
>
> Mantén cuatro commits y T1 intacto. Autorizo incorporar estas correcciones y evidencia mediante amend propio de la cuarta unidad, solo tras confirmar que sigue local y sin trabajo ajeno superpuesto.
>
> Límites: Resend concreto; un intento por evento, sin reintentos, cola ni replay. Misma identidad y memoria de detectAlerts, sin persistencia nueva. secrets::get() y CSP intactos. Remitente introducido por el usuario; Linux #106 fuera de alcance. Sin Integraciones ni capa genérica. No cargo fix, audit fix ni limpieza de los warnings preexistentes. Los borradores privados de docs/ fueron trasladados a Downloads: no recrearlos ni incorporarlos a la entrega. No uses ni reproduzcas credenciales previamente expuestas. No envíos reales, push ni PR.
>
> No declares completada #245 hasta verificar S21/S22 y resolver el cierre funcional pendiente de T4.

**L28 — Evidencia de S21/S22 y checks del candidato corregido.** Reconciliación: Engram 6953 y documento coinciden; git con HEAD `0be370e`, cuatro commits, índice limpio y solo el ODD local (L25–L26) como cambio propio; sin fuentes ajenas superpuestas. Issue revalidada OPEN, `status:approved`, única asignación `ludevdot`; dos comentarios: aprobación del owner y la consulta de `ludevdot` sobre validación manual en macOS, sin respuesta del owner todavía (decisión pendiente, no presupuesta).

S21, hallazgos observados antes de corregir: (a) catálogos frontend es/en completos con las 16 claves email, paridad por `satisfies` e inventario `--check` salida 0; sin textos hardcoded en la sección email de Ajustes. (b) Hallazgo real en backend: asunto, cuerpo del evento y texto de prueba hardcoded en inglés en `email.rs`, contra la convención `i18n.rs` (catálogo tipado, match exhaustivo y paridad). Corregido: `Msg::EmailSubject`, `email_test_body` y `email_event_words` con es/en, inglés byte a byte; `send`/`send_with` reciben el locale de la config (`send_email_alert` lo lee sin cambiar identidad ni memoria). (c) Ninguna prueba ligaba las 13 claves `EmailStatus` a los catálogos: cubierto.

S22, reproducción antes de corregir: el feedback existía (`<p role="status">` traducido) pero ninguna prueba lo reproducía (cero menciones email en los tests de Ajustes) y era un párrafo plano sin tono del patrón. RED observado: 1 fallo/2 correctos por `EmailStatusLine` ausente. Corregido con el patrón existente `eg-notice eg-notice--sm` y tono por estado (verde aceptación, amarillo requisito/incertidumbre, rojo fallo), mensajes traducidos y sin promesa de entrega («Solicitud aceptada por Resend»); sin componente nuevo de toast ni dependencia.

Checks del candidato: focalizados 3/3 (Settings-email-i18n), Rust 511 correctas/1 ignorada/1 smoke filtrado con 2 tests nuevos de textos de email por HTTP simulado, `npm test` 933 Vitest + 298 Node, typecheck, build y `cargo fmt` correctos; sin cargo fix ni limpiezas. Amend propio autorizado ejecutado tras los checks: cuarta unidad (HEAD final tras el amend; hash definitivo en el informe de sesión y el espejo Engram) con corrección, tests, docs, ODD (L25–L28) e inventario regenerado con ancla al nuevo árbol; padres T1 `6e52038`, T2 `54d0534`, T3 `faf99c4` intactos y exactamente cuatro commits; índice limpio y sin cambios ajenos. Verificación final sobre el candidato definitivo: focalizados 3/3, 2 tests Rust de texto, inventario `--check` salida 0. T1 intacto. T4 sigue abierta: falta la evidencia montada/visual de Ajustes y la respuesta del owner; no se declara completada #245.

1. **S21, auditoría de i18n:** revisar todos los textos incorporados por #245 en los idiomas que realmente soporte el proyecto (labels, ayuda, consentimiento, errores y estados). Detectar hardcoded y claves/faltas de traducción antes de afirmar cobertura; no se ha realizado esta auditoría en el turno actual ni se declara que existan fallos concretos. Corregir con las convenciones y catálogos existentes, sin inventar idiomas nuevos. Regenerar inventario cuando cambien fuentes y comprobarlo contra el candidato correcto.
2. **S22/S13/S20, feedback visible:** reproducir primero la experiencia reportada en Alertas, usando Tauri/HTTP simulados para no causar nuevos envíos reales. Comprobar notificación visible tras la prueba tanto para aceptación como fallo. Si falta, RED observado antes de corregir, cubrir ambos resultados y traducir los mensajes. Un resultado positivo debe expresar «Solicitud aceptada por Resend», no garantizar entrega al buzón; errores sanitizados, sin direcciones/clave/payloads ni reintentos automáticos. No decidir todavía toast/banner u otro componente sin explorar los patrones existentes.

**Evidencia aportada por el usuario:** confirma «ahora si, funciona» tras usar el remitente de pruebas de Resend, al no disponer de dominio propio verificado. Es confirmación humana del envío real, no ejecución del agente ni prueba independiente instrumentada; no confirma qué estado exacto presentó la UI ni la validación completa de Ajustes. No repetir envíos ni reutilizar una credencial expuesta; no guardar claves o direcciones en este documento. El backend continúa usando reqwest, sin necesitar SDK adicional. Publicación del comentario de consulta al owner confirmada por el usuario; no se ha consultado una respuesta nueva. Borradores privados trasladados por orden del usuario fuera del repo: no recrearlos ni incluirlos en entrega; este turno no sanea referencias históricas ni reescribe commits.

**L29 — Respuesta del owner registrada y reconciliación (S23/S24).** GitHub consultado con `ludevdot`: [respuesta del owner](https://github.com/egdev6/quorb/issues/245#issuecomment-6716512919) a la consulta de validación. Acepta la combinación comprobación manual en macOS + pruebas automatizadas con HTTP simulado; deja fuera de esta issue la prueba de Ajustes montado (sin `jsdom`/`happy-dom`/`@testing-library/*`/`mockIPC`, decisión transversal con dependencias nuevas, posible issue propia futura). Dos condiciones, registradas como S23 (lógica de interruptores fuera de la UI, en funciones puras/reducer con sus tests) y S24 (checklist manual en la PR, con capturas, estado y credenciales separados; guardar la clave comprobado también en Windows, o indicar su ausencia para que el owner lo verifique).

Verificación S23: explorador independiente (`gentle-ai-explore`, tarea `mw7ys4ka-1-7x3t`) mapeó las seis reglas: 1, 4, 5 y 6 decididas por funciones puras con tests directos (`patchEmail` y `email.test.ts:10`; guard de `dispatchEmailAlerts` y matriz `email-dispatch.test.ts:95-107` más re-gate backend `email.rs:134-141` probado; `nativeAlertsEnabled` y `alerts.test.ts:105-112`, independencia nativa en `email-dispatch.test.ts:95-104`; `sendEmailTest` probado en `email.test.ts:18` y `:26`, gates backend `email.rs:285` y `:459`); regla 3 en gates backend `email.rs:147-149` con tests `email.rs:341`/`secrets.rs:189`. **Brecha S23 única: la regla 2 (desactivar conserva la clave) no tiene prueba directa** — se aplica implícitamente (el toggle solo modifica `enabled` en `Settings.tsx:1673`; la clave solo la toca `set_secret`, `secrets.rs:347-351`), pero nada la acredita. El usuario dirigió la atención del turno a la respuesta del owner; se incorpora como continuación en el alcance de la implementación autorizada la prueba focalizada con almacén sintético (desactivar → clave intacta → re-habilitar → envío funcional). La condición S23 se consideró cumplida tras añadir esa prueba; esa conclusión queda matizada por L32, pues no ejecuta el flujo de guardado; la comprobación manual queda solo para lo visual y el cableado, conforme al owner.

S24: sin acceso a Windows verificado; la checklist de PR indicará que el owner verifique el guardado de clave en Windows. Redacción de checklist y capturas en la PR: pendiente de la decisión de PR/push del usuario. Sin envíos reales, push ni PR; no se declara completada #245.

**L30 — Prueba de regla 2 y checklist manual (S23/S24).** Añadida `disabling_email_preserves_the_stored_key` en `email.rs`: almacén sintético en `Arc<Mutex<Option<String>>>`, envío aceptado, desactivar con round-trip serde, envío automático rechazado (`Disabled`) con almacén intacto, re-habilitar vuelve a enviar sin re-introducir la clave. Pin de comportamiento existente, no cambio de producto: sin RED aplicable, la brecha era de cobertura. GREEN focalizado 1/1; suite email 10/10; `cargo fmt` aplicado y verificado. Conclusión histórica, corregida en L32: con esta prueba, la condición S23 del owner se dio por cumplida: las seis reglas viven en funciones puras/gates con tests directos. Checklist manual añadida a `docs/email-alerts.md`: preparación, Ajustes (advertencias, consentimiento, clave, desactivar/conservar, feedback verde/rojo, prueba con Alertas global desactivado), avisos automáticos (umbral, deduplicación, independencia nativa, desactivar detiene envíos) y sección Windows marcada para verificación del owner si no hay acceso, conforme a S24. Pendiente: amend de la cuarta unidad (solo tras confirmar local/sin ajeno) y decisión de PR/push del usuario.

**L31 — Incidencia de suite observada, no oculta.** En la primera ejecución de la suite Rust completa falló de forma intermitente `email_texts_follow_configured_locale` (`email.rs:422`, unwrap sobre `None`): el servidor de prueba del fixture solo acepta conexiones durante un plazo de 350 ms y, bajo carga de la suite, puede expirar antes de la petición. El test pasa aislado y en tres ejecuciones posteriores completas y focalizadas (512 Rust correctas/1 ignorada/1 smoke filtrado). Es un flaky del harness de test local preexistente, no del código de producto ni del test nuevo; no se modificó su plazo en este turno. `npm test` 933 Vitest + 298 Node, typecheck, build, inventario `--check` y `git diff --check` correctos. Los cambios quedan locales sin commit (3 archivos: `src-tauri/src/email.rs`, `docs/email-alerts.md`, ODD), pendientes de la decisión de integración del usuario.

**L32 — Recomendación aceptada y alcance actual.** Petición literal del usuario:
> adelante con la recomendacion

Se acepta la propuesta del turno previo: reforzar el test en el punto real de guardado, precisar el alcance del test Rust y contar exactamente dos envíos, estabilizar el fixture HTTP, alinear checklist con HTTP simulado y evidencia manual/Windows, corregir cierres excesivos y ejecutar checks. L29/L30 no prueban conservación a través del guardado: el almacén sintético solo se lee. Se mantiene esa evidencia histórica con la corrección explícita, no se inventa RED ni se declara completo S23 por ese test. Explorador `mw7zvz2m-1-414g` identifica `runMixedSave` y `api.saveConfig` como seam existente; sin extraer una capa nueva ni modificar reglas. T6 cubre solo esta mejora, no reabre la verificación final histórica ni ejecuta envíos reales. T4 conserva evidencia manual/capturas y Windows pendientes. La rama ya se publicó en el fork (Engram 6988); no se cumple el requisito histórico «sigue local» para amend. No reescribir historia publicada ni publicar cambios en este turno. Se preservan los tres archivos locales anteriores. Checks nuevos todavía pendientes; RDD on.

**L33 — Implementación y checks propios T6.** Worker `mw801dmr-2-uo1j` modificó solo tests en `email.rs` y `email.test.ts` y checklist en `docs/email-alerts.md`. RED observado: petición inicial tras 400 ms contra fixture antigua falla con `AcceptanceUnknown` frente a `Accepted` (exit 101, `/tmp/quorb-t6-sUsB/red-delayed-first-request.log`). GREEN tras servidor RAII con cierre explícito y lectura acotada; solo registra peticiones completas. El primer check completo aún falló en el parseo de una petición incompleta; worker corrigió su captura y la suite posterior pasó. No se elimina esa incidencia ni se presenta el primer intento como correcto. Test de guardado usa `patchEmail` → `runMixedSave` → `api.saveConfig` con puente simulado y exige una única llamada `save_config`, ninguna de secretos; acredita esa orquestación, no el handler completo de Ajustes ni persistencia OS. Test Rust renombrado a `backend_gates_disabled_email_and_reuses_available_key`, exactamente dos peticiones, sin atribuirle persistencia real. Sin RED de producto para cobertura de comportamiento ya existente.

Checks propios finales reportados y logs en `/tmp/quorb-t6-sUsB/`: focalizados frontend 41; `npm test` 934 Vitest + 298 Node; typecheck y build correctos (typecheck necesitó una corrección del tipo del mock); email Rust 11, suite Rust 513 correctas/1 ignorada/1 smoke real excluido; fmt correcto. `git diff --check` del worker falló por línea vacía al EOF del ODD del parent, corregida al registrar esta entrada. Worker terminó `partial` por ese defecto documental fuera de su superficie; no quedan fallos de producto reportados. El parent corrigió además casillas que aún pedían correos reales y precisó que feedback montado con respuestas simuladas requiere procedimiento aún no disponible. No se inventa aislamiento: config/llavero aislados y simulación integrada son prerrequisitos manuales pendientes, sin arrancar la app ni instalar herramientas. Windows pendiente del owner. T4 permanece parcial, no se vuelve a ejecutar su ciclo histórico.

Evaluación nativa actual: nativeRisk medium, reviewDue false (`under_budget`); escalado explícito ítem 4 por cierre/sincronización de hilos exclusivamente del fixture exige un verificador independiente de T6. No se inicia revisión nativa ni se hereda la autoridad consumida T1. La unidad actual excede aproximadamente 400 líneas authored contando documentación y la sustitución del fixture; es una mejora cohesiva de evidencia, sin nuevas áreas ni división artificial. La historia publicada y T1 se preservan; integración Git pendiente de decisión separada, no amend automático.

**L34 — Verificación independiente T6 y cierre de este alcance.** Verificador `mw80iuex-3-5cwh` ejecutó en scratch aislado `/tmp/quorb-t6-verify.fVbYO8e0` los 41 tests frontend (exit 0), 11 tests email Rust (exit 0, binario del candidato previamente compilado, hash copiado igual y nombres/fechas contrastados; no reconstrucción independiente), 4 probes TS independientes y 5 probes Rust de ciclo de vida con fixture extraído literalmente (exit 0 final). El probe auxiliar necesitó corregir un timeout de su cliente; no fue un defecto del candidato ni se oculta como primer intento correcto. Pruebas de ciclo de vida: acepta tras 500 ms, `stop` acotado, `Drop` recoge hilo bajo pánico, cliente incompleto no se cuenta y lectura acotada, tres peticiones secuenciales exactamente. Sin bloqueadores. Advisories sin corrección obligatoria: servidor serial puede esperar ~2 s ante cliente incompleto, parser HTTP mínimo depende del formato emitido por reqwest, error fatal de accept termina el hilo. Son límites del fixture, no cambios de producto, y no abren otro ciclo de correcciones.

Veredictos: S15/S23 cumplidas en alcance automatizado del coordinador/gates (no handler montado ni durabilidad OS); S24 checklist corregida, ejecución manual/PR no realizada; S25 mejora cumplida. Spot-check del parent: 41 focalizados exit 0 y `git diff --check` exit 0 tras corregir EOF. Aclaración documental final: consentimiento sin marcar bloquea el botón de prueba, no se exige pulsar un botón deshabilitado. No se modificaron funciones de producto, secretos, dependencias ni CSP; sin correo real, app launch, push, PR, commit o reescritura de historia. Checks completos propios en L33; verificador no repitió suites ajenas. T6 completada; T4 sigue parcial por evidencia manual/capturas/Windows y prerrequisito de aislamiento. **Needs your decision:** aportar ese procedimiento/evidencia o acordar por separado su preparación; no declarar cerrada #245 ni inventar pruebas. La integración Git también queda separada: mantener exactamente cuatro commits sobre historia publicada impide el amend automático previamente condicionado a historia local.

**L35 — Handoff y parada explícita del usuario.** Peticiones literales posteriores:
> como no podemos hacer amend al commit de claves, podriamos eliminar la rama de mi fork, hacer amend, y no pushear hasta que este todo. que opinas?
> que recomiendas hacer ahora?
> pues prepara un handoff y lo haremos en la siguiente sesion

Este turno solo documenta el relevo. No se borra ninguna rama, no se hace amend, commit, push ni PR y no se inicia aislamiento ni ejecución manual. La sugerencia de un quinto commit es una recomendación para la próxima sesión, no una autorización de Git inferida de esta solicitud documental. T1 no necesita cambios: T6 solo modifica tests y evidencia. Git permite técnicamente amend publicado; la restricción aquí es preservar historia y respetar la autorización anterior condicionada a que siguiera local.

### Handoff vigente — retomar después de L35

- **Git comprobado al cerrar:** rama `feat/245-email-alerts`, HEAD `a45f646ca046d9ac86fd6bd29ba177085b15f566`; cuatro commits (`6e52038`, `54d0534`, `faf99c4`, `a45f646`). Referencia local `origin/feat/245-email-alerts` coincide con HEAD; no se hizo fetch ni comprobación remota en vivo en este cierre. `origin` es el fork `https://github.com/ludevdot/quorb.git`; `upstream` es `https://github.com/egdev6/quorb.git`. No publicar en upstream. Sin cambios staged; conservar todos los cambios locales y reconciliar de nuevo al retomar.
- **Cambios locales sin commit:** `src-tauri/src/email.rs` (solo `#[cfg(test)]`: servidor RAII/cierre explícito, regresión de llegada tardía, test backend renombrado y dos peticiones), `src/lib/email.test.ts` (regresión del coordinador real de guardado con puente simulado), `docs/email-alerts.md` (checklist y límites) y este documento. Antes de añadir L35: 415 adiciones/75 eliminaciones; no es una nueva modificación de la lógica de claves. El fichero ODD crecerá por este handoff; no reducir texto artificialmente para encajar 400 líneas.
- **Trabajo completo:** T6 verificada sin bloqueadores, evidencia L33–L34. 934 Vitest + 298 Node, 513 Rust/1 ignorado/1 smoke real excluido, tipos/build/fmt correctos. Independiente: 41 frontend, 11 Rust de binario ya compilado (sin reconstrucción independiente), 4 probes TS y 5 probes de ciclo de vida. RED e incidencias intermedias preservadas. Logs temporales `/tmp/quorb-t6-sUsB/` y `/tmp/quorb-t6-verify.fVbYO8e0`; pueden desaparecer entre sesiones, por lo que el registro durable es L33–L34. No relanzar verificadores históricos por recuperar el contexto ni convertir advisories del fixture en bloqueadores nuevos.
- **Siguiente unidad recomendada, pendiente de autorización de la nueva sesión:** sustituir la restricción de exactamente cuatro commits por un quinto commit local cohesivo, por ejemplo `test(email): strengthen save coverage and HTTP fixture lifecycle`. Preservar T1 y los cuatro commits publicados; no borrar rama ni hacer amend/force-push. Antes: inspeccionar diff/índice, alcance y evidencia aplicable al candidato, política de inventario i18n y tamaño. La evaluación previa tuvo reviewDue false; si cambia el candidato, aplicar RDD al candidato correcto sin reutilizar T1 ni fabricar consentimiento. Stage explícito de archivos de la unidad, nunca add-all. No push/PR por inferencia.
- **Siguiente trabajo técnico:** preparar un procedimiento verificable para comprobar manualmente Ajustes en macOS con config y llavero aislados, sin activar sondeos/envíos reales ni leer secretos personales. Primero investigar mecanismos existentes, alcance y recuperación; no basta modificar HOME si el keyring conserva servicio/usuario del sistema. No arrancar `app:dev` contra estado personal. No instalar dependencias ni crear una infraestructura transversal de UI montada sin acordarlo. El feedback de respuestas simuladas en app montada también necesita una vía comprobada: los tests HTTP backend y SSR no la proporcionan por sí solos.
- **Evidencia final pendiente, T4:** checklist con capturas de UI/cableado, comprobación real del llavero por plataforma y Windows; sin acceso a Windows, dejarlo explícito para que el owner lo verifique. Checklist en `docs/email-alerts.md`, todas las casillas manuales sin marcar. El owner acepta manual + HTTP simulado, y deja fuera el test automatizado de Ajustes montado (comentario `6716512919`). No declarar cerrada #245 ni equiparar una suite verde a evidencia visual.
- **Límites vigentes:** npm/package-lock, sin nuevas dependencias, correos reales, credenciales expuestas, cambios en `secrets::get()`/CSP ni limpieza de warnings ajenos. Preservar historia y separación de seguridad de T1. No push, PR, borrado de ramas ni force-push sin petición específica. Este handoff es la parada solicitada, no un nuevo permiso de ejecución.
- **Recuperación:** `mem_context` → `mem_search` por `245`/topic `odd/245-email-alerts/tasks` → observación `6953` → archivo local completo, especialmente L32–L35. Las respuestas de memoria de este documento largo pueden truncarse cerca de 50 KB: leer el archivo por páginas y no interpretar una cola truncada como pérdida de L35; existe además resumen de sesión con el handoff. Reconciliar archivo, memoria, Git y todo antes de continuar. T6 done; T4 blocked por aislamiento/evidencia manual/Windows. El usuario ha pedido parar hasta la próxima sesión.

**L36 — Reanudación y autorización actual (usuario, literal).**
> Retomemos Quorb #245 siguiendo ODD.
>
> Recupera Engram y lee odd/tasks/245-email-alerts.md completo, especialmente
> L32–L35. Reconcilia memoria, archivo, rama, índice y cambios locales antes
> de escribir.
>
> Estado esperado:
> - Rama feat/245-email-alerts.
> - HEAD a45f646ca046d9ac86fd6bd29ba177085b15f566.
> - Cuatro commits publicados en mi fork ludevdot/quorb.
> - Cuatro archivos modificados sin commit: src-tauri/src/email.rs,
>   src/lib/email.test.ts, docs/email-alerts.md y el documento ODD.
> - T6 implementada y verificada; T4 pendiente de evidencia manual.
>
> Autorizo sustituir la restricción anterior de exactamente cuatro commits
> por un quinto commit local coherente con las mejoras de T6 y su evidencia.
> Comprueba primero el diff, los checks aplicables y la política del inventario
> i18n. Preserva el commit de credenciales T1 y toda la historia publicada.
> No hagas amend, no borres ramas y no hagas force-push.
>
> Después, prepara un procedimiento reproducible para comprobar Ajustes
> en macOS con configuración y llavero aislados, sin tocar datos personales
> ni causar envíos reales. No asumas que cambiar HOME aísla el llavero.
> No arranques la app hasta comprobar ese aislamiento.
>
> El owner acepta comprobación manual más HTTP simulado; los tests de
> Ajustes montado quedan fuera. No instales dependencias ni amplíes la
> infraestructura sin consultar. Si no hay acceso a Windows, deja su
> comprobación expresamente pendiente del owner.
>
> Usa npm y package-lock.json. Respeta RDD y los consentimientos nativos.
> No reutilices la aprobación consumida de T1 ni relances verificaciones
> históricas por recuperar el contexto.
>
> Sin push, PR, correos reales ni cambios en secrets::get() o CSP.
> Actualiza ODD, Engram y tareas con evidencia real. No declares cerrada
> #245 mientras falten las comprobaciones manuales y por plataforma.

**L37 — Reconciliación y checks actuales, antes del quinto commit.** Engram recuperado (6953, más 6991/6992 en búsqueda) y archivo leído por páginas: memoria larga truncada, no pérdida de L35. Rama/HEAD coinciden con L36; índice limpio, exactamente cuatro archivos modificados, sin fuente de producto superpuesta. `git ls-remote origin refs/heads/feat/245-email-alerts` confirma en vivo `a45f646ca046d9ac86fd6bd29ba177085b15f566`; cuatro commits desde b82cf78, T1 `6e52038` intacto. Identidad `gh api user`: ludevdot; issue OPEN, status:approved, única asignación ludevdot. Explorador read-only `mw8101ab-1-xf7m` mapeó políticas/aislamiento; no pruebas ni lanzamiento. No se interpreta su nombre público de asignación como cambio de identidad: la API autenticada confirma login.

Diff revisado: Rust solo cfg(test), test TS del coordinador, docs y ODD. No nuevo RED: reproducción/corrección T6 conservada en L33, código sin cambios nuevos. Checks actuales en `.git/245-t6-resume.7QRLCP/`: 44 tests frontend en cuatro archivos, 11 email Rust con cargo offline/locked, typecheck, fmt y diff --check, todos exit 0. No se relanzó verificador T4/T6 histórico ni suites completas por recuperar contexto; suites previas L33 y evidencia independiente L34 se conservan como históricas, no nuevas. No diferencial de producto aplicable: solo fixture/test cambian. RDD on; evaluación actual en L39, no hereda T1.

Política i18n: lee commits y ancla ambos árboles, incluidos tests. Se generará automáticamente desde objeto commit prospectivo con el índice explícito; no mueve ninguna rama ni reescribe historia. El inventario generado se incluirá en el único quinto commit de rama y se comprobará contra HEAD final. No editar a mano ni hacer un sexto commit mecánico. Unidad cohesiva de evidencia supera ~400 líneas (ya excedía antes de este turno); se conserva alcance T6 y procedimiento solicitado, sin dividir tests de su documentación ni decidir PR.

**L38 — Procedimiento manual preparado, no ejecutado.** `docs/email-alerts.md` añade puertas reproducibles para una VM macOS desechable: usuario nuevo sin importación/iCloud, llavero guest, configuración nueva, sin carpetas/discos/clipboard del host, artefacto trazable y todos los adaptadores desconectados antes de abrir Quorb. No se ha provisionado VM, instalado herramientas, tocado llaveros/red del host ni arrancado app. HOME no aísla el servicio fijo de keyring. Inicio del widget consulta proveedores; desconexión protege antes de desactivarlos. Se propone guardar/desactivar/reactivar/cerrar/reabrir/eliminar solo clave sintética y sin pulsar Enviar prueba. Persistencia entre procesos debe observarse, no inferirse del formulario. Procedimiento sujeto a ejecución de sus puertas por owner, sin afirmar aislamiento ya comprobado.

No hay override de endpoint ni simulación integrada en la app; HTTP local backend/SSR no acreditan feedback montado. Capturas aceptación/error quedan pendientes de acordar vía acotada sin nuevas dependencias ni cambios CSP/get(). No se añade infraestructura para resolverlo por inferencia. Windows sin acceso disponible: comprobación de almacén pendiente del owner. T4 parcial, #245 no cerrada. Necesidad concreta: disponer de VM/artefacto aislados y acordar simulación visual; ninguna de estas evidencias se declara realizada.

**L39 — Inventario y RDD de la quinta unidad.** Inventario generado automáticamente con `--ref 3afdcbb8f9eb0b56ad227e647aa8b3dfdd0cd369` (objeto prospectivo sin rama, no sexto commit en la historia); `--check` exit 0. Solo cambia la línea de anclas: src `ac62acc6583186b4e0133ad469b6bcad62ddc1d0`, Rust `dad04320e4e63be2f385936e96dc661c54d5d078`; lista de textos idéntica. Stage explícito de cinco archivos, sin dependencias/secrets/CSP. Assess actual: nativeRisk medium, reviewDue false/under_budget; escalado ítem4 mantiene independentVerifier=true. La prueba independiente de estos mismos cambios de tests ya consta en L34; no se lanza otra ejecución histórica, de acuerdo con L36. Cambios nuevos de este turno son documentación, inventario generado y evidencia, no modificaciones del fixture verificado. No START/consentimiento nuevo ni autoridad reutilizada. T4 no se da por terminada por este assess.

Quinta unidad preparada con los checks L37 y evidencia L33–L34: se materializa como hija directa de a45f646, sin amend, ramas borradas, push, PR ni correos. El hash final y comprobación del inventario contra HEAD se registran en Engram al terminar; este documento identifica la unidad por asunto y padre para no necesitar un amend autorreferencial. T6 completa; T4 bloqueada por ejecución manual macOS/capturas/simulación integrada y Windows owner. No se cierra #245.

**L40 — Petición actual y alcance T7 (literal).**
> usa tu propuesto pero no comitees. el texto"Linux: si el backend es keyutils, la clave puede no sobrevivir a un reinicio. Su resolución corresponde a #106; nunca se usa texto plano." creo que en la ui decir backend, no es correcto sino explicarlo y en la ui referenciar a una issue no tiene sentido

Rama `feat/245-email-alerts`, HEAD `3efb171441b31efba68c5c184172d21ebc4ab9f3`, índice/worktree limpios antes de escribir. Revisión nativa del quinto commit posterior a L39: `review-40c0c4d476e30038`, approved y acknowledgement consumido; no se reutiliza para T7. T7 pequeña y contenida, inline con tests primero. Explorador read-only `mw861eo3-2-h7hv` confirmó helper OS y seam SSR; no pruebas históricas ni escrituras. Sin commits, objetos commit prospectivos ni publicación. Generación del inventario deberá usar funciones canónicas sobre árbol prospectivo sin commit; `--check` de HEAD no representa cambios locales. T4/Windows siguen parciales; capturas previas no verifican los nuevos textos T7.

**L41 — Evidencia T7 sin commit.** Tests SSR añadidos antes de modificar producto: remitente de pruebas y restricción de destinatario sin rellenar campo, aviso Linux en es/en y tres plataformas sin jerga/#106, ayuda breve de prueba manteniendo guardado/envío/consentimiento/clave. RED `.git/245-t7-red.log`: exit1,3 fallos/3 correctos. GREEN `.git/245-t7-checks.uiTb5R/`:36 focalizados en4archivos; npm test937Vitest+298Node; typecheck/build/diff exit0. No tests montados ni nuevas dependencias; no app launch/correos. No suites Rust históricas relanzadas: Rust sin cambios.

Settings reutiliza osFromUA sin modificarlo (clasifica Windows/macOS y resto como Linux); tests fijan UAs desktop soportadas. Catálogos es/en actualizados; aviso técnico solo en docs. No cambia contrato compartido, envío, credenciales ni CSP; no diferencial de producto compartido aplicable. Inventario regenerado con exports canónicos collect/extractTs/extractRust/renderInventory sobre árbol Git prospectivo, índice temporal independiente `.git/245-t7-inventory-yQt3Qx`, sin objeto commit ni cambios al índice real. Comprobación contra árbol fuente exit0: src a6611ce4d2ddd91d9ebb59c0daa490ed4e5c1be7, Rust dad04320e4e63be2f385936e96dc661c54d5d078. CLI --check sobre HEAD no se ejecuta como validación del worktree: lee el commit anterior, que deliberadamente permanece intacto. Solo6 textos de catálogos cambiados y ancla src; Risk:none. Evaluación nativa posterior se registrará en Engram, sin heredar autoridad T1/T6 ni generar commit. Nuevas capturas manuales de textos pendientes; #245 no cerrada.

**L42 — Handoff solicitado por el usuario y estado vigente.** Petición literal:
> genera un handoff para la siguiente sesion

Confirmaciones humanas recibidas durante esta sesión, literales:
> hice todas las alternativas, incluso cerrando la app
> inlcuso hice esta, por si sirve: [external-screenshots]/recepcion.png
> guarda esto en un documento para acordarnos de ello en [external-screenshots]

Se pausa por petición de handoff a la siguiente sesión. Este cierre solo documenta; no añade cambios de comportamiento, commits, envíos ni verificaciones históricas.

### Handoff vigente — retomar después de L42

- **Recuperación:** mem_context → mem_search proyecto quorb/topic odd/245-email-alerts/tasks → observación6953 → archivo completo por páginas, especialmente L36–L42. El documento supera50KB; no confundir truncación de herramientas/memoria con pérdida del final. Reconciliar Git/índice/worktree antes de escribir.
- **Git comprobado al preparar handoff:** rama `feat/245-email-alerts`, HEAD `3efb171441b31efba68c5c184172d21ebc4ab9f3`, cinco commits desde base b82cf78. T1 `6e52038`, T2 `54d0534`, T3 `faf99c4`, cuarta unidad `a45f646`, quinta unidad T6 `3efb171`. Los cuatro primeros publicados en fork ludevdot/quorb; remoto confirmado a45f646 al inicio de sesión, no reconsultado en este handoff. Quinta unidad solo local. Sin amend/borrado/force-push. Mantener T1/historia publicada intactos.
- **Restricción vigente:** «no comitees» de L40 sigue activa. Sin stage/commit nuevo, push, PR ni correos reales del agente. Las autorizaciones anteriores no permiten ignorarla. Este handoff tampoco autoriza instalaciones, VM, nuevos usuarios, borrado de datos o modificación del harness.
- **Cambios locales T7, ocho archivos, índice real limpio:** `src/Settings.tsx`, `src/Settings-email-i18n.test.tsx`, `src/Settings-i18n.test.tsx`, `src/i18n/es.ts`, `src/i18n/en.ts`, `docs/email-alerts.md`, `docs/i18n-inventory.md`, este ODD. Antes de añadir L42:97+/20-; el documento crece por este handoff. No cambios Rust ni manifiestos/lock. No usar add-all/restore/reset/clean ni tocar imágenes originales.
- **T7 implementada sin commit:** remitente explica `onboarding@resend.dev` exclusivamente para pruebas al correo de la cuenta Resend, sin default de campo; ayuda prueba breve conserva guardado/envío/consentimiento/clave/no habilitación automática; aviso Linux solo en Linux con texto comprensible, sin backend/keyutils/#106 en UI. Detalle técnico en docs. es/en completos. Reutiliza osFromUA sin cambiar helper compartido; clasifica Windows/macOS/restoLinux. No cambia envío/consentimiento/secretos/CSP.
- **Checks T7 observados:** RED3fallos/3correctos `.git/245-t7-red.log`; GREEN36focalizados,937Vitest+298Node,typecheck/build/diff exit0 `.git/245-t7-checks.uiTb5R/`. No nuevas suites Rust ni verificadores históricos. No nuevo RED ficticio al retomar si no hay cambio de comportamiento. Capturas anteriores muestran textos previos a T7; no afirman validación visual de los nuevos textos.
- **Inventario sin commit:** generado automáticamente con exports canónicos del script sobre árbol e índice temporal independiente `.git/245-t7-inventory-yQt3Qx`; no commit-tree ni objeto commit T7. src `a6611ce4d2ddd91d9ebb59c0daa490ed4e5c1be7`, Rust `dad04320e4e63be2f385936e96dc661c54d5d078`. Fuente T7 y anclas verificadas, índice real vacío. El CLI lee commits: --check por defecto valida HEAD anterior, no el worktree. Si no cambia source, no hace falta regenerar por este handoff documental. Con autorización futura de commit, verificar contra HEAD definitivo; no editar manualmente ni inventar commit para generar.
- **RDD:** T1 histórica consumida no reutilizable. Quinta unidad T6, review-40c0c4d476e30038 para target sha256:df96ffb0943780191dd5ff4922e99be1e7355e89390a0acacfc756f65632b0b0, aprobada por resilience/readability/reliability tras confirmación humana de3ejecuciones; acknowledge-approved terminó authority=burned, consumed_revision sha256:3d6fe5e7122075eecb66e8f068a729c0b083449afb178783f585a50297434e90. No STATUS tras burn. T7 assess medium/reviewDue=false under_budget/independentVerifier=false; sin START nuevo ni aprobación T7 inferida. Respetar nuevos consentimientos si el proveedor ofrece otra revisión del candidato exacto.
- **Evidencia manual macOS recibida:** carpeta `[external-screenshots]/`, imágenes1–7.png y recepcion.png; agente leyó las imágenes, no ejecutó la app. Usuario confirma todas las alternativas consultadas, incluida conservación tras desactivar/guardar/reactivar y cerrar completamente/reabrir, eliminación con Quitar y ausencia tras reabrir. Registrar como confirmación humana apoyada por capturas, no test independiente ni prueba tras reiniciar macOS.
- **Contenido de capturas:**1 advertencias/campos vacíos, pero clave ya configurada (no instalación limpia);2/3sin consentimiento/campos presentes/clave configurada;4consentimiento activo/email automático off/clave configurada;5campo clave vacío sin configurada/Quitar;6rechazo403rojo;7acceptedverde. Usuario confirma7posterior a nueva solicitud con test@test.com guardado, sin editar. La captura no demuestra payload remoto; no asumir bug ni garantizar entrega. No repetir envío hacia test@test.com (no reservado).
- **Recepción:** recepcion.png es JPEG pese a extensión, muestra Gmail con onboarding@resend.dev, asunto «Quorb: alerta de consumo», cuerpo «Quorb: prueba explícita de email (sin datos de consumo).». Recepción puntual observada, no prueba aviso automático ni vínculo inequívoco con7/destinatario exacto, sin fecha/dirección expuestas en captura. No más envíos necesarios para documentar lo recibido. Recortar sidebar Gmail/contadores/etiquetas antes de publicar.
- **Privacidad y publicación de imágenes:**2/3/5revisadas de nuevo con direcciones ocultas mediante mosaico; preferir bloques opacos y exportación aplanada.4versión anterior conserva dirección: revisar antes de publicar.4/5menor nitidez. No publicar secretos, ni copiar/publicar imágenes por inferencia. Originales siguen fueraGit.
- **Documento externo de recordatorio ya creado:** `[external-screenshots]/README-evidencia-245.md` (68líneas, comprobado UTF-8/estructura). Tabla propuesta por comprobación y evidencia, límites/anonimización/pasos restantes. Conservar imágenes fueraGit; adjuntar copias anonimizadas en cuerpo de PR, no binarios al historial; futuro `docs/email-alerts-validation.md` con resultados y límites, enlace desdePR/ODD; issue solo resumen/enlacePR y Windowsowner. Documento de validación del repositorio todavía NO creado; PR/push NO autorizados.
- **Corrección de la propuesta de aislamiento:** usuario no dispone de VM y cuestionó borrar datos/reinstalar credenciales. No se borró ni se creó nada. VM/usuario separado fueron propuestas del agente, no requisitos del owner ni preparaciones realizadas. HOME no demuestra aislamiento, pero tampoco debe exigirse VM para reconocer evidencia manual ya aportada. L38 conserva propuesta histórica NO ejecutada; no presentar las capturas como aisladas. Owner acepta manual+HTTPsimulado existente; no exigir simulación integrada en app ni tests Ajustes montado como requisito añadido. Estado final de T4 corresponde al owner con límites transparentes, no se declara aprobado globalmente.
- **Pendientes concretos:** versión exacta macOS y trazabilidad commit/artefacto realmente usado en capturas (HEAD del repo no prueba binario); nuevas capturas de ayuda T7 sin repetir correos; preparar documento de validación del repo cuando se retome/autorizado, con distinción observado/confirmado/no acreditado; Windowskeyring expresamente pendiente del owner. No capturas manuales inglés revisadas; tests i18n es/en no equivalen a visual de ambos. No cerrar #245 ni convertir muestras de éxito en garantía de entrega.
- **Siguiente sesión:** preservar los ocho cambios, confirmar propósito (documentar evidencia/capturas nuevas o cambiar código) y restricciones vigentes. No reabrir pruebas históricas, borrar datos personales, instalar infraestructura ni hacer commit por recuperar contexto. Acordar nueva autorización explícita antes de commit/push/PR. Resumir estos pendientes al usuario sin exigir nueva VM ni envíos reales.

**L43 — Reanudación documental autorizada (usuario, literal).**
> Retomemos Quorb #245 siguiendo ODD.
>
>    Recupera Engram y lee completo odd/tasks/245-email-alerts.md,
>    especialmente L36–L42. Reconcilia memoria, archivo, rama,
>    índice y cambios locales antes de escribir.
>
>    Estado esperado:
>    - Rama feat/245-email-alerts.
>    - HEAD 3efb171441b31efba68c5c184172d21ebc4ab9f3.
>    - Cinco commits; los cuatro primeros publicados, quinto local.
>    - Ocho archivos modificados sin commit, enumerados en L42.
>    - Índice limpio.
>
>    Preserva todos los cambios. Sigue vigente «no comitees».
>    Sin amend, borrado de ramas, force-push, push ni PR.
>
>    T7 está implementada y verificada. No relances verificadores
>    históricos por recuperar contexto ni reutilices la autoridad
>    consumida de T1 o de la revisión del quinto commit.
>
>    Continuemos con la preparación documental de la evidencia manual:
>    revisa las capturas y README-evidencia-245.md en
>    [external-screenshots] y prepara
>    docs/email-alerts-validation.md, actualizando ODD y Engram.
>
>    Distingue lo observado en imágenes, lo confirmado por mí y lo
>    no acreditado. No inventes versión de macOS ni el artefacto probado.
>    Las capturas anteriores muestran textos previos a T7.
>
>    No exijas VM ni simulación integrada como requisitos del owner.
>    No hagas nuevos envíos, arranques la app, instales dependencias
>    ni toques datos personales. Usa npm/package-lock.json.
>    Respeta RDD y sus consentimientos nativos.
>
>    Windows sigue pendiente del owner. No declares cerrada #245.

**L44 — Reconciliación previa a escrituras de documentación.** Archivo leído completo hasta L42. Rama `feat/245-email-alerts`, HEAD `3efb171441b31efba68c5c184172d21ebc4ab9f3`, cinco commits desde b82cf78, índice limpio y los ocho archivos de L42 modificados. La referencia local de seguimiento sigue en `a45f646`; no se reconsulta remoto ni se publica. Diff T7 compatible con L41/L42, se conserva íntegro. Engram6953 tiene resumen de L42 pero copia embebida truncada en L22 (export read-only también confirma truncación persistida); no hay divergencia en el prefijo histórico. El intento de restauración completa mediante mem_update vuelve a truncarse: no se afirma éxito; se preparará espejo íntegro paginado con índice en6953 para respetar límite de memoria sin perder el final. Explorador read-only `mw89ef5p-1-d3xo` leyó ocho imágenes y README externo; no inició pruebas ni app. Capturas previas a T7; versiones macOS/artefacto y Windows no acreditadas. T8 solo documentación, sin RED aplicable ni nuevas suites históricas, instalaciones, envíos, stage o commits. L38 conserva propuesta histórica no ejecutada; VM/simulación integrada no son requisitos del owner. Se actualizará también la checklist documental vigente para no mantener esa exigencia obsoleta.

**L45 — T8 completada: evidencia documental y límites de entrega.** Se crea `docs/email-alerts-validation.md` (163 líneas): matriz por captura y comprobación, fuentes, estados observado/confirmado/no acreditado, reconstrucción repetible sin inventar cronología y pendientes. `docs/email-alerts.md` enlaza informe, contextualiza propuesta VM como histórica/opcional y elimina exigencia nueva de simulación integrada; preserva detalle técnico opcional y ayuda T7. Aceptación del owner es del método manual+HTTP simulado, no aprobación de estas imágenes ni del candidato actual. Versión macOS, fecha y artefacto realmente ejecutado quedan desconocidos; HEAD local no prueba binario. No se inventa aislamiento ni ausencia del mismo, reinicio del SO, recepción automática, correlación inequívoca 7/recepción ni inspección visual inglesa. Capturas1–7 previas a T7; recepción de prueba puntual separada. Windows y disposición final de T4 siguen para owner. No envíos nuevos para documentar.

Explorador `mw89ef5p-1-d3xo`: ocho imágenes legibles y README leídos. Writer `mw89mnxd-2-mc0j` y una continuación documental `mw89sy2u-3-3w1f` corrigen atribución/cronología/signoff; parent spot-check7.png confirma feedback aceptado y ayuda antigua. No es verificación funcional nueva. Checks documentales writer exit0 (diff, tablas, enlaces), parent exit0 (UTF-8/newline, enlaces locales de ambos docs, categorías/pendientes, ausencia de rutas personales/dirección de pruebas no reservada en informe, rama/HEAD/índice). Fuentes T7 e inventario idénticos por SHA256 a reconciliación inicial; ningún manifiesto/lock/Rust cambiado. Sin RED aplicable a documentación y sin suites/app/llavero real o verificadores históricos relanzados. RDD assess directo: on, medium, reviewDue=false under_budget, independentVerifier=false, outcome unknown; ve ocho paths tracked incluyendo T7 preexistente, no incluye el documento nuevo ignorado. No START ni autoridad heredada. Llamadas assess intentadas desde codemode fueron rechazadas por direct-only, sin captura ni mutación; llamadas directas correctas. Esto no es aprobación nativa documental ni de T7.

**Preservación/entrega:** HEAD `3efb171441b31efba68c5c184172d21ebc4ab9f3`, cinco commits, cuatro primeros publicados según referencia local a45f646 (sin reconsulta remota), índice limpio. Continúan los ocho archivos tracked modificados; solo docs/email-alerts.md y ODD reciben nuevas modificaciones de este turno, más el informe nuevo. `git check-ignore -v` detecta regla global `docs/*` para `docs/email-alerts-validation.md`: existe en disco pero ignorado y sin seguimiento; no stage ni cambio de gitignore para incorporarlo por inferencia. Incluirlo explícitamente será parte de una futura entrega autorizada, no de este turno. Capturas/README externos solo leídos, no copiados/redactados/publicados; sin app, instalaciones, envíos, commits, amend, borrado de ramas, force-push, push ni PR.

**Engram/continuidad:** espejo completo reparado por páginas JSON lossless (`canonicalPath`, `page`, `total`, `text`), índice en6953 y observaciones7003 en adelante; concatenar campos text en orden sin separadores y comparar con archivo local, no tratar el índice como copia del documento. La copia antigua truncada en L22 se detectó y corrigió; readback de páginas previo a T8 ya fue exacto. La sincronización final de estas notas y sus hashes se comprobará antes de responder. T8 terminada documentalmente; T4 permanece parcial/bloqueada por datos de trazabilidad/capturas T7 y Windowsowner, #245 abierta. No VM ni infraestructura nueva exigidas. Risk: none (este turno solo documentación; código compartido intacto).

**L46 — Corrección del usuario sobre el entorno real (literal).**
> has dicho: También he actualizado docs/email-alerts.md para que la propuesta histórica de VM y
>  simulación integrada no aparezca como requisito del owner
>
>  Pero ya te dije y debe estar registrado que no trabajo en una VM sino en mi Mac local

Corrección vigente: el usuario trabaja y realizó la comprobación manual en su Mac local, no en una VM. La redacción L45/informe que trataba la existencia de VM como no determinada fue una sobrecautela incorrecta; queda sustituida por esta confirmación humana explícita. No cambia el dato distinto de que no se ha acreditado separación de configuración/llavero dentro de ese Mac. La propuesta VM era del agente, no describe la ejecución del usuario ni un requisito owner. Se corrigen procedencia/límites de docs/email-alerts-validation.md y referencia en docs/email-alerts.md; no se eliminan registros históricos. T8 mantiene su resultado documental con esta corrección; T4/Windows siguen pendientes y #245 abierta. Sin app/envíos/dependencias/commits/stage ni verificaciones históricas. Comprobación aplicable: readback documental, enlaces y diff; espejo Engram paginado actualizado tras esta corrección. Risk: none (solo precisión documental).

**L47 — Autorización del sexto commit local.** Tras propuesta de crear un sexto commit local con los ocho archivos tracked modificados más `docs/email-alerts-validation.md`, comprobar inventario contra commit definitivo, sin push/PR y conservando T4/Windows pendientes, el usuario responde literalmente:
> si

Se levanta «no comitees» exclusivamente para esa sexta unidad local, con mensaje `feat(settings): clarify email setup and document manual evidence`. Padre esperado `3efb171441b31efba68c5c184172d21ebc4ab9f3`, cinco commits anteriores intactos. El informe ignorado por regla global `docs/*` se añadirá explícitamente con `git add -f -- docs/email-alerts-validation.md`, sin cambiar gitignore ni incluir imágenes/README externos. Índice limpio antes del stage y diff --check correcto. Código T7/inventario preservado desde L41; no se inventa RED ni se relanzan verificadores históricos ni suites por recuperar contexto. Comprobaciones de esta integración: diff/stage acotado, correspondencia automática de inventario con árboles de fuente staged y luego CLI --check de HEAD definitivo. Cualquier fallo bloquea completar T9 hasta resolverse sin reescribir historia. La unidad supera aproximadamente400 líneas contando informe/ODD; nueve archivos ya acordados y propósito cohesivo, sin decidir PR ni reducir evidencia para encajar. RDD se evaluará sobre el candidato completo incluyendo informe antes de materializar, sin heredar T1/T6. Sin app, instalaciones, envíos ni datos personales. #245 no cerrada. El hash definitivo, resultado RDD y checks postcommit constarán en Engram para no necesitar amend ni otro commit solo de hash. Risk: none (T7 ayuda localizada/visibilidad específica de email, helper compartido intacto; resto documentación).

**L48 — Checks de la sexta unidad antes de materializar.** Stage explícito de nueve archivos, incluyendo informe ignorado mediante -f solo a su path; sin cambios ajenos ni unstaged. Diff staged --check exit0. Inventario contrastado con exports canónicos extractTs/extractRust/renderInventory sobre árbol staged: PASS exit0,115fuentes, src `a6611ce4d2ddd91d9ebb59c0daa490ed4e5c1be7`, Rust `dad04320e4e63be2f385936e96dc661c54d5d078`; inventario del índice y worktree idénticos. Assess nativo con nueve paths completos: RDD on, medium,467líneas en ese momento, reviewDue=false/under_budget, independentVerifier=false, outcomeunknown; sin START/captura/autoridad reutilizada. Se incorpora esta evidencia documental a la misma sexta unidad; solo crece ODD, árboles fuente inalterados. Checks T7 históricos L41 siguen referidos, no relanzados. El commit materializa T9, sin afirmar aquí un hash autorreferencial ni resultado CLI postcommit todavía no observado; ambos se registrarán en Engram al comprobar HEAD definitivo. Las pendientes de T4/Windows y el no cierre de #245 permanecen vigentes. Sin push/PR ni amend.

**L49 — Reanudación documental y petición actual (literal).**
> Retomemos Quorb #245 siguiendo ODD.
>
> Recupera Engram, especialmente el resumen 7031 y el índice 6953
> con sus seis páginas del documento. Lee completo
> odd/tasks/245-email-alerts.md y reconcilia rama, HEAD, índice
> y cambios antes de escribir.
>
> HEAD esperado: 7aeb3295c02dffee9331234689d316df1dd89f79.
> Seis commits; los dos últimos locales. Último estado comprobado limpio.
> La revisión nativa del sexto commit está aprobada y consumida:
> no la reutilices ni relances verificadores históricos.
>
> Actualiza la documentación de evidencia:
> - Revisa los nombres ACTUALES de las capturas en
>   [external-screenshots].
> - No reutilices la numeración antigua: el usuario las renombró.
> - Las actuales 3.png y 4.png son visualmente redundantes;
>   no borres ni muevas ninguna.
> - Capturas históricas: commit a45f646ca046d9ac86fd6bd29ba177085b15f566,
>   ejecución «pnpm:dev», según confirmación humana.
> - macOS Tahoe 26.7.1 (25G241), Mac local, sin VM.
> - Las nuevas capturas de ayuda T7 ya fueron revisadas;
>   identifica sus nombres actuales por contenido.
>
> Actualiza docs/email-alerts-validation.md, docs/email-alerts.md,
> ODD y Engram, distinguiendo observado, confirmado y no acreditado.
> No nuevos envíos, arranque de app, instalaciones ni datos personales.
> Usa npm/package-lock.json para el trabajo actual.
>
> Primero terminemos y comprobemos esa actualización.
> Después abordaremos el commit documental, push a mi fork
> ludevdot/quorb y creación de PR, confirmando el destino de la PR
> antes de publicar. Sin amend ni force-push.
>
> Windows sigue pendiente del owner. No declares cerrada #245.

**Reconciliación previa:** mem_context → búsqueda quorb/245 → resumen7031 e índice6953 → seis páginas7003/7004/7005/7006/7007/7009 recuperadas. Concatenación108820caracteres; archivo completo leído por páginas, SHA256 `b43b462a5452cf83e97e41abc5efb60e721047555ccd2e7060b1d8504b552afb`, coincide con índice. Git confirma rama/HEAD esperados, seis commits e índice/worktree limpios; tracking origin en a45f646, ahead2, sin fetch ni reconsulta remota. Remotes origin=ludevdot/quorb y upstream=egdev6/quorb; destino de PR aún no decidido. Revisión sexta unidad `review-67341bc9f1bbb5e7`, aprobada y consumida según Engram7012/7031; no STATUS/captura ni autoridad reutilizada.

**Descubrimiento acotado:** explorador `mw9n5bkr-1-xhed` inspeccionó carpeta/imágenes actuales y documentos, sin escribir ni ejecutar app/tests. Raíz observada: `1.png`, `2.png`, `3.png`, `5.png`, `6.png`, `7.png`, `recepcion.png`; `4.png` no está en raíz, sí `no/4.png`. Se registra la diferencia con la referencia humana anterior sin inferir quién/cuándo la movió; no se mueve/borra ningún original. Explorador considera `3.png` y `no/4.png` visualmente redundantes; no implica identidad binaria. Parent leyó directamente1/2: ayuda nueva de remitente y ayuda breve de prueba T7, clave enmascarada y sin aviso Linux en la vista macOS, estado sin solicitud en esta sesión. Esto corrige la incertidumbre del explorador sobre T7; el recorte2 no muestra consentimiento, no atribuirle off. Capturas históricas con feedback403/aceptado/recepción se distinguen de estas nuevas visuales. macOS Tahoe26.7.1(25G241), Mac local sin VM y procedencia histórica a45f646 mediante «pnpm:dev» son confirmaciones humanas; no hash de binario ni limpieza histórica observados. Fecha/aislamiento y trazabilidad independiente siguen sin acreditarse. T10 en curso al registrar L49; checks documentales pendientes en ese momento, sin RED significativo para documentación pasiva ni suites históricas.

**L50 — T10 comprobada, sin entrega todavía.** Actualizados `docs/email-alerts-validation.md` y `docs/email-alerts.md`: nombres/ubicaciones actuales, visuales T7 en1/2, redundancia3/no/4 sin tocar originales, procedencia histórica humana a45f646/«pnpm:dev», macOS Tahoe26.7.1(25G241) Mac local sinVM y límites de artefacto/fecha/aislamiento. Se conservan observado/confirmado/no acreditado y pendientes Windows/disposición owner; no declara cierre#245. Referencias y advertencias históricas no se convierten en hechos actuales.

Comprobación estructural final exit0: UTF-8/newline, tablas y enlaces locales de ambos docs, contenido requerido y ausencia de referencias obsoletas al inventario, existencia de archivos citados y ausencia de4enraíz, diff--check, HEAD/6commits/índice vacío y solo3paths documentales modificados. Primer script produjo AssertionError por prohibir cualquier `/Users/`, incluso el ejemplo genérico `/Users/$(id -un)` preexistente en la propuesta histórica: no era un dato personal nuevo ni un defecto del documento. Se ajustó la aserción a la ruta personal real y el script corregido con `set -e` pasó; el wrapper inicial terminó0 por ejecutar después otro comando, no se toma ese0 como éxito del check fallido. No tests funcionales ni RED nuevos aplicables a documentación pasiva; no se relanzaron suites/verificadores históricos. Fuente `src/`, Rust, inventario i18n y manifiestos/lock npm intactos, comprobado por alcance exacto del diff. RDD on: assess actual3paths/382líneas, risk/nativeRisk passive, reason non_executable_only, reviewDue=false, structuralReadbackOnly=true, independentVerifier=false; outcome unknown para este candidato nuevo, no se hereda aprobación sexta ni se hace inspect/START/captura.

T10 documental completada. Espejo íntegro paginado en6953/7003/7004/7005/7006/7007/7009 se actualiza y comprueba por lectura exacta antes de responder; hash final queda en índice Engram sin otro cambio autorreferencial. HEAD sigue7aeb329, seiscommits, últimos2locales según tracking sin reconsulta remota. Sin stage/commit/push/PR, amend, force-push, app, instalaciones, nuevos envíos o modificación de datos/imágenes/README externos. Siguiente fase separada por petición literal «Primero terminemos y comprobemos esa actualización. Después abordaremos el commit documental, push a mi fork ludevdot/quorb y creación de PR, confirmando el destino de la PR antes de publicar.»; destino/base y estrategia de PR todavía no acordados. T4 parcial: Windows y disposición final del owner pendientes, no exigir más verificaciones/VM para reconocer evidencia ya aportada. Risk: none (solo documentación pasiva, sin cambios de código ni contratos compartidos).

**L51 — Privacidad y autorización nueva de amend local.** El usuario exige que la PR no publique datos del desarrollador y señala una ruta personal; el valor privado se omite deliberadamente de esta cita pública. Confirmación posterior literal:
> permito amend, el force push lo haremos cuando de el ok y este todo revisado. mi ultimo commit en mi fork fue: a45f646ca046d9ac86fd6bd29ba177085b15f566

Autorizado amend local para sanear sexta unidad; NO push/force-push/PR. Git remoto read-only confirma rama del fork en a45f646; HEAD inicial7aeb329, padre3efb171, cinco commits anteriores intactos, índice vacío y tres cambios documentales propios pendientes. Respaldo privado en `.git/245-privacy-amend.m4pyf8/`: HEAD anterior, parche binario de cambios pendientes y ODD original del sexto commit; no se añade al repositorio. Mantener los cambios documentales pendientes fuera del amend, salvo redacción de sus rutas privadas en el worktree. La aprobación consumida de la sexta unidad original no aprueba la unidad saneada ni se reutiliza.

Explorador read-only `mw9nzawk-2-arwr` confirma rutas concretas del usuario en ODD y ausencia de otros contactos personales concretos en los tres documentos; no pudo leer diffs históricos con su inventario. Parent comprobó atribución: rutas concretas ausentes en cuarta/quinta unidad, presentes en sexta. Ejemplos genéricos de home, fixtures sintéticos y destinos públicos GitHub no son datos privados del entorno; se conservan. Versión macOS es contexto técnico de validación solicitado expresamente para la evidencia, no una ruta/identidad personal; no suprimirla por inferencia. Las citas históricas públicas con rutas personales quedan redactadas de forma explícita, originales solo en respaldo/memoria privada. Se prepara una única corrección y verificación acotada de privacidad, no se relanzan verificadores de comportamiento históricos.

**L52 — Saneamiento local completado, sin publicación.** Seis referencias privadas del ODD del sexto commit original se sustituyen por `[external-screenshots]`; las siete del ODD del worktree también se redactan. La copia pública declara explícitamente la redacción de citas, sin alterar los originales privados. Preflight de conteo esperado9 falló antes de mutar al observar7; corregido el conteo exacto7, sin pérdida de datos. Stage limitado al blob de HEAD saneado mediante hash-object/update-index: soloODD6adiciones/6eliminaciones, sin incorporar los cambios documentales pendientes. Amend autorizado materializa `33bc5d990f946594772ae1fe87d4aafe8655a8ea`, parent3efb171 idéntico, seiscommits y primeroscincoIDs intactos. src/src-tauri/manifiestos/lock/inventario byteidénticos al sexto original. Índice vacío y hashes de tresdocumentos pendientes idénticos al manifiesto privado tras el amend, antes de añadir esta nota. El comando amend incluyó innecesariamente override hooksPath; comprobación posterior confirma sin hooksPath configurado ni scripts activos de commit, por lo que no se omitió ningún check existente. No repetir ese override.

Assess committedOnly del nuevo sexto frente3efb171: nativeRiskmedium, reviewDuefalse/under_budget, candidateconsumedfalse/outcomeunknown; escalado ítem2 por privacidad mantiene riskhigh/independentVerifiertrue. No inspect/START/captura ni aprobación heredada. Verificador nuevo `mw9o51by-3-0io7`, solo S29/T11: **cumplida en alcance autorizado**, ningún bloqueador reproducido, sin relanzar tests históricos. Contrasta exactamente seis reemplazos y unarchivo, primeros5IDs/parent, árbolesfuente/manifiestos/inventario, treshashesworktree e índicevacío; inspecciona1015líneasintroducidas/14snapshots/0binarios de doscommitslocales y documentos pendientes. Cero candidatos personales concretos en líneasintroducidas/documentospendientes; no certifica ausencia de toda forma imaginable de datos personales. Su script agregado terminó1 por cinco coincidencias solo en snapshots de contenido sin cambios (ejemplos genéricos y strings con forma de email), no en líneasintroducidas; los subprocessGit fueron0. Se conserva el fallo de la aserción auxiliar demasiado amplia, no se presenta como suite íntegramente GREEN ni se lanza otro verificador. Spot-check parent posterior exit0: HEAD/parent/delta/index, preservación de3docs porhash y ausencia de raíz privada en additions de2commits alcanzables/docsactuales; diff--check0. Testsfuncionales0, scratchverificador0, no nuevos probes históricos.

Baseline remotoa45f646 comprobado read-only al inicio y ancestro del HEAD nuevo: con ese estado, un futuro push normal sería fast-forward, no requiere force-push; NO se ejecuta ninguno y nueva aprobación humana sigue pendiente. Backups/objetos antiguos solo en Git local privado, no son ancestros del candidato saneado; no se borran. Versionado contiene metadatos públicos de repositorio/autoría y ejemplos sintéticos legítimos, no rutas personales del desarrollador en el delta local. No cambios de imágenes/README, app, instalaciones, correos, datos personales, force-push ni PR. T11 completada localmente; publicación sigue detenida hasta revisión/OK, destino/base/forma de PR sin acordar. T4/Windowsowner parciales, #245 abierta. Risk: item 2 (privacidad de contenido público); verificación nueva limitada S29 realizada con los límites indicados.

**L53 — Commit documental autorizado y pendientes por plataforma (literal).**
> nos quedaria hacer el commit de lo que tenemos ahora. Windows/Linux continua pendiente, y se pedirán en la PR para que un compañero lo valide

HEAD33bc5d9 comprobado, índice vacío y tresdocumentos pendientes; solo unidad documental hija del sexto saneado, sin nuevo amend ni publicación. Se alinea docs/email-alerts.md con la guía reutilizable: sin inventario local ni resultados específicos de capturas, informe ejecutado y adjuntos en la PR. Windows y Linux quedan explícitamente pendientes de un compañero, solicitud en futuraPR; Windows conserva acuerdo S24 y Linux limitación keyutils/#106 sin ampliar alcance. ODD conserva trazabilidad saneada y no contiene rutas personales concretas. Commit propuesto `docs(alerts): clarify validation evidence and platform checks`, solo docs/email-alerts-validation.md,docs/email-alerts.md,ODD. Sin binarios/capturas ni cambios de src/Rust/manifiestos/inventario. Testsfuncionales/RED no aplican a documentación pasiva; checks de estructura/enlaces/privacidad/scope y RDD del candidato pendientes. Sin app, instalaciones, correos, push, force-push, PR ni cierre#245.

**L54 — Checks de la unidad documental antes de materializar.** Solo trespaths documentales acordados, enlaces/anclas/tablas/UTF8/newline/privacidad correctos; ningún nombre de imagen local ni dependencia de Engram en las dos guías. Windows/Linux explícitamente pendientes, solicitud de compañero en la futuraPR, #106 sin ampliar. diff--check exit0; HEAD33bc5d9 y fuentes/manifiestos/inventario intactos, índice limpio antes del stage. RDD assess actual3paths448líneas: nativeRisk/riskpassive, non_executable_only, reviewDuefalse, structuralReadbackOnlytrue, independentVerifierfalse, outcomeunknown para este candidato documental. No START ni tests/suites/verificadores históricos; checks estructurales suficientes para documentación pasiva, sin RED significativo. Se incorpora esta evidencia a la misma unidad documental; el hash final y estado limpio se comprobarán al materializar y constarán en Engram sin amend autorreferencial. El volumen supera la orientación400 por guía/ODD acumulados y eliminación del informe local obsoleto; se conserva una única unidad documental cohesiva sin partirla artificialmente ni decidir estrategia de PR. El commit no autoriza push/PR ni cierre#245. Risk: none (documentación pasiva, sin tocar comportamiento/contratos/código compartidos).
