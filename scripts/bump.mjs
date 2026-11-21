// Sube la versión en package.json, package-lock.json, src-tauri/Cargo.toml
// (sección [package]) y la entrada `quorb` de src-tauri/Cargo.lock.
//   npm run bump 0.1.1
//
// Valida las cuatro fuentes coherentes ANTES de escribir la primera. No es una
// transacción atómica entre ficheros: si una escritura falla a mitad, revisa el
// diff y vuelve a ejecutar (las escrituras son idempotentes). Recibe `cwd` para
// poder probarla en un directorio temporal.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION_RE = new RegExp(`^${CORE}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);

/** ¿Es una versión SemVer válida (con o sin preestreno) y sin metacaracteres? */
export function isValidVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version);
}

function parseVersion(version) {
  const match = VERSION_RE.exec(version);
  if (!match) throw new Error(`Versión no válida: ${version}`);
  return { main: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : null };
}

/** Compara dos versiones SemVer: -1 si a < b, 0 si iguales, 1 si a > b. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (va.main[i] !== vb.main[i]) return va.main[i] < vb.main[i] ? -1 : 1;
  }
  if (!va.pre || !vb.pre) return va.pre === vb.pre ? 0 : va.pre ? -1 : 1;
  const length = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < length; i += 1) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON no válido en ${label}`);
  }
}

export function packageJsonVersion(text) {
  return parseJson(text, 'package.json')?.version;
}

export function packageLockVersions(text) {
  const lock = parseJson(text, 'package-lock.json');
  return [lock?.version, lock?.packages?.['']?.version];
}

/** Versión de la sección `[package]` (no la primera `version =` del fichero). */
export function cargoTomlVersion(text) {
  const block = text.split(/^\[/m).find((part) => part.startsWith('package]'));
  return block?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
}

/** Reemplaza la versión dentro de `[package]` sin tocar otras secciones. */
export function setCargoTomlVersion(text, version) {
  const lines = text.split('\n');
  let inPackage = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) inPackage = lines[i].trim() === '[package]';
    else if (inPackage && /^\s*version\s*=\s*"/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*version\s*=\s*")[^"]*(")/, `$1${version}$2`);
      return lines.join('\n');
    }
  }
  throw new Error('No encontré version en la sección [package] de src-tauri/Cargo.toml');
}

export function cargoLockVersion(text) {
  return text.match(/\[\[package\]\]\r?\nname = "quorb"\r?\nversion = "([^"]+)"/)?.[1];
}

const FILES = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];

/** Actualiza las cuatro fuentes. Valida todo antes de escribir la primera. */
export function bumpVersion(version, { cwd = process.cwd() } = {}) {
  if (!isValidVersion(version)) throw new Error(`Versión no válida: ${JSON.stringify(version)}`);

  const read = (file) => {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) throw new Error(`Falta ${file}`);
    return fs.readFileSync(full, 'utf8');
  };
  const texts = { pkg: read(FILES[0]), lock: read(FILES[1]), toml: read(FILES[2]), cargoLock: read(FILES[3]) };

  const current = [packageJsonVersion(texts.pkg), ...packageLockVersions(texts.lock), cargoTomlVersion(texts.toml), cargoLockVersion(texts.cargoLock)];
  if (current.some((value) => !value)) throw new Error(`No pude leer la versión en todas las fuentes: ${current.join(', ')}`);
  if (new Set(current).size !== 1) throw new Error(`Versiones actuales incoherentes: ${current.join(', ')}`);
  if (compareVersions(version, current[0]) <= 0) throw new Error(`La versión ${version} no es mayor que la actual ${current[0]}`);

  const pkg = parseJson(texts.pkg, FILES[0]);
  pkg.version = version;
  const lock = parseJson(texts.lock, FILES[1]);
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  const toml = setCargoTomlVersion(texts.toml, version);
  const cargoLock = texts.cargoLock.replace(/(\[\[package\]\]\r?\nname = "quorb"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);

  fs.writeFileSync(path.join(cwd, FILES[0]), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(cwd, FILES[1]), JSON.stringify(lock, null, 2) + '\n');
  fs.writeFileSync(path.join(cwd, FILES[2]), toml);
  fs.writeFileSync(path.join(cwd, FILES[3]), cargoLock);
  return [...FILES];
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const version = process.argv[2];
  try {
    bumpVersion(version);
  } catch (error) {
    console.error(`${error.message}\nUso: npm run bump <x.y.z>`);
    process.exit(1);
  }
  console.log(
    `Versión ${version} actualizada en los cuatro manifiestos. Ahora:\n` +
      '  1. Revisa el diff y abre o actualiza el PR de preparación.\n' +
      '  2. Tras el merge, publica con el workflow manual (Actions → Release). No se crean tags a mano.',
  );
}
