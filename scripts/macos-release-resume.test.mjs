import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeNotarization, loadCheckpoint } from './macos-release-resume.mjs';
import { producerFixture, zipFiles } from './macos-notary-artifact-fixtures.mjs';
import { hash } from './macos-notary-checkpoint.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const checkpoint = { manifest: { version: '0.8.0', sourceSha: 'b'.repeat(40), releaseId: '42', sha256: 'a'.repeat(64), dmgName: 'Quorb_0.8.0_aarch64.dmg' },
  dmg: '/controlled/Quorb_0.8.0_aarch64.dmg', submissionId: id };
function fixture(outcome = 'accepted') {
  const calls = [];
  const dependencies = {
    load: async () => { calls.push('load'); return checkpoint; },
    preflight: async () => { calls.push('preflight'); return { releaseId: 42 }; },
    query: () => { calls.push('query'); return { outcome }; },
    key: (callback) => { calls.push('key'); return callback([]); },
    verify: () => { calls.push('verify'); return { finalSha256: 'f'.repeat(64) }; },
    output: (result) => calls.push(result),
  };
  return { calls, dependencies };
}

test('resume never builds, signs, submits or publishes; pending/rejected cannot reach stapling', async () => {
  for (const outcome of ['pending', 'rejected', 'accepted']) {
    const f = fixture(outcome);
    if (outcome === 'rejected') await assert.rejects(resumeNotarization(f.dependencies), /Rejected/);
    else await resumeNotarization(f.dependencies);
    assert.equal(f.calls.includes('verify'), outcome === 'accepted');
    assert.deepEqual(f.calls.slice(0, 4), ['load', 'preflight', 'key', 'query']);
    if (outcome === 'pending') assert.deepEqual(f.calls.at(-1), { outcome: 'pending' });
  }
});

test('content/run validation and release identity are checked before Apple credentials', async () => {
  const f = fixture();
  f.dependencies.load = async () => { throw new Error('bad digest'); };
  await assert.rejects(resumeNotarization(f.dependencies), /bad digest/);
  assert.deepEqual(f.calls, []);
  const changed = fixture();
  changed.dependencies.preflight = async () => ({ releaseId: 99 });
  await assert.rejects(resumeNotarization(changed.dependencies), /identity/);
  assert.deepEqual(changed.calls, ['load']);
});

test('offline HTTP/Git/ZIP/files adapter restores exact canceled-attempt checkpoint and authenticated receipt', async () => {
  const f = producerFixture();
  const result = await loadCheckpoint(f);
  assert.equal(result.submissionId, f.submissionId);
  assert.deepEqual(result.manifest, f.manifest);
  assert.deepEqual(f.files.get(`notary-retained/${f.manifest.dmgName}`), f.bytes);
  assert.equal(f.files.size, 4); // trusted workflow, exclusive directory and two files, no secrets
  assert.ok(f.calls.some(([command, args]) => command === 'git' && args[0] === 'merge-base'));
  assert.ok(f.calls.every(([command]) => command === 'git' || command.startsWith('https://api.github.com/repos/egdev6/quorb/actions/')));
});

test('recovery UUID without receipt remains only a candidate until Apple hash binding', async () => {
  const f = producerFixture(); f.artifacts.pop(); f.env.SUBMISSION_ID = '00000000-0000-0000-0000-000000000001';
  const result = await loadCheckpoint(f);
  assert.equal(result.submissionId, f.env.SUBMISSION_ID);
  const normal = producerFixture(); normal.artifacts.pop();
  await assert.rejects(loadCheckpoint(normal), /receipt/i);
  const malformed = producerFixture(); malformed.env.SUBMISSION_ID = '--help';
  await assert.rejects(loadCheckpoint(malformed), /inputs/i);
  assert.deepEqual(malformed.calls, []);
});

test('adapter fails closed on unapproved ancestor/workflow bytes, manifest or receipt tampering and raw ZIP hash mismatch', async () => {
  for (const failure of ['ancestry', 'workflow', 'manifest', 'receipt', 'zip', 'dmg']) {
    const f = producerFixture();
    if (failure === 'ancestry') f.exec = () => { throw new Error('SECRET'); };
    if (failure === 'workflow') f.exec = () => 'unapproved producer';
    if (failure === 'zip') f.archives.set(456, Buffer.from('tampered archive'));
    if (['manifest', 'dmg'].includes(failure)) {
      const manifest = failure === 'manifest' ? { ...f.manifest, releaseId: '43' } : f.manifest;
      const bytes = zipFiles({ 'manifest.json': JSON.stringify(manifest), [manifest.dmgName]: failure === 'dmg' ? 'tampered DMG' : f.bytes });
      f.archives.set(456, bytes); f.checkpoint.digest = `sha256:${hash(bytes)}`; f.checkpoint.size_in_bytes = bytes.length;
    }
    if (failure === 'receipt') {
      const bytes = zipFiles({ 'receipt.json': JSON.stringify({ ...f.receipt, checkpointArtifactId: '999' }) });
      f.archives.set(457, bytes); f.receiptArtifact.digest = `sha256:${hash(bytes)}`; f.receiptArtifact.size_in_bytes = bytes.length;
    }
    await assert.rejects(loadCheckpoint(f), (error) => !error.message.includes('SECRET'));
    assert.ok(!f.files.has('notary-retained'));
  }
});

test('attempt ownership rejects artifacts created after a later attempt began, with complete pagination', async () => {
  const f = producerFixture();
  const fetch = f.fetch;
  f.fetch = async (url, options) => {
    if (url.endsWith('/actions/runs/123')) return Response.json({ ...f.run, run_attempt: 3 });
    if (url.endsWith('/attempts/3')) return Response.json({ ...f.run, run_attempt: 3, run_started_at: '2026-01-01T00:00:30Z' });
    return fetch(url, options);
  };
  await assert.rejects(loadCheckpoint(f), /artifact/i);
});
