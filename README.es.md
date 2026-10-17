<!-- egdev:lang:start -->
<p align="right">
  <a href="./README.md"><img src="https://img.shields.io/badge/English-1F1F1F?style=for-the-badge&labelColor=0A0A0A&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI%2BPGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg%2BPHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8%2BPHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8%2BPHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg%3D%3D" alt="English" /></a>
  <img src="https://img.shields.io/badge/Espa%C3%B1ol-FF0036?style=for-the-badge&labelColor=0A0A0A&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3NTAgNTAwIj48cmVjdCB3aWR0aD0iNzUwIiBoZWlnaHQ9IjUwMCIgZmlsbD0iI2M2MGIxZSIvPjxyZWN0IHdpZHRoPSI3NTAiIGhlaWdodD0iMjUwIiB5PSIxMjUiIGZpbGw9IiNmZmM0MDAiLz48L3N2Zz4%3D" alt="Español" />
</p>
<!-- egdev:lang:end -->

<!-- egdev:header:start -->
<img src="./.github/assets/banner.png" alt="Quorb banner" width="100%" />

<div align="center">

[![Version](https://img.shields.io/github/package-json/v/egdev6/quorb?style=for-the-badge&labelColor=0A0A0A&color=FF0036&label=version)](https://github.com/egdev6/quorb/blob/main/package.json)
[![Stars](https://img.shields.io/github/stars/egdev6/quorb?style=for-the-badge&labelColor=0A0A0A&color=FF0036)](https://github.com/egdev6/quorb/stargazers)
[![Issues](https://img.shields.io/github/issues/egdev6/quorb?style=for-the-badge&labelColor=0A0A0A&color=FF0036)](https://github.com/egdev6/quorb/issues)
[![License](https://img.shields.io/github/license/egdev6/quorb?style=for-the-badge&labelColor=0A0A0A&color=FF0036)](./LICENSE)

</div>
<!-- egdev:header:end -->

# Quorb

Tus cuotas de IA, siempre a la vista: consumo, capacidad disponible y gasto de tus suscripciones y APIs de IA en Windows.

## Qué es

Quorb reúne tus límites de IA en una herramienta local de escritorio. Podéis consultar cuánto habéis consumido, a qué ritmo y cuándo se reinician los límites, sin abrir el panel de cada proveedor.

Su widget se pega al borde de la pantalla: es compacto, transparente y permanece por encima de las ventanas. Al pasar el ratón por un proveedor, muestra sus límites, plan, gasto, ritmo e historial.

<!-- egdev:stack:start -->
## Stack
<div align="center">
<a href="https://github.com/Gentleman-Programming/gentle-ai">
  <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
</a>
</div>

<div align="center">

![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)

![Tauri](https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)
![npm](https://img.shields.io/badge/npm-CB3837?style=for-the-badge&logo=npm&logoColor=white)

</div>
<!-- egdev:stack:end -->

## Inicio rápido

Quorb está dirigido actualmente a Windows como plataforma principal. Existe además un port Linux en marcha (ver [Notas de Linux](#notas-de-desarrollo-linux)); macOS está integrado aparte para Apple Silicon.

Necesitáis Node 22+, Rust con el toolchain MSVC, Microsoft C++ Build Tools y WebView2. Consultad los [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/).

```powershell
git clone https://github.com/egdev6/quorb
cd quorb
npm install
npm run app:dev
```

Abrid Ajustes y activad los proveedores que utilizáis. Claude, Codex, Gemini y Cursor leen las sesiones de sus herramientas oficiales; los demás requieren las credenciales indicadas más abajo.

Para compilar un instalador local, ejecutad `npm run app:build`. Los archivos se guardan bajo `src-tauri/target/release/bundle`.

> No había ninguna release pública de GitHub al preparar este README. El repositorio es privado actualmente; clonarlo requiere acceso. No se presupone que exista un instalador público.

## Scripts

| Comando | Función |
| --- | --- |
| `npm run dev` | Servidor de desarrollo del frontend |
| `npm run build` | Comprobar tipos y compilar el frontend |
| `npm run app:dev` | Ejecutar la app de escritorio con hot reload |
| `npm run app:build` | Compilar un instalador local |
| `npm run typecheck` | Comprobar TypeScript |
| `npm test` | Tests de Vitest |
| `cd src-tauri; cargo test` | Tests de Rust |
| `npm run bump x.y.z` | Actualizar la versión |
| `npm run setup:signing` | Preparar la firma: crea claves y puede subir secretos a GitHub |
| `npm run app:release` | Compilar una actualización firmada; requiere credenciales de firma |

## Arquitectura

React 19 y TypeScript gestionan el widget, los ajustes y los overlays. Tauri 2 y Rust gestionan las ventanas, las consultas a proveedores, la configuración local, el historial y el Administrador de credenciales de Windows.

- `src/Widget.tsx` y `src/DetailPanel.tsx`: tira y detalle de consumo.
- `src/Settings.tsx` y `src/Overlay.tsx`: ajustes y efectos de aviso.
- `src/lib/`: paleta, ritmo, orden, actualizaciones y tests.
- `src-tauri/src/providers/`: integraciones con proveedores.
- `src-tauri/src/history.rs`, `config.rs` y `secrets.rs`: datos locales y credenciales.

### Proveedores compatibles

| Proveedor | Datos | Conexión |
| --- | --- | --- |
| Claude Pro / Max | Límites de sesión y semanales | Login oficial de Claude Code |
| ChatGPT Plus / Pro · Codex | Límites de sesión y semanales | Login oficial de Codex CLI |
| Gemini | Cuota diaria por modelo | Login de Gemini CLI |
| Cursor | Consumo del plan y gasto bajo demanda | Sesión de la app en solo lectura |
| GitHub Copilot | Peticiones premium | Token fine-grained con permiso Plan de lectura |
| OpenRouter | Gasto, límite de la key y créditos | API key |
| NaN Builders | Cuota del plan y tokens diarios | Enlace por correo o API key |
| Anthropic API / OpenAI API | Coste mensual | Admin API keys |

Algunas integraciones usan endpoints no documentados, que pueden cambiar o dejar de funcionar. Copilot, OpenRouter y las APIs de coste usan APIs oficiales; NaN combina la API documentada con endpoints no documentados del dashboard.

### Funcionalidades

- Arrastrad la tira a cualquier borde; en los laterales se coloca en vertical.
- Consultad porcentajes, reinicios, plan y gasto al pasar el ratón.
- Revisad el ritmo de consumo y el historial local de 24 horas, 7 días o 30 días.
- Recibid notificaciones de Windows y efectos configurables al superar el umbral y al reiniciarse los límites.
- Ajustad tamaño, acento RGB, opacidad, orden, proveedores ocultos y ocultación automática.
- Usad atajos globales reasignables: `Ctrl+Alt+U`, `Ctrl+Alt+I`, `Ctrl+Alt+R`.
- Actualizad desde releases firmadas de GitHub cuando se publiquen; la app consulta al arrancar y cada seis horas.

### Conectar y comprobar cuentas

Ajustes os guía para conectar cuentas principales y adicionales:

- Para Claude, Codex y Gemini, usad el login oficial del CLI. En Windows, Quorb
  puede instalar Codex con vuestra confirmación usando Node/npm ya instalados;
  iniciar sesión sigue siendo otro paso. Para Claude y Gemini, copiad y ejecutad
  la orden de instalación.
- Comprobad una cuenta desde Ajustes, aunque esté oculta en el widget.
  La consulta usa lo guardado, no los valores pendientes del formulario.
- Guardad los cambios de la cuenta, incluidos los ajustes heredados del
  proveedor, antes de abrir el login del CLI. Un fallo al guardar la configuración
  no inicia el login.
- Encontrar el fichero de sesión no demuestra que la autenticación siga siendo
  válida; consultad la comprobación de conexión para ver el estado de la cuenta.

Consultad la [guía de conexión](./docs/account-onboarding.md)
([English](./docs/account-onboarding.en.md)) para los pasos, mensajes de estado y
errores de guardado parcial.

### Vista visual

Ilustraciones promocionales, no capturas directas.

<table width="100%">
  <tr>
    <td width="50%" align="center"><strong>Vista de consumo</strong><br /><img src="./.github/assets/01-cuotas.png" alt="Vista de consumo con cuotas y capacidad disponible" width="100%" /></td>
    <td width="50%" align="center"><strong>Detalle de consumo</strong><br /><img src="./.github/assets/02-detalle.png" alt="Panel de detalle de consumo" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Ritmo e historial</strong><br /><img src="./.github/assets/03-ritmo.png" alt="Ritmo de consumo e historial" width="100%" /></td>
    <td width="50%" align="center"><strong>Tira vertical</strong><br /><img src="./.github/assets/04-vertical.png" alt="Tira vertical en un borde de pantalla" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Colores de acento</strong><br /><img src="./.github/assets/05-colores.png" alt="Opciones de color de acento" width="100%" /></td>
    <td width="50%" align="center"><strong>Atajos globales</strong><br /><img src="./.github/assets/06-atajos.png" alt="Atajos globales reasignables" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Apariencia</strong><br /><img src="./.github/assets/09-apariencia.png" alt="Ajustes de tamaño, opacidad y ocultación automática" width="100%" /></td>
    <td width="50%" align="center"><strong>Proveedores</strong><br /><img src="./.github/assets/10-proveedores.png" alt="Lista de proveedores y visibilidad" width="100%" /></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><strong>Avisos configurables</strong><br /><img src="./.github/assets/quorb-configura-avisos.png" alt="Avisos configurables con confeti, glow en los bordes o efectos propios" width="50%" /></td>
  </tr>
</table>

### Privacidad y datos locales

Las API keys y la sesión de NaN se guardan en el almacén seguro del sistema (Windows Credential Manager; en Linux, Secret Service; en macOS, Keychain). Los archivos de sesión de las herramientas oficiales se leen sin escribir en ellos ni rotar refresh tokens. Gemini renueva su token de acceso de corta duración en memoria. Si caduca el login de una CLI, iniciad sesión de nuevo con la herramienta oficial.

La configuración y el historial se guardan en la carpeta de usuario de cada plataforma (`%APPDATA%\es.egdev.quorb` en Windows, `~/.config/es.egdev.quorb` en Linux). Quorb consulta directamente los endpoints de los proveedores; no requiere un backend separado. El historial cubre hasta 30 días.

Para sesiones en WSL, configurad las rutas de credenciales en Ajustes, por ejemplo `\\wsl.localhost\Ubuntu\home\YOUR_USER\.codex\auth.json`, y el comando de login `wsl codex login` o `wsl claude` según corresponda.

### Hoja de ruta

La firma de código y distribución por winget, el modo click-through y la ventana de cuatro horas de GLM en NaN siguen siendo objetivos, no funcionalidades actuales. Las releases públicas de macOS/Linux y el updater de Linux no forman parte del proyecto por ahora; el desarrollo local de Linux está recogido en la sección siguiente.

## Notas de desarrollo Linux

Está en marcha un port nativo de Linux (issues ODD #105–#108 del proyecto `quorb-linux-local-v1`). Lo que funciona hoy es desarrollo y pruebas locales, no una release distribuida:

- Requisitos: Node 22+, Rust y las librerías de sistema habituales de Tauri (`libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`). Para ejecutar desde fuente, `npm install` + `npm run app:dev`.
- Los formatos de bundle y el empaquetado de un build local instalable siguen definiéndose en la unidad de paquete (#108); no distribuyáis los artefactos.
- Las limitaciones de sesión y comportamiento dependen del escritorio, y Ajustes las muestra por superficie en el bloque «Sesión de escritorio»:
  - X11: comportamiento completo de siempre-encima, icono de bandeja, atajos globales y transparencia (esta última solo con un compositor).
  - GNOME sobre Wayland: hace falta la extensión AppIndicator para ver el icono de bandeja; siempre-encima y click-through limitados por Mutter; el registro de atajos globales puede denegarse.
  - KDE sobre Wayland: bandeja y siempre-encima soportados; el portal de atajos puede seguir denegando el registro.
  - Compositores tipo WLR (Hyprland, sway): siempre-encima muy estricto; sin bandeja si tu barra no soporta StatusNotifier.
- Diagnóstico rápido: `echo $XDG_SESSION_TYPE` (tipo de sesión), `echo $XDG_CURRENT_DESKTOP` (escritorio actual), `quorb` en consola para ver el debug, además de Ajustes › Atajos para los errores de registro de atajos.

## Contribuir

Se aceptan issues y PRs, especialmente nuevas integraciones. Cada proveedor vive en `src-tauri/src/providers/<name>.rs`; hay que conectar también su configuración y sus ajustes en el frontend.

La documentación técnica existente se conserva en la [guía original en inglés](./docs/original-readme.en.md) y la [guía original en español](./docs/original-readme.es.md). Son copias históricas: sus enlaces relativos e instrucciones de releases pueden necesitar actualización antes de reutilizarlas.

Consultad [CONTRIBUTING.md](./CONTRIBUTING.md) para el entorno local, los pasos de integración de proveedores y el flujo de publicación para mantenedores.

## Recursos

- [Código fuente](https://github.com/egdev6/quorb)
- [Issues](https://github.com/egdev6/quorb/issues)
- [Releases, cuando se publiquen](https://github.com/egdev6/quorb/releases)
- [Requisitos de Tauri](https://v2.tauri.app/start/prerequisites/)

## Licencia

[MIT](./LICENSE) © Enrique Gómez Navarro. Quorb no está afiliado con Anthropic, OpenAI, Google, Anysphere, GitHub, OpenRouter ni NaN Builders; las marcas pertenecen a sus respectivos propietarios.

<!-- egdev:contact:start -->
## Contacto
<div align="center">

[![Web](https://img.shields.io/badge/egdev.es-FF0036?style=for-the-badge&logo=googlechrome&logoColor=white)](https://egdev.es)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/@egdev6)
[![Twitch](https://img.shields.io/badge/Twitch-9146FF?style=for-the-badge&logo=twitch&logoColor=white)](https://twitch.tv/egdev6)
[![X](https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/egdev66)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/egdev6/)
[![Instagram](https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white)](https://www.instagram.com/egdev6/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/egdev6)
![Discord](https://img.shields.io/badge/Egdev5285-5865F2?style=for-the-badge&logo=discord&logoColor=white)
[![Gmail](https://img.shields.io/badge/Gmail-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:egdev6@gmail.com)

</div>
<!-- egdev:contact:end -->

<!-- egdev:footer:start -->
---

<div align="center">

**⭐ Si este proyecto te resulta útil, considera darle una estrella en GitHub ⭐**

</div>
<!-- egdev:footer:end -->
