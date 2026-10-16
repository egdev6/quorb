import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync as execute } from 'node:child_process';
import { buildPreviewManifest, verifyPreviewReadback } from './macos-preview-policy.mjs';
import { verifyMacosBundle } from './verify-macos-bundle.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const failure = 'Preview artifact rejected';
function artifact(mode, { root = projectRoot, env = process.env, io = fs,
  execFileSync = execute, verifyBundle = verifyMacosBundle } = {}) {
  try {
    root = path.resolve(root);
    const sourceSha = env.PREVIEW_SOURCE_SHA, version = env.PREVIEW_VERSION;
    const canonical = (dmgName, sha256, size) => buildPreviewManifest({ version, sourceSha, dmgName, sha256, size });
    canonical('probe.dmg', '0'.repeat(64), 1);
    if (env.GITHUB_REPOSITORY !== 'egdev6/quorb' || env.GITHUB_REF !== 'refs/heads/main' ||
        env.GITHUB_SHA !== sourceSha) throw new Error();
    function checked(target, kind) {
      const relative = path.relative(root, target);
      const segments = relative ? relative.split(path.sep) : [];
      if (path.isAbsolute(relative) || segments.includes('..')) throw new Error();
      let current = root;
      for (let index = 0; index <= segments.length; index++) {
        if (index) current = path.join(current, segments[index - 1]);
        const stat = io.lstatSync(current);
        const directory = index < segments.length || kind === 'directory';
        if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error();
      }
      return target;
    }
    const read = (target) => io.readFileSync(checked(target, 'file'));
    if (JSON.parse(read(path.join(root, 'package.json')))?.version !== version) throw new Error();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
    if (head !== sourceSha) throw new Error();
    const target = checked(path.join(root, 'src-tauri', 'target'), 'directory');
    const upload = path.join(target, 'macos-preview-upload');
    const download = path.join(target, 'macos-preview-download');
    const readme = read(path.join(root, 'docs', 'macos-preview-README.md'));
    if (mode === 'stage') {
      const run = (command, args) => execFileSync(command, args, {
        cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const report = verifyBundle({ root, sourceSha, io, run });
      if (report.sourceSha !== sourceSha || report.version !== version || report.arch !== 'arm64' ||
          report.minimumSystemVersion !== '15.0') throw new Error();
      const bundle = path.join(target, 'release', 'bundle');
      if (!path.isAbsolute(report.dmg)) throw new Error();
      const relative = path.relative(bundle, report.dmg);
      if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error();
      // Validate the basename before consuming an injected verifier's path.
      canonical(path.basename(report.dmg), report.dmgSha256, 1);
      const bytes = read(report.dmg);
      const manifest = canonical(path.basename(report.dmg), report.dmgSha256, bytes.byteLength);
      verifyPreviewReadback(manifest, manifest, bytes);
      // Existing parents were checked; mkdir is exclusive, never recursive or a cleanup.
      io.mkdirSync(upload);
      for (const [name, data] of [[manifest.dmg.name, bytes], ['manifest.json', JSON.stringify(manifest)], ['README.md', readme]]) {
        io.writeFileSync(path.join(upload, name), data, { flag: 'wx' });
      }
    } else {
      function load(directory) {
        checked(directory, 'directory');
        const manifest = JSON.parse(read(path.join(directory, 'manifest.json')));
        const expected = canonical(manifest.dmg.name, manifest.dmg.sha256, manifest.dmg.size);
        const names = io.readdirSync(directory).sort();
        if (JSON.stringify(names) !== JSON.stringify([expected.dmg.name, 'manifest.json', 'README.md'].sort())) throw new Error();
        const bytes = read(path.join(directory, expected.dmg.name));
        verifyPreviewReadback(expected, manifest, bytes);
        if (!read(path.join(directory, 'README.md')).equals(readme)) throw new Error();
        return { manifest, bytes };
      }
      const expected = load(upload), actual = load(download);
      verifyPreviewReadback(expected.manifest, actual.manifest, actual.bytes);
    }
    return { sourceSha, version };
  } catch {
    // Do not leak local paths, child stderr or injected exception payloads.
    throw new Error(failure);
  }
}
export function stagePreview(options) { return artifact('stage', options); }
export function readbackPreview(options) { return artifact('readback', options); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !['stage', 'readback'].includes(mode)) throw new Error();
    console.log(JSON.stringify(mode === 'stage' ? stagePreview() : readbackPreview()));
  } catch {
    console.error(failure);
    process.exitCode = 1;
  }
}
