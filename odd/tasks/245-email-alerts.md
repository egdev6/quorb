# ODD — #245: avisos por email con Resend
Objetivo: implementar el alcance aprobado de #245; rama `feat/245-email-alerts`, base `b82cf78`. Issue revalidada OPEN, `status:approved`, asignada únicamente a `ludevdot`; sin cambios posteriores del owner. T1 en curso, resto pendiente.
Entrega: `ask-on-risk` provisional; previsión de líneas no estimable hasta descubrir la implementación, acordar plan antes de superar 400 líneas sin presuponer PR encadenadas. Runners futuros, no ejecutados: `npm test`, `npm run typecheck`, `npm run build`, `cargo test` (desde `src-tauri/`).

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

## Tasks

- **T1** — S4, S5, S7, S8, S10, S17: ruta propuesta `src-tauri/src/secrets.rs`, puente existente de secretos y sus tests/docs; ampliar lista cerrada y almacenamiento reutilizando invariantes, accessor `Result` exclusivo de email sin cambiar `get`, tests ausencia/fallo y regresión de proveedores; riesgo de seguridad (ítem 2: clave/almacenamiento), commit propio separado; ruta: inline; estado: implementación GREEN, revisión nativa pendiente; RED salida 101 por símbolos ausentes, GREEN focalizado y suite Rust 501 correctas/1 ignorada/1 smoke real excluido, fmt correcto; verificación independiente sin defectos; commit: unidad de seguridad preparada.
- **T2** — S1, S2, S4, S6, S8, S10, S13, S17, S19, S20: ruta propuesta envío Rust/Tauri concreto y tests/docs asociados; HTTP simulado, remitente/configuración, cuerpo mínimo, timeout y errores sanitizados, un intento sin cola/replay, guardias de credenciales y CSP; estado: planificada/no iniciada; commit: pendiente.
- **T3** — S5, S6, S8–S10, S12–S17, S19, S20: ruta propuesta `src/Settings.tsx`, configuración/i18n existentes y tests/docs asociados; configuración concreta, opt-in, estado y botón de prueba, conservación/eliminación de clave y advertencias de disponibilidad, privacidad, Linux y entrega; unidad de commit 3; estado: planificada/no iniciada; commit: pendiente.
- **T5** — S2, S3, S8–S11, S18–S20: ruta propuesta `src/lib/alerts.ts`, `src/Widget.tsx` y tests/docs asociados; conectar avisos automáticos con identidad y memoria existentes sin persistencia nueva, global/email independientes de nativo, deduplicación y fallos remotos sin afectar avisos locales; unidad de commit 4, posterior a T3; estado: planificada/no iniciada; commit: pendiente.
- **T4** — S1–S20: evidencia en este ODD y verificación funcional/de seguridad independiente de la implementación; revisar credenciales en su unidad y comprobar integración completa después de T5, ejecutar checks autorizados y registrar resultados reales, límites y hallazgos antes de entrega; tarea de cierre, no commit artificial separado; estado: planificada/no iniciada; commit: evidencia vinculada a las unidades correspondientes, pendiente.

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
