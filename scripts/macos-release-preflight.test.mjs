import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightRelease } from './macos-release-preflight.mjs';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const token = 'PRIVATE_FIXTURE_MARKER';
function fixture() {
  const env = { GITHUB_REPOSITORY: 'egdev6/quorb', GITHUB_REF: 'refs/heads/main',
    RELEASE_VERSION: '0.8.0', RELEASE_SOURCE_SHA: sha, GH_TOKEN: token };
  const release = { id: 118, tag_name: 'v0.8.0', draft: false, prerelease: false,
    target_commitish: sha };
  const calls = [];
  const responses = {
    '/releases?per_page=100&page=1': [release],
    '/git/ref/tags/v0.8.0': { object: { type: 'commit', sha } },
    '/releases/118/assets?per_page=100&page=1': [],
  };
  const options = { root: '/fixture', env,
    execFileSync(command, args, settings) {
      calls.push(['git', command, args, settings]);
      return args[0] === 'show' ? '{"version":"0.8.0"}' : '';
    },
    async fetch(url, settings) {
      calls.push(['fetch', url, settings]);
      const route = url.replace('https://api.github.com/repos/egdev6/quorb', '');
      assert.ok(Object.hasOwn(responses, route), `Unexpected route: ${route}`);
      const value = responses[route];
      return value instanceof Response ? value : new Response(JSON.stringify(value));
    },
  };
  return { env, release, responses, calls, options, run: (patch = {}) => preflightRelease({ ...options, ...patch }) };
}
async function rejects(f, message, patch = {}) {
  await assert.rejects(f.run(patch), (error) => {
    assert.equal(error.message, message);
    assert.ok(!String(error).includes(token));
    return true;
  });
}

test('accepts an ancestor, checks package at that SHA and resolves a lightweight tag', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { sourceSha: sha, version: '0.8.0', releaseId: 118 });
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'git').map(([, command, args]) => [command, args]), [
    ['git', ['merge-base', '--is-ancestor', sha, 'origin/main']],
    ['git', ['show', `${sha}:package.json`]],
  ]);
  for (const [, , , settings] of f.calls.filter(([kind]) => kind === 'git')) {
    assert.equal(settings.cwd, '/fixture');
    assert.equal(settings.timeout, 10_000);
  }
  for (const [, url, settings] of f.calls.filter(([kind]) => kind === 'fetch')) {
    assert.ok(url.startsWith('https://api.github.com/repos/egdev6/quorb/'));
    assert.equal(settings.redirect, 'error');
    assert.equal(settings.headers.Authorization, `Bearer ${token}`);
    assert.ok(settings.signal instanceof AbortSignal);
  }
});

test('S4 rejects every non-main ref with the exact error before I/O', async () => {
  for (const ref of [undefined, 'main', 'refs/heads/topic', 'refs/pull/118/merge', 'refs/heads/main\n']) {
    const f = fixture(); f.env.GITHUB_REF = ref;
    await rejects(f, 'Release ref must be refs/heads/main');
    assert.deepEqual(f.calls, []);
  }
});

test('S4 rejects non-stable or malformed versions with the exact error before I/O', async () => {
  for (const version of [undefined, '', 'v0.8.0', '0.8', '00.8.0', '0.08.0', '0.8.00',
    '0.8.0-rc.1', '0.8.0+build', '0.8.0\n', '../0.8.0', ' 0.8.0', 8]) {
    const f = fixture(); f.env.RELEASE_VERSION = version;
    await rejects(f, 'Release version must be stable SemVer');
    assert.deepEqual(f.calls, []);
  }
});

test('S4 rejects malformed source_sha with the exact error before I/O', async () => {
  for (const value of [undefined, '', other.slice(1), 'A'.repeat(40), 'g'.repeat(40), `${sha}\n`, `${sha}/..`, 40]) {
    const f = fixture(); f.env.RELEASE_SOURCE_SHA = value;
    await rejects(f, 'Release source_sha must be 40 lowercase hex characters');
    assert.deepEqual(f.calls, []);
  }
});

test('S4 rejects non-ancestors and Git failures with the exact error, before API access', async () => {
  await rejects(fixture(), 'Release source_sha must be an ancestor of origin/main', {
    execFileSync: () => { throw new Error(token); },
  });
});

test('S4 rejects a different or unreadable package version at source_sha with the exact error', async () => {
  for (const data of ['{"version":"0.8.1"}', '{', 'null', '{}', '{"version":"0.8.0\\n"}']) {
    const f = fixture();
    await rejects(f, 'Release package.json version must match version at source_sha', {
      execFileSync: (_command, args) => args[0] === 'show' ? data : '',
    });
    assert.ok(!f.calls.some(([kind]) => kind === 'fetch'));
  }
  await rejects(fixture(), 'Release package.json version must match version at source_sha', {
    execFileSync: (_command, args) => { if (args[0] === 'show') throw new Error(token); return ''; },
  });
});

test('S4 rejects a missing release with the exact error (drafts are discovered through the list API)', async () => {
  const f = fixture(); f.responses['/releases?per_page=100&page=1'] = [];
  await rejects(f, 'Release v0.8.0 must already exist');
});

test('S4 rejects tag/source mismatch with the exact error even if target_commitish matches', async () => {
  const f = fixture(); f.responses['/git/ref/tags/v0.8.0'].object.sha = other;
  await rejects(f, 'Release tag must point at source_sha');
});

test('S4 rejects the target macOS DMG asset with the exact error, including later pages', async () => {
  const f = fixture();
  f.responses['/releases/118/assets?per_page=100&page=1'] = Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` }));
  f.responses['/releases/118/assets?per_page=100&page=2'] = [{ name: 'Quorb_0.8.0_aarch64.dmg' }];
  await rejects(f, 'Release already contains Quorb_0.8.0_aarch64.dmg');
});

test('accepts nested annotated tags and ignores stale target_commitish when a real tag exists', async () => {
  const f = fixture(); f.release.target_commitish = 'main';
  f.responses['/git/ref/tags/v0.8.0'] = { object: { type: 'tag', sha: other } };
  f.responses[`/git/tags/${other}`] = { object: { type: 'tag', sha: 'c'.repeat(40) } };
  f.responses[`/git/tags/${'c'.repeat(40)}`] = { object: { type: 'commit', sha } };
  assert.equal((await f.run()).sourceSha, sha);
});

test('accepts a Windows draft without a tag only with an exact SHA target_commitish', async () => {
  for (const target of [sha, other, 'main', `${sha}\n`]) {
    const f = fixture(); f.release.draft = true; f.release.target_commitish = target;
    f.responses['/git/ref/tags/v0.8.0'] = new Response('', { status: 404 });
    if (target === sha) assert.equal((await f.run()).releaseId, 118);
    else await rejects(f, 'Release tag must point at source_sha');
  }
  const f = fixture();
  f.responses['/git/ref/tags/v0.8.0'] = new Response('', { status: 404 });
  await rejects(f, 'Release tag must point at source_sha');
});

test('fails closed on malformed, duplicate or prerelease release records and tag objects', async () => {
  for (const data of [null, {}, [null], [{ id: 118 }], [fixture().release, fixture().release]]) {
    const f = fixture(); f.responses['/releases?per_page=100&page=1'] = data;
    await rejects(f, 'Unable to verify release metadata');
  }
  const f = fixture(); f.release.prerelease = true;
  await rejects(f, 'Unable to verify release metadata');
  for (const object of [null, {}, { type: 'tree', sha }, { type: 'commit', sha: `${sha}\n` }, { type: 'tag', sha: other }]) {
    const g = fixture(); g.responses['/git/ref/tags/v0.8.0'] = { object };
    g.responses[`/git/tags/${other}`] = { object: { type: 'tag', sha: other } };
    await rejects(g, 'Release tag must point at source_sha');
  }
});

test('paginates release discovery and assets; rejects a checksum collision too', async () => {
  const f = fixture();
  f.responses['/releases?per_page=100&page=1'] = Array.from({ length: 100 }, (_, i) => ({ ...f.release, id: i + 1, tag_name: `other-${i}` }));
  f.responses['/releases?per_page=100&page=2'] = [f.release];
  f.responses['/releases/118/assets?per_page=100&page=1'] = [{ name: 'latest.json' }, { name: 'windows.exe' }];
  assert.equal((await f.run()).releaseId, 118);
  const g = fixture();
  g.responses['/releases/118/assets?per_page=100&page=1'] = [{ name: 'Quorb_0.8.0_aarch64.dmg.sha256' }];
  await rejects(g, 'Release already contains Quorb_0.8.0_aarch64.dmg.sha256');
});

test('rejects untrusted repository and invalid tokens without consuming dependencies', async () => {
  for (const [key, value] of [['GITHUB_REPOSITORY', 'other/quorb'], ['GH_TOKEN', undefined], ['GH_TOKEN', ''], ['GH_TOKEN', `${token}\n`]]) {
    const f = fixture(); f.env[key] = value;
    await rejects(f, 'Invalid release environment');
    assert.deepEqual(f.calls, []);
  }
});

test('sanitizes HTTP errors, redirects, invalid JSON, oversized and timed-out bodies', async (t) => {
  for (const status of [302, 403, 429, 500]) {
    await rejects(fixture(), 'Unable to verify release metadata', { fetch: async () => new Response(token, { status }) });
  }
  for (const data of ['{', token, ' '.repeat(1024 * 1024 + 1)]) {
    await rejects(fixture(), 'Unable to verify release metadata', { fetch: async () => new Response(data) });
  }
  await rejects(fixture(), 'Unable to verify release metadata', { fetch: async () => { throw new Error(token); } });
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  let cancelled = false;
  const body = new ReadableStream({ pull() { controller.abort(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await rejects(fixture(), 'Unable to verify release metadata', { fetch: async () => new Response(body) });
  assert.equal(cancelled, true);
});
