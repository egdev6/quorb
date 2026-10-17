# Política de privacidad

[English](./privacy.en.md) · [Política de firma](./code-signing.md)

Quorb es una utilidad local con runtime para Windows, macOS y Linux, mantenida por
[Enrique Gómez Navarro (@egdev6)](https://github.com/egdev6).
Esta política describe el código revisado en `d097bc3`, no una auditoría de terceros,
una garantía de soporte en cada plataforma ni una aprobación de SignPath.

## Datos locales y credenciales

- `config.json` guarda nombres de cuentas, rutas, proveedores y preferencias;
  `history.json` guarda porcentajes de consumo, gasto, identificadores y marcas
  de tiempo. Usan los directorios de configuración/datos de Tauri para
  `es.egdev.quorb` (en Windows, `%APPDATA%\es.egdev.quorb`), sin cifrado propio.
  La interfaz también guarda navegación, preferencias y avisos de actualización
  en el almacenamiento local de su WebView.
- El historial se poda a 30 días al registrar lecturas, no al cerrar la app.
- Las API keys, tokens y cookies guardados usan el almacén del sistema bajo el
  servicio `es.egdev.quorb`: Credential Manager en Windows, Keychain en macOS
  y keyring del kernel (keyutils, feature `linux-native`) en Linux. No se garantiza
  persistencia entre sesiones/reinicios en Linux ni se acredita Secret Service
  con esta configuración. Los fallos de guardado se devuelven como error, sin
  fallback a JSON. La consulta de estado no devuelve valores secretos al frontend.
  Las cuentas adicionales tienen entradas propias.
- Quorb lee las sesiones de Claude, Codex y Gemini y la base de datos de Cursor
  para consultar consumo; no reescribe esos archivos. Gemini renueva tokens en
  memoria. En macOS, Claude puede leer `Claude Code-credentials` del Keychain
  si falta el archivo de la cuenta principal y no hay ruta explícita; puede pedir
  permiso. Ese respaldo no se usa para cuentas adicionales ni rutas explícitas.
- El login oficial puede crear archivos de sesión: las cuentas CLI adicionales
  usan por defecto `~/.quorb/accounts`, o la carpeta elegida. Pueden contener secretos.
- La migración desde `es.egdev.ai-usage` copia configuración/historial y traslada
  credenciales antiguas. Pueden quedar archivos, entradas o backups antiguos.

## Conexiones de red

Quorb consulta consumo, cuotas, planes y gasto de los proveedores activados.
No hay un intermediario alojado por Quorb; 9Router es un destino elegido por el
usuario. Las peticiones pueden incluir tokens, identificadores de cuenta/proyecto,
IP y versión de Quorb. El login de NaN envía el correo facilitado.

| Función | Destino |
| --- | --- |
| Claude y costes de Anthropic | `api.anthropic.com` |
| Codex y costes de OpenAI | `chatgpt.com`, `api.openai.com` |
| Gemini y renovación de tokens | `cloudcode-pa.googleapis.com`, `oauth2.googleapis.com` |
| Cursor, Copilot y OpenRouter | `cursor.com`, `api.github.com`, `openrouter.ai` |
| NaN y login por correo | `api.nan.builders`, `cloud-api.nan.builders`; enlaces HTTPS de `nan.builders` y sus subdominios; base/URL de consumo configurables |
| 9Router | URL configurable; por defecto `http://localhost:20128` |
| Actualizaciones nativas (Windows/Linux) | GitHub Releases y su infraestructura de descarga |
| Instalación asistida de Codex (Windows) | `registry.npmjs.org`, tras confirmación |
| Instalación de WebView2 (Windows) | Servicios de descarga de Microsoft cuando sea necesario |

9Router recibe la contraseña del dashboard al conectar y la cookie en las consultas;
puede renovar la sesión con la contraseña guardada. Ambas quedan vinculadas a la
URL guardada: no se reutilizan si falta el vínculo o el destino no coincide.
Guardar otro destino invalida las credenciales; probar un borrador distinto usa
una sesión temporal sin persistirla. Esto no garantiza la seguridad del servidor
ni cifra HTTP: usad destinos de confianza y HTTPS para conexiones remotas.

Las consultas periódicas continúan mientras la cuenta/proveedor esté activado;
ocultarlo no lo desactiva. La comprobación manual desde Ajustes también contacta
con el proveedor. En Windows/Linux, las consultas automáticas de actualizaciones
están activadas por defecto: unos 20 segundos tras arrancar, cada seis horas y al
abrir Ajustes. Desactivarlas detiene las automáticas, no las manuales; descargar e
instalar requiere acción del usuario. En macOS la actualización es manual: la app
no busca, descarga ni instala actualizaciones mediante el updater.

El login CLI abre una terminal (Terminal.app en macOS; un emulador disponible en
Linux) y puede abrir la web oficial. Los comandos de login son configurables:
revisadlos antes de ejecutarlos; en Windows/macOS se ejecutan mediante shell.
Los enlaces del navegador siguen las políticas de cada web. La instalación
asistida de Codex usa `%USERPROFILE%\.quorb`, no una instalación global.
El inicio automático opcional modifica la configuración de arranque del sistema.

No se observa un servicio de analítica o telemetría de Quorb en el runtime revisado.
Esto no implica funcionamiento sin conexión ni ausencia de recopilación por los
proveedores, 9Router, GitHub, npm, Microsoft o los CLI oficiales.

## Opciones y borrado

Desactivad las cuentas/proveedores y las consultas automáticas que no queráis.
Eliminar una cuenta adicional intenta borrar sus secretos; un fallo del almacén
puede dejar entradas. Desconectar 9Router borra contraseña, cookie y vínculo, o
informa del error. No hay un control dedicado para borrar o exportar el historial.

Para quitar datos, desactivad el inicio automático, cerrad Quorb y conservad lo
necesario antes de desinstalar por el mecanismo de vuestro sistema. No hay hooks
propios de limpieza ni una verificación completa de desinstalación multiplataforma.
Revisad los directorios de configuración/datos y WebView de Quorb, sus entradas
en Credential Manager, Keychain o keyring y los archivos propios de `~/.quorb`
(`%USERPROFILE%\.quorb` en Windows), incluidas sesiones de cuentas adicionales.
Revisad también `es.egdev.ai-usage`. No borréis sesiones de otras apps: revocad
su acceso desde sus herramientas o cuentas. El borrado local no elimina registros
del proveedor, backups ni copias compartidas.

## Políticas de terceros y contacto

Consultad las políticas según vuestra región y plan:
[Anthropic](https://www.anthropic.com/legal/privacy),
[OpenAI](https://openai.com/policies/privacy-policy/),
[Google](https://policies.google.com/privacy), [Cursor](https://cursor.com/privacy),
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement),
[OpenRouter](https://openrouter.ai/privacy/),
[Microsoft](https://privacy.microsoft.com/privacystatement) y
[npm](https://docs.npmjs.com/policies/privacy).
No se ha verificado aquí una política oficial de NaN ni de vuestro servidor
9Router; obtenedlas antes de activar esas integraciones. Las URL propias tienen
sus propias políticas; estos enlaces externos no se han comprobado por red.

Contacto: [egdev6@gmail.com](mailto:egdev6@gmail.com). El correo y las issues públicas
envían datos a esos servicios: no incluyáis tokens, sesiones, claves privadas ni
diagnósticos sin redactar.

## Avisos de instalación pendientes

Este documento no añade pantallas de privacidad ni opciones de rechazo al
instalador. Los avisos, políticas de terceros y desinstalación requieren revisión
antes de afirmar cumplimiento de SignPath. Consultad la [Política de firma](./code-signing.md).

Fuentes locales: [persistencia y comandos](../src-tauri/src/lib.rs),
[almacén de secretos](../src-tauri/src/secrets.rs),
[backends configurados](../src-tauri/Cargo.toml),
[vínculo de 9Router](../src-tauri/src/providers/nine_router_creds.rs),
[proveedores](../src-tauri/src/providers/mod.rs) y [updater](../src/lib/updater.ts).
