import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishFinal, loadFinalArtifact } from './macos-release-resume-publish.mjs';
import { producerFixture, zipFiles } from './macos-notary-artifact-fixtures.mjs';
import { hash } from './macos-notary-checkpoint.mjs';

const dmgName = 'Quorb_0.8.0_aarch64.dmg';
function fixture({ checksumFailure = false, dmgFailure = false, rollbackFailure = false, releaseId = 42 } = {}) {
  const calls = [];
  const files = new Map([[dmgName, Buffer.from('final DMG')], [`${dmgName}.sha256`, Buffer.from('final checksum')]]);
  const options = {
    env: { RELEASE_ID: '42', GH_TOKEN: 'synthetic' },
    load: async () => { calls.push('load'); return { dmgName, files }; },
    preflight: async () => { calls.push('preflight'); return { releaseId }; },
    fetch: async (url, opts) => {
      calls.push([url, opts]);
      if (opts.method === 'DELETE') return new Response(null, { status: rollbackFailure ? 500 : 204 });
      if ((url.endsWith('.sha256') && checksumFailure) || (!url.endsWith('.sha256') && dmgFailure)) throw new Error('SECRET');
      return new Response(JSON.stringify({ id: 999 }), { status: 201 });
    },
  };
  return { calls, options };
}

test('publication revalidates identity immediately before two non-overwriting fixed-name uploads', async () => {
  const f = fixture();
  assert.equal((await publishFinal(f.options)).outcome, 'published');
  assert.deepEqual(f.calls.slice(0, 2), ['load', 'preflight']);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[2][0], `https://uploads.github.com/repos/egdev6/quorb/releases/42/assets?name=${dmgName}`);
  assert.equal(f.calls[3][0], `${f.calls[2][0]}.sha256`);
  assert.equal(f.calls[2][1].method, 'POST');
  assert.equal(f.calls[2][1].redirect, 'error');
});

test('checksum failure only rolls back the positive owned DMG ID, never preexisting names', async () => {
  const f = fixture({ checksumFailure: true });
  await assert.rejects(publishFinal(f.options), /removed only owned/);
  assert.equal(f.calls.at(-1)[0], 'https://api.github.com/repos/egdev6/quorb/releases/assets/999');
  assert.equal(f.calls.at(-1)[1].method, 'DELETE');
  const failed = fixture({ checksumFailure: true, rollbackFailure: true });
  await assert.rejects(publishFinal(failed.options), (error) => {
    assert.match(error.message, /rollback failed.*999/);
    assert.equal(error.safePublish, true, 'CLI must retain the sanitized owned asset ID for manual cleanup');
    return true;
  });
});

test('ambiguous first upload or changed release never deletes anything or leaks raw errors', async () => {
  for (const scenario of [{ dmgFailure: true }, { releaseId: 43 }]) {
    const f = fixture(scenario);
    await assert.rejects(publishFinal(f.options), /DMG upload failed or ambiguous|identity changed/);
    assert.ok(!f.calls.some((call) => Array.isArray(call) && call[1].method === 'DELETE'));
  }
});

function finalFixture() {
  const f = producerFixture();
  const finalSha256 = hash(f.bytes);
  const archive = zipFiles({ [dmgName]: f.bytes, [`${dmgName}.sha256`]: `${finalSha256}  ${dmgName}\n` });
  Object.assign(f.env, { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY_ID: '10', GITHUB_SHA: f.run.head_sha,
    FINAL_ARTIFACT_ID: '999', FINAL_ARTIFACT_DIGEST: hash(archive), FINAL_SHA256: finalSha256 });
  f.run.path = '.github/workflows/macos-release-resume.yml';
  const artifact = { ...f.checkpoint, id: 999, name: 'macos-notary-final-123-2', size_in_bytes: archive.length, digest: `sha256:${hash(archive)}` };
  f.artifacts.splice(0, f.artifacts.length, artifact);
  f.archives.set(999, archive);
  return f;
}

test('publication artifact transfer independently authenticates same-run ID, ZIP digest and post-staple bytes', async () => {
  const f = finalFixture();
  const result = await loadFinalArtifact(f);
  assert.equal(result.dmgName, dmgName);
  assert.deepEqual(result.files.get(dmgName), f.bytes);
  assert.deepEqual(f.files.get(`notary-publish/${dmgName}`), f.bytes);
  for (const failure of ['id', 'digest', 'finalHash', 'fork', 'duplicate', 'wrongAttempt', 'checksum']) {
    const bad = finalFixture();
    if (failure === 'id') bad.env.FINAL_ARTIFACT_ID = '998';
    if (failure === 'digest') bad.env.FINAL_ARTIFACT_DIGEST = '0'.repeat(64);
    if (failure === 'finalHash') bad.env.FINAL_SHA256 = '0'.repeat(64);
    if (failure === 'fork') bad.run.head_repository.id = 11;
    if (failure === 'duplicate') bad.artifacts.push(bad.artifacts[0]);
    if (failure === 'wrongAttempt') bad.artifacts[0].name = 'macos-notary-final-123-1';
    if (failure === 'checksum') {
      const archive = zipFiles({ [dmgName]: bad.bytes, [`${dmgName}.sha256`]: 'untrusted checksum' });
      bad.archives.set(999, archive);
      Object.assign(bad.artifacts[0], { digest: `sha256:${hash(archive)}`, size_in_bytes: archive.length });
      bad.env.FINAL_ARTIFACT_DIGEST = hash(archive);
    }
    await assert.rejects(loadFinalArtifact(bad));
    assert.ok(!bad.files.has('notary-publish'));
  }
});
