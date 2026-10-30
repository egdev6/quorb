import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url));
const normalize = (text) => text.replaceAll('\r\n', '\n');
const reviewed = 'a832743594cc2133186f691635e23e62ce64b227131cdd5bb0bf0ea6cea8022a';
function contract(draft, active) {
  assert.deepEqual(active, draft);
  assert.equal(createHash('sha256').update(normalize(draft.toString())).digest('hex'), reviewed);
}
const draft = read('.github/security-drafts/macos-release-resume.yml');
const text = normalize(draft.toString());

test('resume exact reviewed workflow keeps read-only validation separate from explicit publication authority', () => {
  contract(draft, read('.github/workflows/macos-release-resume.yml'));
  assert.match(text, /permissions:\n  contents: read\n  actions: read/);
  assert.equal((text.match(/contents: write/g) ?? []).length, 1);
  assert.ok(text.indexOf('contents: write') > text.indexOf('\n  publish:'));
  assert.match(text, /inputs.publish && needs.resume.outputs.outcome == 'accepted'/);
  assert.match(text, /default: false\n        type: boolean/);
  assert.doesNotMatch(text, /download-artifact|APPLE_CERTIFICATE|APPLE_SIGNING_IDENTITY|notarytool submit|npm ci|npm run|--wait|continue-on-error/);
  assert.ok(text.indexOf('macos-release-resume.mjs validate') < text.indexOf('APPLE_API_KEY_P8:'));
  assert.equal((text.match(/environment: macos-signing/g) ?? []).length, 2);
  assert.equal((text.match(/secrets\./g) ?? []).length, 3);
});

test('resume contract supports matching CRLF and rejects every line mutation and nonmatching mirrors', () => {
  for (const candidate of [text, text.replaceAll('\n', '\r\n')]) contract(Buffer.from(candidate), Buffer.from(candidate));
  assert.throws(() => contract(Buffer.from(text), Buffer.from(text.replaceAll('\n', '\r\n'))));
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    for (const candidate of [lines.filter((_, i) => i !== index).join('\n'), lines.map((value, i) => i === index ? `${value} # mutation` : value).join('\n')]) {
      assert.throws(() => contract(Buffer.from(candidate), Buffer.from(candidate)), undefined, line);
    }
  }
  const swapped = Buffer.from([...lines].reverse().join('\n'));
  assert.throws(() => contract(swapped, swapped));
});
