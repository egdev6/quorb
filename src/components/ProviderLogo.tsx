import { useState } from 'react';
import { providerOf } from '../lib/accounts';
import { scopeSvg } from '../lib/svg';

// Logos de cada suscripción, en src/assets/logos/.
// Se busca por id y, si no está, por alias (p. ej. codex → openai.svg).
// Los SVG se insertan inline para que `currentColor` salga en blanco.

const rawSvgs = import.meta.glob<string>('../assets/logos/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const bitmaps = import.meta.glob<string>('../assets/logos/*.{png,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});

const baseName = (path: string) => path.split('/').pop()!.replace(/\.(svg|png|webp)$/, '');

/** Recortes de viewBox para logos que no son cuadrados (wordmarks). Vacío: los logos ya vienen recortados. */
const VIEWBOX: Record<string, string> = {};

function prepareSvg(name: string, svg: string): string {
  let out = svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/\x3c!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    // El tamaño lo decide el CSS
    .replace(/(<svg[^>]*?)\s(width|height)="[^"]*"/g, '$1')
    .replace(/(<svg[^>]*?)\s(width|height)="[^"]*"/g, '$1');
  const vb = VIEWBOX[name];
  if (vb) out = out.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  return scopeSvg(name, out);
}

type Logo = { kind: 'svg'; markup: string } | { kind: 'img'; url: string };

const LOGOS: Record<string, Logo> = {};
for (const [path, url] of Object.entries(bitmaps)) LOGOS[baseName(path)] = { kind: 'img', url };
for (const [path, raw] of Object.entries(rawSvgs)) {
  const name = baseName(path);
  LOGOS[name] = { kind: 'svg', markup: prepareSvg(name, raw) };
}

const ALIASES: Record<string, string[]> = {
  claude: ['claude', 'anthropic'],
  codex: ['codex', 'chatgpt', 'openai'],
  nan: ['nan', 'nan-builders'],
  anthropic_api: ['anthropic_api', 'anthropic', 'claude'],
  openai_api: ['openai_api', 'openai'],
  gemini: ['gemini', 'google'],
  cursor: ['cursor'],
  copilot: ['copilot', 'github-copilot', 'github'],
  openrouter: ['openrouter'],
  // `minimax-cn` es el nombre del nodo de 9Router para la región de China.
  minimax: ['minimax', 'minimax-cn', 'minimax_cn', 'minimaxi'],
  nine_router: ['nine_router', '9router'],
  // Nombres de nodos personalizados de 9Router → logo del proveedor real.
  zhipu: ['zhipu', 'z-ai', 'glm', 'glm-cn'],
  'qwen-alibaba': ['qwen-alibaba', 'qwen'],
  modelscope: ['modelscope'],
  replicate: ['replicate'],
};

export function findLogo(id: string): Logo | undefined {
  for (const key of ALIASES[id] ?? [id]) if (LOGOS[key]) return LOGOS[key];
  return undefined;
}

/**
 * Clave de logo de un sub-proveedor de 9Router. El nombre visible (`name`) es
 * «9Router · <sub>»: si `<sub>` es un nodo personalizado con nombre bonito
 * («Zhipu», «QWEN - Alibaba») se normaliza a un id de logo (`zhipu`, `qwen-alibaba`);
 * si no, se usa el id saneado del sub-proveedor (`kiro`, `minimax-cn`).
 */
export function subLogoKey(rawId: string, name: string): string {
  const raw = rawId.split(':')[1] ?? '';
  const label = name.includes(' · ') ? name.slice(name.indexOf(' · ') + 3) : name;
  const fromName = normalizeLogoKey(label);
  // El nombre del nodo solo manda si aporta algo distinto del id técnico.
  if (fromName && fromName !== normalizeLogoKey(raw) && !looksTechnical(raw)) return fromName;
  return normalizeLogoKey(fromName || raw);
}

/** ¿Es un id técnico de nodo (uuid, `openai-compatible-…`), sin nombre legible? */
function looksTechnical(id: string): boolean {
  return /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) || id.includes('compatible');
}

/** Normaliza un nombre visible a clave de logo: `QWEN - Alibaba` → `qwen-alibaba`. */
export function normalizeLogoKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MONOGRAM: Record<string, { text: string; sub?: string }> = {
  claude: { text: 'Cl' },
  codex: { text: 'GPT' },
  nan: { text: 'NaN' },
  anthropic_api: { text: 'A', sub: 'API' },
  openai_api: { text: 'O', sub: 'API' },
  gemini: { text: 'Ge' },
  cursor: { text: 'Cu' },
  copilot: { text: 'Co' },
  openrouter: { text: 'OR' },
  minimax: { text: 'MM' },
  nine_router: { text: '9R' },
  opencode_go: { text: 'OC' },
};

/** Las APIs de pago por uso llevan una etiqueta «API» para distinguirlas de la suscripción. */
const API_TAG = new Set(['anthropic_api', 'openai_api']);

export function ProviderLogo({ id: rawId, name }: { id: string; name: string }) {
  const [broken, setBroken] = useState(false);
  // Las cuentas adicionales (`claude:trabajo`) llevan el logo de su proveedor.
  const provider = providerOf(rawId);
  // Los sub-proveedores de 9Router (`nine_router:minimax-cn`) usan su propio
  // nombre: si no, todos mostrarían el mismo monograma «9R». Si el nombre visible
  // es el de un nodo personalizado («Zhipu», «QWEN - Alibaba»), se busca el logo
  // por él; si no, por el id saneado del sub-proveedor.
  const sub = rawId.includes(':') && provider === 'nine_router' ? subLogoKey(rawId, name) : null;
  const id = sub ?? provider;
  const logo = findLogo(id);

  if (logo && !broken) {
    const tag = API_TAG.has(id) ? <span className="logo__tag">API</span> : null;
    if (logo.kind === 'svg') {
      return (
        <span className="logo__art" data-id={id} role="img" aria-label={name}>
          <span className="logo__svg" dangerouslySetInnerHTML={{ __html: logo.markup }} />
          {tag}
        </span>
      );
    }
    return (
      <span className="logo__art" data-id={id}>
        <img className="logo__img" src={logo.url} alt={name} draggable={false} onError={() => setBroken(true)} />
        {tag}
      </span>
    );
  }

  const m = MONOGRAM[id] ?? { text: monogramText(id) };
  return (
    <span className="logo__mono" data-len={m.text.length} aria-label={name}>
      {m.text}
      {m.sub && <small>{m.sub}</small>}
    </span>
  );
}
/** Monograma breve y legible a partir de un id de proveedor.
 * `minimax-cn` -> «MC», `codebuddy-intl` -> «CI», `zed` -> «ZE», `github` -> «GH». */
function monogramText(id: string): string {
  const parts = id.split(/[^a-z0-9]+/i).filter(Boolean);
  const letters =
    parts.length > 1
      ? parts.map((p) => p[0]).join("")
      : (parts[0] ?? "").slice(0, 2);
  return (letters.slice(0, 3) || "??").toUpperCase();
}
