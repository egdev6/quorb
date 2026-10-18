# Privacy policy

[Español](./privacy.md) · [Code signing policy](./code-signing.en.md)

Quorb is a local utility with runtime code for Windows, macOS and Linux, maintained by
[Enrique Gómez Navarro (@egdev6)](https://github.com/egdev6).
This policy describes code reviewed at `d097bc3`, not a third-party audit,
a support guarantee for every platform or SignPath approval.

## Local data and credentials

- `config.json` stores account labels, paths, providers and preferences;
  `history.json` stores usage percentages, spending, identifiers and timestamps.
  They use Tauri's configuration/data directories for `es.egdev.quorb`
  (on Windows, `%APPDATA%\es.egdev.quorb`), without Quorb-specific encryption.
  The interface also saves navigation, preferences and update notices
  in its WebView's local storage.
- History is pruned to 30 days when recording readings, not when closing the app.
- Saved API keys, tokens and cookies use the system store under service
  `es.egdev.quorb`: Credential Manager on Windows, Keychain on macOS,
  and the kernel keyring (keyutils, `linux-native` feature) on Linux. Persistence
  across Linux sessions/reboots is not guaranteed, and this configuration does
  not establish Secret Service support. Save failures are returned as errors,
  without a JSON fallback. Status requests do not return secret values to the frontend.
  Additional accounts have their own entries.
- Quorb reads Claude, Codex and Gemini sessions and Cursor's database to query
  usage; it does not rewrite those files. Gemini refreshes tokens in memory.
  On macOS, Claude can read `Claude Code-credentials` from Keychain when the main
  account's file is missing and no explicit path is set; permission may be requested.
  This fallback is not used for additional accounts or explicit paths.
- Official login can create session files: additional CLI accounts default to
  `~/.quorb/accounts`, or the chosen directory. These files may contain secrets.
- Migration from `es.egdev.ai-usage` copies configuration/history and moves
  legacy credentials. Old files, entries or backups may remain.

## Network connections

Quorb queries enabled providers for usage, quotas, plans and spending.
There is no Quorb-hosted intermediary; 9Router is a user-selected destination.
Requests may include tokens, account/project identifiers, IP address and Quorb
version. NaN login sends the supplied email address.

| Feature | Destination |
| --- | --- |
| Claude and Anthropic costs | `api.anthropic.com` |
| Codex and OpenAI costs | `chatgpt.com`, `api.openai.com` |
| Gemini and token refresh | `cloudcode-pa.googleapis.com`, `oauth2.googleapis.com` |
| Cursor, Copilot and OpenRouter | `cursor.com`, `api.github.com`, `openrouter.ai` |
| NaN and email login | `api.nan.builders`, `cloud-api.nan.builders`; HTTPS links on `nan.builders` and its subdomains; configurable base/usage URLs |
| 9Router | Configurable URL; default `http://localhost:20128` |
| Native updates (Windows/Linux) | GitHub Releases and its download infrastructure |
| Assisted Codex installation (Windows) | `registry.npmjs.org`, after confirmation |
| WebView2 installation (Windows) | Microsoft's download services when required |

9Router receives the dashboard password when connecting and the cookie in queries;
it can renew the session using the saved password. Both are bound to the saved
URL: they are not reused if the binding is missing or the destination differs.
Saving another destination invalidates credentials; testing a different draft uses
a temporary session without persistence. This does not guarantee server security
or encrypt HTTP: use trusted destinations and HTTPS for remote connections.

Polling continues while the account/provider is enabled; hiding it does not disable
it. Manual checks from Settings also contact the provider. On Windows/Linux,
automatic update checks are enabled by default: about 20 seconds after startup,
every six hours and when opening Settings. Disabling them stops automatic checks,
not manual ones; downloading and installing require user action. On macOS,
updates are manual: the app does not check, download or install through the updater.

CLI login opens a terminal (Terminal.app on macOS; an available emulator on Linux)
and may open the official website. Login commands are configurable: review them
before execution; on Windows/macOS they run through a shell. Browser links follow
each site's policies. Assisted Codex installation uses `%USERPROFILE%\.quorb`,
not a global installation. Optional autostart changes system startup configuration.

No Quorb analytics or telemetry service is evident in the reviewed runtime.
This does not imply offline operation or absence of data collection by providers,
9Router, GitHub, npm, Microsoft or the official CLIs.

## Your choices and removal

Disable accounts/providers and automatic checks you do not want.
Removing an additional account attempts to delete its secrets; store failures may
leave entries behind. Disconnecting 9Router deletes password, cookie and binding,
or reports an error. There is no dedicated history-clear or history-export control.

To remove data, disable autostart, close Quorb and preserve anything needed before
uninstalling through your system's mechanism. There are no project-specific cleanup
hooks or a complete cross-platform uninstall verification. Review Quorb's
configuration/data and WebView directories, its Credential Manager, Keychain or
keyring entries, and Quorb-owned files in `~/.quorb` (`%USERPROFILE%\.quorb` on
Windows), including additional-account sessions. Also check `es.egdev.ai-usage`.
Do not delete other apps' sessions: revoke access through their tools or accounts.
Local deletion does not remove provider records, backups or shared copies.

## Third-party policies and support

Consult the policies relevant to your region and plan:
[Anthropic](https://www.anthropic.com/legal/privacy),
[OpenAI](https://openai.com/policies/privacy-policy/),
[Google](https://policies.google.com/privacy), [Cursor](https://cursor.com/privacy),
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement),
[OpenRouter](https://openrouter.ai/privacy/),
[Microsoft](https://privacy.microsoft.com/privacystatement) and
[npm](https://docs.npmjs.com/policies/privacy).
No official NaN policy or policy for your 9Router server has been verified here;
obtain them before enabling those integrations. Custom URLs have their own policies;
these external links have not been checked over the network.

Contact: [egdev6@gmail.com](mailto:egdev6@gmail.com). Email and public issues send data
to those services: do not include tokens, sessions, private keys or unredacted
diagnostics.

## Pending installation disclosures

This document adds no privacy screens or installer opt-out controls.
Disclosures, third-party policies and uninstall behavior need review before
claiming SignPath compliance. See the [Code signing policy](./code-signing.en.md).

Local sources: [persistence and commands](../src-tauri/src/lib.rs),
[secret store](../src-tauri/src/secrets.rs),
[configured backends](../src-tauri/Cargo.toml),
[9Router binding](../src-tauri/src/providers/nine_router_creds.rs),
[providers](../src-tauri/src/providers/mod.rs) and [updater](../src/lib/updater.ts).
