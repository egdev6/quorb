import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { normalizeZizmor } from './zizmor-report.mjs';

const root = resolve('inert-zizmor');
const SECRET = 'SECRET-MESSAGE-TOKEN';
const inventory = () => ({
  commit: 'a'.repeat(40),
  root,
  targets: [
    { path: join(root, '000000.yml'), originalPath: '.github/workflows/ci.yml', sha256: 'b'.repeat(64) },
    { path: join(root, '000001.yaml'), originalPath: '.github/workflows/release.yml', sha256: 'c'.repeat(64) },
  ],
  excluded: [{ path: 'README.md', reason: 'outside-workflow-scope' }],
});

// Minimal copy of the zizmor 1.30.1 --format=json-v1 schema captured from a real inert run.
function loc(mounted, kind, row) {
  return {
    symbolic: {
      key: { Local: { verbatim_path: mounted } },
      annotation: `annotation ${SECRET}`,
      route: { route: [{ Key: 'jobs' }, { Key: 'build' }, { Key: 'steps' }, { Index: 0 }] },
      feature_kind: 'Normal',
      kind,
    },
    concrete: {
      location: {
        start_point: { row, column: 8 },
        end_point: { row: row + 1, column: 0 },
        offset_span: { start: 106, end: 187 },
      },
      feature: `feature ${SECRET}`,
      comments: [`# ${SECRET}`],
    },
  };
}

function finding({ mounted = '/inputs/000000.yml', ident = 'template-injection', row = 7,
  kind = 'Primary', ignored = true, locations } = {}) {
  return {
    ident,
    desc: `desc ${SECRET}`,
    url: `https://example.invalid/${SECRET}`,
    determinations: { confidence: 'High', severity: 'High', persona: SECRET },
    locations: locations ?? [loc(mounted, 'Hidden', row), loc(mounted, kind, row), loc(mounted, 'Related', row)],
    ignored,
    fixes: [{ title: SECRET, disposition: 'unsafe' }],
  };
}

const report = () => ({
  version: '1.30.1',
  reports: [
    { path: '/inputs/000000.yml', findings: [finding()] },
    { path: '/inputs/000001.yaml', findings: [] },
  ],
});

const throws = (raw, inv = inventory()) =>
  assert.throws(() => normalizeZizmor(raw, inv), { message: 'invalid-zizmor-report' });

test('binds the real json-v1 schema to originals and never leaks finding text', () => {
  const inv = inventory();
  const raw = report();
  const before = JSON.stringify({ inv, raw });
  const out = normalizeZizmor(raw, inv);
  assert.deepEqual(out, {
    commit: inv.commit,
    status: 'ok',
    scannedFiles: 2,
    excluded: [{ path: 'README.md', reason: 'outside-workflow-scope' }],
    findings: [{ rule: 'template-injection', path: '.github/workflows/ci.yml', line: 8, advisory: true }],
  });
  assert.ok(!JSON.stringify(out).includes(SECRET));
  assert.ok(!JSON.stringify(out).includes(root));
  assert.ok(!JSON.stringify(out).includes('/inputs/'));
  for (const item of out.findings) assert.deepEqual(Object.keys(item).sort(), ['advisory', 'line', 'path', 'rule']);
  assert.equal(JSON.stringify({ inv, raw }), before);
});

test('ignored:true is advisory evidence and does not suppress the finding', () => {
  for (const ignored of [true, false]) {
    const raw = report();
    raw.reports[0].findings = [finding({ ignored })];
    const out = normalizeZizmor(raw, inventory());
    assert.deepEqual(out.findings, [{ rule: 'template-injection', path: '.github/workflows/ci.yml', line: 8, advisory: true }]);
  }
});

test('accepts empty findings and deduplicates/sorts deterministically', () => {
  const raw = report();
  raw.reports[0].findings = [
    finding({ row: 3, ident: 'artipacked' }),
    finding({ row: 7 }),
    finding({ row: 3, ident: 'artipacked' }),
  ];
  const out = normalizeZizmor(raw, inventory());
  assert.equal(out.scannedFiles, 2);
  assert.deepEqual(out.findings, [
    { rule: 'artipacked', path: '.github/workflows/ci.yml', line: 4, advisory: true },
    { rule: 'template-injection', path: '.github/workflows/ci.yml', line: 8, advisory: true },
  ]);
});

test('requires the exact independently expected report set', () => {
  const missing = report(); missing.reports.pop();
  const empty = { version: '1.30.1', reports: [] };
  const extra = report(); extra.reports.push({ path: '/inputs/000002.yml', findings: [] });
  const dup = report(); dup.reports.push({ path: '/inputs/000000.yml', findings: [] });
  const alias = report(); alias.reports[0].path = '/inputs/000000.YML';
  const remoteAlias = report(); remoteAlias.reports[0].path = '/other/000000.yml';
  for (const raw of [missing, empty, extra, dup, alias, remoteAlias]) throws(raw);
});

test('rejects malformed report envelopes instead of returning empty findings', () => {
  for (const raw of [null, {}, { version: '1.30.1' }, { version: '1.30.1', reports: null },
    { version: '1.30.1', reports: [null] }, { version: '1.30.1', reports: [{ path: 1, findings: [] }] },
    { version: '1.30.1', reports: [{ path: '/inputs/000000.yml', findings: null }] }]) throws(raw);
});

test('rejects a wrong tool version', () => {
  throws({ version: '1.29.0', reports: [] });
  throws({ version: '1.30.1', reports: [] });
});

test('every location must reference the current report target as Local', () => {
  const otherFile = report();
  otherFile.reports[0].findings = [finding({ mounted: '/inputs/000001.yaml' })];
  const remote = report();
  remote.reports[0].findings = [finding({ locations: [{
    symbolic: { key: { Remote: { verbatim_path: '/inputs/000000.yml' } }, kind: 'Primary' },
    concrete: loc('/inputs/000000.yml', 'Primary', 7).concrete,
  }] })];
  const mixed = report();
  mixed.reports[0].findings = [finding({ locations: [{
    symbolic: { key: { Local: { verbatim_path: '/inputs/000000.yml' }, Remote: { verbatim_path: '/inputs/000000.yml' } }, kind: 'Primary' },
    concrete: loc('/inputs/000000.yml', 'Primary', 7).concrete,
  }] })];
  for (const raw of [otherFile, remote, mixed]) throws(raw);
});

test('requires a valid integer row and at least one Primary location', () => {
  for (const row of [-1, '7', 1.5, Number.MAX_SAFE_INTEGER, 2 ** 53]) {
    const raw = report();
    raw.reports[0].findings = [finding({ row })];
    throws(raw);
  }
  const noPrimary = report();
  noPrimary.reports[0].findings = [finding({ locations: [loc('/inputs/000000.yml', 'Hidden', 7), loc('/inputs/000000.yml', 'Related', 7)] })];
  throws(noPrimary);
  const noLocations = report();
  noLocations.reports[0].findings = [finding({ locations: [] })];
  throws(noLocations);
});

test('rejects malformed location shapes', () => {
  const shapes = [
    null, {}, { symbolic: null, concrete: {} }, { symbolic: {}, concrete: {} },
    { symbolic: { key: { Local: { verbatim_path: '/inputs/000000.yml' } }, kind: 'Primary' }, concrete: {} },
    { symbolic: { key: { Local: { verbatim_path: '/inputs/000000.yml' } }, kind: 'Primary' },
      concrete: { location: {} } },
  ];
  for (const shape of shapes) {
    const raw = report();
    raw.reports[0].findings = [finding({ locations: [shape] })];
    throws(raw);
  }
});

test('rejects unsafe idents', () => {
  for (const ident of ['Template-Injection', '1bad', '', 'x'.repeat(81), 'bad_rule', 'bad rule']) {
    const raw = report();
    raw.reports[0].findings = [finding({ ident })];
    throws(raw);
  }
});

test('rejects malformed or unsafe inventory mappings', () => {
  const cases = [null, {}, { ...inventory(), root: '.' }, { ...inventory(), commit: 'HEAD' },
    { ...inventory(), commit: 'a'.repeat(41) }, { ...inventory(), targets: [] }];
  for (const patch of [
    { path: join(root, 'nested', '000000.yml') }, { path: join(root, '000000.txt') },
    { path: 'relative/000000.yml' }, { originalPath: 'src/ci.yml' },
    { originalPath: '.github/workflows/sub/ci.yml' }, { originalPath: '.github/workflows/ci.txt' },
    { originalPath: '.github/workflows/../ci.yml' }, { originalPath: '.github/other/ci.yml' },
    { sha256: 'bad' },
  ]) {
    const inv = inventory();
    Object.assign(inv.targets[0], patch);
    cases.push(inv);
  }
  const dup = inventory();
  dup.targets[1] = { ...dup.targets[0] };
  cases.push(dup);
  const badReason = inventory();
  badReason.excluded[0].reason = SECRET;
  cases.push(badReason);
  const overlap = inventory();
  overlap.excluded[0].path = '.github/workflows/ci.yml';
  cases.push(overlap);
  const dupExcluded = inventory();
  dupExcluded.excluded.push({ path: 'README.md', reason: 'outside-workflow-scope' });
  cases.push(dupExcluded);
  const traversal = inventory();
  traversal.excluded[0].path = '../escape.md';
  cases.push(traversal);
  for (const inv of cases) throws(report(), inv);
});

test('rejects control and format characters in the host root of remapped targets', () => {
  for (const evil of ['\u0000', '\u202e']) {
    const inv = inventory();
    const mounts = inv.targets.map(target => target.path.split(sep).at(-1));
    inv.root = `${root}${evil}`;
    inv.targets = inv.targets.map((target, index) => ({ ...target, path: join(inv.root, mounts[index]) }));
    const before = JSON.stringify(inv);
    assert.throws(() => normalizeZizmor(report(), inv), { message: 'invalid-zizmor-report' });
    assert.equal(JSON.stringify(inv), before);
  }
});
