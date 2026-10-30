import { execFileSync } from 'node:child_process';
import { hash, positiveId, hex, MAX_DMG, repository, workflowPath } from './macos-notary-checkpoint.mjs';

const API = `https://api.github.com/repos/${repository}`;
const MAX_ZIP = MAX_DMG + 1024 * 1024;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;

export function validateRun(run, workflow, { runId, runAttempt }) {
  if (!positiveId(runId) || !positiveId(runAttempt) || run?.id !== Number(runId) || run.run_attempt !== Number(runAttempt) ||
      !Number.isSafeInteger(workflow?.id) || workflow.id <= 0 || workflow.path !== workflowPath ||
      run.workflow_id !== workflow.id || run.path !== workflowPath || run.event !== 'workflow_dispatch' ||
      run.head_branch !== 'main' || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      !Number.isSafeInteger(run.repository?.id) || run.repository.id <= 0 || run.repository.id !== run.head_repository?.id ||
      !hex(run.head_sha, 40) || run.status !== 'completed' || !Number.isFinite(timestamp(run.run_started_at)) ||
      !Number.isFinite(timestamp(run.updated_at)) || timestamp(run.updated_at) < timestamp(run.run_started_at)) {
    throw new Error('Untrusted producer run/workflow/attempt');
  }
  // Deliberately not checking conclusion=success: cancellation after checkpoint
  // upload is recoverable. The attempt must have stopped before resuming it.
  return run;
}

export function validateArtifact(artifact, run, name, { now = Date.now(), end = timestamp(run.updated_at) } = {}) {
  const linked = artifact?.workflow_run;
  if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0 || artifact.name !== name || artifact.expired !== false ||
      !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '') || !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_ZIP || timestamp(artifact.expires_at) <= now ||
      !Number.isFinite(timestamp(artifact.expires_at)) || !Number.isFinite(timestamp(artifact.created_at)) ||
      timestamp(artifact.created_at) < timestamp(run.run_started_at) || timestamp(artifact.created_at) > end ||
      linked?.id !== run.id || linked.repository_id !== run.repository.id || linked.head_repository_id !== run.repository.id ||
      linked.head_sha !== run.head_sha || linked.head_branch !== 'main') throw new Error('Untrusted artifact metadata/attempt/expiry');
  return artifact;
}

export function selectArtifacts(artifacts, run, recovery = false, options = {}) {
  const select = (kind, optional) => {
    const name = `macos-notary-${kind}-${run.id}-${run.run_attempt}`;
    const matches = artifacts.filter((artifact) => artifact.name === name);
    if (matches.length > 1) throw new Error('Duplicate artifact name');
    if (!matches.length && optional) return null;
    if (matches.length !== 1) throw new Error(`Missing ${kind} artifact`);
    return validateArtifact(matches[0], run, name, options);
  };
  return { checkpoint: select('checkpoint', false), receipt: select('receipt', recovery) };
}

async function boundedBytes(response, limit) {
  if (!response.ok || response.status !== 200 || !response.body) throw new Error();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) throw new Error();
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function githubClient({ token, fetch = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Invalid GitHub read credentials');
  const signal = AbortSignal.timeout(120_000);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return {
    async json(route) {
      // Only locally constructed relative API routes; never server-supplied URLs.
      if (!/^\/actions\/[A-Za-z0-9_./?=&-]+$/.test(route) || route.includes('..')) throw new Error('Invalid artifact API route');
      try {
        const response = await fetch(API + route, { headers, redirect: 'error', signal });
        return JSON.parse((await boundedBytes(response, 1024 * 1024)).toString('utf8'));
      } catch { throw new Error('Unable to read trusted GitHub Actions metadata'); }
    },
    async artifacts(runId) {
      if (!positiveId(runId)) throw new Error('Invalid run ID');
      const result = [];
      for (let page = 1; page <= 20; page++) {
        const data = await this.json(`/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
        if (!Array.isArray(data.artifacts) || data.artifacts.length > 100) throw new Error('Invalid artifact listing');
        result.push(...data.artifacts);
        if (data.artifacts.length < 100) return result;
      }
      throw new Error('Artifact listing truncated');
    },
  };
}

export async function downloadZip(artifact, { token, fetch = globalThis.fetch } = {}) {
  if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0 || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '') ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_ZIP ||
      typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Invalid artifact download context');
  try {
    const signal = AbortSignal.timeout(120_000);
    let response = await fetch(`${API}/actions/artifacts/${artifact.id}/zip`, {
      method: 'GET', redirect: 'manual', signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (response.status === 302) {
      const location = new URL(response.headers.get('location'));
      // GitHub currently redirects artifact archives to Azure blob storage.
      // No alternate user endpoints and no credentials forwarded to blob hosts.
      if (location.protocol !== 'https:' || location.username || location.password || location.port || location.hash ||
          !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(location.hostname)) throw new Error();
      await response.body?.cancel();
      response = await fetch(location.href, { method: 'GET', redirect: 'error', signal });
    }
    const bytes = await boundedBytes(response, Math.min(MAX_ZIP, artifact.size_in_bytes));
    if (bytes.length !== artifact.size_in_bytes || `sha256:${hash(bytes)}` !== artifact.digest) {
      throw new Error('digest');
    }
    return bytes;
  } catch (error) {
    throw new Error(error.message === 'digest' ? 'Artifact ZIP digest/size mismatch' : 'Artifact ZIP download failed');
  }
}

// Validate *before* writing anything. Python's real ZIP parser handles central
// directory and CRC, with a flat exact allowlist and bounded decompression.
export const ZIP_PARSER = String.raw`import sys, io, json, zipfile, base64, stat

limits = json.loads(sys.argv[1])
raw = sys.stdin.buffer.read(537919489)
if len(raw) > 537919488:
    raise ValueError('ZIP size')
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    entries = archive.infolist()
    if len(entries) != len(limits) or len({entry.filename for entry in entries}) != len(entries):
        raise ValueError('ZIP entries')
    output = {}
    for entry in entries:
        name = entry.filename
        mode = entry.external_attr >> 16
        if entry.orig_filename != name or name not in limits or '/' in name or '\\' in name or entry.is_dir():
            raise ValueError('ZIP path')
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or entry.flag_bits & 1:
            raise ValueError('ZIP type')
        if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError('ZIP compression')
        if entry.file_size < 0 or entry.file_size > limits[name] or entry.file_size > max(1, entry.compress_size) * 200:
            raise ValueError('ZIP bomb')
        with archive.open(entry) as source:
            data = source.read(limits[name] + 1)
            if len(data) != entry.file_size or len(data) > limits[name] or source.read(1):
                raise ValueError('ZIP size')
        output[name] = base64.b64encode(data).decode('ascii')
    if set(output) != set(limits):
        raise ValueError('ZIP allowlist')
    sys.stdout.write(json.dumps(output))
`;

export function extractZip(bytes, limits, run = execFileSync) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ZIP || !Object.keys(limits).length ||
        Object.entries(limits).some(([name, size]) => !/^[A-Za-z0-9_.-]+$/.test(name) || !Number.isSafeInteger(size) || size < 1 || size > MAX_DMG)) throw new Error();
    const result = JSON.parse(run('python3', ['-c', ZIP_PARSER, JSON.stringify(limits)], {
      input: bytes, timeout: 120_000, maxBuffer: MAX_ZIP * 2, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString('utf8'));
    if (Object.keys(result).sort().join(',') !== Object.keys(limits).sort().join(',')) throw new Error();
    return new Map(Object.entries(result).map(([name, data]) => {
      if (typeof data !== 'string' || Buffer.byteLength(data, 'base64') > limits[name]) throw new Error();
      return [name, Buffer.from(data, 'base64')];
    }));
  } catch { throw new Error('Unsafe or invalid artifact ZIP'); }
}
