// DRAFT Unit 2 slice — pure normalizer for trusted Semgrep JSON reports.
// Read-only: accepts a decoded object plus explicit trusted targets; never reads files,
// imports project code or executes scanners. Findings are advisory evidence, not a verdict.
import { isAbsolute, relative, sep } from 'node:path';

const SELECTED_VERSION = '1.180.0';
const KNOWN_RULES = new Set(['decoded-text-execution', 'dynamic-function-construction', 'shell-command-execution']);
const RULE_NAME = /^[A-Za-z0-9_./-]+$/;
const UNSAFE = /[\p{Cc}\p{Cf}]/u;
const ESC = /[\p{Cc}\p{Cf}]/gu;

const esc = (s) => s.replace(ESC, (c) => '\\u{' + c.codePointAt(0).toString(16).padStart(4, '0') + '}');
const reject = () => { throw new Error('invalid-semgrep-report'); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function safePath(value, root) {
  if (typeof value !== 'string' || value.length === 0 || UNSAFE.test(value) || !isAbsolute(value)) reject();
  const segments = value.split('/');
  for (let i = 1; i < segments.length; i++) if (segments[i] === '' || segments[i] === '.' || segments[i] === '..') reject();
  const rel = relative(root, value);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) reject();
  return value;
}

function checkRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || UNSAFE.test(root) || !isAbsolute(root)) reject();
}

function expectedSet(expectedPaths, root) {
  if (!Array.isArray(expectedPaths) || expectedPaths.length === 0) reject();
  const expected = new Set();
  for (const path of expectedPaths) {
    safePath(path, root);
    if (expected.has(path)) reject();
    expected.add(path);
  }
  return expected;
}

function scannedSet(report, root) {
  const paths = report.paths;
  if (!isObject(paths) || !Array.isArray(paths.scanned)) reject();
  const scanned = new Set();
  for (const path of paths.scanned) {
    safePath(path, root);
    if (scanned.has(path)) reject();
    scanned.add(path);
  }
  return scanned;
}

function mapFinding(result, scanned, root) {
  if (!isObject(result)) reject();
  const id = result.check_id;
  if (typeof id !== 'string' || id.length === 0 || UNSAFE.test(id) || !RULE_NAME.test(id)) reject();
  const rule = id.slice(id.lastIndexOf('.') + 1);
  if (!KNOWN_RULES.has(rule)) reject();
  const path = safePath(result.path, root);
  if (!scanned.has(path)) reject();
  if (!isObject(result.start) || !Number.isInteger(result.start.line) || result.start.line < 1) reject();
  if (result.extra !== undefined && result.extra !== null) {
    if (!isObject(result.extra)) reject();
    if (result.extra.severity !== undefined && result.extra.severity !== 'WARNING') reject();
  }
  return { rule, path: esc(path), line: result.start.line, severity: 'advisory' };
}

export function normalizeSemgrep(report, expectedPaths, options) {
  if (!isObject(report)) reject();
  if (!Array.isArray(report.results)) reject();
  if (!Array.isArray(report.errors)) reject();
  if (!Array.isArray(report.skipped_rules) || report.skipped_rules.length !== 0) reject();
  if (report.version !== SELECTED_VERSION) reject();
  const root = isObject(options) ? options.root : undefined;
  checkRoot(root);
  const expected = expectedSet(expectedPaths, root);
  const scanned = scannedSet(report, root);
  if (scanned.size !== expected.size) reject();
  for (const path of expected) if (!scanned.has(path)) reject();
  if (report.errors.length > 0) reject();
  const findings = report.results.map((result) => mapFinding(result, scanned, root));
  return { status: 'completed', scannedFiles: expected.size, findings };
}
