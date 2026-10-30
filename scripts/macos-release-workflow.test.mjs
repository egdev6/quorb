import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url));
const normalize = (text) => text.replaceAll('\r\n', '\n');
const digest = (text) => createHash('sha256').update(normalize(text)).digest('hex');
// Exact reviewed bytes, including every step, permission, pin and secret. This
// replaces the old inline snapshot, not its strictness: no YAML subset matching.
const reviewed = 'df1055991fe75d4c528361a7abec0c2f78952540393ad15f8c1e12e5689bcade';
const requiredTests = ['macos-release-preflight', 'macos-release-workflow', 'macos-notary-checkpoint', 'macos-notary-submit', 'macos-notary-artifact', 'macos-release-resume', 'macos-release-resume-workflow', 'macos-release-resume-publish'];

function contract(draft, active, pkg) {
  assert.deepEqual(active, draft, 'Materialization must be byte-identical');
  assert.equal(digest(draft.toString('utf8')), reviewed, 'Exact prepare/submit workflow contract');
  for (const name of requiredTests) assert.ok(pkg.scripts.test.includes(`scripts/${name}.test.mjs`), name);
  assert.equal(pkg.scripts['app:build:mac'], 'tauri build --config src-tauri/tauri.macos.conf.json');
}
const pkg = () => JSON.parse(read('package.json'));
const draft = () => read('.github/security-drafts/macos-release.yml');

test('prepare/submit workflow is exact, byte-mirrored and fully wired', () => {
  contract(draft(), read('.github/workflows/macos-release.yml'), pkg());
  const text = normalize(draft().toString());
  assert.doesNotMatch(text, /contents: write|--wait|stapler staple|gh release|latest.json|continue-on-error/);
  assert.ok(text.indexOf('id: checkpoint') < text.indexOf('APPLE_API_KEY_P8:'));
  assert.ok(text.indexOf('macos-notary-checkpoint.mjs build') < text.indexOf('macos-notary-checkpoint.mjs stage'));
  assert.ok(text.indexOf('macos-notary-checkpoint.mjs stage') < text.indexOf('id: checkpoint'));
  const build = text.split('      - name: Build and sign')[1].split('      - name: Verify')[0];
  assert.doesNotMatch(build, /APPLE_API|APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID/);
});

test('exact workflow contract is CRLF-safe but never accepts mismatched materialization', () => {
  const lf = normalize(draft().toString());
  for (const text of [lf, lf.replaceAll('\n', '\r\n')]) contract(Buffer.from(text), Buffer.from(text), pkg());
  assert.throws(() => contract(Buffer.from(lf), Buffer.from(lf.replaceAll('\n', '\r\n')), pkg()));
});

test('rejects deletion or mutation of every reviewed line, step order, pins and wiring', () => {
  const text = normalize(draft().toString());
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    for (const change of [lines.filter((_, i) => i !== index).join('\n'), lines.map((value, i) => i === index ? `${value} # mutation` : value).join('\n')]) {
      assert.throws(() => contract(Buffer.from(change), Buffer.from(change), pkg()), undefined, line);
    }
  }
  const reversed = Buffer.from([...lines].reverse().join('\n'));
  assert.throws(() => contract(reversed, reversed, pkg()));
  for (const name of requiredTests) {
    const changed = pkg(); changed.scripts.test = changed.scripts.test.replace(`scripts/${name}.test.mjs`, '');
    assert.throws(() => contract(draft(), draft(), changed));
  }
});
