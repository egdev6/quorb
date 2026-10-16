// Pure Node 22 policy helpers. Callers must acquire real HEAD, github.sha and
// complete REST check data themselves; importing this module performs no I/O.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const requiredChecks = Object.freeze([
  'Tests and build (Windows)',
  'Tests and bundle (macOS ARM64)',
  'Static code safety',
  'Secrets scan',
]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// trim equality also excludes a final newline, which JavaScript's $ can accept.
const matches = (value, pattern) => typeof value === 'string' && value === value.trim() && pattern.test(value);
const validSha = (value) => matches(value, /^[0-9a-f]{40}$/);
const validVersion = (value) => matches(value, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);

export function validatePreviewSource(source) {
  if (!record(source)) throw new Error('Invalid preview source');
  const { ref, expectedVersion, version, sourceSha, workflowSha, headSha, checks } = source;
  if (ref !== 'refs/heads/main' || !validVersion(expectedVersion) || !validVersion(version) ||
      expectedVersion !== version || !validSha(sourceSha) || !validSha(workflowSha) || !validSha(headSha) ||
      sourceSha !== workflowSha || sourceSha !== headSha) {
    throw new Error('Invalid preview source');
  }
  // Fail closed on incomplete/paginated responses, before counting names.
  if (!record(checks) || !Number.isSafeInteger(checks.total_count) || checks.total_count < 0 ||
      !Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length ||
      checks.check_runs.some((check) => !record(check) || typeof check.name !== 'string' ||
        typeof check.status !== 'string' || !(check.conclusion === null || typeof check.conclusion === 'string') ||
        !validSha(check.head_sha) || !record(check.app) || typeof check.app.slug !== 'string')) {
    throw new Error('Invalid preview checks response');
  }
  for (const name of requiredChecks) {
    const found = checks.check_runs.filter((check) => check.name === name);
    if (found.length !== 1 || found[0].status !== 'completed' || found[0].conclusion !== 'success' ||
        found[0].app.slug !== 'github-actions' || found[0].head_sha !== sourceSha) {
      throw new Error('Required preview checks not satisfied');
    }
  }
  return true;
}

export function buildPreviewManifest(input) {
  const keys = ['version', 'sourceSha', 'dmgName', 'sha256', 'size'];
  if (!record(input) || !isDeepStrictEqual(Object.keys(input).sort(), [...keys].sort())) {
    throw new Error('Invalid preview manifest fields');
  }
  const { version, sourceSha, dmgName, sha256, size } = input;
  if (!validVersion(version) || !validSha(sourceSha) ||
      !matches(dmgName, /^[A-Za-z0-9][A-Za-z0-9._-]*\.dmg$/) ||
      !matches(sha256, /^[0-9a-f]{64}$/) || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Invalid preview manifest data');
  }
  // Fixed policy: callers cannot inject signing, updater or retention claims.
  return {
    schemaVersion: 1, delivery: 'unsigned-preview', developerId: false, notarized: false,
    arch: 'arm64', minimumSystemVersion: '15.0', updater: 'manual', retentionDays: 14,
    version, sourceSha, dmg: { name: dmgName, sha256, size },
  };
}

export function verifyPreviewReadback(expected, actual, dmgBytes) {
  if (!record(expected) || !record(expected.dmg)) throw new Error('Invalid preview readback manifest');
  let canonical;
  try {
    canonical = buildPreviewManifest({
      version: expected.version, sourceSha: expected.sourceSha,
      dmgName: expected.dmg.name, sha256: expected.dmg.sha256, size: expected.dmg.size,
    });
  } catch {
    throw new Error('Invalid preview readback manifest');
  }
  if (!isDeepStrictEqual(canonical, expected) || !isDeepStrictEqual(expected, actual) ||
      !(dmgBytes instanceof Uint8Array) || dmgBytes.byteLength !== expected.dmg.size ||
      createHash('sha256').update(dmgBytes).digest('hex') !== expected.dmg.sha256) {
    throw new Error('Invalid preview readback data');
  }
  return true;
}
