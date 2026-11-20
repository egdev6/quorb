import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { attachRelease, loadBundles } from './linux-release-attach.mjs';

const version = '0.9.0';
const deb = `Quorb_${version}_amd64.deb`;
const appimage = `Quorb_${version}_amd64.AppImage`;
const names = [deb, `${deb}.sha256`, appimage, `${appimage}.sha256`];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checksum = (name, bytes) => Buffer.from(`${hash(bytes)}  ${name}\n`);

function fixture({ failAt = 0, rollbackFailure = false, badResponse = false } = {}) {
  const files = new Map([[deb, Buffer.from('deb bundle')], [appimage, Buffer.from('appimage bundle')]]);
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'egdev6/quorb',
    RELEASE_VERSION: version, RELEASE_SOURCE_SHA: 'a'.repeat(40), RELEASE_ID: '42',
    GH_TOKEN: 'fixture-token', BUNDLE_DIR: '/fake-bundles',
    DEB_SHA256: hash(files.get(deb)), APPIMAGE_SHA256: hash(files.get(appimage)) };
  const calls = [];
  const stored = new Map([['windows.exe', { id: 10, bytes: Buffer.from('untouched') }]]);
  let attempt = 0;
  const options = { env,
    io: {
      readdirSync: () => [...files.keys()],
      lstatSync: (file) => ({ isFile: () => true, isSymbolicLink: () => false, size: files.get(path.basename(file)).length }),
      readFileSync: (file) => files.get(path.basename(file)),
    },
    preflight: async () => { calls.push('preflight'); return { releaseId: 42 }; },
    fetch: async (url, request) => {
      calls.push([url, request]);
      if (request.method === 'DELETE') {
        if (rollbackFailure) return new Response('', { status: 500 });
        const id = Number(url.split('/').at(-1));
        for (const [name, asset] of stored) if (asset.id === id) stored.delete(name);
        return new Response(null, { status: 204 });
      }
      assert.equal(request.method, 'POST');
      attempt++;
      if (attempt === failAt) {
        if (badResponse) return new Response('not-json', { status: 201 });
        return new Response('fixture-token', { status: 422 });
      }
      const name = new URL(url).searchParams.get('name');
      assert.ok(!stored.has(name), 'fake API never overwrites');
      const id = 100 + attempt;
      stored.set(name, { id, bytes: request.body });
      return new Response(JSON.stringify({ id }), { status: 201 });
    },
  };
  return { env, files, stored, calls, options, run: (patch = {}) => attachRelease({ ...options, ...patch }) };
}

test('loads only exact verified bundles and constructs sha256sum-compatible checksums', () => {
  const f = fixture();
  const result = loadBundles(f.options);
  assert.deepEqual([...result.keys()], names);
  assert.deepEqual(result.get(deb), f.files.get(deb));
  assert.deepEqual(result.get(`${deb}.sha256`), checksum(deb, f.files.get(deb)));
  assert.deepEqual(result.get(`${appimage}.sha256`), checksum(appimage, f.files.get(appimage)));
});

test('rejects wrong, missing, extra, nonregular or modified artifact files before any upload', async () => {
  const scenarios = [
    (f) => f.files.delete(deb),
    (f) => f.files.set('unexpected.txt', Buffer.from('x')),
    (f) => f.files.set(deb, Buffer.from('changed')),
    (f) => { f.env.DEB_SHA256 = 'x'.repeat(64); },
    (f) => { f.options.io.lstatSync = () => ({ isFile: () => false, isSymbolicLink: () => true, size: 1 }); },
    (f) => { f.files.set(appimage, Buffer.alloc(0)); },
  ];
  for (const change of scenarios) {
    const f = fixture(); change(f);
    await assert.rejects(f.run());
    assert.deepEqual(f.calls, []);
    assert.deepEqual([...f.stored.keys()], ['windows.exe']);
  }
});

test('revalidates release identity and uploads exactly four assets without overwriting', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { outcome: 'attached', names });
  assert.equal(f.calls[0], 'preflight');
  const requests = f.calls.slice(1);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(([url]) => new URL(url).searchParams.get('name')), names);
  for (const [url, request] of requests) {
    assert.ok(url.startsWith('https://uploads.github.com/repos/egdev6/quorb/releases/42/assets?name='));
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture-token');
  }
  assert.deepEqual(f.stored.get(`${deb}.sha256`).bytes, checksum(deb, f.files.get(deb)));
  assert.deepEqual(f.stored.get(`${appimage}.sha256`).bytes, checksum(appimage, f.files.get(appimage)));
  assert.deepEqual(f.stored.get('windows.exe'), { id: 10, bytes: Buffer.from('untouched') });
});

test('changed identity, collision or invalid release ID abort before writes', async () => {
  for (const change of [
    (f) => { f.options.preflight = async () => ({ releaseId: 43 }); },
    (f) => { f.options.preflight = async () => { throw new Error('Release already contains an asset'); }; },
    (f) => { f.env.RELEASE_ID = '42/../10'; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.run());
    assert.ok(!f.calls.some((call) => Array.isArray(call)));
    assert.deepEqual([...f.stored.keys()], ['windows.exe']);
  }
});

test('each partial upload failure rolls back every confirmed asset from this run only', async () => {
  for (let failAt = 1; failAt <= names.length; failAt++) {
    const f = fixture({ failAt });
    await assert.rejects(f.run(), (error) => {
      assert.match(error.message, /upload failed/i);
      assert.ok(!error.message.includes('fixture-token'));
      return true;
    });
    const deletions = f.calls.filter((call) => Array.isArray(call) && call[1].method === 'DELETE');
    assert.deepEqual(deletions.map(([url]) => Number(url.split('/').at(-1))), Array.from({ length: failAt - 1 }, (_, i) => 100 + failAt - 1 - i));
    assert.deepEqual([...f.stored.keys()], ['windows.exe']);
  }
});

test('a name claimed after preflight is never overwritten or deleted on upload failure', async () => {
  const f = fixture();
  const fetch = f.options.fetch;
  f.options.fetch = async (url, request) => {
    if (request.method === 'POST' && new URL(url).searchParams.get('name') === appimage) {
      f.calls.push([url, request]);
      f.stored.set(appimage, { id: 900, bytes: Buffer.from('concurrent upload') });
      return new Response('', { status: 422 });
    }
    return fetch(url, request);
  };
  await assert.rejects(f.run(), /upload failed/i);
  assert.deepEqual(f.stored.get(appimage), { id: 900, bytes: Buffer.from('concurrent upload') });
  assert.deepEqual([...f.stored.keys()], ['windows.exe', appimage]);
  const deletes = f.calls.filter((call) => Array.isArray(call) && call[1].method === 'DELETE');
  assert.deepEqual(deletes.map(([url]) => Number(url.split('/').at(-1))), [102, 101]);
});

test('ambiguous responses roll back confirmed IDs only; failed cleanup is reported and attempted for all', async () => {
  const ambiguous = fixture({ failAt: 3, badResponse: true });
  await assert.rejects(ambiguous.run(), /ambiguous|inspect/i);
  assert.deepEqual([...ambiguous.stored.keys()], ['windows.exe']);
  const failed = fixture({ failAt: 4, rollbackFailure: true });
  await assert.rejects(failed.run(), (error) => {
    assert.match(error.message, /rollback failed/i);
    for (const id of ['101', '102', '103']) assert.ok(error.message.includes(id));
    return true;
  });
  assert.equal(failed.calls.filter((call) => Array.isArray(call) && call[1].method === 'DELETE').length, 3);
  assert.ok(failed.stored.has('windows.exe'));
});
