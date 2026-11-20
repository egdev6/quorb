import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightRelease } from './linux-release-preflight.mjs';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const secret = 'SYNTHETIC_TOKEN_MARKER';
const version = '0.9.0';
const names = [`Quorb_${version}_amd64.deb`, `Quorb_${version}_amd64.deb.sha256`,
  `Quorb_${version}_amd64.AppImage`, `Quorb_${version}_amd64.AppImage.sha256`];

function fixture() {
  const calls = [];
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'egdev6/quorb',
    RELEASE_VERSION: version, RELEASE_SOURCE_SHA: sha, GH_TOKEN: secret };
  const files = {
    'package.json': JSON.stringify({ version }),
    'package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'src-tauri/Cargo.toml': `[package]\nname = "quorb"\nversion = "${version}"\n[dependencies]\n`,
    'src-tauri/Cargo.lock': `[[package]]\nname = "quorb"\nversion = "${version}"\n`,
    'src-tauri/tauri.conf.json': JSON.stringify({ productName: 'Quorb', version: '../package.json' }),
  };
  const release = { id: 42, tag_name: `v${version}`, draft: false, target_commitish: 'main' };
  const routes = {
    '/releases?per_page=100&page=1': [release],
    [`/git/ref/tags/v${version}`]: { object: { type: 'commit', sha } },
    '/releases/42/assets?per_page=100&page=1': [],
  };
  const options = { env, root: '/fake-root',
    execFileSync(command, args, settings) {
      calls.push(['git', command, args, settings]);
      if (args[0] === 'merge-base') return '';
      assert.equal(args[0], 'show');
      const file = args[1].slice(`${sha}:`.length);
      assert.ok(Object.hasOwn(files, file), file);
      return files[file];
    },
    async fetch(url, settings) {
      calls.push(['fetch', url, settings]);
      const route = url.replace('https://api.github.com/repos/egdev6/quorb', '');
      assert.ok(Object.hasOwn(routes, route), `Unexpected route ${route}`);
      const value = routes[route];
      return value instanceof Response ? value : new Response(JSON.stringify(value));
    },
  };
  return { env, files, release, routes, calls, options, run: (overrides = {}) => preflightRelease({ ...options, ...overrides }) };
}
async function rejects(f, message, overrides) {
  await assert.rejects(f.run(overrides), (error) => {
    assert.equal(error.message, message);
    assert.ok(!String(error).includes(secret));
    return true;
  });
  assert.ok(f.calls.filter(([kind]) => kind === 'fetch').every(([, , options]) => options.method === 'GET'));
}

test('accepts exact ancestor, all release manifests, config and existing tag without mutation', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { sourceSha: sha, version, releaseId: 42 });
  const git = f.calls.filter(([kind]) => kind === 'git');
  assert.deepEqual(git[0][2], ['merge-base', '--is-ancestor', sha, 'origin/main']);
  assert.deepEqual(git.slice(1).map(([, , args]) => args[1]), Object.keys(f.files).map((file) => `${sha}:${file}`));
  for (const [, , , settings] of git) assert.equal(settings.cwd, '/fake-root');
  for (const [, url, settings] of f.calls.filter(([kind]) => kind === 'fetch')) {
    assert.ok(url.startsWith('https://api.github.com/repos/egdev6/quorb/'));
    assert.equal(settings.method, 'GET');
    assert.equal(settings.redirect, 'error');
    assert.equal(settings.headers.Authorization, `Bearer ${secret}`);
  }
});

test('rejects invalid ref, version, SHA, repository and token before any I/O', async () => {
  const cases = [
    ['GITHUB_REF', 'refs/heads/feature', 'Release ref must be refs/heads/main'],
    ...[undefined, '', 'v0.9.0', '00.9.0', '0.9.0-rc.1', '0.9.0+build', '0.9.0\n', '../0.9.0'].map((v) => ['RELEASE_VERSION', v, 'Release version must be stable SemVer']),
    ...[undefined, '', 'A'.repeat(40), 'g'.repeat(40), `${sha}\n`, sha.slice(1)].map((v) => ['RELEASE_SOURCE_SHA', v, 'Release source_sha must be 40 lowercase hex characters']),
    ['GITHUB_REPOSITORY', 'other/quorb', 'Invalid release environment'],
    ['GH_TOKEN', '', 'Invalid release environment'], ['GH_TOKEN', `${secret}\n`, 'Invalid release environment'],
  ];
  for (const [key, value, message] of cases) {
    const f = fixture(); f.env[key] = value;
    await rejects(f, message); assert.deepEqual(f.calls, []);
  }
});

test('rejects non-ancestor and every mismatching or missing version source before HTTP', async () => {
  const f = fixture();
  await rejects(f, 'Release source_sha must be an ancestor of origin/main', { execFileSync: () => { throw new Error(secret); } });
  for (const [file, text] of [
    ['package.json', '{"version":"0.8.0"}'],
    ['package-lock.json', '{"version":"0.9.0","packages":{"":{"version":"0.8.0"}}}'],
    ['src-tauri/Cargo.toml', '[package]\nversion = "0.8.0"'],
    ['src-tauri/Cargo.lock', '[[package]]\nname = "quorb"\nversion = "0.8.0"'],
    ['src-tauri/tauri.conf.json', '{"productName":"Other","version":"../package.json"}'],
    ['src-tauri/tauri.conf.json', '{"productName":"Quorb","version":"0.8.0"}'],
    ['package.json', '{'],
  ]) {
    const g = fixture(); g.files[file] = text;
    await rejects(g, 'Release manifest versions or Tauri configuration do not match source_sha');
    assert.ok(!g.calls.some(([kind]) => kind === 'fetch'));
  }
});

test('requires one existing release and its actual matching tag, including drafts', async () => {
  const missing = fixture(); missing.routes['/releases?per_page=100&page=1'] = [];
  await rejects(missing, `Release v${version} must already exist`);
  const duplicate = fixture(); duplicate.routes['/releases?per_page=100&page=1'] = [duplicate.release, duplicate.release];
  await rejects(duplicate, 'Unable to verify release metadata');
  for (const draft of [true, false]) {
    const f = fixture(); f.release.draft = draft;
    f.routes[`/git/ref/tags/v${version}`] = new Response('', { status: 404 });
    await rejects(f, 'Release tag must point at source_sha');
  }
  const mismatch = fixture(); mismatch.routes[`/git/ref/tags/v${version}`].object.sha = other;
  await rejects(mismatch, 'Release tag must point at source_sha');
  const draft = fixture(); draft.release.draft = true;
  assert.equal((await draft.run()).releaseId, 42);
});

test('resolves annotated tags and rejects cycles and malformed objects', async () => {
  const f = fixture();
  f.routes[`/git/ref/tags/v${version}`] = { object: { type: 'tag', sha: other } };
  f.routes[`/git/tags/${other}`] = { object: { type: 'commit', sha } };
  assert.equal((await f.run()).releaseId, 42);
  for (const object of [null, {}, { type: 'tree', sha }, { type: 'tag', sha: other }]) {
    const g = fixture(); g.routes[`/git/ref/tags/v${version}`] = { object };
    g.routes[`/git/tags/${other}`] = { object: { type: 'tag', sha: other } };
    await rejects(g, 'Release tag must point at source_sha');
  }
});

test('checks all four asset names across pages and leaves unrelated release assets intact', async () => {
  for (const name of names) {
    const f = fixture();
    f.routes['/releases/42/assets?per_page=100&page=1'] = Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` }));
    f.routes['/releases/42/assets?per_page=100&page=2'] = [{ name }];
    await rejects(f, `Release already contains ${name}`);
  }
  const f = fixture();
  f.routes['/releases?per_page=100&page=1'] = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: `other-${i}` }));
  f.routes['/releases?per_page=100&page=2'] = [f.release];
  f.routes['/releases/42/assets?per_page=100&page=1'] = [{ name: 'latest.json' }, { name: 'windows.exe' }];
  assert.equal((await f.run()).releaseId, 42);
});

test('fails closed on malformed HTTP, pagination and secret-bearing errors', async () => {
  for (const value of [new Response('no', { status: 403 }), new Response('{'), new Response(' '.repeat(1024 * 1024 + 1)), {}]) {
    const f = fixture(); f.routes['/releases?per_page=100&page=1'] = value;
    await rejects(f, 'Unable to verify release metadata');
  }
  await rejects(fixture(), 'Unable to verify release metadata', { fetch: async () => { throw new Error(secret); } });
  const f = fixture(); f.routes['/releases/42/assets?per_page=100&page=1'] = [null];
  await rejects(f, 'Unable to verify release assets');
});
