// DRAFT: pure normalizer binding trusted zizmor 1.30.1 --format=json-v1 output to a trusted
// export inventory. Read-only: no I/O, no scanner execution, no imports of target code.
// Findings are advisory evidence for human review, never a verdict.
// The caller mounts inventory.root read-only at /inputs and runs zizmor once per workflow
// with --offline --no-config --strict-collection --no-ignores --no-exit-codes.
import { isAbsolute, relative, join } from 'node:path';

const VERSION = '1.30.1';
const RULE = /^[a-z][a-z0-9-]{0,79}$/;
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MOUNTED = /^\d{6}\.(?:yml|yaml)$/;
const MAX_REPORTS = 10000;
const MAX_FINDINGS = 10000;
const UNSAFE = /[\p{Cc}\p{Cf}\\:]/u;

const fail = () => { throw new Error('invalid-zizmor-report'); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Repository-relative safe path: no control/format chars, backslashes, colons, traversal,
// .git segments, empty segments, leading slash or trailing slash.
function segments(value) {
  if (typeof value !== 'string' || value.length === 0 || UNSAFE.test(value)) fail();
  if (value.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) fail();
}

// A target original must be exactly .github/workflows/<single filename>.yml|yaml.
function workflowOriginal(value) {
  segments(value);
  const parts = value.split('/');
  if (parts.length !== 3 || parts[0] !== '.github' || parts[1] !== 'workflows' ||
      !/\.(?:yml|yaml)$/.test(parts[2])) fail();
  return value;
}

function inventoryOf(inventory) {
  if (!isObject(inventory)) fail();
  const { root, commit, targets, excluded } = inventory;
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) fail();
  if (typeof commit !== 'string' || !HASH.test(commit)) fail();
  if (!Array.isArray(targets) || targets.length === 0 || !Array.isArray(excluded)) fail();
  const byMounted = new Map();
  const originals = new Set();
  for (const target of targets) {
    if (!isObject(target)) fail();
    const { path, originalPath, sha256 } = target;
    if (typeof path !== 'string' || !isAbsolute(path) || UNSAFE.test(path)) fail();
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) fail();
    const name = relative(root, path);
    if (!MOUNTED.test(name) || join(root, name) !== path) fail();
    const original = workflowOriginal(originalPath);
    const mounted = `/inputs/${name}`;
    if (byMounted.has(mounted) || originals.has(original)) fail();
    byMounted.set(mounted, original);
    originals.add(original);
  }
  const excludedOut = excluded.map((entry) => {
    if (!isObject(entry) || entry.reason !== 'outside-workflow-scope') fail();
    segments(entry.path);
    if (originals.has(entry.path)) fail();
    originals.add(entry.path);
    return { path: entry.path, reason: 'outside-workflow-scope' };
  });
  return { commit, byMounted, excluded: excludedOut };
}

function reportEntries(report, byMounted) {
  if (!isObject(report)) fail();
  if (report.version !== VERSION) fail();
  if (!Array.isArray(report.reports) || report.reports.length > MAX_REPORTS) fail();
  const seen = new Set();
  for (const entry of report.reports) {
    if (!isObject(entry) || typeof entry.path !== 'string' || !byMounted.has(entry.path)) fail();
    if (seen.has(entry.path)) fail();
    seen.add(entry.path);
    if (!Array.isArray(entry.findings) || entry.findings.length > MAX_FINDINGS) fail();
  }
  // Exact set equality against independently expected mounted paths (no case aliases).
  if (seen.size !== byMounted.size) fail();
  return report.reports;
}

function locationOf(loc, mounted) {
  if (!isObject(loc) || !isObject(loc.symbolic) || !isObject(loc.concrete)) fail();
  const key = loc.symbolic.key;
  if (!isObject(key) || Object.keys(key).length !== 1 || !isObject(key.Local) ||
      key.Local.verbatim_path !== mounted) fail();
  const kind = loc.symbolic.kind;
  if (typeof kind !== 'string' || kind.length === 0) fail();
  const concrete = loc.concrete.location;
  if (!isObject(concrete) || !isObject(concrete.start_point)) fail();
  const row = concrete.start_point.row;
  if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(row + 1)) fail();
  return { kind, line: row + 1 };
}

function findingOf(finding, mounted, original) {
  if (!isObject(finding) || typeof finding.ident !== 'string' || !RULE.test(finding.ident)) fail();
  if ('ignored' in finding && typeof finding.ignored !== 'boolean') fail();
  if (!Array.isArray(finding.locations) || finding.locations.length === 0 ||
      finding.locations.length > MAX_FINDINGS) fail();
  let line;
  for (const loc of finding.locations) {
    const parsed = locationOf(loc, mounted);
    if (parsed.kind === 'Primary' && line === undefined) line = parsed.line;
  }
  if (line === undefined) fail();
  return { rule: finding.ident, path: original, line, advisory: true };
}

export function normalizeZizmor(report, inventory) {
  try {
    const trusted = inventoryOf(inventory);
    const entries = reportEntries(report, trusted.byMounted);
    const findings = [];
    for (const entry of entries) {
      const original = trusted.byMounted.get(entry.path);
      for (const finding of entry.findings) findings.push(findingOf(finding, entry.path, original));
    }
    findings.sort((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.rule, b.rule));
    const unique = findings.filter((f, i) => i === 0 || f.path !== findings[i - 1].path ||
      f.line !== findings[i - 1].line || f.rule !== findings[i - 1].rule);
    return {
      commit: trusted.commit,
      status: 'ok',
      scannedFiles: trusted.byMounted.size,
      excluded: trusted.excluded,
      findings: unique,
    };
  } catch { fail(); }
}
