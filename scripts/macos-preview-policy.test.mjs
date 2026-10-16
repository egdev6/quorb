import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validatePreviewSource, buildPreviewManifest, verifyPreviewReadback } from './macos-preview-policy.mjs';

const sha = 'a'.repeat(40);
const names = ['Tests and build (Windows)', 'Tests and bundle (macOS ARM64)', 'Static code safety', 'Secrets scan'];
const bytes = Buffer.from('fixture DMG bytes, not a mountable image');
const input = {
  version: '0.6.0', sourceSha: sha, dmgName: 'Quorb_0.6.0_aarch64.dmg',
  sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
};
function source() {
  return {
    ref: 'refs/heads/main', expectedVersion: '0.6.0', version: '0.6.0',
    sourceSha: sha, workflowSha: sha, headSha: sha,
    checks: { total_count: 4, check_runs: names.map((name) => ({
      name, status: 'completed', conclusion: 'success', head_sha: sha, app: { slug: 'github-actions' },
    })) },
  };
}

// All provenance and REST responses are injected fixtures, not runtime attestations.
test('accepts only the exact main source and four uniquely successful Actions checks', () => {
  assert.equal(validatePreviewSource(source()), true);
  const extra = source();
  extra.checks.check_runs.push({ ...extra.checks.check_runs[0], name: 'Unrelated check', conclusion: 'failure' });
  extra.checks.total_count++;
  assert.equal(validatePreviewSource(extra), true);
});

test('rejects non-main refs, invalid or mismatched stable versions and provenance', () => {
  const cases = [
    ['ref', 'main'], ['ref', 'refs/heads/feature'], ['ref', 'refs/heads/main\n'],
    ['version', '0.6.1'], ['expectedVersion', '0.6.1'],
  ];
  for (const version of ['0.06.0', '01.6.0', '0.6.00', '0.6', '0.6.0-rc.1', '0.6.0+build', '../0.6.0', '0.6.0\n', null]) {
    cases.push(['version', version], ['expectedVersion', version]);
  }
  for (const key of ['sourceSha', 'workflowSha', 'headSha']) {
    for (const value of ['b'.repeat(40), 'A'.repeat(40), 'g'.repeat(40), sha.slice(1), `${sha}\n`, `${sha}/..`, null]) {
      cases.push([key, value]);
    }
  }
  for (const [key, value] of cases) {
    assert.throws(() => validatePreviewSource({ ...source(), [key]: value }), /preview source/);
  }
  for (const value of [undefined, null, {}, []]) assert.throws(() => validatePreviewSource(value), /preview source/);
});

test('rejects malformed, paginated or incomplete REST check responses before granting authority', () => {
  for (const checks of [null, {}, [], { total_count: 0, check_runs: [] },
    { total_count: 5, check_runs: source().checks.check_runs },
    { total_count: '4', check_runs: source().checks.check_runs },
    { total_count: -1, check_runs: [] }, { total_count: 1, check_runs: [null] },
    { total_count: 1, check_runs: [{}] }, { total_count: 4, check_runs: {} }]) {
    assert.throws(() => validatePreviewSource({ ...source(), checks }), /preview checks/);
  }
  const missing = source();
  missing.checks.check_runs.pop();
  missing.checks.total_count--;
  assert.throws(() => validatePreviewSource(missing), /preview checks/);
  for (const patch of [{ name: null }, { status: 1 }, { conclusion: {} }, { head_sha: `${sha}\n` }, { app: {} }]) {
    const malformed = source();
    malformed.checks.check_runs.push({ ...malformed.checks.check_runs[0], name: 'Other', ...patch });
    malformed.checks.total_count++;
    assert.throws(() => validatePreviewSource(malformed), /preview checks/);
  }
});

test('each required name rejects duplicate, unsuccessful, pending, stale or non-Actions results', () => {
  for (let index = 0; index < names.length; index++) {
    for (const patch of [{ conclusion: 'failure' }, { conclusion: 'skipped' }, { conclusion: null },
      { status: 'in_progress' }, { status: 'queued' }, { head_sha: 'b'.repeat(40) },
      { app: { slug: 'other' } }, { app: null }, { name: `${names[index]} ` }]) {
      const value = source();
      Object.assign(value.checks.check_runs[index], patch);
      assert.throws(() => validatePreviewSource(value), /preview checks/);
    }
    const duplicate = source();
    duplicate.checks.check_runs.push({ ...duplicate.checks.check_runs[index] });
    duplicate.checks.total_count++;
    assert.throws(() => validatePreviewSource(duplicate), /preview checks/);
  }
});

test('builds a deterministic unsigned preview manifest with a fixed policy', () => {
  const expected = {
    schemaVersion: 1, delivery: 'unsigned-preview', developerId: false, notarized: false,
    arch: 'arm64', minimumSystemVersion: '15.0', updater: 'manual', retentionDays: 14,
    version: input.version, sourceSha: sha,
    dmg: { name: input.dmgName, sha256: input.sha256, size: bytes.length },
  };
  assert.deepEqual(buildPreviewManifest(input), expected);
  assert.equal(JSON.stringify(buildPreviewManifest(input)), JSON.stringify(expected));
  assert.equal(verifyPreviewReadback(expected, JSON.parse(JSON.stringify(expected)), bytes), true);
  assert.equal(verifyPreviewReadback(expected, expected, new Uint8Array(bytes)), true);
});

test('rejects unsafe names, invalid digest, size, version, SHA and policy injection', () => {
  const cases = [];
  for (const dmgName of ['', '../a.dmg', '/a.dmg', 'a/b.dmg', 'a\\b.dmg', 'a:b.dmg', '.hidden.dmg', 'a\n.dmg', 'a.dmg\n', 'a.zip', 'a\u0000.dmg', null]) {
    cases.push({ dmgName });
  }
  for (const sha256 of ['', 'a'.repeat(63), 'G'.repeat(64), 'A'.repeat(64), `${input.sha256}\n`, null]) cases.push({ sha256 });
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12', null]) cases.push({ size });
  cases.push({ version: '0.06.0' }, { sourceSha: 'A'.repeat(40) });
  for (const [key, value] of [['delivery', 'signed'], ['developerId', true], ['notarized', true],
    ['arch', 'x64'], ['minimumSystemVersion', '12.0'], ['updater', 'automatic'], ['retentionDays', 90]]) {
    cases.push({ [key]: value });
  }
  for (const patch of cases) assert.throws(() => buildPreviewManifest({ ...input, ...patch }), /preview manifest/);
  for (const value of [undefined, null, {}, []]) assert.throws(() => buildPreviewManifest(value), /preview manifest/);
});

test('readback rejects changed claims, metadata, digest and bytes rather than trusting an artifact ZIP hash', () => {
  const expected = buildPreviewManifest(input);
  for (const key of Object.keys(expected)) {
    const actual = { ...expected, [key]: 'tampered' };
    assert.throws(() => verifyPreviewReadback(expected, actual, bytes), /preview readback/);
  }
  for (const patch of [{ name: 'Other.dmg' }, { sha256: 'b'.repeat(64) }, { size: bytes.length + 1 }]) {
    assert.throws(() => verifyPreviewReadback(expected, { ...expected, dmg: { ...expected.dmg, ...patch } }, bytes), /preview readback/);
  }
  for (const actual of [null, { ...expected, dmg: null }, { ...expected, signed: true }]) {
    assert.throws(() => verifyPreviewReadback(expected, actual, bytes), /preview readback/);
  }
  for (const invalid of [null, { ...expected, dmg: null }, { ...expected, version: '../0.6.0' }, { ...expected, notarized: true }]) {
    assert.throws(() => verifyPreviewReadback(invalid, expected, bytes), /preview readback/);
  }
  for (const data of [Buffer.from('different bytes'), Buffer.from('x'.repeat(bytes.length)), 'not bytes', null]) {
    assert.throws(() => verifyPreviewReadback(expected, expected, data), /preview readback/);
  }
  const zipDigest = buildPreviewManifest({ ...input, sha256: createHash('sha256').update('artifact ZIP').digest('hex') });
  assert.throws(() => verifyPreviewReadback(zipDigest, zipDigest, bytes), /preview readback/);
});
