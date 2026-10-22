# Logos de las suscripciones

Deja aquí el logo de cada proveedor (`.svg`, `.png` o `.webp`). Se busca primero por id y luego por alias:

| Proveedor | Archivos que busca (en orden) |
|---|---|
| Claude (Pro / Max) | `claude`, `anthropic` |
| ChatGPT · Codex | `codex`, `chatgpt`, `openai` |
| NaN Builders | `nan`, `nan-builders` |
| Anthropic API | `anthropic_api`, `anthropic`, `claude` |
| OpenAI API | `openai_api`, `openai` |
| Gemini | `gemini`, `google` |
| Cursor | `cursor` |
| Grok (SuperGrok) | `grok` |
| GitHub Copilot | `copilot`, `github-copilot`, `microsoft-copilot`, `github` |
| OpenRouter | `openrouter` |

Los SVG se insertan inline, así que `fill="currentColor"` sale en blanco. Los `id`, `class` y estilos internos de cada SVG se prefijan con el nombre del archivo, así dos logos con el mismo `id="a"` no se pisan. Si un wordmark necesitara recortarse, usa la constante `VIEWBOX` de `ProviderLogo.tsx` (ahora vacía: `nan.svg` ya viene recortado).

Se pintan dentro del círculo (62 % del hueco central, sobre fondo oscuro), así que funcionan mejor las versiones claras o monocromas en blanco. Usa los kits de prensa oficiales de cada marca.

Si falta un archivo, el widget muestra un monograma (`Cl`, `GPT`, `Ge`, `Cu`, `Co`, `NaN`, `OR`, `A API`, `O API`). Tras añadir o cambiar un logo, reinicia `npm run app:dev` o vuelve a compilar.
