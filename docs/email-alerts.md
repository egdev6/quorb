# Avisos por email con Resend

Implementación incremental de [#245](https://github.com/egdev6/quorb/issues/245).
El alcance vigente y la evidencia de cada unidad están en
[`odd/tasks/245-email-alerts.md`](../odd/tasks/245-email-alerts.md).

## Credenciales

La clave `resend_api_key` usa el almacén seguro y los comandos de secretos
existentes. No se guarda en JSON ni se devuelve su valor al frontend. No hay
fallback a texto plano. Resend no es un proveedor de consumo ni una cuenta extra.

El lector exclusivo de email distingue una clave ausente o vacía de un fallo de
lectura del almacén. Los fallos se comunican sin diagnósticos internos del backend.
No cambia `secrets::get()` ni la lectura o migración de los proveedores existentes.

**Linux:** si el backend efectivo es keyutils, la clave puede no sobrevivir a un
reinicio. La validación y resolución de ese almacenamiento pertenece a #106, no
a esta integración.

## Configurar y probar en Ajustes → Alertas

1. Lee las advertencias de disponibilidad, privacidad y límites del correo.
2. Introduce remitente y destinatario y guarda tu API key mediante el campo
   oculto de Resend. No se puede recuperar el valor guardado desde la interfaz.
3. Marca el consentimiento explícito. Guardar por sí solo no habilita email.
4. Si quieres, pulsa **Enviar prueba**: guarda los campos del formulario,
   incluidos consentimiento, remitente y destinatario, conservando los valores
   ya guardados de los interruptores de Alertas global y email, aunque el
   borrador muestre otros. Después hace una única solicitud de prueba sin datos
   de consumo. No activa ni desactiva los avisos automáticos y funciona aunque
   Alertas global esté desactivado. Si guardar falla, no envía.
5. Para avisos automáticos, activa tanto email como Alertas global y guarda.
   Desactivar la notificación nativa no desactiva el email.

El resultado sanitizado más reciente se muestra en Ajustes, también cuando
proviene de un aviso automático. Revocar consentimiento desmarca la activación
en el formulario; el backend exige consentimiento en cualquier envío.
Los cambios de configuración se aplican al guardarlos. Desactivar email conserva
la clave; **Quitar** elimina la clave del almacén e impide nuevas solicitudes.
Una solicitud que ya empezó no puede retirarse de Resend.

## Frontera de envío

El envío usa `POST https://api.resend.com/emails` exclusivamente desde Rust,
con la clave en `Authorization: Bearer`. No amplía la CSP ni admite un endpoint
configurable. Un intento usa un cliente nuevo, HTTP/1, sin redirecciones ni
reintentos, con timeout de 10 segundos; no hay cola ni replay.

La configuración no secreta en `alerts.email` contiene `enabled`, `consent`,
`sender` y `recipient`, inicialmente desactivados/vacíos. Se admiten direcciones
simples, sin nombre visible ni listas. Guardar direcciones no activa email.
Ambos interruptores (Alertas y email) y el consentimiento son necesarios para
avisos automáticos; la notificación nativa es independiente. La prueba explícita
requiere consentimiento y configuración válida, pero no los interruptores.

El remitente lo introduce el usuario. Si no dispone de dominio propio, puede
usar `onboarding@resend.dev` exclusivamente para pruebas hacia el correo asociado
a su cuenta de Resend. Para otros destinatarios necesita un dominio verificado
y un remitente autorizado de ese dominio. Quorb muestra esa ayuda, pero no
rellena el campo ni proporciona un remitente fijo. Se admiten direcciones simples,
sin nombres visibles ni listas.

La ayuda de **Enviar prueba** recuerda que guarda los cambios, envía una prueba
sin datos de consumo, requiere consentimiento y clave guardada y no activa los
avisos automáticos. Sigue funcionando con Alertas global desactivado.

El aviso sobre volver a introducir la clave después de reiniciar solo se muestra
en Linux, con lenguaje orientado al usuario. Los detalles de keyutils, la ausencia
de fallback a texto plano y el seguimiento en #106 se conservan en esta
documentación, no en la ayuda del formulario.

El payload incluye únicamente el sobre (remitente/destinatario), asunto y
texto plano en el idioma configurado (es/en). Los avisos automáticos muestran
el nombre legible del proveedor y el porcentaje observado, nunca la clave interna
`window` ni los identificadores técnicos del medidor. El evento interno conserva
su contrato e identidad, sin cambiar detección ni deduplicación. No incluye
nombres/identificadores de cuentas, etiquetas configurables, informes completos,
prompts, código ni sesiones. Resend procesa también las direcciones personales.
La prueba conserva su asunto y cuerpo, sin datos de consumo. El último estado
vive solo en memoria; no se guardan eventos ni payloads. La API no devuelve
claves ni respuestas crudas.

### Contenido de los avisos automáticos (#263)

Cada evento tiene su propio asunto y cuerpo completos en los recursos nativos
ES/EN. El aviso de consumo explica que se ha alcanzado el umbral configurado,
no que se haya agotado el límite. El aviso de bajada describe lo observado por
debajo del umbral; no demuestra un reinicio del periodo ni disponibilidad del
servicio. El porcentaje es el observado, no el umbral de configuración.

Se trunca a dos decimales, sin redondear ni conservar ceros finales: `12.345`
se muestra como `12,34 %` / `12.34%` y `89.996` como `89,99 %` / `89.99%`,
también al bajar del umbral 90. `99.999` permanece en `99,99 %` / `99.99%`;
solo el 100 exacto se muestra como `100 %` / `100%`. Si un valor superior a 100
se truncaría a 100 (por ejemplo, `100.001`), se muestra `100,01 %` / `100.01%`.

La descripción se decide por proveedor y medidor juntos mediante una lista
conservadora y explícita, enumerada también en los tests HTTP:

- Claude: `weekly`, `weekly_opus`, `weekly_sonnet`, `weekly_apps` (límites semanales).
- Codex y Z.ai: `weekly` (límite semanal).
- OpenRouter: `key_limit_daily`, `key_limit_weekly`, `key_limit_monthly` (diario,
  semanal, mensual).
- Anthropic API y OpenAI API: `budget_monthly` (presupuesto mensual).
- OpenCode Go: `five_hour`, `weekly`, `monthly` (5 horas, semana, ciclo de facturación).

El resto usa las variantes genéricas completas, incluso `session`, los modelos
proyectados a `usage`, `weekly` de Grok y `five_hour` de Z.ai; no se reconstruyen
periodos, modelos ni etiquetas a partir de información que el evento no contiene.
Los tests simulan HTTP local y comprueban asuntos y cuerpos completos en ambos
idiomas, no entrega real. Las comprobaciones manuales de #245 quedan fuera.

El estado aceptado significa **Solicitud aceptada por Resend**, no entrega en
la bandeja de entrada. Los errores se presentan mediante estados sanitizados:

| Respuesta | Estado |
| --- | --- |
| 2xx | `Accepted`: solicitud aceptada, no entrega confirmada. |
| 401; 403 con `name: invalid_api_key` | `AuthenticationError`: fallo de autenticación. |
| 422 con `name: invalid_from_address` | `SenderRejected`: remitente rechazado. |
| 403 sin el nombre reconocido `invalid_api_key` | `SenderRejected`: conserva la clasificación anterior para rechazos de remitente o dominio. |
| 429 | `RateLimited`: límite de solicitudes. |
| 5xx | `ServiceError`: fallo del servicio. |
| Cualquier otro estado HTTP, incluido 422 sin `invalid_from_address` y las redirecciones | `RequestRejected`: petición rechazada. |
| Error de transporte/timeout antes de recibir la respuesta | `AcceptanceUnknown`: aceptación incierta. |

Solo se deserializa `name` a un conjunto cerrado (`invalid_api_key` e
`invalid_from_address`) para las dos correcciones de 403/422. No se interpretan
mensajes libres ni se muestran cuerpos, direcciones, cabeceras o secretos
remotos. Los nombres desconocidos, JSON no válido, cuerpos mayores de 4 KiB
o fallos de lectura conservan el estado de fallback HTTP de la tabla. La lectura
del cuerpo mantiene el timeout del intento; nunca provoca reintentos automáticos.

Referencia de protocolo: [Send Email](https://resend.com/docs/api-reference/emails/send-email)
y [Errors](https://resend.com/docs/api-reference/errors). Solo se consultó la
documentación: no se hicieron envíos reales.

## Identidad, memoria y avisos automáticos

El widget pasa a email exactamente los eventos emitidos por `detectAlerts`,
después de actualizar su memoria existente y lanzar los avisos locales. La
identidad sigue siendo proveedor (incluida su cuenta local), medidor,
`windowKey(resetsAt)` y tipo (umbral o reinicio). No se añade otro deduplicador,
registro persistente, cola ni memoria para email.

Un umbral ya recordado no se reenvía al repetir el sondeo, traducir una etiqueta,
fallar Resend o activar email más tarde. Una ventana nueva puede emitir otro
aviso. Los reinicios conservan la detección de transición existente entre el
informe anterior y el nuevo; no se crea un registro remoto de reinicios. Se
conserva la limpieza de memoria y la compatibilidad de claves antiguas del
aviso local. No se promete deduplicación remota tras borrar/perder esa memoria,
ni entrega exactamente una vez.

La cuenta se usa solo para identidad local: al enviar se proyecta el proveedor
base, sin sufijo de cuenta, nombre personal ni etiqueta configurable. El medidor
exportado usa solo el ID real del informe si cumple `[a-z0-9_]{1,64}`; si falta
o no cumple ese formato, se representa como `usage`. Nunca se exporta el
fallback local a la etiqueta, aunque parezca un ID válido (por ejemplo,
`alice_private`). La etiqueta sigue formando parte de la identidad, memoria
y texto locales de los medidores legacy sin ID; esos comportamientos no cambian.

Los fallos remotos no bloquean notificaciones ni efectos y no pasan por el
mecanismo de reintentos de lectura de consumo. Cada evento emitido causa como
máximo una llamada al envío, con ambos interruptores, consentimiento y
configuración válidos. El backend vuelve a comprobar los permisos de envío y
la presencia de la clave al atender la solicitud.

## Verificación de credenciales

Los tests deterministas usan resultados sintéticos: ausencia, valor vacío,
lectura válida y fallo del backend. No requieren claves reales ni envían correo.
Los smokes de llavero reales mantienen sus restricciones de aislamiento; no son
prueba de persistencia validada en todos los sistemas operativos.

## Checklist de comprobación manual (PR #245)

Combinación de evidencia acordada con el owner (fuente D, S23–S24): comprobación
manual más pruebas automatizadas. Tres niveles distintos, con límites explícitos:

| Nivel | Qué acredita | Cómo |
| --- | --- | --- |
| Automatizado: HTTP local | Las seis reglas de interruptores (S23) y el protocolo de envío. Servidor sintético en `127.0.0.1` de `email.rs` y el coordinador real de guardado en `email.test.ts`; sin Resend ni correo real. | `cargo test --lib email::tests`, `npx vitest run src/lib/email.test.ts src/lib/email-dispatch.test.ts` |
| Manual: UI montada | Solo lo visual y el cableado (layout, advertencias, feedback, estados en pantalla). | Checklist de esta sección con capturas en la PR |
| Manual: llavero del SO | Que la clave sobrevive en el almacén real de cada plataforma. | Ningún test automatizado la cubre; comprobación manual por Sistema Operativo |

La lógica de interruptores vive en funciones puras y gates con tests directos;
no repite esa verificación manual. Cobertura de regresión nueva de T6, descrita
con sus límites: un test de `email.test.ts` pinnea el coordinador real de
guardado — `patchEmail` → `runMixedSave` → `api.saveConfig` con el puente
Tauri mockeado — y comprueba que guardar con email deshabilitado conserva
consentimiento y direcciones y que el puente emite exactamente un
`save_config`, nunca `set_secret` ni un borrado de clave. No añadió
comportamiento nuevo (sin RED de producto aplicable: era una brecha de
cobertura); acredita la orquestación, no la persistencia del llavero del SO
ni la UI montada. El test de Rust
`email::tests::backend_gates_disabled_email_and_reuses_available_key` cubre el
gate backend (envío deshabilitado rechazado antes de leer llavero o red, sin
ninguna petición) y la reutilización de la clave disponible al re-habilitar
(exactamente dos peticiones HTTP: activado y re-habilitado).

El owner aceptó como **método** de validación (S23–S24) la comprobación
manual más las pruebas automatizadas con HTTP simulado existentes; no exige
VM, simulación integrada en la app ni tests de Ajustes montado. Esto no aprueba
por sí solo una ejecución concreta. La [guía de validación](email-alerts-validation.md)
explica cómo distinguir lo observado, lo confirmado por quien realiza la
comprobación y lo no acreditado. La checklist ejecutada, la procedencia, los
resultados y las capturas se presentan **en la PR**, no mediante nombres de
imágenes locales en esta guía. Windows y Linux siguen pendientes de validación
por un compañero; se solicitará expresamente en la PR.
El procedimiento aislado del final es una propuesta histórica opcional, no un
requisito del owner. `npm run app:dev` puede usar configuración y llavero
personales y causar envíos reales: no se propone como paso de verificación ni
se repiten envíos para preparar la documentación. El desarrollo usa npm y
`package-lock.json`.

Ajustes (S12–S16, S21–S22):

Estas casillas son una plantilla, no resultados de una ejecución. Se completan
en la PR con observaciones, confirmaciones y límites; una imagen estática no
acredita todas las transiciones. La validación de Windows y Linux sigue pendiente.

- [ ] Guardar configuración válida sin marcar el interruptor de email:
      la configuración se guarda y el email sigue desactivado.
- [ ] Advertencias visibles: disponibilidad (Quorb abierto y equipo despierto),
      privacidad (qué datos salen hacia Resend), límite de aceptación
      («Solicitud aceptada», no entrega) y aviso de Linux mostrado solo en
      Linux (sin jerga técnica; los detalles técnicos quedan en esta
      documentación).
- [ ] Consentimiento: sin marcarlo, el botón de prueba no permite enviar;
      al marcarlo y completar configuración/clave, comprobar su disponibilidad.
      Los mensajes y estados visibles deben seguir el idioma de la app.
- [ ] Clave: con campo vacío o clave en blanco, la prueba no puede enviarse
      (botón deshabilitado o `KeyMissing` sanitizado). Guardar la clave no
      la muestra de nuevo; **Quitar** la elimina y bloquea envíos.
- [ ] Desactivar email y guardar: el estado se muestra y la clave sigue
      indicada como guardada al reactivar, sin reintroducirla. No pulsar
      «Enviar prueba» contra Resend para verificar este punto.
- [ ] Feedback de aceptación/error: presentar en la PR las capturas disponibles
      de «Solicitud aceptada por Resend» en verde y del rechazo sanitizado en
      rojo, indicando su procedencia y alcance. Los tests HTTP cubren el
      protocolo, no sustituyen la evidencia visual. No se exige simulación
      integrada nueva ni repetir envíos reales para documentar.

Avisos automáticos (S2, S3, S11, S18):

Estas reglas se comprueban con eventos y HTTP simulados, no esperando correos
reales en una bandeja de entrada. Su resultado automatizado no marca casillas
manuales ni acredita el cableado de la aplicación montada:

- Ambos interruptores activos: un intento con el payload mínimo traducido,
  conservando el aviso local.
- Repetir el sondeo sin ventana nueva: ningún intento adicional.
- Notificación nativa desactivada: email independiente del aviso local.
- Email desactivado: ningún envío automático; aviso local independiente.
- Alertas global desactivado: ni envíos automáticos ni avisos locales.
  Para volver a emitir deben habilitarse Alertas global y email y producirse
  un evento nuevo según la memoria existente.

Windows y Linux (validación pendiente por un compañero, solicitada en la PR):

- [ ] Comprobar en Windows el guardado, presencia tras desactivar/reactivar
      y eliminación de una clave sintética aislada, sin enviar correos,
      con el almacén del sistema correspondiente
      (el backend `keyring` cambia por sistema operativo).
- [ ] Linux: comprobar la interfaz y el almacén real de credenciales, indicando
      backend efectivo, conservación/eliminación y comportamiento tras reinicio
      si se comprueba. Mantener explícita la limitación de keyutils: su
      resolución sigue en #106, no se amplía aquí el alcance de #245.
- [ ] Solicitar en la PR validación de ambas plataformas por un compañero;
      ninguna suite macOS ni prueba con almacén sintético la sustituye.
      Windows conserva el acuerdo de verificación del owner (S24).

## Propuesta histórica opcional: procedimiento macOS aislado (no ejecutado)

Esta propuesta del agente se redactó antes de disponer de evidencia manual y
**nunca se ejecutó**. Quien realizó la comprobación confirmó que fue en
macOS, **sin VM**. La propuesta no describe esa comprobación ni es un
requisito del owner o de esta PR: el owner aceptó el
método manual + HTTP simulado según S23–S24 (ver
[`email-alerts-validation.md`](email-alerts-validation.md)); la evidencia
manual actual y sus huecos siguen sujetos a la disposición del owner. Se
conserva por su
detalle técnico para quien quiera aislar una comprobación futura.

**No arrancar la app en el usuario habitual.** Cambiar `HOME`, el identificador
aparente del formulario o el llavero por defecto del usuario habitual no prueba
el aislamiento. El servicio de credenciales es `es.egdev.quorb` y la cuenta de
Resend es `resend_api_key`; no hay un override de aislamiento en la app.
La configuración se resuelve con Tauri `app_config_dir()`. Además, al arrancar
el widget consulta proveedores; no basta mantener email desactivado.

Este procedimiento permite comprobar visuales, guardado y presencia/eliminación
de una clave sintética, **no** aceptación simulada en la app. Es una propuesta
para ejecución por el owner: preparar una VM, instalar herramientas o cambiar
red/usuarios del host no forma parte de esta sesión ni está autorizado aquí.
Si no hay una VM macOS desechable ya preparada con los requisitos existentes,
parar y acordar su provisión; no sustituirla por `HOME` temporal.

### 1. Puertas previas al primer arranque

1. Usar una VM macOS desechable con usuario local nuevo, sin Apple ID/iCloud,
   migración, restauración, cuentas de proveedores ni llaveros importados.
   No usar una copia del perfil personal. Registrar versión de macOS y nombre
   de la instantánea inicial, sin datos personales.
2. Desactivar en el hipervisor carpetas compartidas, montaje de discos del host,
   portapapeles, arrastrar/soltar y sincronización de cuentas. Transferir solo un
   artefacto de Quorb del candidato comprobado, nunca `.git`, configuraciones,
   `.env`, sesiones, cachés de proveedores ni llaveros. Registrar SHA del commit
   y `shasum -a 256 <artefacto>` en origen y destino. No reutilizar un binario
   antiguo como prueba del candidato ni instalar dependencias para prepararlo.
3. Desconectar **todos** los adaptadores virtuales antes de arrancar Quorb:
   sin NAT, puente, host-only ni segundo adaptador. Registrar captura de la
   configuración del hipervisor. Loopback puede seguir disponible. Un proxy,
   DNS falso o el firewall de conexiones entrantes de macOS no equivalen a
   denegar todo el egreso. No conectar de nuevo mientras Quorb esté abierto.
4. Dentro del guest, antes de abrir el artefacto, registrar únicamente identidad
   y rutas (nunca valores de credenciales):

   ```sh
   id -un
   dscl . -read "/Users/$(id -un)" NFSHomeDirectory
   security default-keychain -d user
   security list-keychains -d user
   /sbin/route -n get default
   /sbin/route -n get -inet6 default
   ```

   Las rutas de llavero deben pertenecer al usuario nuevo del guest, sin llaveros
   personales/importados. La ausencia de rutas por defecto IPv4/IPv6 es evidencia
   auxiliar, no sustituye la desconexión comprobada en el hipervisor. Si hay
   conectividad o no se puede acreditar la separación, **no arrancar**.
5. Confirmar con Finder que el perfil nuevo no contiene estado previo de Quorb
   (`~/Library/Application Support/es.egdev.quorb` como ubicación esperada;
   confirmar la ruta efectiva al guardar), `.quorb`, sesiones de proveedores ni
   enlaces hacia datos externos. No leer el contenido de llaveros/configuración
   personales para compararlos. Conservar captura del estado inicial y revisión
   de estas puertas por quien ejecuta; ninguna casilla queda aprobada por leerlas.

### 2. Comprobación manual sin solicitudes de email

Solo tras pasar las cinco puertas, abrir el artefacto en el guest sin red.
No usar `npm run app:dev` en el host. Un artefacto ausente o no trazable bloquea
este paso; compilar o provisionar otro entorno requiere acordarlo por separado.

1. Abrir Ajustes → Alertas. Capturar estado inicial y advertencias en es/en.
   Mantener Alertas global y email desactivados; desactivar también todos los
   proveedores y guardar. La desconexión del guest protege el intervalo inicial
   en que los proveedores por defecto todavía están habilitados.
2. Introducir exclusivamente `sender@example.test`, `recipient@example.test` y
   una clave sintética de prueba (no una API key válida). Guardar sin habilitar
   email. Comprobar campo oculto y presencia indicada; no extraer el valor del
   llavero ni incluirlo en capturas/logs. El consentimiento no debe activarse
   por guardar. No pulsar **Enviar prueba**, incluso con una clave sintética.
3. Marcar consentimiento, guardar; activar/desactivar email y guardar manteniendo
   Alertas global desactivado. Capturar que desactivar no elimina la presencia
   de clave; reactivar sin reintroducirla. No inferir durabilidad del SO de la
   mera presencia en el formulario.
4. Cerrar Quorb completamente, volver a abrir en el mismo guest desconectado y
   comprobar presencia de la clave y configuración guardada. Capturar la ruta
   efectiva de config dentro del guest, sin publicar su contenido. Esto aporta
   evidencia de persistencia entre procesos en esa versión de macOS, no después
   de un reinicio del SO ni en otras plataformas.
5. Pulsar **Quitar**, comprobar ausencia indicada, cerrar/reabrir y confirmar
   ausencia y prueba bloqueada. Capturar el resultado, sin consultar el valor
   almacenado mediante `security find-generic-password -w`.
6. Cerrar Quorb. Conservar solo evidencias sanitizadas y la instantánea de prueba;
   no modificar ni borrar llaveros/usuarios del host. Eliminar VM/instantáneas
   es una acción destructiva separada, no un paso automático de esta guía.

### 3. HTTP simulado y límites pendientes

El endpoint de producción está fijado a `https://api.resend.com/emails` y no hay
inyección de respuestas en el comando de la app. No cambiar CSP, `secrets::get()`,
DNS, certificados de confianza ni TLS para hacer pasar una simulación por Resend.
Los tests locales indicados arriba acreditan aceptación/fallo sanitizado y las
reglas de interruptores; no prueban que el botón y feedback estén cableados en
la app abierta. SSR acredita el marcado, no esa interacción.

Por tanto, esta propuesta queda como alternativa histórica opcional: el owner
no exige una captura con simulación integrada ni la ejecución del procedimiento
como parte del método de validación aceptado (S23–S24). Las capturas y sus
resultados se presentan en la PR conforme a la
[guía de validación](email-alerts-validation.md), con procedencia y límites
explícitos; esta guía no depende de referencias a archivos locales.
Los tests HTTP locales indicados arriba siguen siendo la vía acreditada de comprobar
aceptación/fallo sanitizado, sin infraestructura nueva montada. Una VM
desconectada, una clave falsa o un fallo de transporte no acreditarían
aceptación simulada.

Registrar por paso: candidato/hash del artefacto, macOS, aislamiento, acción,
resultado esperado/observado, captura sanitizada y PASS/FAIL/PENDING. Sin acceso
a Windows o Linux, la comprobación de sus almacenes e interfaz queda
expresamente **pendiente de validación por un compañero**, que se solicitará
en la PR; Windows mantiene el acuerdo con el owner (S24). Ningún resultado
macOS sustituye estas comprobaciones. La limitación Linux de keyutils sigue
perteneciendo a #106. #245 permanece abierta hasta completar la evidencia requerida.
