<!-- egdev:lang:start -->
<p align="right">
  <img src="https://img.shields.io/badge/English-FF0036?style=for-the-badge&labelColor=0A0A0A&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI%2BPGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg%2BPHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8%2BPHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8%2BPHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg%3D%3D" alt="English" />
  <a href="./README.es.md"><img src="https://img.shields.io/badge/Espa%C3%B1ol-1F1F1F?style=for-the-badge&labelColor=0A0A0A&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3NTAgNTAwIj48cmVjdCB3aWR0aD0iNzUwIiBoZWlnaHQ9IjUwMCIgZmlsbD0iI2M2MGIxZSIvPjxyZWN0IHdpZHRoPSI3NTAiIGhlaWdodD0iMjUwIiB5PSIxMjUiIGZpbGw9IiNmZmM0MDAiLz48L3N2Zz4%3D" alt="Español" /></a>
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

Your AI quotas, always in sight: usage, remaining capacity and spending across your AI subscriptions and APIs on Windows.

## What is it

Quorb brings your AI limits into one local desktop utility. Check how much you have used, how fast you are consuming it and when your limits reset, without opening a separate dashboard for every provider.

Its edge-docked widget is compact, transparent and always on top. Hover over a provider for its limits, plan, spending, pace and history.

## Linux

A native Linux port is in progress. The current baseline, support matrix (distros, X11/Wayland, tray, secrets, package format) and known limits live in [docs/build-linux.md](./docs/build-linux.md), tracked under [issue #105](https://github.com/egdev6/quorb/issues/105). **Do not claim support for a distro or compositor that is not marked as measured there** — compilation does not equal a working experience.

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

## Quick start

Quorb currently targets Windows as its main platform. There is also a Linux port in progress (see the [Linux notes](#linux-development-notes)); macOS has been integrated separately for Apple Silicon.

You need Node 22+, Rust with the MSVC toolchain, Microsoft C++ Build Tools and WebView2. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
git clone https://github.com/egdev6/quorb
cd quorb
npm install
npm run app:dev
```

Open Settings and enable the providers you use. Claude, Codex, Gemini and Cursor read existing sessions from their official tools; other providers require the credentials listed below.

To build a local installer, run `npm run app:build`. Outputs are written under `src-tauri/target/release/bundle`.

> No public GitHub release was available when this README was written. The repository is currently private; cloning requires access. Do not assume a public installer is available.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Frontend development server |
| `npm run build` | Type-check and build the frontend |
| `npm run app:dev` | Run the desktop app with hot reload |
| `npm run app:build` | Build a local installer |
| `npm run typecheck` | TypeScript checks |
| `npm test` | Vitest tests |
| `cd src-tauri; cargo test` | Rust tests |
| `npm run bump x.y.z` | Update the version |
| `npm run setup:signing` | Maintainer signing setup; creates keys and can upload GitHub secrets |
| `npm run app:release` | Build a signed update; requires signing credentials |

## Architecture

React 19 and TypeScript handle the widget, settings and overlays. Tauri 2 and Rust handle windows, provider requests, local configuration, history and Windows Credential Manager.

- `src/Widget.tsx` and `src/DetailPanel.tsx`: docked strip and usage details.
- `src/Settings.tsx` and `src/Overlay.tsx`: settings and notification effects.
- `src/lib/`: palette, pace, ordering, updater and tests.
- `src-tauri/src/providers/`: provider integrations.
- `src-tauri/src/history.rs`, `config.rs` and `secrets.rs`: local data and credentials.

### Supported providers

| Provider | Data | Connection |
| --- | --- | --- |
| Claude Pro / Max | Session and weekly limits | Official Claude Code login |
| ChatGPT Plus / Pro · Codex | Session and weekly limits | Official Codex CLI login |
| Gemini | Daily quota per model | Gemini CLI login |
| Cursor | Plan usage and on-demand spend | Read-only app session |
| GitHub Copilot | Premium requests | Fine-grained token with Plan read access |
| OpenRouter | Spend, key limit and credits | API key |
| NaN Builders | Plan quota and daily tokens | Email magic link or API key |
| Anthropic API / OpenAI API | Monthly cost | Admin API keys |

Some integrations use undocumented endpoints, which may change or stop working. Copilot, OpenRouter and the cost APIs use official APIs; NaN combines documented API access with undocumented dashboard endpoints.

### Features

- Drag the strip to any screen edge; it becomes vertical on the sides.
- Hover for percentages, reset times, plan and spending.
- Track consumption pace and local history over 24 hours, 7 days or 30 days.
- Receive Windows notifications and configurable effects at the threshold and when limits reset.
- Adjust size, RGB accent, opacity, order, hidden providers and auto-hide.
- Use remappable global shortcuts: `Ctrl+Alt+U`, `Ctrl+Alt+I`, `Ctrl+Alt+R`.
- Update from signed GitHub releases when published; the app checks on startup and every six hours.

### Connect and check accounts

Settings guides you through connecting your primary and additional accounts:

- For Claude, Codex and Gemini, use the official CLI login. On Windows, Quorb
  can install Codex with your confirmation using existing Node/npm; signing in
  remains a separate step. For Claude and Gemini, copy and run the install command.
- Check one account from Settings, even when it is hidden from the widget.
  The check uses saved settings, not unsaved form values.
- Save pending account settings, including inherited provider settings, before
  opening CLI login. A failed configuration save does not start login.
- A session file being found does not prove that authentication is still valid;
  use the connection check to see the account's current status.

See the [connection guide](./docs/account-onboarding.en.md)
([Español](./docs/account-onboarding.md)) for the steps, status messages and
partial-save errors.

### Visual overview

Promotional illustrations, not raw screenshots.

<table width="100%">
  <tr>
    <td width="50%" align="center"><strong>Usage overview</strong><br /><img src="./.github/assets/01-cuotas.png" alt="Usage overview with quotas and remaining capacity" width="100%" /></td>
    <td width="50%" align="center"><strong>Usage detail</strong><br /><img src="./.github/assets/02-detalle.png" alt="Usage detail panel" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Pace and history</strong><br /><img src="./.github/assets/03-ritmo.png" alt="Consumption pace and history" width="100%" /></td>
    <td width="50%" align="center"><strong>Vertical strip</strong><br /><img src="./.github/assets/04-vertical.png" alt="Vertical strip on a screen edge" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Accent colors</strong><br /><img src="./.github/assets/05-colores.png" alt="Accent color options" width="100%" /></td>
    <td width="50%" align="center"><strong>Global shortcuts</strong><br /><img src="./.github/assets/06-atajos.png" alt="Remappable global shortcuts" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Appearance</strong><br /><img src="./.github/assets/09-apariencia.png" alt="Size, opacity and auto-hide settings" width="100%" /></td>
    <td width="50%" align="center"><strong>Providers</strong><br /><img src="./.github/assets/10-proveedores.png" alt="Provider list and visibility" width="100%" /></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><strong>Configurable alerts</strong><br /><img src="./.github/assets/quorb-configura-avisos.png" alt="Configurable alerts with confetti, edge glow or custom effects" width="50%" /></td>
  </tr>
</table>

### Privacy and local data

API keys and the NaN session are stored in the system's secure store (Windows Credential Manager; on Linux, Secret Service; on macOS, Keychain). Official CLI/app session files are read without writing to them or rotating refresh tokens. Gemini refreshes its short-lived access token in memory. If a CLI login expires, sign in again through the official tool.

Configuration and history are stored under the platform user directory (`%APPDATA%\es.egdev.quorb` on Windows, `~/.config/es.egdev.quorb` on Linux). Quorb calls provider endpoints directly; no separate backend is required. History covers up to 30 days.

For WSL sessions, configure the credential file paths in Settings, for example `\\wsl.localhost\Ubuntu\home\YOUR_USER\.codex\auth.json`, and set the login command to `wsl codex login` or `wsl claude` as appropriate.

### Roadmap

Code signing and winget distribution, click-through mode and NaN's GLM four-hour window remain roadmap items, not current capabilities. macOS/Linux public releases and a Linux updater are not part of this project yet; Linux local development is covered in the section below.

## Linux development notes

A native Linux port is under development (tracking issues #105–#108 of the ODD project `quorb-linux-local-v1`). What works today is local development and testing, not a distributed release:

- Requirements: Node 22+, Rust, and the usual Linux system libraries of Tauri (`libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`). Run from source with `npm install` + `npm run app:dev`.
- The bundle formats and the packaging of an installable local build are still being defined in the packaging unit (#108); do not distribute the artifacts.
- Session and behaviour limits depend on the desktop session, and Settings shows them per surface in the «Sesión de escritorio» block:
  - X11: complete behaviour of always-on-top, tray icon, global shortcuts and transparency (the last only with a compositing WM).
  - GNOME on Wayland: AppIndicator extension needed to see the tray icon; always-on-top and click-through are limited by Mutter; global shortcut registration may be denied.
  - KDE on Wayland: tray and always-on-top supported; the global-shortcut portal may still deny the registration.
  - WLR-based compositors (Hyprland, sway): very strict always-on-top; no tray if your bar has no StatusNotifier support.
- Quick diagnostics: `echo $XDG_SESSION_TYPE` (session type), `echo $XDG_CURRENT_DESKTOP` (current desktop), `$ quorb` debug from the terminal, plus Settings › Atajos for the shortcut registration errors.

## Contributing

Issues and PRs are welcome, especially provider integrations. A provider lives in `src-tauri/src/providers/<name>.rs`; wire its configuration and frontend settings as well.

The existing technical documentation is preserved in the [original English guide](./docs/original-readme.en.md) and [original Spanish guide](./docs/original-readme.es.md). These are historical copies: relative links and release instructions may need updating before reuse.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the local setup, the provider integration steps and the maintainer release flow.

## Resources

- [Source code](https://github.com/egdev6/quorb)
- [Issues](https://github.com/egdev6/quorb/issues)
- [Releases, when published](https://github.com/egdev6/quorb/releases)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## License

[MIT](./LICENSE) © Enrique Gómez Navarro. Quorb is not affiliated with Anthropic, OpenAI, Google, Anysphere, GitHub, OpenRouter or NaN Builders; trademarks belong to their respective owners.

<!-- egdev:contact:start -->
## Contact
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

**⭐ If you find this project useful, consider giving it a star on GitHub ⭐**

</div>
<!-- egdev:footer:end -->
