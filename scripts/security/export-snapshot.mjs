// DRAFT: trusted Git-to-Semgrep export. Never execute/import target code.
// Callers own the returned temporary root and must remove it after scanning.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { devNull } from 'node:os';
import { extname, join, resolve } from 'node:path';

const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const MAX_SOURCE = 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Git for Windows rejects node's os.devNull (\\.\nul) as a config path, so use
// the Git-aware null device on that platform while still suppressing globals.
const GIT_NULL_CONFIG = process.platform === 'win32' ? 'NUL' : devNull;
const fail = () => { throw new Error('snapshot-export-failed'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function safeOriginal(path) {
  if (!path || /[\p{Cc}\p{Cf}\\:]/u.test(path)) fail();
  if (path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) fail();
}

export function exportSnapshot({ repo, commit, parent, scope = 'js-ts' }) {
  let root;
  try {
    if (!['js-ts', 'workflows'].includes(scope)) fail();
    if (typeof repo !== 'string' || typeof parent !== 'string' || typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) fail();
    // Do not inherit Git overrides, replacement objects, global config or lazy network fetches.
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = args => execFileSync('git', args, { cwd: repo, env,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 10000 });
    if (git(['cat-file', '-t', commit]).toString().trim() !== 'commit') fail();
    const records = decoder.decode(git(['ls-tree', '-rz', '-l', commit])).split('\0');
    if (records.pop() !== '' || records.length > 10000) fail();
    const targets = [];
    const excluded = [];
    const seen = new Set();
    let total = 0;
    root = mkdtempSync(join(resolve(parent), 'semgrep-snapshot-'));
    for (const record of records) {
      const tab = record.indexOf('\t');
      if (tab < 0) fail();
      const originalPath = record.slice(tab + 1);
      safeOriginal(originalPath);
      if (seen.has(originalPath)) fail();
      seen.add(originalPath);
      const fields = record.slice(0, tab).trim().split(/\s+/);
      const [mode, type, oid, sizeText] = fields;
      if (fields.length !== 4 || !['100644', '100755'].includes(mode) || type !== 'blob' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || !/^\d+$/.test(sizeText)) fail();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size)) fail();
      const extension = extname(originalPath).toLowerCase();
      const included = scope === 'workflows'
        ? /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/.test(originalPath)
        : EXTENSIONS.has(extension);
      if (!included) {
        excluded.push({ path: originalPath, reason: scope === 'workflows' ? 'outside-workflow-scope' : 'outside-js-ts-scope' });
        continue;
      }
      total += size;
      if (size > MAX_SOURCE || total > MAX_TOTAL) fail();
      const bytes = git(['cat-file', 'blob', oid]);
      if (bytes.length !== size || bytes.includes(0)) fail();
      decoder.decode(bytes);
      // Flat generated names prevent target ignores/configuration and path aliases being exported.
      // Semgrep 1.180.0 does not recognize .mts/.cts; both use the non-TSX grammar.
      // Canonicalize only those suffixes. Bytes/hash and original identity never change.
      const scannerExtension = ['.mts', '.cts'].includes(extension) ? '.ts' : extension;
      const path = join(root, `${String(targets.length).padStart(6, '0')}${scannerExtension}`);
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 });
      targets.push({ path, originalPath, sha256: hash(bytes) });
    }
    if (targets.length === 0) fail();
    return { commit, root, targets, excluded };
  } catch {
    if (root) rmSync(root, { recursive: true, force: true });
    fail();
  }
}
