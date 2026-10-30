import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitDmg, querySubmission, withNotaryKey } from './macos-notary-submit.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const sha256 = 'a'.repeat(64);
const auth = ['--key', '/private/key.p8', '--key-id', 'synthetic', '--issuer', 'synthetic'];

test('submit calls once, never waits or retries; errors cannot leak command credentials', () => {
  const calls = [];
  assert.equal(submitDmg('/checkpoint/Quorb.dmg', auth, (cmd, args) => {
    calls.push([cmd, args]); return JSON.stringify({ id });
  }), id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['xcrun', ['notarytool', 'submit', '/checkpoint/Quorb.dmg', ...auth, '--output-format', 'json']]);
  let count = 0;
  assert.throws(() => submitDmg('/checkpoint/Quorb.dmg', auth, () => { count++; throw new Error('SECRET'); }), /ambiguous.*diagnostics/i);
  assert.equal(count, 1);
  assert.throws(() => submitDmg('/checkpoint/Quorb.dmg', auth, () => '{}'), /ambiguous/i);
});

test('pending never requests log; accepted requires exact UUID and synthetic pre-staple hash', () => {
  for (const status of ['In Progress', 'Accepted']) {
    const calls = [];
    const result = querySubmission(id, sha256, auth, (cmd, args) => {
      calls.push(args);
      if (args[1] === 'info') return JSON.stringify({ id, status });
      return JSON.stringify({ jobId: id.toUpperCase(), status: 'Accepted', sha256 });
    });
    assert.equal(result.outcome, status === 'In Progress' ? 'pending' : 'accepted');
    assert.deepEqual(calls.map((args) => args[1]), status === 'In Progress' ? ['info'] : ['info', 'log']);
    if (calls[1]) assert.ok(!calls[1].includes('--output-format'));
  }
  for (const log of [{}, { jobId: id, status: 'Accepted' }, { jobId: id, status: 'Accepted', sha256: 'b'.repeat(64) }, { jobId: '00000000-0000-0000-0000-000000000000', status: 'Accepted', sha256 }]) {
    assert.throws(() => querySubmission(id, sha256, auth, (cmd, args) => JSON.stringify(args[1] === 'info' ? { id, status: 'Accepted' } : log)), /binding/i);
  }
  assert.equal(querySubmission(id, sha256, auth, (cmd, args) => {
    if (args[1] === 'info') return JSON.stringify({ id, status: 'Accepted' });
    throw new Error('not ready SECRET');
  }).outcome, 'pending');
});

test('invalid status/UUID and rejected issues fail safely; log does not accept output-format', () => {
  assert.throws(() => querySubmission('--help', sha256, auth, () => assert.fail()), /UUID/);
  assert.throws(() => querySubmission(id, sha256, auth, () => JSON.stringify({ id: 'wrong', status: 'Accepted' })), /identity/);
  assert.throws(() => querySubmission(id, sha256, auth, () => JSON.stringify({ id, status: 'unknown' })), /status/);
  const result = querySubmission(id, sha256, auth, (cmd, args) => JSON.stringify(args[1] === 'info' ? { id, status: 'Invalid' } : {
    issues: [{ severity: 'error', message: 'bad\n::error::untrusted', path: 'Quorb.app', secret: 'SECRET' }],
  }));
  assert.equal(result.outcome, 'rejected');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|::error::/);
});

test('private key is exclusive 0600 and removed even after failure; no raw error leaks', () => {
  const calls = [];
  const io = { writeFileSync: (...args) => calls.push(['write', ...args]), unlinkSync: (...args) => calls.push(['unlink', ...args]) };
  const env = { RUNNER_TEMP: '/controlled', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', APPLE_API_KEY_P8: 'synthetic', APPLE_API_KEY: 'key', APPLE_API_ISSUER: 'issuer' };
  assert.throws(() => withNotaryKey(() => { throw new Error('SECRET'); }, { env, io }), /Notarization operation failed/);
  assert.deepEqual(calls[0].slice(2), ['synthetic', { mode: 0o600, flag: 'wx' }]);
  assert.equal(calls[1][0], 'unlink');
  assert.equal(calls[0][1], calls[1][1]);
});
