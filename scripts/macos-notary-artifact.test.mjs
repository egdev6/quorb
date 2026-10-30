import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateRun, selectArtifacts, extractZip, downloadZip, githubClient } from './macos-notary-artifact.mjs';

const workflow = { id: 99, path: '.github/workflows/macos-release.yml' };
const run = { id: 123, run_attempt: 2, repository: { id: 10, full_name: 'egdev6/quorb' }, head_repository: { id: 10, full_name: 'egdev6/quorb' },
  head_branch: 'main', event: 'workflow_dispatch', path: workflow.path, workflow_id: 99, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'cancelled',
  run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z' };
const artifact = (name, id) => ({ id, name, expired: false, digest: `sha256:${'c'.repeat(64)}`, size_in_bytes: 200,
  created_at: '2026-01-01T00:01:00Z', expires_at: '2099-01-01T00:00:00Z',
  workflow_run: { id: 123, repository_id: 10, head_repository_id: 10, head_branch: 'main', head_sha: run.head_sha } });
const checkpoint = artifact('macos-notary-checkpoint-123-2', 1);
const receipt = artifact('macos-notary-receipt-123-2', 2);

test('canceled same-repo producer is recoverable, but provenance and attempts are strict', () => {
  assert.doesNotThrow(() => validateRun(run, workflow, { runId: '123', runAttempt: '2' }));
  for (const patch of [{ id: 124 }, { run_attempt: 1 }, { head_repository: { id: 11, full_name: 'fork/quorb' } }, { repository: { id: 11, full_name: 'other/quorb' } },
    { head_branch: 'feature' }, { event: 'push' }, { path: 'other.yml' }, { workflow_id: 100 }, { head_sha: '--help' }, { status: 'in_progress' }]) {
    assert.throws(() => validateRun({ ...run, ...patch }, workflow, { runId: '123', runAttempt: '2' }), /producer/i);
  }
  assert.deepEqual(selectArtifacts([checkpoint, receipt], run), { checkpoint, receipt });
  assert.deepEqual(selectArtifacts([checkpoint], run, true), { checkpoint, receipt: null });
  assert.throws(() => selectArtifacts([checkpoint], run), /receipt/i);
  for (const patch of [{ expired: true }, { expires_at: '2020-01-01' }, { created_at: '2025-12-31' }, { digest: null }, { name: 'macos-notary-checkpoint-123-1' },
    { workflow_run: { ...checkpoint.workflow_run, id: 999 } }, { workflow_run: { ...checkpoint.workflow_run, head_repository_id: 11 } }]) {
    assert.throws(() => selectArtifacts([{ ...checkpoint, ...patch }, receipt], run), /artifact|checkpoint/i);
  }
  assert.throws(() => selectArtifacts([checkpoint, checkpoint, receipt], run), /duplicate/i);
  assert.throws(() => selectArtifacts([checkpoint, receipt, receipt], run, true), /duplicate/i);
});

function zip(entries) {
  return execFileSync('python3', ['-c', `import io,json,zipfile,sys,base64
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 for e in json.loads(sys.stdin.read()):
  i=zipfile.ZipInfo(e['name']); i.external_attr=e.get('mode',0)<<16
  z.writestr(i,e.get('data','').encode())
sys.stdout.buffer.write(b.getvalue())`], { input: JSON.stringify(entries) });
}

test('real in-memory Python ZIP parser rejects extras, traversal, symlinks, duplicates and oversize before extraction', () => {
  const good = zip([{ name: 'manifest.json', data: '{}' }, { name: 'Quorb.dmg', data: 'DMG' }]);
  assert.equal(extractZip(good, { 'manifest.json': 65536, 'Quorb.dmg': 100 }).get('Quorb.dmg').toString(), 'DMG');
  for (const entries of [
    [{ name: '../Quorb.dmg' }, { name: 'manifest.json' }],
    [{ name: 'Quorb.dmg', mode: 0o120777 }, { name: 'manifest.json' }],
    [{ name: 'Quorb.dmg' }, { name: 'manifest.json' }, { name: 'extra' }],
    [{ name: 'Quorb.dmg' }, { name: 'Quorb.dmg' }],
    [{ name: 'Quorb.dmg', data: 'too large' }, { name: 'manifest.json' }],
  ]) assert.throws(() => extractZip(zip(entries), { 'manifest.json': 65536, 'Quorb.dmg': 3 }), /ZIP/);
  assert.throws(() => extractZip(Buffer.from('not zip'), { 'manifest.json': 100 }), /ZIP/);
  const bomb = execFileSync('python3', ['-c', `import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z: z.writestr('Quorb.dmg',b'0'*1000000)
sys.stdout.buffer.write(b.getvalue())`]);
  assert.throws(() => extractZip(bomb, { 'Quorb.dmg': 1000000 }), /ZIP/);
  const crc = Buffer.from(good); crc[40] ^= 0xff;
  assert.throws(() => extractZip(crc, { 'manifest.json': 65536, 'Quorb.dmg': 100 }), /ZIP/);
});

test('ZIP allowlist rejects NUL-truncated filenames rather than trusting parser normalization', () => {
  const hidden = zip([{ name: 'Quorb.dmgXevil', data: 'DMG' }]);
  const name = Buffer.from('Quorb.dmgXevil');
  for (const index of [hidden.indexOf(name), hidden.lastIndexOf(name)]) hidden[index + 'Quorb.dmg'.length] = 0;
  assert.throws(() => extractZip(hidden, { 'Quorb.dmg': 3 }), /ZIP/);
});

test('authenticated API raw ZIP digest is fatal before parsing; redirects never receive bearer', async () => {
  const bytes = Buffer.from('raw synthetic ZIP');
  const meta = { ...checkpoint, size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const calls = [];
  const fetch = async (url, options) => {
    calls.push([url, options]);
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://productionresultssa0.blob.core.windows.net/actions/a?sig=synthetic' } });
    return new Response(bytes);
  };
  assert.deepEqual(await downloadZip(meta, { token: 'synthetic', fetch }), bytes);
  assert.match(calls[0][0], /^https:\/\/api.github.com\/repos\/egdev6\/quorb\/actions\/artifacts\/1\/zip$/);
  assert.equal(calls[0][1].redirect, 'manual');
  assert.ok(calls[0][1].headers.Authorization);
  assert.equal(calls[1][1].headers?.Authorization, undefined);
  await assert.rejects(downloadZip({ ...meta, digest: `sha256:${'d'.repeat(64)}` }, { token: 'synthetic', fetch: async () => new Response(bytes) }), /digest/i);
  await assert.rejects(downloadZip(meta, { token: 'synthetic', fetch: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/zip' } }) }), /download/i);
  for (const response of [new Response(bytes, { headers: { 'content-length': '999999999' } }), new Response(Buffer.concat([bytes, bytes])), new Response('SECRET', { status: 403 })]) {
    await assert.rejects(downloadZip(meta, { token: 'synthetic', fetch: async () => response }), /download/i);
  }
});

test('metadata client paginates completely, bounds data, rejects arbitrary endpoints and sanitizes failures', async () => {
  const calls = [];
  const api = githubClient({ token: 'synthetic', fetch: async (url) => {
    calls.push(url);
    return Response.json({ artifacts: url.endsWith('page=1') ? Array(100).fill(checkpoint) : [receipt] });
  } });
  assert.equal((await api.artifacts('123')).length, 101);
  assert.equal(calls.length, 2);
  for (const route of ['https://attacker.example', '/releases/42', '/actions/../other']) await assert.rejects(api.json(route), /route/);
  assert.equal(calls.length, 2);
  for (const fetch of [async () => { throw new Error('SECRET'); }, async () => new Response('not JSON'), async () => new Response('x'.repeat(1024 * 1024 + 1)), async () => new Response(null, { status: 302 })]) {
    await assert.rejects(githubClient({ token: 'synthetic', fetch }).json('/actions/runs/123'), (error) => !error.message.includes('SECRET'));
  }
  let pages = 0;
  const truncated = githubClient({ token: 'synthetic', fetch: async () => { pages++; return Response.json({ artifacts: Array(100).fill(checkpoint) }); } });
  await assert.rejects(truncated.artifacts('123'), /truncated/);
  assert.equal(pages, 20);
});
