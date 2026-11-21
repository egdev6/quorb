// Procedimiento de firma del updater de Quorb. SOLO se ejecuta en una terminal
// interactiva del owner (TTY), nunca en CI. Importarlo no tiene efectos.
//   npm run setup:signing -- --repo egdev6/quorb
//
// 1. Comprueba que estás en la raíz git y que el remoto `origin` es el mismo
//    repo GitHub que pides con --repo (leyendo solo la config de git).
// 2. Verifica el repo objetivo con `gh repo view` (nombre canónico y permiso),
//    no con el estado de autenticación ambiental.
// 3. Anuncia el plan y pide confirmación explícita en la terminal.
// 4. Genera el par de claves con la CLI nativa de Tauri: su prompt oculto de
//    contraseña ocurre en la TTY del owner (sin contraseña por argv/entorno).
// 5. Escribe SOLO la clave pública en src-tauri/tauri.conf.json.
// 6. Sube la clave privada y la contraseña como secretos del repo, pasando los
//    valores canónicos por stdin. Nunca por argv, ni se imprimen.
//
// No crea repos, no hace login, no instala nada, no mueve carpetas y no firma ni
// publica. La clave privada no sale del equipo salvo hacia los secretos de GitHub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isValidUpdaterPubkey } from './release-check.mjs';

export const SECRET_KEY = 'TAURI_SIGNING_PRIVATE_KEY';
export const SECRET_PASSWORD = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD';
const KEY_DIR_RELATIVE = '.tauri';
const KEY_RELATIVE = path.join(KEY_DIR_RELATIVE, 'quorb.key');
const CONF_RELATIVE = path.join('src-tauri', 'tauri.conf.json');
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const COMMENT_PREFIX = 'untrusted comment: ';
const SENSITIVE_ENV = [SECRET_KEY, SECRET_PASSWORD, 'TAURI_SIGNING_PRIVATE_KEY_PATH'];
const GENERATION_STDIO = ['inherit', 'pipe', 'inherit'];
const MIN_SECRET_PAYLOAD_BYTES = 32;

export function isValidRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

/** Exige `--repo owner/nombre` explícito; no asume ningún repositorio. */
export function parseRepoArg(argv) {
  let repo = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--repo') throw new Error(`Argumento no reconocido: ${JSON.stringify(argv[i])}. Uso: npm run setup:signing -- --repo owner/nombre`);
    if (repo !== null) throw new Error('--repo está repetido');
    repo = argv[i + 1];
    if (!repo || repo.startsWith('-')) throw new Error('--repo necesita un valor owner/nombre');
    i += 1;
  }
  if (repo === null) throw new Error('Falta --repo owner/nombre (no se asume ningún repositorio)');
  if (!isValidRepo(repo)) throw new Error(`Repositorio no válido: ${JSON.stringify(repo)}`);
  return repo;
}

/** Rechaza la ejecución fuera de una terminal del owner o dentro de CI. */
export function assertOwnerTty({ stdin = {}, stdout = {}, env = {} } = {}) {
  if (!stdin.isTTY || !stdout.isTTY || env.CI) {
    throw new Error('Este procedimiento solo se ejecuta en una terminal interactiva del owner (TTY), nunca en CI.');
  }
}

// Solo ENOENT significa "no existe". Cualquier otro error (permisos, EACCES...)
// se relanza para fallar cerrado en vez de fingir que no hay fichero.
function lstatOrNull(fsImpl, target) {
  try {
    return fsImpl.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Estado del par: none | complete | partial | unsafe (enlace o no-fichero). */
export function inspectKeyPair({ fsImpl = fs, keyPath, pubPath }) {
  const entries = [lstatOrNull(fsImpl, keyPath), lstatOrNull(fsImpl, pubPath)];
  if (entries.every((entry) => entry == null)) return 'none';
  if (entries.some((entry) => entry != null && !entry.isFile())) return 'unsafe';
  if (entries.every((entry) => entry != null && entry.isFile())) return 'complete';
  return 'partial';
}

/** Estado del directorio de claves: absent | dir | unsafe (enlace/no-dir). */
export function inspectKeyDir({ fsImpl = fs, dirPath }) {
  const entry = lstatOrNull(fsImpl, dirPath);
  if (entry == null) return 'absent';
  return entry.isDirectory() ? 'dir' : 'unsafe';
}

/** Generación nativa: prompt de contraseña en la TTY, sin flags de modo. */
export function generateCommand(cliPath, keyPath) {
  return [cliPath, 'signer', 'generate', '--write-keys', keyPath];
}

/** `gh secret set` leyendo el valor de stdin; el valor nunca viaja por argv. */
export function secretSetCommand(repo, name) {
  return ['secret', 'set', name, '--repo', repo];
}

// Decodifica base64 de forma estricta: rechaza caracteres inválidos, longitudes
// imposibles y cualquier cadena que no sea canónica (round-trip). Nunca decodifica
// "a la ligera" aceptando basura.
function strictBase64Decode(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const buffer = Buffer.from(text, 'base64');
  if (buffer.length === 0) return null;
  if (buffer.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) return null;
  return buffer;
}

/**
 * Normaliza el contenido de un fichero minisign a texto. Acepta el texto crudo
 * (empieza por `untrusted comment:`) o el mismo texto envuelto en base64, que es
 * lo que produce la CLI nativa al "encode secret key". Devuelve null si no es
 * ninguna de esas formas; nunca adivina.
 */
export function normalizeMinisignText(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith(COMMENT_PREFIX)) return { text: content, encoded: false };
  const decoded = strictBase64Decode(trimmed);
  if (decoded == null) return null;
  const decodedText = decoded.toString('utf8');
  if (!decodedText.startsWith(COMMENT_PREFIX)) return null;
  return { text: decodedText, encoded: true };
}

/**
 * Secreto canónico para GitHub: SIEMPRE base64 del texto minisign, que es lo que
 * espera el firmante de Tauri. Nunca se sube el payload crudo.
 */
export function toCanonicalKeySecret(content) {
  const normalized = normalizeMinisignText(content);
  return normalized == null ? null : Buffer.from(normalized.text, 'utf8').toString('base64');
}

/** Clave pública canónica (base64 del texto minisign) para tauri.conf.json. */
export function toCanonicalPubkey(content) {
  const normalized = normalizeMinisignText(content);
  return normalized == null ? null : Buffer.from(normalized.text, 'utf8').toString('base64');
}

/**
 * Guard heurístico (no validación criptográfica): el fichero debe normalizarse a
 * un texto minisign cuyo primer comentario diga que está cifrado y cuyo payload
 * base64 decodifique a bytes con tamaño plausible de clave. La garantía real del
 * cifrado es el prompt de contraseña nativo que teclea el owner.
 */
export function isEncryptedSecretKeyText(content) {
  const normalized = normalizeMinisignText(content);
  if (normalized == null) return false;
  const lines = normalized.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;
  if (!/^untrusted comment: .*encrypted secret key\s*$/.test(lines[0].trim())) return false;
  const payload = strictBase64Decode(lines[1].trim());
  return payload != null && payload.length >= MIN_SECRET_PAYLOAD_BYTES;
}

/**
 * Reconoce remotos GitHub https/ssh y devuelve `owner/nombre`. Cualquier host,
 * sintaxis rara o credencial incrustada devuelve null sin exponer el valor.
 */
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  const patterns = [
    /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
    /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

/** Copia el entorno quitando secretos conocidos; no registra ningún valor. */
export function sanitizeSecretEnv(env) {
  const copy = { ...(env ?? {}) };
  for (const name of SENSITIVE_ENV) delete copy[name];
  return copy;
}

/** Valida el repo canónico y el permiso de escritura de `gh repo view --json`. */
export function verifyTarget(stdout, repo) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('Respuesta ilegible de gh repo view.');
  }
  const canonical = data?.nameWithOwner;
  if (typeof canonical !== 'string' || canonical.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`El repo canónico (${canonical ?? 'desconocido'}) no coincide con ${repo}.`);
  }
  if (!WRITE_PERMISSIONS.has(data.viewerPermission)) {
    throw new Error(`Sin permiso de escritura verificado en ${repo} (viewerPermission=${data.viewerPermission ?? 'nulo'}).`);
  }
  return { nameWithOwner: canonical, isPrivate: data.isPrivate === true, viewerPermission: data.viewerPermission };
}

/** Lista de secretos ya existentes; aborta si la respuesta no es un array válido. */
export function preexistingSecrets(listStdout) {
  let data;
  try {
    data = JSON.parse(listStdout);
  } catch {
    throw new Error('No pude interpretar la lista de secretos del repo; se aborta por seguridad.');
  }
  if (!Array.isArray(data)) throw new Error('La lista de secretos del repo no tiene el formato esperado; se aborta.');
  const names = data.map((entry) => {
    if (!entry || typeof entry.name !== 'string') throw new Error('La lista de secretos del repo contiene entradas no válidas; se aborta.');
    return entry.name;
  });
  return [SECRET_KEY, SECRET_PASSWORD].filter((name) => names.includes(name));
}

/** Preflight local antes de escribir la config pública: config, CLI y raíz git. */
export function checkPreflight({ fsImpl = fs, cwd, cliPath, confPath, gitToplevel = null }) {
  const errors = [];
  if (!fsImpl.existsSync(path.join(cwd, 'package.json'))) errors.push('Ejecuta el helper desde la raíz del proyecto (falta package.json).');
  if (gitToplevel == null) errors.push('No pude determinar la raíz git; ejecútalo dentro del repositorio.');
  else if (path.resolve(gitToplevel) !== path.resolve(cwd)) errors.push(`La raíz git (${gitToplevel}) no es el directorio actual.`);
  if (!fsImpl.existsSync(cliPath)) errors.push('Falta la CLI de Tauri en node_modules; ejecuta npm install aparte (aquí no se instala nada).');
  if (!fsImpl.existsSync(confPath)) errors.push(`Falta ${CONF_RELATIVE}.`);
  else {
    try {
      if (!JSON.parse(fsImpl.readFileSync(confPath, 'utf8'))?.plugins?.updater) errors.push('tauri.conf.json no declara plugins.updater.');
    } catch {
      errors.push('tauri.conf.json no es JSON válido.');
    }
  }
  return errors;
}

/** Cierra permisos solo si aflojan; nunca relaja permisos ya más estrictos. */
export function restrictPrivateKey({ fsImpl = fs, keyPath }) {
  if ((fsImpl.statSync(keyPath).mode & 0o077) !== 0) fsImpl.chmodSync(keyPath, 0o600);
}

function defaultGitToplevel() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Orquesta el procedimiento completo. Todas las dependencias son inyectables
 * para poder probarlo con fixtures temporales y un ejecutor falso.
 */
export async function runSetup(deps) {
  const {
    argv,
    cwd,
    home,
    fsImpl = fs,
    run,
    confirm,
    promptHidden,
    log = console.log,
    setUmask = (value) => process.umask(value),
    tty = { stdin: process.stdin, stdout: process.stdout },
    env = process.env,
    gitToplevel = defaultGitToplevel(),
  } = deps;

  const repo = parseRepoArg(argv);
  assertOwnerTty({ stdin: tty.stdin, stdout: tty.stdout, env });

  const cliPath = path.join(cwd, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const confPath = path.join(cwd, CONF_RELATIVE);
  const keyDir = path.join(home, KEY_DIR_RELATIVE);
  const keyPath = path.join(home, KEY_RELATIVE);
  const pubPath = `${keyPath}.pub`;

  const preflight = checkPreflight({ fsImpl, cwd, cliPath, confPath, gitToplevel });
  if (preflight.length) throw new Error(preflight.join('\n'));

  if (inspectKeyDir({ fsImpl, dirPath: keyDir }) === 'unsafe') {
    throw new Error(`${keyDir} no es un directorio normal (¿enlace simbólico?); se rechaza antes de escribir.`);
  }

  const state = inspectKeyPair({ fsImpl, keyPath, pubPath });
  if (state === 'partial') {
    throw new Error(`Par de claves incompleto en ${keyPath}: falta o sobra uno de los dos ficheros. No se sobrescribe ni se reintenta; inspecciónalo a mano.`);
  }
  if (state === 'unsafe') {
    throw new Error(`${keyPath} o su .pub no es un fichero regular (¿enlace simbólico?). Se rechaza antes de escribir.`);
  }

  const origin = run('git', ['remote', 'get-url', 'origin']);
  if (origin.status !== 0) throw new Error('No pude leer el remoto origin con git. Ejecútalo dentro del repositorio; no se continúa.');
  const originRepo = parseGitHubRemote(origin.stdout);
  if (originRepo == null) throw new Error('El remoto origin no es una URL GitHub https/ssh reconocida; no se continúa (no se muestra el valor).');
  if (originRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`El remoto origin (${originRepo}) no coincide con --repo (${repo}); no se sube nada.`);
  }

  const view = run('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,isPrivate,viewerPermission']);
  if (view.status !== 0) throw new Error(`No pude verificar ${repo} con gh (revisa sesión y permisos). No se crea el repo ni se hace login.`);
  const target = verifyTarget(view.stdout, repo);

  if (state === 'complete' && !isEncryptedSecretKeyText(fsImpl.readFileSync(keyPath, 'utf8'))) {
    throw new Error(`La clave existente en ${keyPath} no parece cifrada; no se reutiliza sin contraseña.`);
  }

  log('Vas a ejecutar (solo metadatos):');
  log(`  • ${state === 'complete' ? 'reutilizar' : 'crear'} el par cifrado en ${keyPath} (prompt nativo de contraseña)`);
  log(`  • escribir SOLO la clave pública canónica en ${CONF_RELATIVE}`);
  log(`  • subir ${SECRET_KEY} y ${SECRET_PASSWORD} a ${target.nameWithOwner} (privado=${target.isPrivate})`);
  if (!(await confirm('¿Continuar?'))) return { status: 'cancelled' };

  if (state === 'none') {
    setUmask(0o077);
    fsImpl.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    // stdin TTY para el prompt oculto, stdout descartado (nunca se imprime lo que
    // capture) y stderr heredado. El entorno del hijo va sin secretos conocidos.
    const generated = run(process.execPath, generateCommand(cliPath, keyPath), { stdio: GENERATION_STDIO, env: sanitizeSecretEnv(env) });
    if (generated.status !== 0) {
      throw new Error('La generación nativa falló. Los ficheros, si existen, se conservan; no se reintenta ni se sobrescribe. Inspecciónalos a mano.');
    }
  } else if (!(await confirm(`Ya existe un par en ${keyPath}. ¿Reutilizarlo?`))) {
    throw new Error('Cancelado: no se reutiliza el par existente.');
  }

  if (inspectKeyPair({ fsImpl, keyPath, pubPath }) !== 'complete') {
    throw new Error('La generación no dejó un par de ficheros regular completo; no se toca tauri.conf.json.');
  }
  restrictPrivateKey({ fsImpl, keyPath });

  const privateKey = fsImpl.readFileSync(keyPath, 'utf8');
  if (!isEncryptedSecretKeyText(privateKey)) {
    throw new Error('La clave privada no parece cifrada; no se continúa. Repite la generación eligiendo una contraseña no vacía.');
  }
  const keySecret = toCanonicalKeySecret(privateKey);
  if (keySecret == null) throw new Error('No pude normalizar la clave privada a base64 minisign; no se sube nada.');
  const pubCanonical = toCanonicalPubkey(fsImpl.readFileSync(pubPath, 'utf8'));
  if (pubCanonical == null || !isValidUpdaterPubkey(pubCanonical)) {
    throw new Error('La clave pública no normaliza a base64 minisign que acepte el updater; no se escribe en tauri.conf.json.');
  }

  const password = await promptHidden('Contraseña de la clave para el secreto de GitHub (obligatoria, no se muestra): ');
  if (!password) throw new Error('La contraseña del secreto no puede estar vacía; elige una y vuelve a empezar.');

  const list = run('gh', ['secret', 'list', '--repo', repo, '--json', 'name']);
  if (list.status !== 0) throw new Error('No pude listar los secretos del repo con gh; se aborta antes de escribir o subir nada.');
  const existing = preexistingSecrets(list.stdout);
  if (existing.length && !(await confirm(`Ya existen los secretos ${existing.join(', ')} en ${repo}. ¿Reemplazarlos?`))) {
    throw new Error('Cancelado: no se rotan secretos existentes sin confirmación explícita.');
  }

  let conf;
  try {
    conf = JSON.parse(fsImpl.readFileSync(confPath, 'utf8'));
  } catch {
    throw new Error(`${CONF_RELATIVE} no es JSON válido; no se escribe.`);
  }
  conf.plugins ??= {};
  conf.plugins.updater ??= {};
  conf.plugins.updater.pubkey = pubCanonical;
  fsImpl.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  log(`✔ Clave pública escrita en ${CONF_RELATIVE}.`);

  const uploads = [
    { name: SECRET_KEY, value: keySecret },
    { name: SECRET_PASSWORD, value: password },
  ];
  const uploaded = [];
  for (const { name, value } of uploads) {
    const result = run('gh', secretSetCommand(repo, name), { input: value });
    if (result.status !== 0) {
      throw new Error(
        `Falló la subida de ${name} a ${repo}. Subidos: ${uploaded.length ? uploaded.join(', ') : 'ninguno'}. No se reintenta ni se revierte; revísalo a mano.`,
      );
    }
    uploaded.push(name);
  }

  log(`✔ Secretos creados en ${repo}: ${uploaded.join(', ')}.`);
  log('Metadatos: clave pública escrita y secretos creados. La verificación de firma real sigue pendiente del workflow.');
  return { status: 'completed', repo, publicConfigUpdated: true, secretsUploaded: uploaded };
}

function makeHiddenPrompt(stdin, stdout) {
  return (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      rl._writeToOutput = (chunk) => {
        if (chunk.includes(question)) stdout.write(chunk);
      };
      rl.question(question, (answer) => {
        rl.close();
        stdout.write('\n');
        resolve(answer);
      });
    });
}

function makeConfirm(stdin, stdout) {
  return (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question(`${question} [s/N] `, (answer) => {
        rl.close();
        resolve(/^s[ií]?$/i.test(answer.trim()));
      });
    });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runSetup({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    home: os.homedir(),
    env: process.env,
    tty: { stdin: process.stdin, stdout: process.stdout },
    run: (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options }),
    promptHidden: makeHiddenPrompt(process.stdin, process.stdout),
    confirm: makeConfirm(process.stdin, process.stdout),
  })
    .then((result) => {
      if (result.status === 'cancelled') console.log('Cancelado; no se hizo nada.');
    })
    .catch((error) => {
      console.error(`✖ ${error.message}`);
      process.exitCode = 1;
    });
}
