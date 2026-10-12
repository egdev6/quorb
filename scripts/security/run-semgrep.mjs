// DRAFT Unit 2 slice — trusted offline Semgrep orchestration (library, no CLI).
// Scope: Git-only snapshot of a target commit plus the pinned Semgrep CE runtime
// executed inside a locked-down local Docker container. This module never imports
// or executes target-repository code and performs no network I/O of its own. Raw
// scanner stdout is captured into a bounded in-memory buffer, normalized to
// rule/path/line advisories, and never printed: scanner logs may contain secrets.
//
// Trusted inputs (rules, lock, Python entrypoint) are resolved relative to this
// module — the trusted runner — never from the target repository. lock bytes must
// match LOCK_SHA. Explicit flat `/inputs/<name>` paths come from the exporter's
// independent inventory, never from scanner output.
//
// Runtime assumptions NOT verified by this slice (parent must confirm on a real
// Linux daemon): Docker CLI on PATH, pinned image already present locally
// (--pull=never), wheelhouse holds exactly the locked wheels, non-root uid/gid,
// and the create/start --attach/rm -f sequence leaves no container behind.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSnapshot as defaultExportSnapshot } from './export-snapshot.mjs';
import { normalizeSnapshotReport } from './snapshot-report.mjs';

const IMAGE = 'docker.io/library/python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d';
const LOCK_SHA = '5dee77d1a53b22acae3c3429f2c3adef01e7bc5994ae80146fa1f03078da211f';
const HERE = dirname(fileURLToPath(import.meta.url));
const TRUSTED = {
  rules: resolve(HERE, '../../.github/security/semgrep.yml'),
  lock: resolve(HERE, '../../.github/security-drafts/semgrep-linux-py312.lock'),
  entry: join(HERE, 'semgrep-entry.py'),
  gate: join(HERE, 'semgrep-parse-gate.py'),
};
const CREATE_TIMEOUT_MS = 30_000;
const SCAN_TIMEOUT_MS = 600_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MOUNT_BREAK = /[,\r\n]/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const fail = (stage) => { throw new Error(`semgrep-run-failed:${stage}`); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function mountPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || MOUNT_BREAK.test(value)) fail('mount-path');
  return value;
}

function wheelhousePath(value) {
  mountPath(value);
  let info;
  try { info = statSync(value); } catch { fail('wheelhouse'); }
  if (!info.isDirectory()) fail('wheelhouse');
  return value;
}

function readBytes(path, stage) {
  try { return readFileSync(path); } catch { fail(stage); }
}

function writeControl(dir, name, bytes) {
  try { writeFileSync(join(dir, name), bytes, { flag: 'wx', mode: 0o400 }); } catch { fail('control'); }
}

function removeDir(path) {
  try { rmSync(path, { recursive: true, force: true }); return true; } catch { return false; }
}

function call(execute, args, timeout, maxBuffer) {
  try { return execute('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { shell: false, encoding: 'utf8', timeout, maxBuffer }) ?? {}; }
  catch { return { error: true }; }
}

const succeeded = (result) => result.error === undefined && result.status === 0;

function snapshotFingerprint(inventory, verifyInventory) {
  return inventory.targets.map((target) => {
    let bytes;
    try { bytes = readFileSync(target.path); } catch { fail('snapshot-hash'); }
    const digest = sha256(bytes);
    // The initial read must match the exporter's independent claim; later reads only
    // need to prove the bytes did not change while the scanner was running.
    if (verifyInventory && digest !== target.sha256) fail('snapshot-hash');
    return `${target.path}\0${digest}`;
  }).join('\n');
}

function createArgs({ name, wheelhouse, snapshot, control, uid, gid }) {
  return [
    'create', '--name', name,
    '--pull=never',
    '--platform', 'linux/amd64',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '2g',
    '--cpus', '2',
    '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1073741824,mode=1777',
    '--mount', `type=bind,src=${mountPath(wheelhouse)},dst=/wheels,readonly`,
    '--mount', `type=bind,src=${mountPath(snapshot)},dst=/inputs,readonly`,
    '--mount', `type=bind,src=${mountPath(control)},dst=/control,readonly`,
    '--workdir', '/tmp',
    '--env', 'HOME=/tmp',
    '--env', 'SEMGREP_SEND_METRICS=off',
    '--env', 'SEMGREP_ENABLE_VERSION_CHECK=0',
    '--env', 'PIP_NO_INDEX=1',
    '--env', 'PIP_DISABLE_PIP_VERSION_CHECK=1',
    '--log-driver=none',
    IMAGE,
    'python', '/control/runner.py',
  ];
}

function removeContainer(execute, name) {
  const result = call(execute, ['rm', '-f', name], CLEANUP_TIMEOUT_MS, 1024 * 1024);
  // A container may be absent when a timed-out create never materialized; that is
  // still a clean state. Any other failure is an operational cleanup failure.
  return succeeded(result) || /no such container/i.test(String(result.stderr ?? ''));
}

// Profiles are trusted constants selected by these wrappers, never by target data.
export const runSemgrep = (input, deps) => runScanner(input, deps);

function runScanner(input, deps = {}) {
  const exportSnapshot = deps.exportSnapshot ?? defaultExportSnapshot;
  const execute = deps.execute ?? spawnSync;
  const rulesPath = deps.rulesPath ?? TRUSTED.rules;
  const lockPath = deps.lockPath ?? TRUSTED.lock;
  const entryPath = deps.entrypointPath ?? TRUSTED.entry;
  const lockHash = LOCK_SHA;
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const gid = deps.gid ?? (typeof process.getgid === 'function' ? process.getgid() : undefined);

  let inventory;
  let control;
  let name;
  let report;
  let failure;
  let cleanupFailed = false;
  try {
    if (!input || typeof input !== 'object') fail('input');
    const { repo, commit, wheelhouse, parent } = input;
    if (typeof repo !== 'string' || repo.length === 0 || typeof parent !== 'string' || parent.length === 0) fail('input');
    if (typeof commit !== 'string' || !COMMIT_SHA.test(commit)) fail('input');
    wheelhousePath(wheelhouse);
    if (platform !== 'linux') fail('platform');
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) fail('uid');

    const rules = readBytes(rulesPath, 'trusted-files');
    const lock = readBytes(lockPath, 'trusted-lock');
    const entry = readBytes(entryPath, 'trusted-files');
    const gate = readBytes(TRUSTED.gate, 'trusted-files');
    if (rules.length === 0 || entry.length === 0 || gate.length === 0) fail('trusted-files');
    if (sha256(lock) !== lockHash) fail('trusted-lock');

    try { inventory = exportSnapshot({ repo, commit, parent, scope: 'js-ts' }); } catch { fail('snapshot'); }
    try { control = mkdtempSync(join(resolve(parent), 'semgrep-control-')); } catch { fail('control'); }

    // Copy trusted rules/lock/entrypoint into a fresh control dir mounted read-only.
    // targets.json is generated from the independent inventory, mapping flat export
    // names to /inputs/<basename>; the scanner can never redefine this coverage.
    writeControl(control, 'rules.yml', rules);
    writeControl(control, 'requirements.lock', lock);
    writeControl(control, 'runner.py', entry);
    writeControl(control, 'parse_gate.py', gate);
    const targets = { targets: inventory.targets.map((t) => ({ path: `/inputs/${basename(t.path)}`, originalPath: t.originalPath, sha256: t.sha256 })) };
    writeControl(control, 'targets.json', Buffer.from(JSON.stringify(targets)));

    const controlFingerprint = () => ['rules.yml', 'requirements.lock', 'runner.py', 'targets.json', 'parse_gate.py']
      .map(file => sha256(readBytes(join(control, file), 'control-hash'))).join(':');
    const beforeControl = controlFingerprint();
    const beforeSnapshot = snapshotFingerprint(inventory, true);

    name = `quorb-semgrep-${randomUUID()}`;
    const create = call(execute, createArgs({ name, wheelhouse, snapshot: inventory.root, control, uid, gid }), CREATE_TIMEOUT_MS, 1024 * 1024);
    if (!succeeded(create)) fail('docker-create');
    const start = call(execute, ['start', '--attach', name], SCAN_TIMEOUT_MS, MAX_REPORT_BYTES);
    if (!succeeded(start) || typeof start.stdout !== 'string') fail('scanner');
    if (controlFingerprint() !== beforeControl
      || snapshotFingerprint(inventory, false) !== beforeSnapshot) fail('tamper');

    let parsed;
    try { parsed = JSON.parse(start.stdout); } catch { fail('report'); }
    try { report = normalizeSnapshotReport(parsed, inventory); } catch { fail('report'); }
  } catch (error) {
    failure = error;
  } finally {
    // The container name is chosen before create so an uncertain create is still
    // covered by the same unique name; cleanup runs on every exit path. Cleanup
    // failure is operational and can never produce a green result.
    if (name && !removeContainer(execute, name)) cleanupFailed = true;
    if (control && !removeDir(control)) cleanupFailed = true;
    if (inventory && inventory.root && !removeDir(inventory.root)) cleanupFailed = true;
  }
  if (cleanupFailed) fail('cleanup');
  if (failure) throw failure;
  return report;
}
