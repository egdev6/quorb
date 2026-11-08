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
4. Si quieres, pulsa **Enviar prueba**: guarda la configuración del formulario
   y hace una única solicitud de prueba sin datos de consumo. No activa email
   y funciona aunque Alertas global esté desactivado. Si guardar falla, no envía.
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
texto de proveedor, medidor, ventana, porcentaje y tipo de evento según el
idioma configurado (es/en; el inglés conserva los literales originales). No incluye
nombres/identificadores de cuentas, etiquetas configurables, informes completos,
prompts, código ni sesiones. Resend procesa también las direcciones personales.
La prueba no incluye datos de consumo. El último estado vive solo en memoria;
no se guardan eventos ni payloads. La API no devuelve claves ni respuestas crudas.

El estado aceptado significa **Solicitud aceptada por Resend**, no entrega en
la bandeja de entrada. Fallos de autenticación (401), remitente/destinatario o
dominio (403), petición (otros 4xx), límite (429) y servicio (5xx) se distinguen
sin mostrar la respuesta del servidor. Un error de transporte/timeout deja la
aceptación incierta y nunca provoca un reintento automático.

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

Estado de la evidencia: el owner aceptó como **método** de validación (S23–S24)
la combinación de comprobación manual más las pruebas automatizadas con HTTP
simulado ya existentes; no exige VM, simulación integrada en la app ni tests de
Ajustes montado. Eso no aprueba por sí las capturas concretas aportadas: la
evidencia manual macOS (capturas y confirmaciones humanas) se obtuvo en el
Mac local del usuario, **no en una VM**, según su confirmación expresa. No se
ha acreditado separación de configuración o llavero dentro de ese Mac. La
evidencia está inventariada con sus límites en
[`email-alerts-validation.md`](email-alerts-validation.md), que distingue lo
observado en imágenes, lo confirmado por el usuario y lo no acreditado, y
sigue sujeta a la disposición del owner. Las
capturas muestran los textos de ayuda previos a T7, por lo que no validan
visualmente la ayuda actual; eso no invalida la evidencia de estados y feedback.
El procedimiento aislado del final de este documento es una propuesta histórica
opcional, no un requisito para reconocer esa evidencia. `npm run app:dev` usa la
config y el llavero reales del usuario y podría causar envíos reales: no se
propone como paso de verificación y no se repiten envíos para documentar.

Ajustes (S12–S16, S21–S22):

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
- [ ] Feedback de aceptación/error: la evidencia visual ya aportada muestra
      «Solicitud aceptada por Resend» en verde y el rechazo 403 en rojo,
      sanitizados (capturas previas a T7, inventariadas en
      [`email-alerts-validation.md`](email-alerts-validation.md)). El
      comportamiento sanitizado queda además cubierto por los tests HTTP
      existentes. No se exige un procedimiento nuevo de simulación integrada
      para reconocer esa evidencia; no repetir envíos reales para documentar.

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

Windows (S24, verificación del owner si no hay acceso):

- [ ] Comprobar en Windows el guardado, presencia tras desactivar/reactivar
      y eliminación de una clave sintética aislada, sin enviar correos,
      con el almacén del sistema correspondiente
      (el backend `keyring` cambia por sistema operativo).
- [ ] Sin acceso a Windows en esta PR: dejar la casilla para verificación del
      owner, como acordó en la respuesta del owner (S24); ninguna prueba
      automatizada sustituye esta comprobación del llavero real.

## Propuesta histórica opcional: procedimiento macOS aislado (no ejecutado)

Esta propuesta del agente se redactó antes de disponer de evidencia manual y
**nunca se ejecutó**. No describe el entorno del usuario: él confirmó que
trabaja y realizó la comprobación en su Mac local, **no en una VM**. No es un requisito del owner ni de esta PR: el owner aceptó el
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
como parte del método de validación aceptado (S23–S24). Las capturas
`6.png`/`7.png` y `recepcion.png`, previas a T7, están inventariadas en
[`email-alerts-validation.md`](email-alerts-validation.md) y siguen sujetas a
la disposición del owner. Los tests HTTP
locales indicados arriba siguen siendo la vía acreditada de comprobar
aceptación/fallo sanitizado, sin infraestructura nueva montada. Una VM
desconectada, una clave falsa o un fallo de transporte no acreditarían
aceptación simulada.

Registrar por paso: candidato/hash del artefacto, macOS, aislamiento, acción,
resultado esperado/observado, captura sanitizada y PASS/FAIL/PENDING. Sin acceso
a Windows, su guardado/desactivación/reactivación/eliminación en Credential
Manager queda expresamente **pendiente del owner** (S24). Ningún resultado macOS
lo sustituye. #245 permanece abierta hasta completar la evidencia requerida.
