import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const source = '.github/security-drafts/macos-ci.yml';

function assertWorkflowContract(workflow, active, windows) {
  [workflow, active, windows] = [workflow, active, windows].map((text) => text.replace(/\r\n/g, '\n'));
  assert.equal(active, workflow);
  const parts = workflow.split('    steps:\n');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], `name: macOS CI

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: macos-ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  checks:
    name: Tests and bundle (macOS ARM64)
    runs-on: macos-15
    timeout-minutes: 30
`);
  const steps = parts[1].split(/      - name: /).slice(1).map((step) => step.trimEnd());
  const action = (name, ref, options) => `${name}\n        uses: ${ref}\n        with:\n${options}`;
  const refs = windows.match(/uses: (\S+)/g).map((line) => line.slice(6));
  assert.deepEqual(refs, [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
    'dtolnay/rust-toolchain@89b12181fb390509a0842a86cc55eeb8eb928c1d',
  ]);
  assert.deepEqual(steps, [
    action('Checkout', refs[0], '          persist-credentials: false'),
    action('Node 22', refs[1], '          node-version: 22\n          package-manager-cache: false'),
    action('Rust stable', refs[2], '          toolchain: stable'),
    `Native environment and source
        shell: bash
        run: |
          set -euo pipefail
          printf 'Source SHA: %s\\n' "$GITHUB_SHA"
          uname -a
          node --version
          rustc -vV
          test "$(uname -m)" = arm64
          test "$(node -p 'process.arch')" = arm64
          test "$(rustc -vV | awk '/^host:/ { print $2 }')" = aarch64-apple-darwin`,
    'Install locked frontend dependencies\n        run: npm ci',
    'Frontend and script tests\n        run: npm test',
    'Typecheck\n        run: npm run typecheck',
    'Frontend build\n        run: npm run build',
    'Rust tests with locked dependencies\n        working-directory: src-tauri\n        run: cargo test --locked',
    'Build native app and DMG\n        run: npm run app:build:mac',
    'Verify bundle without launching\n        run: node scripts/verify-macos-bundle.mjs',
  ]);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target|continue-on-error|upload-artifact|keychain|\$\{\{ github.sha/);
}

const workflowFiles = [source, '.github/workflows/macos-ci.yml', '.github/workflows/ci.yml'];
test('macOS workflow matches its reviewed source and bounded native ARM64 CI contract', () => {
  assertWorkflowContract(...workflowFiles.map(read));
});

for (const [label, endings] of [
  ['LF', ['\n', '\n', '\n']],
  ['CRLF', ['\r\n', '\r\n', '\r\n']],
  ['mixed LF/CRLF', ['\n', '\r\n', '\r\n']],
]) {
  test(`macOS workflow contract accepts ${label} in source, active workflow and Windows pins`, () => {
    const fixtures = workflowFiles.map((name, index) => read(name).replace(/\r?\n/g, endings[index]));
    assertWorkflowContract(...fixtures);
  });
}

test('npm test includes both macOS contracts without changing the macOS build command', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['macos-ci', 'verify-macos-bundle']) assert.ok(pkg.scripts.test.includes(`scripts/${name}.test.mjs`));
  assert.equal(pkg.scripts['app:build:mac'], 'tauri build --config src-tauri/tauri.macos.conf.json');
});
