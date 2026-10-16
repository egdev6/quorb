import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = '.github/security-drafts/macos-preview.yml';
const active = '.github/workflows/macos-preview.yml';
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pins = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  'dtolnay/rust-toolchain@89b12181fb390509a0842a86cc55eeb8eb928c1d',
  'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f',
  'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131',
];
const artifactName = 'quorb-macos-preview-${{ github.sha }}';
const guideClaims = [
  'GitHub login', '14 days', 'not application expiry', 'ARM64', 'macOS 15',
  'manual updates', 'Developer ID', 'not notarized', 'manifest.sourceSha',
  'manifest.version', 'manifest.dmg.sha256', 'shasum -a 256', 'not proof of safety',
  'quarantine', 'malware', 'damaged', 'https://support.apple.com/en-us/102445',
  'not yet validated', 'Inicio de sesión', 'No elimines',
];

function assertMaterialization(sourceBytes, activeBytes) {
  assert.deepEqual(activeBytes, sourceBytes);
}

// Deliberately exact reviewed text, not a general YAML security parser.
function assertContract(workflow, materialized, pkg, guide) {
  [workflow, materialized] = [workflow, materialized].map((text) => text.replace(/\r\n/g, '\n'));
  assert.equal(materialized, workflow);
  const parts = workflow.split('    steps:\n');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], `name: macOS preview

on:
  workflow_dispatch:
    inputs:
      version:
        description: Exact stable package.json version
        required: true
        type: string
      source_sha:
        description: Full lowercase SHA of current main HEAD
        required: true
        type: string

permissions:
  contents: read
  checks: read

concurrency:
  group: macos-preview-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  preview:
    name: Build unsigned macOS preview
    if: github.ref == 'refs/heads/main'
    runs-on: macos-15
    timeout-minutes: 30
    env:
      PREVIEW_VERSION: \${{ inputs.version }}
      PREVIEW_SOURCE_SHA: \${{ inputs.source_sha }}
`);
  assert.deepEqual(workflow.match(/uses: (\S+)/g).map((line) => line.slice(6)), pins);
  const action = (name, pin, options) => `${name}\n        uses: ${pin}\n        with:\n${options}`;
  const stepParts = parts[1].split(/      - name: /);
  assert.equal(stepParts[0], '');
  const steps = stepParts.slice(1).map((step) => step.trimEnd());
  assert.deepEqual(steps, [
    action('Checkout exact source', pins[0], '          ref: ${{ github.sha }}\n          persist-credentials: false'),
    action('Node 22', pins[1], '          node-version: 22\n          package-manager-cache: false'),
    'Preflight exact source and required checks\n        run: node scripts/macos-preview-preflight.mjs\n        env:\n          GH_TOKEN: ${{ github.token }}',
    action('Rust stable', pins[2], '          toolchain: stable'),
    'Install locked dependencies\n        run: npm ci',
    'Build app and DMG\n        run: npm run app:build:mac',
    'Stage verified preview\n        run: node scripts/macos-preview-artifact.mjs stage',
    action('Upload immutable preview', pins[3], `          name: ${artifactName}\n          path: src-tauri/target/macos-preview-upload\n          retention-days: 14\n          if-no-files-found: error\n          overwrite: false\n          include-hidden-files: false`),
    action('Download same-run preview by name', pins[4], `          name: ${artifactName}\n          path: src-tauri/target/macos-preview-download`),
    'Verify downloaded preview\n        run: node scripts/macos-preview-artifact.mjs readback',
  ]);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target|continue-on-error|always\(|id-token|keychain|notariz|latest\.json|minisign|tauri-action|gh release/);
  assert.ok(pkg.scripts.test.includes('scripts/macos-preview-workflow.test.mjs'));
  assert.equal(pkg.scripts['app:build:mac'], 'tauri build --config src-tauri/tauri.macos.conf.json');
  for (const claim of guideClaims) assert.ok(guide.includes(claim), `Missing guidance: ${claim}`);
  assert.doesNotMatch(guide, /xattr|spctl|curl|automatically bypass/i);
}
const fixtures = () => [read(source), read(source), JSON.parse(read('package.json')), read('docs/macos-preview-README.md')];

for (const [label, endings] of [
  ['LF', ['\n', '\n']], ['CRLF', ['\r\n', '\r\n']], ['mixed LF/CRLF', ['\n', '\r\n']],
]) {
  test(`pure preview contract accepts ${label} with in-memory materialization`, () => {
    const values = fixtures();
    for (let index = 0; index < 2; index++) values[index] = values[index].replace(/\r?\n/g, endings[index]);
    assertContract(...values);
  });
}

test('real preview integration requires active workflow with byte-identical reviewed source', () => {
  const destination = readFileSync(new URL(`../${active}`, import.meta.url));
  assertMaterialization(readFileSync(new URL(`../${source}`, import.meta.url)), destination);
  assertContract(read(source), destination.toString('utf8'), JSON.parse(read('package.json')), read('docs/macos-preview-README.md'));
});

test('rejects removed gates, unsafe scope, input interpolation, publishing and artifact drift', () => {
  const values = fixtures();
  const mutations = [
    ['workflow_dispatch:', 'push:'], ['  workflow_dispatch:', '  schedule:\n  workflow_dispatch:'],
    ['    steps:\n', '    steps:\n      - run: echo unreviewed\n'],
    ['        required: true', '        required: false'], ['        type: string', '        type: boolean'],
    ['        type: string', '        type: string\n        default: 0.6.0'],
    ["    if: github.ref == 'refs/heads/main'\n", ''], ["refs/heads/main", 'refs/heads/topic'],
    ['    name: Build unsigned macOS preview', '    name: Tests and bundle (macOS ARM64)'],
    ['contents: read', 'contents: write'], ['  checks: read\n', ''], ['  checks: read', '  id-token: write'],
    ['cancel-in-progress: false', 'cancel-in-progress: true'], ['macos-preview-${{ github.ref }}', 'macos-ci-${{ github.ref }}'],
    ['macos-15', 'ubuntu-latest'], ['timeout-minutes: 30', 'timeout-minutes: 90'],
    ['node-version: 22', 'node-version: 24'], ['package-manager-cache: false', 'package-manager-cache: true'],
    ['ref: ${{ github.sha }}', 'ref: ${{ inputs.source_sha }}'], ['persist-credentials: false', 'persist-credentials: true'],
    ['PREVIEW_SOURCE_SHA: ${{ inputs.source_sha }}', 'PREVIEW_SOURCE_SHA: ${{ github.sha }}'],
    ['PREVIEW_VERSION: ${{ inputs.version }}', 'PREVIEW_VERSION: 0.6.0'],
    ['    env:', '    env:\n      GH_TOKEN: ${{ github.token }}'], ['          GH_TOKEN: ${{ github.token }}\n', ''],
    ['run: npm ci', 'run: npm ci --ignore-scripts'], ['run: npm ci', 'run: echo ${{ inputs.version }}'],
    ['run: npm ci', 'if: always()\n        run: npm ci'], ['run: npm ci', 'continue-on-error: true\n        run: npm ci'],
    ['run: npm run app:build:mac', 'run: npm run app:build:macos'], ['run: npm ci', 'run: npm test'],
    ['run: node scripts/macos-preview-preflight.mjs', 'run: npm ci'],
    ['run: node scripts/macos-preview-artifact.mjs stage', 'run: gh release create preview'],
    ['retention-days: 14', 'retention-days: 90'], ['overwrite: false', 'overwrite: true'],
    ['include-hidden-files: false', 'include-hidden-files: true'], ['if-no-files-found: error', 'if-no-files-found: warn'],
    ['path: src-tauri/target/macos-preview-upload', 'path: src-tauri/target'],
    ['path: src-tauri/target/macos-preview-download', 'path: elsewhere\n          run-id: 123'],
    ['path: src-tauri/target/macos-preview-download', 'path: elsewhere\n          github-token: ${{ github.token }}'],
    ['path: src-tauri/target/macos-preview-download', 'path: elsewhere\n          repository: other/repo'],
    ['path: src-tauri/target/macos-preview-download', 'path: elsewhere\n          artifact-ids: 123'],
    ['path: src-tauri/target/macos-preview-download', 'path: elsewhere\n          pattern: "*"'],
    ['name: quorb-macos-preview-${{ github.sha }}', 'name: preview-latest'],
    ['run: node scripts/macos-preview-artifact.mjs readback', 'run: echo unchecked'],
  ];
  for (const pin of pins) mutations.push([pin, pin.replace(/@.*/, '@main')]);
  for (const [before, after] of mutations) {
    assert.ok(values[0].includes(before), `Mutation must apply: ${before}`);
    const changed = values[0].replace(before, after);
    assert.throws(() => assertContract(changed, changed, ...values.slice(2)), undefined, before);
  }
  assert.throws(() => assertContract(values[0], `${values[1]}\n`, ...values.slice(2)));
  const sourceBytes = Buffer.from(values[0]);
  assertMaterialization(sourceBytes, Buffer.from(values[0]));
  assert.throws(() => assertMaterialization(sourceBytes, Buffer.from(`${values[0]}\n`)));
  assert.throws(() => assertMaterialization(sourceBytes, Buffer.from(values[0].replaceAll('\n', '\r\n'))));
  const swapped = values[0].replace(/run: (npm ci|node scripts\/macos-preview-preflight\.mjs)/g,
    (_, command) => `run: ${command === 'npm ci' ? 'node scripts/macos-preview-preflight.mjs' : 'npm ci'}`);
  assert.notEqual(swapped, values[0]);
  assert.throws(() => assertContract(swapped, swapped, ...values.slice(2)));
});

test('rejects misleading guide and missing npm test wiring', () => {
  const values = fixtures();
  for (const claim of guideClaims) {
    assert.throws(() => assertContract(...values.slice(0, 3), values[3].replaceAll(claim, 'removed')));
  }
  const pkg = structuredClone(values[2]);
  pkg.scripts.test = pkg.scripts.test.replace('scripts/macos-preview-workflow.test.mjs', '');
  assert.throws(() => assertContract(...values.slice(0, 2), pkg, values[3]));
});
