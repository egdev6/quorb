import { execFileSync as execute } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseInputs } from './macos-release-preflight.mjs';
import { packageJsonVersion, packageLockVersions, cargoTomlVersion, cargoLockVersion } from './bump.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = 'egdev6/quorb';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value === value.trim();

export function linuxAssetNames(version) {
  validateReleaseInputs({ ref: 'refs/heads/main', version, sourceSha: '0'.repeat(40) });
  const deb = `Quorb_${version}_amd64.deb`;
  const appimage = `Quorb_${version}_amd64.AppImage`;
  return [deb, `${deb}.sha256`, appimage, `${appimage}.sha256`];
}

async function readJson(response, signal) {
  if (!response?.ok || response.status !== 200 || typeof response.body?.getReader !== 'function') throw new Error();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    const chunks = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error();
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error();
      chunks.push(value);
    }
    complete = true;
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

// No import-time I/O; Git and HTTP can be replaced by offline test fakes.
export async function preflightRelease({ root = projectRoot, env = process.env,
  execFileSync = execute, fetch = globalThis.fetch } = {}) {
  const { GITHUB_REF: ref, RELEASE_VERSION: version, RELEASE_SOURCE_SHA: sourceSha,
    GITHUB_REPOSITORY, GH_TOKEN: token } = env;
  validateReleaseInputs({ ref, version, sourceSha });
  if (GITHUB_REPOSITORY !== repository || typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Invalid release environment');
  }
  const git = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure = 'Release source_sha must be an ancestor of origin/main';
  try {
    git(['merge-base', '--is-ancestor', sourceSha, 'origin/main']);
    failure = 'Release manifest versions or Tauri configuration do not match source_sha';
    const at = (file) => git(['show', `${sourceSha}:${file}`]);
    const versions = [packageJsonVersion(at('package.json')),
      ...packageLockVersions(at('package-lock.json')),
      cargoTomlVersion(at('src-tauri/Cargo.toml')),
      cargoLockVersion(at('src-tauri/Cargo.lock'))];
    const tauri = JSON.parse(at('src-tauri/tauri.conf.json'));
    if (versions.some((value) => value !== version) || tauri?.productName !== 'Quorb' ||
        !['../package.json', version].includes(tauri?.version)) throw new Error();

    // Bound all pages, annotated-tag hops and response bodies by one deadline.
    const signal = AbortSignal.timeout(30_000);
    const request = async (route) => readJson(await fetch(`https://api.github.com/repos/${repository}${route}`, {
      method: 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28' },
    }), signal);
    const list = async (route) => {
      const entries = [];
      for (let page = 1; page <= 20; page++) {
        const data = await request(`${route}?per_page=100&page=${page}`);
        if (!Array.isArray(data) || data.length > 100 || data.some((entry) => !record(entry))) throw new Error();
        entries.push(...data);
        if (data.length < 100) return entries;
      }
      throw new Error();
    };
    failure = 'Unable to verify release metadata';
    // The list endpoint also discovers drafts; the tag endpoint does not.
    const releases = await list('/releases');
    if (releases.some((release) => typeof release.tag_name !== 'string')) throw new Error();
    const found = releases.filter((release) => release.tag_name === `v${version}`);
    if (found.length === 0) throw new Error(`Release v${version} must already exist`);
    if (found.length !== 1 || !Number.isSafeInteger(found[0].id) || found[0].id <= 0 ||
        typeof found[0].draft !== 'boolean') throw new Error();
    const release = found[0];

    failure = 'Release tag must point at source_sha';
    let object = (await request(`/git/ref/tags/v${version}`)).object;
    const visited = new Set();
    for (let depth = 0; ; depth++) {
      if (!record(object) || !validSha(object.sha)) throw new Error();
      if (object.type === 'commit') {
        if (object.sha !== sourceSha) throw new Error();
        break;
      }
      if (object.type !== 'tag' || depth >= 8 || visited.has(object.sha)) throw new Error();
      visited.add(object.sha);
      object = (await request(`/git/tags/${object.sha}`)).object;
    }

    failure = 'Unable to verify release assets';
    const assets = await list(`/releases/${release.id}/assets`);
    if (assets.some((asset) => typeof asset.name !== 'string')) throw new Error();
    for (const name of linuxAssetNames(version)) {
      if (assets.some((asset) => asset.name === name)) throw new Error(`Release already contains ${name}`);
    }
    return { sourceSha, version, releaseId: release.id };
  } catch (error) {
    if (failure === 'Unable to verify release metadata' && error.message === `Release v${version} must already exist`) {
      throw new Error(error.message);
    }
    if (failure === 'Unable to verify release assets' &&
        linuxAssetNames(version).some((name) => error.message === `Release already contains ${name}`)) {
      throw new Error(error.message);
    }
    throw new Error(failure);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await preflightRelease())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
