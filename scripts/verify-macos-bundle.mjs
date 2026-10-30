import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000 });

function parseMetadata(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid bundle metadata JSON');
  }
}

export function verifyMacosBundle({ root = projectRoot, sourceSha = process.env.GITHUB_SHA, io = fs, run = execute } = {}) {
  if (!/^[a-fA-F0-9]{40}$/.test(sourceSha ?? '')) throw new Error('Invalid source SHA (40 hex required)');
  root = path.resolve(root);
  function checked(target, kind) {
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escape');
    const segments = relative ? relative.split(path.sep) : [];
    let current = root;
    for (let i = 0; i <= segments.length; i++) {
      if (i) current = path.join(current, segments[i - 1]);
      const stat = io.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Forbidden symlink: ${current}`);
      const expected = i === segments.length ? kind : 'directory';
      if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Expected ${expected}: ${current}`);
    }
    return target;
  }
  const bundle = checked(path.join(root, 'src-tauri/target/release/bundle'), 'directory');
  const apps = [];
  const dmgs = [];
  function discover(directory) {
    for (const name of io.readdirSync(directory)) {
      const target = path.join(directory, name);
      const stat = io.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`Forbidden symlink: ${target}`);
      if (stat.isDirectory()) {
        if (name.endsWith('.app')) apps.push(target);
        else discover(target);
      } else if (name.endsWith('.dmg')) dmgs.push(checked(target, 'file'));
    }
  }
  discover(bundle);
  if (apps.length !== 1 || dmgs.length !== 1) throw new Error('Expected exactly one .app and one .dmg');
  const plistPath = checked(path.join(apps[0], 'Contents/Info.plist'), 'file');
  const plist = parseMetadata(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]));
  const pkg = parseMetadata(io.readFileSync(checked(path.join(root, 'package.json'), 'file'), 'utf8'));
  if (typeof pkg.version !== 'string' || plist.CFBundleShortVersionString !== pkg.version) throw new Error('Bundle version mismatch');
  if (plist.CFBundleIdentifier !== 'es.egdev.quorb') throw new Error('Bundle identifier mismatch');
  const config = parseMetadata(io.readFileSync(checked(path.join(root, 'src-tauri/tauri.macos.conf.json'), 'file'), 'utf8'));
  const minimumSystemVersion = config?.bundle?.macOS?.minimumSystemVersion;
  if (minimumSystemVersion !== '15.0' || plist.LSMinimumSystemVersion !== minimumSystemVersion) {
    throw new Error('Bundle minimum macOS version mismatch (expected 15.0)');
  }
  const executable = plist.CFBundleExecutable;
  if (typeof executable !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executable)) throw new Error('Unsafe executable name');
  const binary = io.readFileSync(checked(path.join(apps[0], 'Contents/MacOS', executable), 'file'));
  // A thin, little-endian 64-bit ARM executable, not x86_64 or a universal container.
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf ||
      binary.readUInt32LE(4) !== 0x0100000c || binary.readUInt32LE(12) !== 2) throw new Error('Expected native arm64 Mach-O executable');
  run('/usr/bin/hdiutil', ['verify', dmgs[0]]);
  return {
    sourceSha, version: pkg.version, arch: 'arm64', minimumSystemVersion, app: apps[0], dmg: dmgs[0],
    dmgSha256: createHash('sha256').update(io.readFileSync(dmgs[0])).digest('hex'),
  };
}

const securityCommand = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('macOS verification command failed');
  return result.stdout + result.stderr;
};

export function verifyDeveloperSignature(target, { run = securityCommand } = {}) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  const signature = run('/usr/bin/codesign', ['-dv', '--verbose=4', target]);
  if (!/^Authority=Developer ID Application: .+ \(SRD8T33RU5\)$/m.test(signature) ||
      !/^TeamIdentifier=SRD8T33RU5$/m.test(signature)) throw new Error('Unexpected Developer ID authority or team');
}

export function validateMountEntities(plist, mount) {
  const entities = plist?.['system-entities'];
  if (!Array.isArray(entities) || !entities.length || entities.length > 32 ||
      entities.some((entity) => !entity || typeof entity !== 'object' || Array.isArray(entity) ||
        typeof entity['dev-entry'] !== 'string' || !/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(entity['dev-entry']))) {
    throw new Error('Invalid mounted DMG entities');
  }
  const volumes = entities.filter((entity) => Object.hasOwn(entity, 'mount-point'));
  if (volumes.length !== 1 || volumes[0]['mount-point'] !== mount) throw new Error('Unexpected mounted DMG volume');
  return volumes[0];
}

export function verifyMountedApp({ mount, version, io = fs, run = securityCommand }) {
  if (!path.isAbsolute(mount) || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? '')) throw new Error('Invalid mounted app context');
  function checked(target, directory = false) {
    const relative = path.relative(mount, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Mounted app path escape');
    let current = mount;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      current = segment ? path.join(current, segment) : current;
      const stat = io.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Mounted app symlink');
      if (current !== target && !stat.isDirectory()) throw new Error('Mounted app parent not directory');
    }
    const stat = io.lstatSync(target);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Invalid mounted app file type');
    return target;
  }
  checked(mount, true);
  const apps = [];
  function scan(directory, insideApp = false) {
    for (const name of io.readdirSync(directory)) {
      const target = path.join(directory, name);
      const stat = io.lstatSync(target);
      if (stat.isSymbolicLink()) {
        // Standard drag-to-Applications shortcut, never followed or verified as code.
        if (!insideApp && target === path.join(mount, 'Applications') && io.readlinkSync(target) === '/Applications') continue;
        throw new Error('Unexpected mounted DMG symlink');
      }
      if (name.endsWith('.app')) {
        if (!stat.isDirectory()) throw new Error('Invalid mounted app');
        apps.push(target);
      }
      if (stat.isDirectory()) scan(target, insideApp || name.endsWith('.app'));
      else if (!stat.isFile()) throw new Error('Unexpected mounted DMG file type');
    }
  }
  scan(mount);
  const app = path.join(mount, 'Quorb.app');
  if (apps.length !== 1 || apps[0] !== app) throw new Error('Expected only contained Quorb.app');
  checked(app, true);
  const metadata = parseMetadata(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', checked(path.join(app, 'Contents/Info.plist'))]));
  if (metadata.CFBundleIdentifier !== 'es.egdev.quorb' || metadata.CFBundleShortVersionString !== version || metadata.LSMinimumSystemVersion !== '15.0') {
    throw new Error('Mounted app identifier/version/minimum macOS mismatch');
  }
  const executable = metadata.CFBundleExecutable;
  if (typeof executable !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executable)) throw new Error('Unsafe mounted executable');
  const binary = io.readFileSync(checked(path.join(app, 'Contents/MacOS', executable)));
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c || binary.readUInt32LE(12) !== 2) {
    throw new Error('Expected mounted native arm64 Mach-O executable');
  }
  verifyDeveloperSignature(app, { run });
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  return app;
}

// No build, re-sign, app staple, repackaging or execution. Only the retained outer
// DMG is mutated. Gatekeeper/network failures fail closed, including during cleanup.
export function stapleAndVerifyDmg({ dmg, version, inputSha256, temp = process.env.RUNNER_TEMP, io = fs, run = securityCommand,
  parsePlist = (text) => JSON.parse(execFileSync('python3', ['-c', 'import plistlib,json,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], {
    input: text, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  })) }) {
  if (!path.isAbsolute(temp ?? '') || io.lstatSync(dmg).isSymbolicLink() || !io.lstatSync(dmg).isFile()) throw new Error('Unsafe retained DMG');
  const before = createHash('sha256').update(io.readFileSync(dmg)).digest('hex');
  if (before !== inputSha256) throw new Error('Retained DMG changed before staple');
  run('/usr/bin/hdiutil', ['verify', dmg]);
  verifyDeveloperSignature(dmg, { run });
  run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
  run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
  verifyDeveloperSignature(dmg, { run });
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]);
  const mount = io.mkdtempSync(path.join(temp, 'quorb-notary-mount-'));
  let attempted = false;
  try {
    attempted = true;
    const attached = run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-plist', '-mountpoint', mount, dmg]);
    validateMountEntities(parsePlist(attached), mount);
    verifyMountedApp({ mount, version, io, run });
  } finally {
    // Also try cleanup when attach failed after partially mounting. Detach only
    // our controlled mount point, never an untrusted dev-entry from the image.
    if (attempted) run('/usr/bin/hdiutil', ['detach', mount]);
    io.rmdirSync(mount);
  }
  const finalSha256 = createHash('sha256').update(io.readFileSync(dmg)).digest('hex');
  return { dmg, version, inputSha256, finalSha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(verifyMacosBundle(), null, 2));
  } catch (error) {
    console.error(`macOS bundle verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
