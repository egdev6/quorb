# Conectar y comprobar cuentas

[English](./account-onboarding.en.md)

## Añadir una cuenta adicional

Quorb puede consultar varias cuentas del mismo proveedor. Para las cuentas CLI
(Claude, Codex y Gemini), la sesión usa una carpeta independiente por defecto.
Comprueba la ruta si eliges una carpeta personalizada para no compartirla con la principal.

## Pasos

1. Elige el proveedor y pulsa **+ Añadir cuenta**.
2. Ponle un **nombre**: es el que verás en la tira junto al proveedor.
3. Pulsa **Guardar e iniciar sesión** (o **Iniciar sesión** si ya está guardada).
   Si hace falta guardar, Quorb guarda la config **antes** de abrir el CLI.
   Si el guardado no confirma
   que la cuenta quedó persistida, no abre el login; verás el error del guardado.
4. Entra en el navegador con la cuenta que quieres añadir, no con la principal.
   Si ya tienes la principal abierta, usa una ventana privada.

## Comprobar una cuenta principal o adicional

1. Abre **Ajustes** y elige el proveedor y la cuenta que quieres consultar.
2. En el paso **Comprobación**, usa **Guardar y comprobar** si hay cambios
   pendientes, o **Comprobar ahora** si la configuración ya está guardada.
3. Lee el resultado de esa cuenta: **Funciona**, **Sin sesión** o el mensaje
   de error. Un fallo de la consulta no confirma que las credenciales sean
   inválidas; revisa el mensaje y vuelve a intentarlo.

La cuenta se puede comprobar aunque esté oculta en el widget. No necesitas
mostrarla para diagnosticar su conexión desde Ajustes; la consulta utiliza la
configuración guardada y no cambia su visibilidad.

## Requisitos del CLI

Para iniciar sesión en Claude, Codex y Gemini, Quorb usa el login oficial de su
CLI. Si falta, Ajustes ofrece **Instalar Codex** en Windows para ChatGPT y
Codex. Claude y Gemini conservan la orden para copiar y ejecutar manualmente.

- Claude Code (`claude`), Codex CLI (`codex`) y Gemini CLI (`gemini`).
- Quorb los detecta solo (cada pocos segundos o al volver a la ventana).
- Para conectar Gemini en Quorb, elige «Login with Google» cuando el CLI lo
  pida: esta integración lee las credenciales OAuth guardadas por ese flujo.

### Instalar Codex desde Quorb (Windows)

1. En la cuenta principal o adicional de **ChatGPT y Codex**, pulsa
   **Instalar Codex**. Una confirmación nativa explica la descarga y su destino;
   cancelar no instala nada.
2. Necesitas Node.js 22 o posterior y npm ya instalados, con la misma arquitectura
   que Quorb (por ejemplo, Node x64 para Quorb x64). Quorb no instala Node,
   no pide elevación y no cambia tu instalación global de npm ni el PATH del sistema.
   Descarga el paquete oficial fijado `@openai/codex@0.162.1` desde el registro
   público de npm, sin ejecutar scripts de instalación de los paquetes.
3. Espera al resultado. Quorb comprueba el binario y su versión antes de dar la
   instalación por terminada. Después pulsa **Iniciar sesión** o
   **Guardar e iniciar sesión**: instalar el CLI no crea una sesión de ChatGPT.

La instalación se guarda en `%USERPROFILE%\.quorb\tools\codex-0.162.1` y se
comparte entre todas las cuentas ChatGPT/Codex. Sus carpetas de sesión siguen
separadas; instalar no guarda los cambios del formulario ni abre el login.

| Situación | Qué hacer |
| --- | --- |
| Falta Node/npm | Instala el requisito por separado y vuelve a comprobar. Quorb no lo instala automáticamente. |
| Codex instalado manualmente con Quorb abierto | Vuelve a comprobar; en Windows Quorb también busca en el PATH actualizado del registro, sin cambiar el entorno global. |
| Prefijo npm personalizado que no está en el PATH | Revisa el comando de login en los ajustes del proveedor y usa la ruta completa entre comillas si contiene espacios. Quorb no inspecciona tu `.npmrc`. |
| Instalación fallida o **Sin sesión** | Son pasos distintos: primero comprueba el resultado de instalación; después inicia sesión y usa **Comprobación** para validar el acceso. |

Fuera de Windows, usa la instalación manual del
[CLI oficial](https://developers.openai.com/codex/cli).

## Cómo se comprueba la conexión

La comprobación consulta la **configuración guardada**, no el formulario. Si hay
cambios sin guardar, el paso avisa y ofrece **Guardar y comprobar**; el login del
CLI tampoco se abre con cambios pendientes, porque el CLI busca lo ya persistido.
Esto incluye los ajustes del proveedor que hereda una cuenta adicional, como su
comando de login o URL de consulta.

- El estado real (**Funciona** / **Sin sesión**) sale de la consulta de uso del
  proveedor, no de la presencia del fichero de sesión.
- El manejo y refresco OAuth depende del proveedor. Si la comprobación pide
  renovar la sesión, usa **Volver a abrir el login**; encontrar el fichero no
  garantiza que el acceso siga siendo válido.

## Si guardar solo funciona en parte

La configuración y **Arrancar con Windows** se guardan por separado:

| Mensaje o situación | Qué significa y qué hacer |
| --- | --- |
| **Configuración no guardada: …** | El login que necesitaba esos cambios no se abre. Revisa el error y vuelve a guardar antes de conectar. La comprobación no valida el borrador fallido; utiliza lo ya guardado. |
| **Configuración guardada · Inicio con Windows no guardado: …** | La configuración de la cuenta sí se guardó: el login puede abrirse. Revisa por separado el fallo de arranque con Windows; no se confirmó esa opción. |
| **Inicio con Windows guardado · Configuración no guardada: …** | El arranque se confirmó, pero la cuenta no quedó actualizada. El login que necesita esa configuración sigue bloqueado. |
| Guardado en curso | Espera a que termine. Mientras tanto, los botones de conectar y guardar para comprobar se deshabilitan; un guardado ocupado no cuenta como confirmación. |

## Qué significa «Fichero de sesión encontrado»

Es solo eso: Quorb ve el fichero que deja el CLI en la carpeta de la cuenta
(`.credentials.json`, `auth.json` o `.gemini/oauth_creds.json`).

- **No** confirma que la sesión sea válida ni que la cuenta esté «conectada».
- Comprueba el estado real en **Comprobación**, dentro de Ajustes, o en el
  **widget** si muestras esa cuenta; una sesión caducada puede conservar su fichero.
- Puedes volver a iniciar sesión sin borrar nada.

## Carpeta de sesión

En **Avanzado · carpeta de sesión** puedes fijar una carpeta propia. Quorb lee el
fichero de sesión que haya dentro. Si el widget pide renovar la sesión, usa
**Renovar sesión** para abrir el login del CLI. La presencia del fichero no
confirma la validez del acceso ni el estado del refresco OAuth de cada proveedor.

En la cuenta principal, una ruta válida con el nombre estándar del CLI determina
la carpeta de sesión del login. En host, si usas otro nombre con un comando
avanzado, Quorb no impone una carpeta: el comando debe escribir en la ruta
configurada. En WSL se exige una ruta absoluta del guest y el nombre estándar
del CLI.

Para validar el flujo interactivo de una cuenta adicional en Windows/WSL, sigue
la [guía de validación de login en WSL](./wsl-login-validation.md).
