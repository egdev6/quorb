// Preflight del workflow de release: valida los inputs y la fuente ANTES de
// compilar o firmar. En CI:
//   RELEASE_VERSION=0.1.1 RELEASE_SOURCE_SHA=<40hex> node scripts/release-check.mjs
//
// `checkRelease` recibe un `git` inyectable (ver `createGit`) para probarlo sin
// red ni repositorio real. Los valores llegan por variables de entorno; nunca se
// interpolan en shell. Solo comprueba estado local: no consulta la API de GitHub,
// así que un borrador de release remoto sin tag local no se detecta aquí.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isValidVersion, packageJsonVersion, packageLockVersions, cargoTomlVersion, cargoLockVersion } from './bump.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const PLACEHOLDER_RE = /pega[_\s-]*aqui[_\s-]*tu[_\s-]*clave[_\s-]*publica/i;

/** ¿Es un SHA de 40 hex minúscula, sin nada añadido? */
export function isValidSha(value) {
  return typeof value === 'string' && SHA_RE.test(value);
}

/** Versión estable: este flujo no publica preestrenos. */
export function isStableVersion(version) {
  return isValidVersion(version) && !version.includes('-');
}

/**
 * Clave pública del updater: la CLI de Tauri envuelve en base64 el fichero .pub
 * de minisign, que empieza por "untrusted comment:". Rechaza no-strings, vacíos,
 * placeholders (en cualquier variante) y valores que no decodifican así.
 */
export function isValidUpdaterPubkey(pubkey) {
  if (typeof pubkey !== 'string') return false;
  const value = pubkey.trim();
  if (!value || PLACEHOLDER_RE.test(value)) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length < 40) return false;
  try {
    return Buffer.from(value, 'base64').toString('utf8').startsWith('untrusted comment:');
  } catch {
    return false;
  }
}

/** Acceso a git limitado a lo que necesita el preflight. */
export function createGit(cwd = process.cwd()) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    fileAt(sha, file) {
      try {
        return run(['show', `${sha}:${file}`]);
      } catch {
        return null;
      }
    },
    isAncestor(sha, ref) {
      try {
        run(['merge-base', '--is-ancestor', sha, ref]);
        return true;
      } catch {
        return false;
      }
    },
    tagExists(tag) {
      try {
        run(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const READERS = {
  'package.json': (text) => [packageJsonVersion(text)],
  'package-lock.json': (text) => packageLockVersions(text),
  'src-tauri/Cargo.toml': (text) => [cargoTomlVersion(text)],
  'src-tauri/Cargo.lock': (text) => [cargoLockVersion(text)],
};

/** Devuelve la lista de errores; vacía significa que la release puede seguir. */
export function checkRelease({ version, sourceSha, git }) {
  const errors = [];
  if (!isValidVersion(version)) errors.push(`version inválida o con caracteres no permitidos: ${JSON.stringify(version)}`);
  if (!isValidSha(sourceSha)) errors.push(`source_sha inválido (se esperan 40 hex minúscula): ${JSON.stringify(sourceSha)}`);
  if (errors.length) return errors;

  if (!isStableVersion(version)) errors.push(`este flujo solo publica versiones estables (sin preestreno): ${version}`);
  if (!git.isAncestor(sourceSha, 'origin/main')) errors.push(`source_sha ${sourceSha} no pertenece al historial de origin/main`);

  for (const [file, read] of Object.entries(READERS)) {
    const text = git.fileAt(sourceSha, file);
    if (text == null) {
      errors.push(`falta ${file} en ${sourceSha}`);
      continue;
    }
    let found = [];
    try {
      found = read(text).filter((value) => value != null);
    } catch {
      found = [];
    }
    const expected = file === 'package-lock.json' ? 2 : 1;
    if (found.length !== expected || found.some((value) => value !== version)) {
      errors.push(`${file} en ${sourceSha} no declara la versión ${version} (encontrado: ${JSON.stringify(found)})`);
    }
  }

  const tag = `v${version}`;
  if (git.tagExists(tag)) errors.push(`el tag ${tag} ya existe; borra el tag o elige otra versión antes de continuar`);

  const notes = git.fileAt(sourceSha, `docs/releases/v${version}.md`);
  if (notes == null || notes.trim() === '') {
    errors.push(`faltan o están vacías las notas docs/releases/v${version}.md en ${sourceSha}`);
  }

  let pubkey = null;
  try {
    pubkey = JSON.parse(git.fileAt(sourceSha, 'src-tauri/tauri.conf.json'))?.plugins?.updater?.pubkey;
  } catch {
    pubkey = null;
  }
  if (!isValidUpdaterPubkey(pubkey)) {
    errors.push('la clave pública del updater (src-tauri/tauri.conf.json) no está configurada o no es una clave minisign válida');
  }
  return errors;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const errors = checkRelease({
    version: process.env.RELEASE_VERSION,
    sourceSha: process.env.RELEASE_SOURCE_SHA,
    git: createGit(),
  });
  if (errors.length) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(`Release v${process.env.RELEASE_VERSION} validada para ${process.env.RELEASE_SOURCE_SHA}.`);
}
