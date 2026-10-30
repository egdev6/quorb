import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = '.github/security-drafts/macos-release.yml';
const active = '.github/workflows/macos-release.yml';
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url));
// Exact reviewed text, not a general-purpose YAML parser. Both job boundaries,
// every step and all secret references are part of this allowlist.
const expected = String.raw`name: macOS signed release

on:
  workflow_dispatch:
    inputs:
      version:
        description: Exact stable version of the existing Windows release
        required: true
        type: string
      source_sha:
        description: Full lowercase SHA of that release, ancestor of main
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: macos-release
  cancel-in-progress: false

jobs:
  preflight:
    name: Validate release before signing approval
    if: github.ref == 'refs/heads/main'
    runs-on: macos-15
    timeout-minutes: 5
    outputs:
      source_sha: \${{ steps.validate.outputs.sourceSha }}
      version: \${{ steps.validate.outputs.version }}
      release_id: \${{ steps.validate.outputs.releaseId }}
    steps:
      - name: Checkout trusted workflow source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Node 22
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1
        with:
          node-version: 22
          package-manager-cache: false

      - name: Validate existing release
        id: validate
        env:
          RELEASE_VERSION: \${{ inputs.version }}
          RELEASE_SOURCE_SHA: \${{ inputs.source_sha }}
          GH_TOKEN: \${{ github.token }}
        run: |
          node --input-type=module <<'NODE'
          import { appendFileSync } from 'node:fs';
          import { preflightRelease } from './scripts/macos-release-preflight.mjs';
          const result = await preflightRelease();
          for (const [key, value] of Object.entries(result)) {
            appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n');
          }
          NODE

  signing:
    name: Sign, notarize and attach macOS ARM64 DMG
    needs: preflight
    if: github.ref == 'refs/heads/main'
    environment: macos-signing
    runs-on: macos-15
    timeout-minutes: 120
    permissions:
      contents: write
    env:
      RELEASE_VERSION: \${{ needs.preflight.outputs.version }}
      RELEASE_SOURCE_SHA: \${{ needs.preflight.outputs.source_sha }}
      RELEASE_ID: \${{ needs.preflight.outputs.release_id }}
    steps:
      - name: Checkout trusted verification tools
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Checkout validated build source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: \${{ needs.preflight.outputs.source_sha }}
          path: source
          persist-credentials: false

      - name: Node 22
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1
        with:
          node-version: 22
          package-manager-cache: false

      - name: Rust stable
        uses: dtolnay/rust-toolchain@89b12181fb390509a0842a86cc55eeb8eb928c1d
        with:
          toolchain: stable

      - name: Require native ARM64 toolchains
        run: |
          set -euo pipefail
          test "$(uname -m)" = arm64
          test "$(node -p process.arch)" = arm64
          rustc -vV | grep -Fx 'host: aarch64-apple-darwin'

      - name: Install locked dependencies
        working-directory: source
        run: npm ci

      - name: Write private notarization key
        env:
          APPLE_API_KEY_P8: \${{ secrets.APPLE_API_KEY_P8 }}
          APPLE_API_KEY_PATH: \${{ runner.temp }}/quorb-notary-\${{ github.run_id }}-\${{ github.run_attempt }}.p8
        run: |
          node --input-type=module <<'NODE'
          import { writeFileSync } from 'node:fs';
          const key = process.env.APPLE_API_KEY_P8;
          if (!key || !key.trim()) throw new Error('Missing notarization key');
          writeFileSync(process.env.APPLE_API_KEY_PATH, key, { mode: 0o600, flag: 'wx' });
          NODE

      - name: Build, sign, notarize and staple
        working-directory: source
        env:
          APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: \${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: \${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_API_ISSUER: \${{ secrets.APPLE_API_ISSUER }}
          APPLE_API_KEY: \${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_PATH: \${{ runner.temp }}/quorb-notary-\${{ github.run_id }}-\${{ github.run_attempt }}.p8
        run: |
          set -euo pipefail
          test -n "$APPLE_CERTIFICATE"
          test -n "$APPLE_CERTIFICATE_PASSWORD"
          test -n "$APPLE_SIGNING_IDENTITY"
          test -n "$APPLE_API_ISSUER"
          test -n "$APPLE_API_KEY"
          npm run app:build:mac
          dmg="src-tauri/target/release/bundle/dmg/Quorb_\${RELEASE_VERSION}_aarch64.dmg"
          xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
          xcrun stapler staple "$dmg"

      - name: Remove private notarization key
        if: always()
        env:
          APPLE_API_KEY_PATH: \${{ runner.temp }}/quorb-notary-\${{ github.run_id }}-\${{ github.run_attempt }}.p8
        run: |
          node --input-type=module <<'NODE'
          import { unlinkSync } from 'node:fs';
          try { unlinkSync(process.env.APPLE_API_KEY_PATH); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          NODE

      - name: Verify signed app and stapled DMG, then hash final bytes
        run: |
          node --input-type=module <<'NODE'
          import path from 'node:path';
          import { writeFileSync } from 'node:fs';
          import { execFileSync, spawnSync } from 'node:child_process';
          import { verifyMacosBundle } from './scripts/verify-macos-bundle.mjs';
          const result = verifyMacosBundle({ root: path.resolve('source'), sourceSha: process.env.RELEASE_SOURCE_SHA });
          const expected = path.resolve('source/src-tauri/target/release/bundle/dmg', 'Quorb_' + process.env.RELEASE_VERSION + '_aarch64.dmg');
          if (result.version !== process.env.RELEASE_VERSION || result.dmg !== expected) throw new Error('Unexpected release bundle');
          const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', timeout: 120000 });
          run('codesign', ['--verify', '--deep', '--strict', result.app]);
          const signature = spawnSync('codesign', ['-dv', '--verbose=4', result.app], { encoding: 'utf8', timeout: 120000 });
          if (signature.error || signature.status !== 0 ||
              !/^Authority=Developer ID Application: .+ \(SRD8T33RU5\)$/m.test(signature.stderr) ||
              !/^TeamIdentifier=SRD8T33RU5$/m.test(signature.stderr)) throw new Error('Unexpected Developer ID authority or team');
          console.log(signature.stderr);
          run('spctl', ['--assess', '--type', 'execute', result.app]);
          run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', result.dmg]);
          run('xcrun', ['stapler', 'validate', result.dmg]);
          writeFileSync(result.dmg + '.sha256', result.dmgSha256 + '  ' + path.basename(result.dmg) + '\n', { flag: 'wx' });
          NODE

      - name: Revalidate release and upload only DMG and SHA-256 without overwrite
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          node --input-type=module <<'NODE'
          import { preflightRelease } from './scripts/macos-release-preflight.mjs';
          const result = await preflightRelease();
          if (String(result.releaseId) !== process.env.RELEASE_ID) throw new Error('Release identity changed');
          NODE
          dmg="source/src-tauri/target/release/bundle/dmg/Quorb_\${RELEASE_VERSION}_aarch64.dmg"
          name="\${dmg##*/}"
          dmg_id="$(gh api --method POST -H 'Content-Type: application/x-apple-diskimage' "https://uploads.github.com/repos/egdev6/quorb/releases/$RELEASE_ID/assets?name=$name" --input "$dmg" --jq .id)"
          if ! [[ "$dmg_id" =~ ^[0-9]+$ ]]; then
            echo "::error::DMG upload returned a non-numeric asset id; deleting nothing."
            exit 1
          fi
          if ! gh api --method POST -H 'Content-Type: text/plain' "https://uploads.github.com/repos/egdev6/quorb/releases/$RELEASE_ID/assets?name=$name.sha256" --input "$dmg.sha256" --jq .id; then
            echo "::error::SHA-256 upload failed; removing only the DMG this run uploaded."
            if ! gh api --method DELETE "repos/egdev6/quorb/releases/assets/$dmg_id"; then
              echo "::error::Rollback failed; manual cleanup needed for $name (asset id $dmg_id)."
              exit 1
            fi
            exit 1
          fi
`.replaceAll('\\${', '${');

function assertContract(draft, workflow, pkg) {
  assert.deepEqual(workflow, draft, 'Materialization must be byte-identical');
  assert.equal(draft.toString('utf8').replace(/\r\n/g, '\n'), expected);
  assert.ok(pkg.scripts.test.includes('scripts/macos-release-preflight.test.mjs'));
  assert.ok(pkg.scripts.test.includes('scripts/macos-release-workflow.test.mjs'));
  assert.equal(pkg.scripts['app:build:mac'], 'tauri build --config src-tauri/tauri.macos.conf.json');
}
const pkg = () => JSON.parse(read('package.json'));

test('real signed release workflow is exactly the reviewed source and has npm test wiring', () => {
  assertContract(read(source), read(active), pkg());
});

test('pure exact workflow contract accepts reviewed LF and matching CRLF bytes', () => {
  for (const text of [expected, expected.replaceAll('\n', '\r\n')]) {
    assertContract(Buffer.from(text), Buffer.from(text), pkg());
  }
});

test('rejects mutations to every reviewed line, step order and byte materialization', () => {
  const bytes = Buffer.from(expected);
  for (const [index, line] of expected.split('\n').entries()) {
    if (!line.trim()) continue;
    const lines = expected.split('\n');
    lines.splice(index, 1);
    const changed = Buffer.from(lines.join('\n'));
    assert.throws(() => assertContract(changed, changed, pkg()), undefined, `Removed line: ${line}`);
  }
  const mutations = [
    ['workflow_dispatch:', 'pull_request_target:'], ['contents: read', 'contents: write'],
    ['needs: preflight', 'needs: []'], ['environment: macos-signing', 'environment: production'],
    ['timeout-minutes: 120', 'timeout-minutes: 45'], ['timeout-minutes: 5\n', 'timeout-minutes: 120\n'],
    ['persist-credentials: false', 'persist-credentials: true'], ['macos-15', 'macos-latest'],
    ['node-version: 22', 'node-version: 24'], ['if: always()', 'if: success()'],
    ['run: npm ci', 'continue-on-error: true\n        run: npm ci'],
    ['run: npm ci', 'if: always()\n        run: npm ci'],
    ['run: npm ci', 'run: echo ${{ inputs.version }}'],
    ['    env:\n', '    env:\n      APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}\n'],
    ['--input "$dmg"', '--clobber --input "$dmg"'],
    ['"$dmg.sha256"', '"$dmg.sha256" latest.json'], ['SRD8T33RU5', 'OTHERTEAM1'],
    ['--strict', '--verbose'], ['stapler\', \'validate', 'stapler\', \'staple'],
    ['--wait', '--no-wait'], ["flag: 'wx'", "flag: 'w'"],
    ['gh api --method DELETE "repos/egdev6/quorb/releases/assets/$dmg_id"', 'gh release delete-asset "v$RELEASE_VERSION" "$name" --repo egdev6/quorb --yes'],
    ['releases/assets/$dmg_id', 'releases/assets/$sha_id'],
    ['releases/assets/$dmg_id', 'releases/assets/12345'],
    ['[[ "$dmg_id" =~ ^[0-9]+$ ]]', 'true'],
    ['releases/assets/$dmg_id"; then', 'releases/assets/$dmg_id" || true; then'],
    ['manual cleanup needed for $name (asset id $dmg_id).', 'cleanup succeeded.'],
  ];
  for (const pin of expected.matchAll(/uses: (\S+)/g)) mutations.push([pin[1], pin[1].replace(/@.*/, '@main')]);
  for (const [before, after] of mutations) {
    assert.ok(expected.includes(before), `Mutation must apply: ${before}`);
    const changed = Buffer.from(expected.replace(before, after));
    assert.throws(() => assertContract(changed, changed, pkg()), undefined, before);
  }
  const checksumUpload = 'gh api --method POST -H \'Content-Type: text/plain\' "https://uploads.github.com/repos/egdev6/quorb/releases/$RELEASE_ID/assets?name=$name.sha256" --input "$dmg.sha256" --jq .id';
  const rollbackStart = expected.indexOf(`          if ! ${checksumUpload}; then\n`);
  assert.ok(rollbackStart >= 0, 'Rollback removal mutation must apply');
  const rollback = expected.slice(rollbackStart);
  assert.ok(rollback.includes('gh api --method DELETE'), 'Rollback mutation must remove the DELETE');
  const changedRollback = expected.replace(rollback, `          ${checksumUpload}\n`);
  assert.notEqual(changedRollback, expected, 'Rollback removal mutation must change the workflow');
  assert.throws(() => assertContract(Buffer.from(changedRollback), Buffer.from(changedRollback), pkg()), undefined, 'Removed rollback branch');
  const revalidation = `          node --input-type=module <<'NODE'
          import { preflightRelease } from './scripts/macos-release-preflight.mjs';
          const result = await preflightRelease();
          if (String(result.releaseId) !== process.env.RELEASE_ID) throw new Error('Release identity changed');
          NODE
`;
  assert.ok(expected.includes(revalidation), 'Upload order mutation must apply');
  const uploadBeforeRevalidation = expected.replace(revalidation, '') + revalidation;
  assert.notEqual(uploadBeforeRevalidation, expected, 'Upload order mutation must change the workflow');
  assert.throws(() => assertContract(Buffer.from(uploadBeforeRevalidation), Buffer.from(uploadBeforeRevalidation), pkg()), undefined, 'Upload order changed');
  assert.ok(expected.includes('          npm run app:build:mac\n'), 'Build order mutation must remove the build');
  assert.ok(expected.includes('          xcrun stapler staple "$dmg"'), 'Build order mutation must find stapling');
  const swapped = expected.replace('          npm run app:build:mac\n', '').replace('          xcrun stapler staple "$dmg"', '          xcrun stapler staple "$dmg"\n          npm run app:build:mac');
  assert.notEqual(swapped, expected, 'Build order mutation must change the workflow');
  assert.throws(() => assertContract(Buffer.from(swapped), Buffer.from(swapped), pkg()));
  assert.throws(() => assertContract(bytes, Buffer.from(expected.replaceAll('\n', '\r\n')), pkg()));
  assert.throws(() => assertContract(bytes, Buffer.from(expected + '\n'), pkg()));
  for (const name of ['scripts/macos-release-preflight.test.mjs', 'scripts/macos-release-workflow.test.mjs']) {
    const changed = pkg(); changed.scripts.test = changed.scripts.test.replace(name, '');
    assert.throws(() => assertContract(bytes, bytes, changed));
  }
});
