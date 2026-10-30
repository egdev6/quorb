import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileFixture } from './macos-notary-artifact-fixtures.mjs';
import { validateManifest, validateDmg, validateReceipt, signingEnvironment, createCheckpoint, buildSigned } from './macos-notary-checkpoint.mjs';
import { submitCheckpoint } from './macos-notary-submit.mjs';

export const trusted = {
  repository: 'egdev6/quorb', workflowPath: '.github/workflows/macos-release.yml',
  workflowSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40), version: '0.8.0',
  releaseId: '42', runId: '123', runAttempt: '2',
};
export const bytes = Buffer.from('synthetic signed DMG');
export const manifest = {
  schema: 1, ...trusted, dmgName: 'Quorb_0.8.0_aarch64.dmg', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
export const receipt = {
  schema: 1, ...trusted, checkpointArtifactId: '456', checkpointArtifactDigest: 'c'.repeat(64),
  submissionId: '12345678-1234-1234-1234-123456789abc', dmgSha256: manifest.sha256,
};

for (const [style, paths] of [['POSIX', path.posix], ['Windows', path.win32]]) {
  test(`offline filesystem canonicalizes ${style} separators without weakening exclusive writes or exact file checks`, () => {
    for (const directory of ['notary-checkpoint', 'notary-retained', 'notary-publish']) {
      const { files, io } = fileFixture();
      io.mkdirSync(directory);
      const dmg = paths.join(directory, manifest.dmgName);
      io.writeFileSync(dmg, bytes, { flag: 'wx' });
      io.writeFileSync(paths.join(directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
      assert.deepEqual(files.get(`${directory}/${manifest.dmgName}`), bytes);
      assert.deepEqual(io.readFileSync(`${directory}/${manifest.dmgName}`), bytes);
      assert.deepEqual(io.readFileSync(dmg), bytes);
      assert.deepEqual([...files.keys()].filter((name) => name.startsWith(`${directory}/`)).sort(),
        [`${directory}/${manifest.dmgName}`, `${directory}/manifest.json`]);
      assert.ok(!files.has(`${directory}/unexpected.dmg`));
      assert.throws(() => io.writeFileSync(`${directory}/${manifest.dmgName}`, bytes, { flag: 'wx' }), /overwrite/);
      assert.throws(() => io.writeFileSync(paths.join(directory, 'unexpected.dmg'), bytes, { flag: 'w' }), /overwrite/);
      assert.throws(() => io.mkdirSync(directory), /exists/);
      assert.deepEqual(files.get(`${directory}/${manifest.dmgName}`), bytes);
      assert.ok(!files.has(`${directory}/unexpected.dmg`));
    }
  });
}

test('manifest and receipt are strictly bound to externally trusted values, not self-authenticated', () => {
  assert.deepEqual(validateManifest(manifest, trusted), manifest);
  assert.doesNotThrow(() => validateDmg(bytes, manifest));
  assert.deepEqual(validateReceipt(receipt, trusted, { id: 456, digest: `sha256:${'c'.repeat(64)}` }, manifest), receipt);
  for (const key of Object.keys(trusted)) {
    assert.throws(() => validateManifest({ ...manifest, [key]: 'wrong' }, trusted), /manifest/i);
    assert.throws(() => validateReceipt({ ...receipt, [key]: 'wrong' }, trusted, { id: 456, digest: `sha256:${'c'.repeat(64)}` }, manifest), /receipt/i);
  }
  for (const change of [{ extra: true }, { sha256: '' }, { size: 0 }, { size: 1.5 }, { dmgName: '../other.dmg' }, { schema: 2 }]) {
    assert.throws(() => validateManifest({ ...manifest, ...change }, trusted), /manifest/i);
  }
  assert.throws(() => validateDmg(Buffer.from('tampered'), manifest), /DMG/);
  for (const change of [{ submissionId: '--help' }, { checkpointArtifactId: '457' }, { checkpointArtifactDigest: 'd'.repeat(64) }, { dmgSha256: 'f'.repeat(64) }, { extra: true }]) {
    assert.throws(() => validateReceipt({ ...receipt, ...change }, trusted, { id: 456, digest: `sha256:${'c'.repeat(64)}` }, manifest), /receipt/i);
  }
});

test('build removes every Tauri notarization credential including alternate Apple ID flow', () => {
  const env = signingEnvironment({ PATH: '/bin', APPLE_CERTIFICATE: 'cert', APPLE_CERTIFICATE_PASSWORD: 'pass', APPLE_SIGNING_IDENTITY: 'id',
    APPLE_API_KEY: 'key', APPLE_API_KEY_PATH: 'path', APPLE_API_ISSUER: 'issuer', APPLE_API_KEY_P8: 'private',
    APPLE_ID: 'id', APPLE_PASSWORD: 'password', APPLE_TEAM_ID: 'team' });
  assert.deepEqual(env, { PATH: '/bin', APPLE_CERTIFICATE: 'cert', APPLE_CERTIFICATE_PASSWORD: 'pass', APPLE_SIGNING_IDENTITY: 'id' });
  let calls = 0;
  buildSigned({ env: { ...env, APPLE_API_KEY: 'inherited', APPLE_ID: 'inherited' }, run: (command, args, options) => {
    calls++;
    assert.equal(command, 'npm'); assert.deepEqual(args, ['run', 'app:build:mac']);
    assert.equal(options.cwd, 'source'); assert.deepEqual(options.env, env);
  } });
  assert.equal(calls, 1);
});

test('checkpoint contains only signed DMG and strict manifest; successful upload binding is required before key creation or submit', () => {
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: trusted.repository, GITHUB_SHA: trusted.workflowSha,
    GITHUB_RUN_ID: trusted.runId, GITHUB_RUN_ATTEMPT: trusted.runAttempt, RELEASE_SOURCE_SHA: trusted.sourceSha, RELEASE_VERSION: trusted.version, RELEASE_ID: trusted.releaseId };
  const { files, io } = fileFixture([['/synthetic/Quorb_0.8.0_aarch64.dmg', bytes]]);
  const signatures = [];
  const result = createCheckpoint({ env, io, verify: () => ({ version: '0.8.0', app: '/synthetic/Quorb.app', dmg: '/synthetic/Quorb_0.8.0_aarch64.dmg' }), signature: (target) => signatures.push(target) });
  assert.deepEqual(result, manifest);
  assert.equal(signatures.length, 2);
  assert.deepEqual([...files.keys()].filter((name) => name.startsWith('notary-checkpoint/')).sort(), ['notary-checkpoint/Quorb_0.8.0_aarch64.dmg', 'notary-checkpoint/manifest.json']);
  let keyCalls = 0;
  const key = (callback) => { keyCalls++; return callback([]); };
  assert.throws(() => submitCheckpoint({ env, io, key }), /upload must succeed/);
  assert.equal(keyCalls, 0);
  const uploaded = { ...env, CHECKPOINT_ARTIFACT_ID: '456', CHECKPOINT_ARTIFACT_DIGEST: 'c'.repeat(64) };
  const saved = submitCheckpoint({ env: uploaded, io, key, run: (_command, args) => {
    assert.ok(files.has('notary-checkpoint/manifest.json'));
    assert.ok(!args.includes('--wait')); return JSON.stringify({ id: receipt.submissionId });
  } });
  assert.deepEqual(saved, receipt);
  assert.equal(keyCalls, 1);
  assert.deepEqual(JSON.parse(files.get('notary-receipt/receipt.json')), receipt);
});
