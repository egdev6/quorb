#!/usr/bin/env node
// Reproducible inventory of user-facing text literals for the bilingual UI (#66).
//
// Reads sources from a git commit (never the working tree) and anchors the
// document to the content-addressed trees of `src/` and `src-tauri/src/`, so
// the checked texts stay checkable after a squash or rebase.
// React/TS is parsed with the TypeScript compiler; Rust with a lexical scanner
// that understands comments, char literals, raw strings, attributes, log
// macros and `#[cfg(test)]` items.
//
//   node scripts/i18n-inventory.mjs [--ref <commit>] [--out <file>] [--check] [--sites]
//
// `--check` regenerates in memory and exits 1 when <file> differs. CI runs it
// (.github/workflows/ci.yml, #155); see CONTRIBUTING.md for the convention.
// `--sites` prints `path:line | text` rows on stdout instead of writing the
// document: occurrence sites stay available for debugging but out of the
// checked document, so its diff only moves when a text actually changes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const DEFAULT_OUT = 'docs/i18n-inventory.md';
const PLACEHOLDER = '${…}';

// ---------------------------------------------------------------------------
// Text heuristic
// ---------------------------------------------------------------------------

const CODE_TOKEN = /^[\w.\/\\:@#%=<>+-]+$/;
const CODE_MARK = /[_\/\\.:#%=@<>+-]|\d/;

/** True when `s` looks like text a person reads, not an identifier, path, url or style. */
export function isUiText(s) {
  const text = s.trim();
  if (!text || /^\S+:\/\/\S*$/.test(text)) return false;
  const hadPlaceholder = /\$\{…\}|\{[^{}]*\}/.test(text);
  const core = text.replace(/\$\{…\}|\{[^{}]*\}/g, ' ').trim();
  if (!/\p{L}/u.test(core)) return false;
  const tokens = core.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const [word] = tokens;
    if (/[^\x00-\x7F]/.test(word) && !/[_\/\\@#%=]/.test(word)) return true;
    if (/^\p{Lu}\p{Ll}{2,}[.…:!?]?$/u.test(word)) return true;
    return hadPlaceholder && /^\p{L}{3,}[.…:!?]?$/u.test(word);
  }
  // Trailing punctuation («p. ej.») does not make a word look like code.
  return !tokens.every((t) => CODE_TOKEN.test(t) && CODE_MARK.test(t.replace(/[.,;:!?…]+$/, '')));
}

// ---------------------------------------------------------------------------
// TypeScript / TSX
// ---------------------------------------------------------------------------

const SKIP_ATTRS = new Set([
  'accept', 'autoComplete', 'class', 'className', 'd', 'dir', 'fill', 'height', 'href', 'htmlFor', 'id', 'inputMode',
  'key', 'lang', 'method', 'mode', 'name', 'pattern', 'rel', 'role', 'src', 'stroke', 'style', 'tabIndex', 'target',
  'type', 'viewBox', 'width', 'xmlns',
]);
// Always visible to the user: kept whenever they hold a letter (except whole URLs).
// Only ARIA attributes that carry readable text; state ones (aria-hidden, aria-live…) hold tokens.
const VISIBLE_ATTR = /^(placeholder|title|alt|label|hint|aria-(label|description|placeholder|roledescription|valuetext))$/;
// Wrappers a visible attribute value may hide its literals behind (`cond ? 'a' : 'b'`, `x ?? 'y'`).
const isValueWrapper = (n) => ts.isJsxExpression(n) || ts.isConditionalExpression(n) || ts.isParenthesizedExpression(n) || ts.isBinaryExpression(n);
const SKIP_CALLS = /^(console\.\w+|invoke|listen|emit|emitTo|once|\w+\.(addEventListener|removeEventListener|querySelector|querySelectorAll|getElementById|setAttribute|getItem|setItem|removeItem|matchMedia|toggle|add|remove|contains)|clsx|cn|classNames|require)$/;

/** Visible-text candidates of one TS/TSX source, ordered by position. */
export function extractTs(source, fileName) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  // `context` decides what is kept: 'jsx' = any text with a letter, 'attr' = a letter and not a whole
  // URL, otherwise the `isUiText` shape heuristic.
  const add = (pos, raw, context) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    const keep = context === 'jsx' ? /\p{L}/u.test(text)
      : context === 'attr' ? /\p{L}/u.test(text) && !/^\S+:\/\/\S*$/.test(text)
      : isUiText(text);
    if (keep) found.push({ pos, line: sf.getLineAndCharacterOfPosition(pos).line + 1, text });
  };
  // A literal compared with `===`/`!==` or used as a `case` label is a code value, not text.
  const isComparedLiteral = (node) => {
    const p = node.parent;
    return (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind))
      || (ts.isCaseClause(p) && p.expression === node);
  };
  const visit = (node, context) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (SKIP_ATTRS.has(name) || name.startsWith('data-')) return;
      if (VISIBLE_ATTR.test(name)) {
        if (node.initializer) visit(node.initializer, 'attr');
        return;
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(sf) === 'Set' && node.arguments?.length === 1 && ts.isArrayLiteralExpression(node.arguments[0])) {
      // `new Set([...])` holds lookup keys: drop its string elements, keep anything computed.
      for (const el of node.arguments[0].elements) {
        if (!ts.isStringLiteralLike(el) && !ts.isTemplateExpression(el)) visit(el);
      }
      return;
    }
    if (ts.isCallExpression(node) && SKIP_CALLS.test(node.expression.getText(sf))) {
      // Skip the literal arguments (event/command names, debug text) but keep callbacks.
      for (const arg of node.arguments) {
        if (!ts.isStringLiteralLike(arg) && !ts.isTemplateExpression(arg)) visit(arg);
      }
      return;
    }
    if (ts.isJsxText(node)) {
      const lead = node.text.search(/\S/);
      if (lead >= 0) add(node.getStart(sf) + lead, node.text, 'jsx');
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isComparedLiteral(node)) add(node.getStart(sf), node.text, context);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (!isComparedLiteral(node)) {
        add(node.getStart(sf), node.head.text + node.templateSpans.map((s) => PLACEHOLDER + s.literal.text).join(''), context);
      }
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    // Only value wrappers carry the attribute context; calls, JSX and callbacks start afresh.
    const inner = context && isValueWrapper(node) ? context : undefined;
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sf, undefined);
  return found.sort((a, b) => a.pos - b.pos).map(({ line, text }) => ({ line, text }));
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const LOG_MACROS = new Set(['println', 'eprintln', 'print', 'eprint', 'dbg', 'debug', 'trace', 'info', 'warn', 'error', 'log']);
const UNIT_ARG = /\bunit\s*:\s*Some\(\s*$/;
// Calls whose string arguments are panic messages, header names or internal diagnostics.
const QUIET_CALL = /(?:\.\s*(?:expect|header)|\b(?:diagnostic|checked))\s*$/;
const isIdent = (c) => c !== undefined && /[\w]/.test(c);

/** Visible-text candidates of one Rust source, ordered by position. */
export function extractRust(source) {
  const found = [];
  let i = 0;
  let line = 1;
  let depth = 0; // `{}` depth
  let parens = 0; // `()` depth
  let skipUntilDepth = -1; // inside a #[cfg(test)] item body
  let pendingTestItem = false;
  let logUntilParens = -1; // inside a log macro call
  let quietUntilParens = -1; // inside the arguments of .expect( / .header( / diagnostic( / checked(
  let attrBrackets = 0; // inside #[...]
  const src = source;
  const n = src.length;
  const advance = (to) => {
    for (; i < to && i < n; i++) if (src[i] === '\n') line++;
  };
  // `unit: Some("…")` is a visible measurement unit whatever its shape.
  const isUnitArg = (pos) => UNIT_ARG.test(src.slice(Math.max(0, pos - 32), pos));
  const record = (startLine, text, forced) => {
    if (skipUntilDepth >= 0 || logUntilParens >= 0 || quietUntilParens >= 0 || attrBrackets > 0) return;
    if (forced ? /\p{L}/u.test(text) : isUiText(text)) found.push({ line: startLine, text });
  };
  const readQuoted = (open) => {
    // `open` points at the opening quote of a normal (escaped) string.
    const startLine = line;
    let out = '';
    let j = open + 1;
    while (j < n && src[j] !== '"') {
      if (src[j] === '\\') {
        const e = src[j + 1];
        if (e === '\n' || (e === '\r' && src[j + 2] === '\n')) {
          j += e === '\r' ? 3 : 2;
          while (j < n && /\s/.test(src[j])) j++;
          continue;
        }
        if (e === 'u' && src[j + 2] === '{') {
          const close = src.indexOf('}', j);
          out += String.fromCodePoint(parseInt(src.slice(j + 3, close), 16));
          j = close + 1;
          continue;
        }
        out += { n: '\n', t: '\t', r: '', '0': '', '"': '"', "'": "'", '\\': '\\' }[e] ?? e;
        j += 2;
        continue;
      }
      out += src[j++];
    }
    advance(j + 1);
    return { startLine, text: out };
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      advance(end < 0 ? n : end);
      continue;
    }
    if (c === '/' && next === '*') {
      let level = 0;
      let j = i;
      do {
        if (src[j] === '/' && src[j + 1] === '*') { level++; j += 2; }
        else if (src[j] === '*' && src[j + 1] === '/') { level--; j += 2; }
        else j++;
      } while (level > 0 && j < n);
      advance(j);
      continue;
    }
    if (c === "'") {
      // Char literal ('x', '\n', '\u{..}', '"') or lifetime ('a).
      if (next === '\\') {
        advance(src.indexOf("'", i + 2) + 1);
        continue;
      }
      const cp = src.codePointAt(i + 1);
      const width = cp > 0xffff ? 2 : 1;
      advance(src[i + 1 + width] === "'" ? i + 2 + width : i + 1);
      continue;
    }
    // Raw strings: r"..", r#".."#, br#".."#
    if ((c === 'r' || (c === 'b' && next === 'r')) && !isIdent(src[i - 1])) {
      let j = c === 'b' ? i + 2 : i + 1;
      let hashes = 0;
      while (src[j] === '#') { hashes++; j++; }
      if (src[j] === '"') {
        const close = '"' + '#'.repeat(hashes);
        const end = src.indexOf(close, j + 1);
        const startLine = line;
        const text = src.slice(j + 1, end);
        const forced = isUnitArg(i);
        advance(end + close.length);
        if (c === 'r') record(startLine, text, forced);
        continue;
      }
    }
    if (c === 'b' && next === '"' && !isIdent(src[i - 1])) {
      advance(i + 1);
      readQuoted(i);
      continue;
    }
    if (c === '"') {
      const forced = isUnitArg(i);
      const { startLine, text } = readQuoted(i);
      record(startLine, text, forced);
      continue;
    }
    if (c === '#' && (next === '[' || (next === '!' && src[i + 2] === '['))) {
      const open = next === '[' ? i + 1 : i + 2;
      const head = src.slice(open, open + 12).replace(/\s+/g, '');
      if (head.startsWith('[cfg(test)]')) pendingTestItem = true;
      attrBrackets++;
      advance(open + 1);
      continue;
    }
    if (attrBrackets > 0 && c === '[') attrBrackets++;
    else if (attrBrackets > 0 && c === ']') attrBrackets--;
    else if (c === '{') {
      if (pendingTestItem && skipUntilDepth < 0) {
        skipUntilDepth = depth;
        pendingTestItem = false;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === skipUntilDepth) skipUntilDepth = -1;
    } else if (c === ';' && pendingTestItem && attrBrackets === 0) {
      pendingTestItem = false; // e.g. #[cfg(test)] use ...;
    } else if (c === '(') {
      if (quietUntilParens < 0 && QUIET_CALL.test(src.slice(Math.max(0, i - 24), i))) quietUntilParens = parens;
      parens++;
    } else if (c === ')') {
      parens--;
      if (parens === logUntilParens) logUntilParens = -1;
      if (parens === quietUntilParens) quietUntilParens = -1;
    } else if (c === '!' && next !== '=' && logUntilParens < 0) {
      const m = src.slice(Math.max(0, i - 40), i).match(/(?:\b(?:log|tracing)::)?\b(\w+)$/);
      const after = src.slice(i + 1).match(/^\s*[([{]/);
      if (m && LOG_MACROS.has(m[1]) && after) logUntilParens = parens;
    }
    advance(i + 1);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const isReactSource = (p) => p.startsWith('src/') && /\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.|\.d\.ts$|__tests__\//.test(p);
const isRustSource = (p) => p.startsWith('src-tauri/src/') && p.endsWith('.rs') && !/\/tests?\//.test(p);
const cell = (s) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
// Deterministic collation: UTF-16 code-unit order, locale-independent, so the
// rendered document is byte-identical across runs and platforms.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function renderInventory(trees, files) {
  const areas = [
    { label: 'React (`src/`)', match: isReactSource, distinct: new Set(), sites: 0 },
    { label: 'Rust (`src-tauri/src/`)', match: isRustSource, distinct: new Set(), sites: 0 },
  ];
  const sections = [];
  for (const { path: p, entries } of [...files].sort((a, b) => cmp(a.path, b.path))) {
    if (!entries.length) continue;
    const area = areas.find((a) => a.match(p));
    for (const e of entries) area.distinct.add(e.text);
    area.sites += entries.length;
    const texts = [...new Set(entries.map((e) => e.text))].sort(cmp);
    sections.push(`## ${p}\n\n${texts.map((t) => `- ${cell(t)}`).join('\n')}\n`);
  }
  const all = new Set(areas.flatMap((a) => [...a.distinct]));
  return [
    '# i18n inventory (egdev6/quorb#66)',
    '',
    `Generated by \`node scripts/i18n-inventory.mjs\` from the source trees \`src/\` = \`${trees.src}\` and \`src-tauri/src/\` = \`${trees.rust}\`.`,
    'Any commit whose `git rev-parse <commit>:src` and `<commit>:src-tauri/src` match has these exact texts.',
    'Do not edit by hand: regenerate, or verify with `node scripts/i18n-inventory.mjs --check`.',
    '',
    'Each `## <path>` section lists the distinct text candidates of that file, sorted and deduplicated, with no',
    'line numbers: the document only changes when a text actually changes, so diffs stay meaningful. Occurrence',
    'sites (`path:line`) are not part of the checked document; print them with `node scripts/i18n-inventory.mjs',
    '--sites`. React/TS is parsed with the TypeScript compiler (JSX text, visible attributes, string and template',
    'literals; imports, types, `className`-like attributes, `console.*`, `invoke`/`listen` and tests excluded).',
    'Rust is scanned lexically (comments, attributes, log macros and `#[cfg(test)]` items excluded). Template and',
    '`format!` placeholders are kept as written; `${…}` marks an interpolation. It is a superset: a few',
    'candidates may be identifiers or brand names that stay untranslated. Known gap: short tokens bound through',
    'tuples (e.g. the `"req"` unit in `providers/nan.rs`) are only listed when they also look like text.',
    '',
    '## Summary',
    '',
    '| Area | Distinct texts | Sites |',
    '|---|---:|---:|',
    ...areas.map((a) => `| ${a.label} | ${a.distinct.size} | ${a.sites} |`),
    `| Total | ${all.size} | ${areas.reduce((s, a) => s + a.sites, 0)} |`,
    '',
    ...sections,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

export function generate(cwd, ref) {
  const { trees, files } = collect(cwd, ref);
  return renderInventory(trees, files);
}

export function collect(cwd, ref) {
  const root = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const sha = git(root, 'rev-parse', '--verify', `${ref}^{commit}`).trim();
  const trees = { src: git(root, 'rev-parse', `${sha}:src`).trim(), rust: git(root, 'rev-parse', `${sha}:src-tauri/src`).trim() };
  const paths = git(root, 'ls-tree', '-r', '--name-only', sha, '--', 'src', 'src-tauri/src')
    .split('\n')
    .filter((p) => isReactSource(p) || isRustSource(p))
    .sort();
  const files = paths.map((p) => {
    const source = git(root, 'show', `${sha}:${p}`);
    return { path: p, entries: p.endsWith('.rs') ? extractRust(source) : extractTs(source, p) };
  });
  return { trees, files };
}

function main(argv) {
  let ref = 'HEAD';
  let out = DEFAULT_OUT;
  let check = false;
  let sites = false;
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--check') check = true;
    else if (a === '--sites') sites = true;
    else if ((a === '--ref' || a === '--out') && argv[k + 1] !== undefined) {
      if (a === '--ref') ref = argv[++k];
      else out = argv[++k];
    } else {
      process.stderr.write(`unknown argument: ${a}\nusage: node scripts/i18n-inventory.mjs [--ref <commit>] [--out <file>] [--check] [--sites]\n`);
      return 2;
    }
  }
  if (sites && (check || out !== DEFAULT_OUT)) {
    process.stderr.write(`--sites prints site rows on stdout and cannot be combined with --check or --out\nusage: node scripts/i18n-inventory.mjs [--ref <commit>] [--out <file>] [--check] [--sites]\n`);
    return 2;
  }
  const { trees, files } = collect(process.cwd(), ref);
  if (sites) {
    for (const { path: p, entries } of [...files].sort((a, b) => cmp(a.path, b.path))) {
      for (const e of entries) process.stdout.write(`${p}:${e.line} | ${e.text}\n`);
    }
    return 0;
  }
  const doc = renderInventory(trees, files);
  const target = path.resolve(process.cwd(), out);
  if (check) {
    // Line endings follow the checkout (core.autocrlf), not the content.
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current !== doc) {
      // Everything but the tree-hash line: equal means no text, count or prose changed.
      const withoutHashes = (s) => s.replace(/^Generated by .* from the source trees .*$/m, '');
      if (current !== null && withoutHashes(current) === withoutHashes(doc)) {
        // Hashes-only drift: main moved the source trees without changing any text.
        process.stderr.write(`${out} is out of date in its header tree hashes only (the listed texts still match); refresh them with: node scripts/i18n-inventory.mjs --out ${out}\n`);
      } else {
        process.stderr.write(`${out} is out of date; regenerate with: node scripts/i18n-inventory.mjs --out ${out}\nnote: CI validates the merge of this branch with main; if main changed texts under src/ or src-tauri/src/, merge main into the branch and regenerate\n`);
      }
      return 1;
    }
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, doc);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
