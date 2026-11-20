import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const workflow = () => read('.github/workflows/linux-release.yml');
const job = (text, name, next) => text.split(`  ${name}:\n`)[1]?.split(next ? `  ${next}:\n` : '\n# end of jobs')[0];

test('manual dispatch accepts only the required version and source SHA', () => {
  const text = workflow();
  const trigger = text.split('\non:\n')[1]?.split('\npermissions:\n')[0];
  assert.ok(trigger);
  assert.deepEqual([...trigger.matchAll(/^  ([\w-]+):/gm)].map((m) => m[1]), ['workflow_dispatch']);
  assert.deepEqual([...trigger.matchAll(/^      ([\w-]+):/gm)].map((m) => m[1]), ['version', 'source_sha']);
  for (const name of ['version', 'source_sha']) {
    assert.match(trigger, new RegExp(`      ${name}:\\n(?:        [^\\n]*\\n)*?        required: true\\n(?:        [^\\n]*\\n)*?        type: string`));
  }
});

test('all three jobs guard main, and only attach receives write permission', () => {
  const text = workflow();
  assert.match(text, /\npermissions:\n  contents: read\n/);
  const preflight = job(text, 'preflight', 'build');
  const build = job(text, 'build', 'attach');
  const attach = job(text, 'attach');
  for (const part of [preflight, build, attach]) {
    assert.ok(part);
    assert.match(part, /\n    if: github\.ref == 'refs\/heads\/main'\n/);
    assert.match(part, /\n    runs-on: ubuntu-22\.04\n/);
  }
  assert.doesNotMatch(preflight + build, /contents: write/);
  assert.match(attach, /\n    permissions:\n      contents: write\n/);
  assert.equal((text.match(/contents: write/g) ?? []).length, 1);
  assert.doesNotMatch(text, /\$\{\{\s*secrets\./);
});

test('each action is SHA pinned, and user input never enters run blocks', () => {
  const text = workflow();
  const actions = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(actions.length >= 6);
  for (const action of actions) assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/);
  for (const line of text.split('\n').filter((line) => /\$\{\{\s*inputs\./.test(line))) {
    assert.match(line, /^\s+(RELEASE_VERSION|RELEASE_SOURCE_SHA): \$\{\{ inputs\.(version|source_sha) \}\}$/);
  }
  assert.doesNotMatch(text, /run:[^\n]*\$\{\{\s*inputs\./);
});

test('validated exact source is built and clean-container verified before same-run attachment', () => {
  const text = workflow();
  const preflight = job(text, 'preflight', 'build');
  const build = job(text, 'build', 'attach');
  const attach = job(text, 'attach');
  assert.match(preflight, /scripts\/linux-release-preflight\.mjs/);
  assert.match(build, /needs: preflight/);
  assert.match(build, /ref: \$\{\{ needs\.preflight\.outputs\.source_sha \}\}\n\s+path: source/);
  assert.match(build, /working-directory: source\n\s+run: npm ci/);
  assert.match(build, /working-directory: source\n\s+run: npm run app:build/);
  for (const dependency of ['pkg-config', 'libdbus-1-dev', 'libwebkit2gtk-4.1-dev', 'libxdo-dev', 'libssl-dev', 'libayatana-appindicator3-dev', 'librsvg2-dev', 'libsecret-1-dev', 'libfuse2', 'xvfb', 'dbus-x11']) assert.ok(build.includes(dependency), dependency);
  assert.match(build, /source\/src-tauri\/target\/release\/bundle\/deb\/Quorb_\$\{RELEASE_VERSION\}_amd64\.deb/);
  assert.match(build, /source\/src-tauri\/target\/release\/bundle\/appimage\/Quorb_\$\{RELEASE_VERSION\}_amd64\.AppImage/);
  assert.match(build, /docker build -t quorb-build-verify \.testcontainer/);
  assert.match(build, /docker run --rm -v "\$BUNDLE_DIR:\/artifacts" --platform linux\/amd64 quorb-build-verify/);
  assert.match(build, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(attach, /needs: \[preflight, build\]/);
  assert.match(attach, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(attach, /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact_id \}\}/);
  assert.match(attach, /run: node scripts\/linux-release-attach\.mjs/);
  assert.equal((attach.match(/^\s+run:/gm) ?? []).length, 1, 'attach job cannot invoke another publisher');
  assert.doesNotMatch(text, /gh release|gh api|git tag|git push|\/git\/refs|latest\.json|release body|--clobber|continue-on-error/);
});

test('Tauri naming configuration and npm test wiring agree with the release contract', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(config.productName, 'Quorb');
  assert.equal(config.version, '../package.json');
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['linux-release-workflow', 'linux-release-preflight', 'linux-release-attach']) {
    assert.ok(pkg.scripts.test.includes(`scripts/${name}.test.mjs`), name);
  }
});

test('Linux release documentation explains the operator and user caveats', () => {
  const text = read('docs/release-linux.md');
  for (const expression of [/workflow_dispatch|Actions/i, /\bversion\b/, /\bsource_sha\b/, /\.deb/, /\.AppImage/, /\.sha256/, /main/, /manual/i, /latest\.json/, /libfuse2/i, /desktop/i, /recommend/i]) assert.match(text, expression);
});

test('job-level env uses only contexts GitHub allows there', () => {
  // GitHub rejects `runner`, `steps`, `job` and `env` in `jobs.<id>.env`; the
  // workflow would fail to load before any job runs.
  const text = workflow();
  const blocks = [...text.matchAll(/\n    env:\n((?: {6}[^\n]*\n)+)/g)];
  assert.ok(blocks.length > 0);
  for (const block of blocks) assert.doesNotMatch(block[1], /\$\{\{\s*(runner|steps|job|env)\./, block[1]);
});
