# grok-provider

Provider SuperGrok (Grok Build CLI) para Quorb — issue #173.

## Specs

- S1: "Provider nativo `grok` (`Kind::Subscription`), siguiendo el patrón de credenciales de sesión CLI de `codex.rs`/`claude.rs` (no el de API keys)".
- S2: "Credenciales: token Bearer del login local del Grok CLI oficial (`grok`), en `~/.grok/auth.json`. Detección y lectura con parseo defensivo; sin importar cookies de navegador en una primera etapa." Detalle del formato: claves de nivel superior son URLs de scope OIDC; se prefiere la entrada bajo `https://auth.x.ai::<client-id>` (fallback: `https://accounts.x.ai/sign-in`); token en campo `key`; respeto `GROK_HOME` y `credentials_path`.
- S3: "Endpoints: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` → `creditUsagePercent` (porcentaje usado 0–100), ventana de la semana y reset. `GET https://cli-chat-proxy.grok.com/v1/settings` (opcional) → nombre del plan visible." Headers: `Authorization: Bearer <token>`, `x-xai-token-auth: xai-grok-cli`, `Accept: application/json`. Reset: `config.currentPeriod.end`, luego `config.billingPeriodEnd`. Ventana: `currentPeriod.start/end`, fallback `billingPeriodStart/End`. Porcentaje fallback: `onDemandUsed.val / onDemandCap.val * 100`.
- S4: "Medidores: anillo principal con porcentaje de créditos usados de la ventana semanal (`percent`, `resets_at`, `window_seconds` = 7 días). Identificación del plan activo en el detalle."
- S5: "Robustez: ante cambios del formato, degradar con mensaje claro (`Status::Error`) en lugar de romper; parseo tolerante como en `codex.rs`." Sin `creditUsagePercent` ni fallback on-demand pero con período activo → uso desconocido, no 0%.
- S6: "Interfaz y assets: logo en `ProviderLogo.tsx` con alias `grok`. Sección en `Settings.tsx` (pestaña `grok`, estado en `mainState` según presencia del auth file/token). Inclusión en `widget-refresh.ts`."
- S7: "Tests: unitarios deterministas en Rust con fixtures JSON representativas (sin red), incluyendo caso de respuesta legacy sin `creditUsagePercent`."

## Tasks

- T1 (S1,S2,S3,S4,S5,S7): backend Rust — `providers/grok.rs` con parse de auth.json, fetch de billing + settings, `parse` con fixtures; config `grok: SubscriptionConfig`; wiring en `providers/mod.rs`. Commit: feat(providers).
- T2 (S6): frontend — pestaña en `Settings.tsx`, `PROVIDER_TABS`, `mainState`, logo/alias, `order.ts`, widget-refresh. Commit: feat(providers).
- T3 (S7): verificación completa — `cargo test`, suite frontend, differential de comandos compartidos. Commit: docs/chore.

## Log

- L1: "si porque te voy a pedir algo" → investigación del mecanismo; resultado: SuperGrok vía Grok CLI (issue #173, aprobado por "si").
- L2: Investigación de wire: CodexBar docs/grok.md — auth.json (claves OIDC, campo `key`, `GROK_HOME`), billing proxy (`config.creditUsagePercent`, `currentPeriod.end`, headers `x-xai-token-auth: xai-grok-cli`), plan por `/v1/settings` → `subscription_tier_display`.
