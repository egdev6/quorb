import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(verifyMacosBundle(), null, 2));
  } catch (error) {
    console.error(`macOS bundle verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
