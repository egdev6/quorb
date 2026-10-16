import { readFileSync as readFile } from 'node:fs';
import { execFileSync as execute } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePreviewSource } from './macos-preview-policy.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const matches = (value, pattern) => typeof value === 'string' && value === value.trim() && pattern.test(value);
const shaFormat = /^[0-9a-f]{40}$/;
const versionFormat = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

async function readChecks(response, signal) {
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

// Dependencies are acquired only on invocation; imports never read provenance or contact GitHub.
export async function preflightPreview({ root = projectRoot, env = process.env,
  readFileSync = readFile, execFileSync = execute, fetch = globalThis.fetch } = {}) {
  let failure = 'Invalid preview inputs';
  try {
    const { GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_SHA: workflowSha,
      PREVIEW_SOURCE_SHA: sourceSha, PREVIEW_VERSION: expectedVersion, GH_TOKEN: token } = env;
    if (repository !== 'egdev6/quorb' || ref !== 'refs/heads/main' ||
        !matches(workflowSha, shaFormat) || !matches(sourceSha, shaFormat) || sourceSha !== workflowSha ||
        !matches(expectedVersion, versionFormat) || typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
      throw new Error();
    }
    failure = 'Invalid preview package version';
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))?.version;
    if (!matches(version, versionFormat) || version !== expectedVersion) throw new Error();
    failure = 'Unable to verify preview HEAD';
    const output = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const headSha = output.replace(/\r?\n$/, '');
    if (!matches(headSha, shaFormat) || headSha !== workflowSha) throw new Error();
    failure = 'Unable to read preview checks';
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(`https://api.github.com/repos/egdev6/quorb/commits/${workflowSha}/check-runs?per_page=100`, {
      method: 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28' },
    });
    const checks = await readChecks(response, signal);
    failure = 'Preview source checks rejected';
    validatePreviewSource({ ref, expectedVersion, version, sourceSha, workflowSha, headSha, checks });
    return { sourceSha, version };
  } catch {
    throw new Error(failure);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await preflightPreview()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
