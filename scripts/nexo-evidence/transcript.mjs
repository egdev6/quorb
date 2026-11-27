// Evidence for the Nexo hub integration (#281): turns the transcript of the
// plugin's `sim_hub` fixture into the cases the review asks to see.
//
// The fixture prints one line per event:
//   `Listening on \\.\pipe\nexo-hub-<SID> (current user only)`
//   `-> <json>`   frame the hub sent to the app
//   `<- <json>`   frame the app sent to the hub
//   `Registered app: <id> / <name> / <version>`
//   `Menu replacement: [...]`
//   `App connected` / `Waiting for an app` / `Dropping connection; ...`
//
// Only the protocol is observable from CI: whether the icon is *visible* in the
// Windows tray is not, so those cases stay a manual check.

const FRAME = /^(->|<-) (\{.*\})$/;
const REGISTERED = /^Registered app: (.*) \/ (.*) \/ (.*)$/;
const MENU = /^Menu replacement: (.*)$/;

/** Los ids que Quorb declara al hub; el hub añade por su cuenta Open y Quit. */
export const HUB_MENU_IDS = ['toggle', 'refresh', 'settings'];

/**
 * Parsea la transcripción de `sim_hub` en eventos estructurados.
 *
 * @param {string} text salida completa del fixture
 */
export function parseTranscript(text) {
  const frames = [];
  const registrations = [];
  const menus = [];
  const unified = [];
  let sessions = 0;
  let drops = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const frame = FRAME.exec(line);
    if (frame) {
      let data = null;
      try {
        data = JSON.parse(frame[2]);
      } catch {
        data = null;
      }
      frames.push({ direction: frame[1] === '<-' ? 'app-to-hub' : 'hub-to-app', type: data?.type ?? null, data });
      continue;
    }
    const registered = REGISTERED.exec(line);
    if (registered) {
      registrations.push({ id: registered[1], name: registered[2], version: registered[3] });
      continue;
    }
    const menu = MENU.exec(line);
    if (menu) {
      menus.push(line);
      continue;
    }
    if (line === 'App connected') sessions += 1;
    if (line.startsWith('Dropping connection')) drops += 1;
    if (line.startsWith('Unified:')) {
      const value = line.slice('Unified:'.length).trim();
      unified.push(value === 'true');
    }
  }
  return { frames, registrations, menus, unified, sessions, drops };
}

/** Los frames de un tipo, en el orden en que aparecieron. */
export function framesOf(transcript, type) {
  return transcript.frames.filter((frame) => frame.type === type);
}

/**
 * Evalúa la transcripción y devuelve un caso por cada punto verificable por
 * protocolo, con su resultado y el detalle que lo sostiene.
 *
 * @param {ReturnType<typeof parseTranscript>} transcript
 */
export function evaluate(transcript) {
  const cases = [];

  const register = framesOf(transcript, 'register').at(-1)?.data ?? null;
  const capabilities = Array.isArray(register?.capabilities) ? register.capabilities : [];
  cases.push({
    id: 'registro',
    title: 'La app se registra en el hub con sus capacidades',
    ok: Boolean(register) && ['show', 'quit', 'menu'].every((capability) => capabilities.includes(capability)),
    detail: register ? `${register.app?.id} ${register.app?.version} · capacidades: ${capabilities.join(', ')}` : 'no se vio ningún frame de registro',
  });

  const menu = framesOf(transcript, 'menu').at(-1)?.data ?? null;
  const items = Array.isArray(menu?.items) ? menu.items : [];
  const ids = items.map((item) => item.id);
  cases.push({
    id: 'menu',
    title: 'El hub recibe el menú de Quorb con sus tres ids',
    ok: HUB_MENU_IDS.every((id) => ids.includes(id)) && items.every((item) => typeof item.label === 'string' && item.label.length > 0),
    detail: items.length ? `${ids.join(', ')} → ${items.map((item) => item.label).join(' | ')}` : 'no se vio ningún frame de menú',
  });

  cases.push({
    id: 'unified',
    title: 'El hub puede alternar el modo unificado sin tumbar la sesión',
    ok: transcript.unified.length >= 2 && transcript.registrations.length >= 1,
    detail: `alternancias unified: ${transcript.unified.join(', ')}`,
  });

  cases.push({
    id: 'caida',
    title: 'Al caer el hub la app vuelve a conectarse y a registrarse',
    ok: transcript.drops >= 1 && transcript.registrations.length >= 2,
    detail: `caídas: ${transcript.drops} · registros: ${transcript.registrations.length}`,
  });

  const quit = framesOf(transcript, 'quit_result').at(-1)?.data ?? null;
  const bye = framesOf(transcript, 'bye').length > 0;
  cases.push({
    id: 'quit',
    title: '«Salir» del hub se acepta y la app se despide',
    ok: quit?.accepted === true && bye,
    detail: quit ? `quit_result accepted=${quit.accepted}${quit.reason ? ` · motivo: ${quit.reason}` : ''} · bye=${bye}` : 'no se vio ningún quit_result',
  });

  return cases;
}

/** Resumen textual para el log del job y para el comentario de la PR. */
export function summarize(cases) {
  return cases.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'} · ${entry.id} · ${entry.title} — ${entry.detail}`).join('\n');
}
