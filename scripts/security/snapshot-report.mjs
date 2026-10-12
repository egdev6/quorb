// DRAFT: bind scanner output to the trusted exporter's independent inventory.
// The caller mounts inventory.root read-only at /inputs. This module performs no I/O.
import { isAbsolute, relative, join } from 'node:path';
import { normalizeSemgrep } from './semgrep-report.mjs';

const fail = () => { throw new Error('invalid-snapshot-report'); };
function originalPath(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\\:]/u.test(value) ||
      value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) fail();
  return value;
}

export function normalizeSnapshotReport(report, inventory) {
  try {
    if (!inventory || typeof inventory.root !== 'string' || !isAbsolute(inventory.root) ||
        typeof inventory.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(inventory.commit) ||
        !Array.isArray(inventory.targets) || inventory.targets.length === 0 || !Array.isArray(inventory.excluded)) fail();
    const mappings = new Map();
    const originals = new Set();
    for (const target of inventory.targets) {
      if (!target || typeof target.path !== 'string' || !isAbsolute(target.path) ||
          typeof target.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(target.sha256)) fail();
      const name = relative(inventory.root, target.path);
      if (!/^\d{6}\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(name) || join(inventory.root, name) !== target.path) fail();
      const original = originalPath(target.originalPath);
      const mountedPath = `/inputs/${name}`;
      if (mappings.has(mountedPath) || originals.has(original)) fail();
      mappings.set(mountedPath, original);
      originals.add(original);
    }
    const excluded = inventory.excluded.map(entry => {
      if (!entry || entry.reason !== 'outside-js-ts-scope') fail();
      const path = originalPath(entry.path);
      if (originals.has(path)) fail();
      originals.add(path);
      return { path, reason: 'outside-js-ts-scope' };
    });
    // Never derive expectedPaths from report.paths.scanned: it is evidence to check.
    const normalized = normalizeSemgrep(report, [...mappings.keys()], { root: '/inputs' });
    const findings = normalized.findings.map(finding => ({ ...finding, path: mappings.get(finding.path) }));
    return { commit: inventory.commit, status: normalized.status, scannedFiles: normalized.scannedFiles, excluded, findings };
  } catch { fail(); }
}
