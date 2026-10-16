// DRAFT unit tests — policy checks and exact-image exclusions; not a malware certificate.
// Cases use constructed escape sequences / short literals; no executable payloads.
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { analyze, validatePolicy, OperationalError } from './check-repository.mjs';

const pol = (o = {}) => ({ schemaVersion: 1, maxTextBytes: 1048576, allowedSymlinks: [], allowedRootLifecycleHooks: [], bidiExceptions: [], ...o });
const src = (path, text) => ({ path, mode: '100644', bytes: Buffer.from(text, 'utf8') });
const raw = (path, arr) => ({ path, mode: '100644', bytes: Buffer.from(arr) });

const image = raw('assets/logo.png', [137, 80, 78, 71, 0]);
const imageApproval = { path: image.path, sha256: createHash('sha256').update(image.bytes).digest('hex') };

test('approved image requires exact path and SHA, reports explicit exclusion', () => {
  const policy = pol({ approvedBinaryImages: [imageApproval] });
  const r = analyze([image], policy);
  assert.equal(r.ok, true);
  assert.deepEqual(r.approvedExclusions, [imageApproval]);
  assert.equal(analyze([{ ...image, path: 'assets/other.png' }], policy).ok, false);
  assert.equal(analyze([{ ...image, bytes: Buffer.from([0, 1]) }], policy).ok, false);
});

test('ICNS approval requires exact path, hash and regular non-executable mode', () => {
  const icon = raw('src-tauri/icons/icon.icns', [105, 99, 110, 115, 0, 0, 0, 8]);
  const approval = { path: icon.path, sha256: createHash('sha256').update(icon.bytes).digest('hex') };
  const policy = pol({ approvedBinaryImages: [approval] });
  const report = analyze([icon], policy);
  assert.equal(report.ok, true);
  assert.deepEqual(report.approvedExclusions, [approval]);
  for (const changed of [
    { ...icon, path: 'src-tauri/icons/other.icns' },
    { ...icon, bytes: Buffer.concat([icon.bytes, Buffer.from([0])]) },
    { ...icon, mode: '100755' },
    { ...icon, mode: '120000' },
    { ...icon, bytes: null },
  ]) {
    const rejected = analyze([changed], policy);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.approvedExclusions, []);
  }
  assert.equal(analyze([icon], pol()).ok, false, 'ICNS is not approved by extension alone');
});

test('repository policy pins the statically reviewed macOS icon', () => {
  const policy = validatePolicy(JSON.parse(readFileSync(new URL('../../.github/security/policy.json', import.meta.url), 'utf8')));
  assert.deepEqual(policy.approvedBinaryImages.filter(image => image.path.endsWith('.icns')), [
    { path: 'src-tauri/icons/icon.icns', sha256: 'da545af8c619e13615caa7c57541b45dae94c43e92d2a2641eff74d00909fc0b' },
  ]);
});

test('image approval never exempts links, executable modes or bidi paths', () => {
  const policy = pol({ approvedBinaryImages: [imageApproval] });
  assert.equal(analyze([{ ...image, mode: '120000' }], policy).ok, false);
  assert.equal(analyze([{ ...image, mode: '100755' }], policy).ok, false);
  const path = 'assets/\u202elogo.png';
  assert.equal(analyze([{ ...image, path }], pol({ approvedBinaryImages: [{ ...imageApproval, path }] })).ok, false);
});

test('image exemption handles bytes beyond text limit but never missing bytes', () => {
  const policy = pol({ maxTextBytes: 1, approvedBinaryImages: [imageApproval] });
  assert.equal(analyze([image], policy).ok, true);
  assert.equal(analyze([{ ...image, bytes: null }], policy).ok, false);
});

test('image approvals reject bad hashes, traversal, duplicates and source exemptions', () => {
  for (const approvals of [[{ ...imageApproval, sha256: 'bad' }], [{ ...imageApproval, path: '../logo.png' }], [imageApproval, imageApproval], [{ ...imageApproval, path: 'src/main.ts' }]]) {
    assert.throws(() => validatePolicy(pol({ approvedBinaryImages: approvals })), TypeError);
  }
});

test('safe source has no findings', () => {
  const r = analyze([src('src/a.ts', 'const x = 1;\n')], pol());
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('bidi control in source blocks', () => {
  const r = analyze([src('src/a.ts', 'let x = "\u202e";\n')], pol());
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings[0], { severity: 'block', id: 'bidi-control', path: 'src/a.ts', line: 1 });
});

test('zero-width joiner alerts but does not block', () => {
  const r = analyze([src('src/a.ts', 'a\u200db\n')], pol());
  assert.equal(r.ok, true);
  assert.equal(r.findings[0].severity, 'alert');
});

test('nonblocking Cf on first line cannot mask later bidi', () => {
  const r = analyze([src('src/a.ts', 'a\u200db\nline\u202e\n')], pol());
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings.map(f => [f.severity, f.line]), [['alert', 1], ['block', 2]]);
});

test('bidi in tracked Markdown (non-source extension) is scanned and blocks', () => {
  const r = analyze([src('docs/NOTES.md', '# title\u202e\n')], pol());
  assert.equal(r.findings[0].id, 'bidi-control');
});

test('unallowed symlink blocks without dereference', () => {
  const r = analyze([{ path: 'link', mode: '120000', bytes: null }], pol());
  assert.equal(r.findings[0].id, 'symlink-not-allowed');
});

test('gitlink blocks and is never ok', () => {
  const r = analyze([{ path: 'sub', mode: '160000', bytes: null }], pol());
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].id, 'gitlink-not-allowed');
});

test('root lifecycle hook denied by default, allowed when listed', () => {
  const body = JSON.stringify({ scripts: { postinstall: 'true' } });
  assert.equal(analyze([src('package.json', body)], pol()).ok, false);
  assert.equal(analyze([src('package.json', body)], pol({ allowedRootLifecycleHooks: ['postinstall'] })).ok, true);
});

test('pack hooks and nested manifests are checked; root exceptions stay local', () => {
  for (const hook of ['prepack', 'postpack', 'dependencies']) {
    assert.equal(analyze([src('package.json', JSON.stringify({ scripts: { [hook]: 'true' } }))], pol()).ok, false);
  }
  const nested = src('packages/tool/package.json', JSON.stringify({ scripts: { postinstall: 'true' } }));
  assert.equal(analyze([nested], pol({ allowedRootLifecycleHooks: ['postinstall'] })).ok, false);
});

test('coverage gaps do not yield complete green', () => {
  const r = analyze([raw('asset.bin', [0x00])], pol());
  assert.equal(r.ok, false);
  assert.equal(r.coverageGaps[0].reason, 'binary');
});

test('malformed package.json is an operational failure', () => {
  assert.throws(() => analyze([src('package.json', '{not json')], pol()), OperationalError);
});

test('invalid UTF-8 or NUL in source is an operational failure', () => {
  assert.throws(() => analyze([raw('a.ts', [0xff, 0xfe])], pol()), OperationalError);
  assert.throws(() => analyze([raw('a.ts', [0x61, 0x00])], pol()), OperationalError);
});

test('invalid policy shape and non-empty bidiExceptions are rejected', () => {
  assert.throws(() => validatePolicy({ schemaVersion: 1 }), TypeError);
  assert.throws(() => validatePolicy(pol({ bidiExceptions: ['\u202e'] })), TypeError);
});

test('oversize source blocks; unread/binary non-source is an explicit gap', () => {
  const p = pol({ maxTextBytes: 4 });
  assert.equal(analyze([src('a.ts', '12345')], p).findings[0].id, 'source-too-large');
  assert.equal(analyze([{ path: 'a.bin', mode: '100644', bytes: null }], p).coverageGaps[0].reason, 'large');
  assert.equal(analyze([raw('a.bin', [0x00])], p).coverageGaps[0].reason, 'binary');
});
