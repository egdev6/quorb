// DRAFT — unit/CLI fixtures verified, not ready for production adoption.
// Narrow policy check, not malware/secret detection. Buffer|null is intentional;
// bidiExceptions must be empty. Image exclusions require exact path/hash; CI adoption pending.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const CF = /\p{Cf}/u;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/u;
const ESC = /[\p{Cc}\p{Cf}]/gu;
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.rs', '.yml', '.yaml', '.json']);
const ROOT_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'dependencies'];
const IMAGE_EXT = new Set(['.png', '.ico', '.icns', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const SYMLINK_MODE = '120000';
const BLOB_MODES = ['100644', '100755', '100664'];
const DECODER = new TextDecoder('utf-8', { fatal: true });

export class OperationalError extends Error {}

const esc = (s) => s.replace(ESC, (c) => '\\u{' + c.codePointAt(0).toString(16).padStart(4, '0') + '}');
const bad = (msg) => { throw new TypeError('policy: ' + msg); };

export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) bad('must be an object');
  const keys = Object.keys(policy).filter(k => k !== 'approvedBinaryImages').sort().join(',');
  if (keys !== 'allowedRootLifecycleHooks,allowedSymlinks,bidiExceptions,maxTextBytes,schemaVersion') bad('unexpected or missing keys');
  if (policy.schemaVersion !== 1 || !Number.isInteger(policy.maxTextBytes) || policy.maxTextBytes < 0) bad('schemaVersion/maxTextBytes invalid');
  for (const key of ['allowedSymlinks', 'allowedRootLifecycleHooks', 'bidiExceptions']) if (!Array.isArray(policy[key]) || policy[key].some((v) => typeof v !== 'string')) bad(key + ' must be an array of strings');
  if (policy.bidiExceptions.length > 0) bad('bidiExceptions are not supported in this draft');
  const images = policy.approvedBinaryImages ?? [];
  if (!Array.isArray(images)) bad('approvedBinaryImages must be an array');
  const paths = new Set();
  for (const image of images) {
    if (!image || typeof image !== 'object' || Object.keys(image).sort().join(',') !== 'path,sha256') bad('invalid image approval');
    if (typeof image.path !== 'string' || image.path.startsWith('/') || image.path.includes('\\') || image.path.includes(':') || image.path.split('/').some(p => !p || p === '.' || p === '..') || !IMAGE_EXT.has(extname(image.path).toLowerCase())) bad('invalid image path');
    if (typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256) || paths.has(image.path)) bad('invalid or duplicate image approval');
    paths.add(image.path);
  }
  return policy;
}

function scanText(text, path, add) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (BIDI.test(lines[i])) add('block', 'bidi-control', path, i + 1);
    else if (CF.test(lines[i])) add('alert', 'cf-format', path, i + 1);
  }
}

function checkHooks(text, path, policy, add) {
  let data;
  try { data = JSON.parse(text); } catch { throw new OperationalError('package.json is not valid JSON'); }
  const scripts = data && typeof data === 'object' ? data.scripts : null;
  if (!scripts || typeof scripts !== 'object') return;
  for (const hook of ROOT_HOOKS) {
    if (typeof scripts[hook] === 'string' && !(path === 'package.json' && policy.allowedRootLifecycleHooks.includes(hook))) add('block', 'lifecycle-hook', path, 0);
  }
}

export function analyze(entries, policy) {
  validatePolicy(policy);
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const findings = [];
  const coverageGaps = [];
  const approvedExclusions = [];
  const add = (severity, id, path, line) => findings.push({ severity, id, path: esc(path), line });
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('entry must be an object');
    const { path, mode, bytes } = entry;
    if (typeof path !== 'string' || path.length === 0) throw new TypeError('entry.path must be a non-empty string');
    if (typeof mode !== 'string') throw new TypeError('entry.mode must be a string');
    if (bytes !== null && !Buffer.isBuffer(bytes)) throw new TypeError('entry.bytes must be a Buffer or null');
    if (BIDI.test(path)) add('block', 'bidi-control-path', path, 0);
    else if (CF.test(path)) add('alert', 'cf-format-path', path, 0);
    if (mode === SYMLINK_MODE) { if (!policy.allowedSymlinks.includes(path)) add('block', 'symlink-not-allowed', path, 0); continue; }
    if (mode === '160000') { add('block', 'gitlink-not-allowed', path, 0); continue; }
    if (!BLOB_MODES.includes(mode)) throw new TypeError('unsupported mode: ' + mode);
    const approval = (policy.approvedBinaryImages ?? []).find(image => image.path === path);
    if (approval && mode === '100644' && bytes !== null && bytes.length <= MAX_IMAGE_BYTES && createHash('sha256').update(bytes).digest('hex') === approval.sha256) {
      approvedExclusions.push({ path: esc(path), sha256: approval.sha256 });
      continue;
    }
    if (approval) add('block', 'image-approval-mismatch', path, 0);
    const isSource = SOURCE_EXT.has(extname(path).toLowerCase());
    if (bytes === null || bytes.length > policy.maxTextBytes) { if (isSource) add('block', 'source-too-large', path, 0); else coverageGaps.push({ path: esc(path), reason: 'large' }); continue; }
    if (bytes.includes(0)) { if (isSource) throw new OperationalError('nul-byte-in-source'); coverageGaps.push({ path: esc(path), reason: 'binary' }); continue; }
    let text;
    try { text = DECODER.decode(bytes); } catch { if (isSource) throw new OperationalError('invalid-utf8-in-source'); coverageGaps.push({ path: esc(path), reason: 'binary' }); continue; }
    scanText(text, path, add);
    if (path === 'package.json' || path.endsWith('/package.json')) checkHooks(text, path, policy, add);
  }
  return { ok: !findings.some((f) => f.severity === 'block') && coverageGaps.length === 0, findings, coverageGaps, approvedExclusions };
}

function parseArgs(argv) {
  const usage = new OperationalError('usage: --repo <path> --policy <path>');
  if (argv.length !== 4 || argv[0] !== '--repo' || argv[2] !== '--policy' || !argv[1] || !argv[3]) throw usage;
  return { repo: argv[1], policyPath: argv[3] };
}

const git = (repo, args) => execFileSync('git', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });

function readSnapshot(repo, policy) {
  const raw = DECODER.decode(git(repo, ['ls-tree', '-rz', '-l', 'HEAD']));
  const entries = [];
  for (const line of raw.split('\0')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    if (tab < 0) throw new OperationalError('unexpected git ls-tree output');
    const [mode, type, oid, sizeRaw] = line.slice(0, tab).split(/\s+/);
    const path = line.slice(tab + 1);
    if (type !== 'blob' || mode === SYMLINK_MODE) { entries.push({ path, mode, bytes: null }); continue; }
    const size = Number(sizeRaw);
    if (!Number.isInteger(size) || size < 0) throw new OperationalError('unexpected blob size');
    const approvedImage = (policy.approvedBinaryImages ?? []).some(image => image.path === path);
    const limit = approvedImage ? MAX_IMAGE_BYTES : policy.maxTextBytes;
    entries.push({ path, mode, bytes: size > limit ? null : git(repo, ['cat-file', 'blob', oid]) });
  }
  return entries;
}

export function main(argv) {
  const { repo, policyPath } = parseArgs(argv);
  let policy;
  try { policy = validatePolicy(JSON.parse(readFileSync(policyPath, 'utf8'))); }
  catch { throw new OperationalError('policy-load-failed'); }
  const report = analyze(readSnapshot(repo, policy), policy);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.findings.some((f) => f.severity === 'block')) return 1;
  return report.coverageGaps.length > 0 ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { process.stderr.write('operational-error\n'); process.exitCode = 2; }
}
