import { execFileSync as execute } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, pattern) => typeof value === 'string' && value === value.trim() && pattern.test(value);
const validSha = (value) => matches(value, /^[0-9a-f]{40}$/);
const validVersion = (value) => matches(value, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);

// Pure input policy; invalid user input never reaches Git, URLs or a shell.
export function validateReleaseInputs({ ref, version, sourceSha }) {
  if (ref !== 'refs/heads/main') throw new Error('Release ref must be refs/heads/main');
  if (!validVersion(version)) throw new Error('Release version must be stable SemVer');
  if (!validSha(sourceSha)) throw new Error('Release source_sha must be 40 lowercase hex characters');
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
    while (true) {
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

// No import-time I/O. All external observations are injectable for offline tests.
export async function preflightRelease({ root = projectRoot, env = process.env,
  execFileSync = execute, fetch = globalThis.fetch } = {}) {
  const { GITHUB_REF: ref, RELEASE_VERSION: version, RELEASE_SOURCE_SHA: sourceSha,
    GITHUB_REPOSITORY: repository, GH_TOKEN: token } = env;
  validateReleaseInputs({ ref, version, sourceSha });
  if (repository !== 'egdev6/quorb' || typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Invalid release environment');
  }
  const git = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure = 'Release source_sha must be an ancestor of origin/main';
  try {
    git(['merge-base', '--is-ancestor', sourceSha, 'origin/main']);
    failure = 'Release package.json version must match version at source_sha';
    if (JSON.parse(git(['show', `${sourceSha}:package.json`]))?.version !== version) throw new Error();

    // One deadline bounds all requests, pages, annotated tags and streamed bodies.
    const signal = AbortSignal.timeout(30_000);
    const request = async (route, allowMissing = false) => {
      const response = await fetch(`https://api.github.com/repos/egdev6/quorb${route}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (allowMissing && response?.status === 404) {
        await response.body?.cancel();
        return null;
      }
      return readJson(response, signal);
    };
    const list = async (route) => {
      const entries = [];
      for (let page = 1; page <= 20; page++) {
        const data = await request(`${route}?per_page=100&page=${page}`);
        if (!Array.isArray(data) || data.length > 100 || data.some((entry) => !record(entry))) throw new Error();
        entries.push(...data);
        if (data.length < 100) return entries;
      }
      throw new Error(); // Fail closed rather than assume truncated lists are complete.
    };
    failure = 'Unable to verify release metadata';
    // The tag endpoint for releases cannot reliably discover unpublished drafts.
    const releases = await list('/releases');
    if (releases.some((release) => typeof release.tag_name !== 'string')) throw new Error();
    const found = releases.filter((release) => release.tag_name === `v${version}`);
    if (found.length === 0) throw new Error(`Release v${version} must already exist`);
    if (found.length !== 1) throw new Error();
    const release = found[0];
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.draft !== 'boolean' ||
        release.prerelease !== false || typeof release.target_commitish !== 'string') throw new Error();

    failure = 'Release tag must point at source_sha';
    const tag = await request(`/git/ref/tags/v${version}`, true);
    if (tag === null) {
      // Windows tauri-action creates a draft with a SHA commitish; GitHub may not
      // create its tag until publication. Never resolve a movable branch here.
      if (!release.draft || release.target_commitish !== sourceSha) throw new Error();
    } else {
      let object = tag.object;
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
    }
    failure = 'Unable to verify release assets';
    const assets = await list(`/releases/${release.id}/assets`);
    if (assets.some((asset) => typeof asset.name !== 'string')) throw new Error();
    const dmg = `Quorb_${version}_aarch64.dmg`;
    for (const name of [dmg, `${dmg}.sha256`]) {
      if (assets.some((asset) => asset.name === name)) throw new Error(`Release already contains ${name}`);
    }
    return { sourceSha, version, releaseId: release.id };
  } catch (error) {
    // Only these locally constructed diagnostics can escape; HTTP/Git messages
    // can contain tokens, paths or server-controlled text.
    if (failure === 'Unable to verify release metadata' && error.message === `Release v${version} must already exist`) {
      throw new Error(error.message);
    }
    if (failure === 'Unable to verify release assets' &&
        [ `Release already contains Quorb_${version}_aarch64.dmg`,
          `Release already contains Quorb_${version}_aarch64.dmg.sha256` ].includes(error.message)) {
      throw new Error(error.message);
    }
    throw new Error(failure);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await preflightRelease()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
