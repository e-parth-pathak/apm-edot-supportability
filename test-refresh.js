#!/usr/bin/env node
/**
 * test-refresh.js — tests the refresh pipeline WITHOUT network access.
 *
 * The network paths in refresh.js could not be executed in the environment
 * where this project was written (elastic.co and raw.githubusercontent.com
 * were both unreachable). So the parsing, cross-checking and diffing logic is
 * tested here against recorded fixtures, exercising every branch of the
 * additions-auto / changes-review policy:
 *
 *     unchanged · row added · cell changed · row removed · columns changed
 *     new table · rule-quote-at-risk · markdown/HTML conflict
 *
 * Run:  node test-refresh.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const STAGING = path.join(HERE, '.refresh-staging');
const DATA_DIR = path.join(HERE, 'data');
const TMP = path.join(HERE, '.refresh-test-tmp');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
};
const group = n => console.log('\n' + n);

/* ===================================================================
   1. markdown table parser
   =================================================================== */

// Re-implement the loader by requiring refresh.js in a sandboxed way is
// awkward (it has a main()), so the parser is re-derived here from the same
// file to guarantee we test the shipped code, not a copy.
const refreshSrc = fs.readFileSync(path.join(HERE, 'refresh.js'), 'utf8');
const parseFnSrc = refreshSrc.match(
  /function parseMarkdownTables\(md\) \{[\s\S]*?\n\}/)[0];
const proseFnSrc = refreshSrc.match(
  /function parseMarkdownProse\(md\) \{[\s\S]*?\n\}/)[0];
const plainFnSrc = refreshSrc.match(/function plain\(s\) \{[\s\S]*?\n\}/)[0];
const htmlFnSrc = refreshSrc.match(/function htmlToText\(html\) \{[\s\S]*?\n\}/)[0];
const xcheckFnSrc = refreshSrc.match(/function crossCheck\(tables, htmlText\) \{[\s\S]*?\n\}/)[0];
// eslint-disable-next-line no-new-func
const sandbox = new Function(
  parseFnSrc + '\n' + proseFnSrc + '\n' + plainFnSrc + '\n' + htmlFnSrc + '\n' + xcheckFnSrc +
  '\nreturn { parseMarkdownTables, parseMarkdownProse, plain, htmlToText, crossCheck };')();

const { parseMarkdownTables, parseMarkdownProse, plain, htmlToText, crossCheck } = sandbox;

group('markdown table parser');
{
  const md = [
    '# APM agent compatibility',
    '',
    'Intro prose.',
    '',
    '## Go agent [go-agent]',
    '',
    '| APM agent version | APM integration version |',
    '| ----------------- | ----------------------- |',
    '| `1.x`             | ≥ `6.5`                 |',
    '| `2.x`             | ≥ `6.5`                 |',
    '',
    '## Java agent',
    '',
    '| APM agent version | APM integration version |',
    '| --- | --- |',
    '| `1.x` | ≥ `6.5` |',
  ].join('\n');

  const t = parseMarkdownTables(md);
  ok('finds both tables', t.length === 2, 'got ' + t.length);
  ok('captures heading', t[0].heading === 'Go agent', 'got ' + t[0].heading);
  ok('captures {#anchor}', t[0].anchor === 'go-agent', 'got ' + t[0].anchor);
  ok('captures columns', t[0].columns.join('|') === 'APM agent version|APM integration version');
  ok('captures 2 rows', t[0].rows.length === 2);
  ok('preserves backticks in cells', t[0].rows[0][0] === '`1.x`');
  ok('preserves ≥ in cells', t[0].rows[0][1] === '≥ `6.5`');
  ok('second table parsed with short separator', t[1].rows.length === 1);
  ok('heading with no anchor is left intact', t[1].heading === 'Java agent', 'got ' + t[1].heading);
}

group('parser: both anchor syntaxes');
{
  // Elastic's docs-builder uses `## Heading [anchor]`; plain markdown uses
  // `{#anchor}`. Both must be stripped from the heading text, otherwise
  // heading-matching in diff-refresh.js never lines up.
  const sq = parseMarkdownTables('## Go agent [go-agent]\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  ok('[anchor] stripped from heading', sq[0].heading === 'Go agent', 'got ' + sq[0].heading);
  ok('[anchor] captured', sq[0].anchor === 'go-agent', 'got ' + sq[0].anchor);

  const cu = parseMarkdownTables('## Go agent {#go-agent}\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  ok('{#anchor} stripped from heading', cu[0].heading === 'Go agent', 'got ' + cu[0].heading);
  ok('{#anchor} captured', cu[0].anchor === 'go-agent', 'got ' + cu[0].anchor);

  // A trailing markdown LINK must not be mistaken for an anchor.
  const lk = parseMarkdownTables(
    '## See [the docs](https://x.dev)\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  ok('trailing link is not treated as an anchor', lk[0].anchor === null, 'got ' + lk[0].anchor);
  ok('heading with a link is preserved',
    lk[0].heading === 'See [the docs](https://x.dev)', 'got ' + lk[0].heading);
}

group('parser robustness');
{
  ok('ignores tables inside code fences',
    parseMarkdownTables('```\n| a | b |\n| - | - |\n| 1 | 2 |\n```').length === 0);
  ok('ignores a header with no separator',
    parseMarkdownTables('| a | b |\n| 1 | 2 |').length === 0);
  ok('ignores separator with mismatched column count',
    parseMarkdownTables('| a | b |\n| --- |\n| 1 | 2 |').length === 0);
  const esc = parseMarkdownTables('| a | b |\n| - | - |\n| x \\| y | z |');
  ok('handles escaped pipes', esc[0].rows[0][0] === 'x | y', 'got ' + JSON.stringify(esc[0].rows[0]));
  const tick = parseMarkdownTables('| a | b |\n| - | - |\n| `p\\|q` | z |');
  ok('does not split inside inline code', tick[0].rows.length === 1);
  const pad = parseMarkdownTables('| a | b | c |\n| - | - | - |\n| 1 | 2 |');
  ok('pads short rows to column count', pad[0].rows[0].length === 3);
}

group('markdown list + prose parser');
{
  // Shaped after data/core-synthetics.json, which is almost entirely bullets.
  const md = [
    '# Synthetics support matrix',
    '',
    'There are various components that make up the Synthetics solution.',
    '',
    '## Private Locations [_private_locations_2]',
    '',
    '- **GA support**: 8.8.0 and higher',
    '- For running lightweight and browser monitors from your own infrastructure',
    '- Shipped as multiple `elastic-agent` variants:',
    '    - `elastic-agent-complete`, provided as a Docker image',
    '    - `elastic-agent` which only supports TCP, HTTP, and ICMP monitors.',
    '',
    '## Output to Elasticsearch',
    '',
    'Synthetics must have a direct connection to Elasticsearch.',
  ].join('\n');

  const { lists, prose } = parseMarkdownProse(md);

  const pl = lists.find(l => l.heading === 'Private Locations');
  ok('finds the list under its heading', !!pl);
  ok('strips the [anchor] from the heading', pl && pl.heading === 'Private Locations');
  ok('captures the anchor', pl && pl.anchor === '_private_locations_2', pl && pl.anchor);
  ok('FLATTENS nested bullets to match the original transcription',
    pl && pl.items.length === 5, pl && 'got ' + pl.items.length);
  ok('drops the bullet marker', pl && pl.items[0] === '**GA support**: 8.8.0 and higher',
    pl && JSON.stringify(pl.items[0]));
  ok('nested item is a sibling, not nested', pl &&
    pl.items[3] === '`elastic-agent-complete`, provided as a Docker image',
    pl && JSON.stringify(pl.items[3]));

  const op = prose.find(p => p.heading === 'Output to Elasticsearch');
  ok('captures prose under its heading', !!op);
  ok('prose text is the paragraph',
    op && op.text === 'Synthetics must have a direct connection to Elasticsearch.',
    op && JSON.stringify(op.text));
}

group('list parser robustness');
{
  ok('ignores bullets inside code fences',
    parseMarkdownProse('# H\n\n```\n- not a bullet\n```').lists.length === 0);
  ok('ignores table rows (parseMarkdownTables owns those)',
    parseMarkdownProse('# H\n\n| a | b |\n| - | - |\n| 1 | 2 |').lists.length === 0);

  const mixed = parseMarkdownProse('# H\n\n- one\n* two\n+ three');
  ok('treats -, * and + as the same marker',
    mixed.lists.length === 1 && mixed.lists[0].items.length === 3,
    JSON.stringify(mixed.lists));

  const num = parseMarkdownProse('# H\n\n1. first\n2. second');
  ok('handles numbered lists', num.lists[0].items.length === 2);

  const cont = parseMarkdownProse('# H\n\n- a bullet that\n  wraps onto the next line\n- second');
  ok('joins a wrapped continuation line onto its bullet',
    cont.lists[0].items[0] === 'a bullet that wraps onto the next line',
    JSON.stringify(cont.lists[0].items));
  ok('the following bullet is still separate', cont.lists[0].items.length === 2);

  ok('a list before any heading is not attributed to one',
    parseMarkdownProse('- orphan bullet').lists.every(l => l.heading === null));
}

group('markdown -> plain text');
{
  ok('strips links', plain('[Compatible](https://x.dev/y)') === 'Compatible');
  ok('strips backticks', plain('`1.x`') === '1.x');
  ok('strips bold', plain('**APM**') === 'APM');
  ok('keeps status symbols', plain('✅ 1.0+') === '✅ 1.0+');
  ok('collapses whitespace', plain('a   b\n c') === 'a b c');
}

group('plain(): docs-builder constructs (first-live-run regression)');
{
  // The first live run reported 55 of 65 cells "missing" on features.md. The
  // --explain output showed the real cause: Elastic's source is docs-builder
  // markdown, not plain markdown. These are FORMATTING, not drift.
  ok('reference-style link [text] unwrapped',
    plain('[Compatible]') === 'Compatible', JSON.stringify(plain('[Compatible]')));
  ok('full reference link [text][ref] unwrapped',
    plain('[Compatible][nomenclature]') === 'Compatible');
  ok('inline link still unwrapped',
    plain('[Service Maps](https://www.elastic.co/x)') === 'Service Maps');
  ok('{{substitution}} dropped — its rendered value is unknown to us',
    plain('{{product.apm}}') === '', JSON.stringify(plain('{{product.apm}}')));
  ok('mixed constructs resolve together',
    plain('**{{product.apm}}** is [Supported]') === 'is Supported',
    JSON.stringify(plain('**{{product.apm}}** is [Supported]')));
  ok('parenthesised text is NOT mistaken for a link',
    plain('Head-based sampling (HBS)') === 'Head-based sampling (HBS)');
  ok('directive colons stripped', plain(':::: note') === 'note');
}

group('cross-check: substitution-only and token-only cells are not counted');
{
  const cnt = (cells, html) =>
    crossCheck([{ heading: 'T', columns: ['a'], rows: cells.map(c => [c]) }], htmlToText(html));

  const sub = cnt(['{{product.apm}}'], '<p>APM</p>');
  ok('a substitution-only cell is skipped, not reported missing',
    sub.checked === 0 && sub.missing.length === 0,
    'checked=' + sub.checked + ' missing=' + sub.missing.length);

  const tok = cnt(['✅ 1.0+', '≥ 6.5', '1.x'], '<p>unrelated</p>');
  ok('version/symbol-only cells are skipped',
    tok.checked === 0 && tok.missing.length === 0,
    'checked=' + tok.checked + ' missing=' + tok.missing.length);

  const real = cnt(['Head-based sampling (HBS)'], '<p>unrelated</p>');
  ok('real prose cells are still checked and still flagged',
    real.checked === 1 && real.missing.length === 1);

  const ref = cnt(['[Compatible]'], '<p>Compatible</p>');
  ok('a reference-link cell now MATCHES the rendered page',
    ref.missing.length === 0, JSON.stringify(ref.missing));
}

group('HTML cross-check');
{
  const tables = [{ heading: 'T', columns: ['a', 'b'], rows: [['Supported', 'Not supported']] }];
  const good = htmlToText('<div><p>Supported</p><span>Not supported</span></div>');
  const r1 = crossCheck(tables, good);
  ok('all cells found -> no missing', r1.missing.length === 0, JSON.stringify(r1.missing));
  ok('counts what it checked', r1.checked === 2, 'got ' + r1.checked);

  const bad = htmlToText('<div><p>Supported</p></div>');
  const r2 = crossCheck(tables, bad);
  ok('missing cell is reported', r2.missing.length === 1 &&
    r2.missing[0].cell === 'Not supported', JSON.stringify(r2.missing));

  const r3 = crossCheck([{ heading: 'T', columns: ['a'], rows: [['✅']] }], good);
  ok('trivial cells (<4 chars) are skipped, not falsely flagged', r3.missing.length === 0);

  ok('entity decoding', htmlToText('<p>a &amp; b &nbsp;c</p>') === 'a & b c');
  ok('script/style stripped', htmlToText('<script>x=1</script><p>hi</p>') === 'hi');
}

group('cross-check: --explain classifies WHY a cell missed');
{
  // A miss is only actionable if you know the cause. The three causes differ
  // completely in what you should do about them.
  const mk = (cell, html) =>
    crossCheck([{ heading: 'T', columns: ['a'], rows: [[cell]] }], htmlToText(html))
      .missing[0];

  const suffix = mk('Supported with some caveats here',
    '<p>Supported with some caveats THEN DIFFERENT</p>');
  ok('prefix match, differing tail -> prefix-found-suffix-differs',
    suffix && suffix.reason === 'prefix-found-suffix-differs', suffix && suffix.reason);
  ok('...and it shows the rendered text for comparison',
    suffix && typeof suffix.htmlNearby === 'string' && suffix.htmlNearby.length > 0);

  const partial = mk('Kubernetes dashboard widget',
    '<p>Something about Kubernetes elsewhere</p>');
  ok('shared word only -> partial-word-match',
    partial && partial.reason === 'partial-word-match', partial && partial.reason);
  ok('...and it shows where that word appears',
    partial && /Kubernetes/.test(partial.htmlNearby || ''));

  const absent = mk('Zzzqqq Wwwxxx Yyyvvv', '<p>completely unrelated content</p>');
  ok('nothing in common -> absent-from-rendered-page',
    absent && absent.reason === 'absent-from-rendered-page', absent && absent.reason);
  ok('...and it offers no misleading nearby text', absent && !absent.htmlNearby);
}

/* ===================================================================
   2. diff policy — drive the real diff-refresh.js via fixtures
   =================================================================== */

function writeStaging(datasetId, mdPath, tables, errors) {
  fs.mkdirSync(STAGING, { recursive: true });
  fs.writeFileSync(
    path.join(STAGING, datasetId + '__' + mdPath.replace(/\//g, '_') + '.json'),
    JSON.stringify({
      datasetId, liveUrl: 'https://www.elastic.co/docs/x', mdPath,
      fetchedAt: new Date().toISOString(), tables, errors: errors || [],
    }, null, 2));
}

function clearStaging() {
  if (!fs.existsSync(STAGING)) return;
  for (const f of fs.readdirSync(STAGING)) fs.rmSync(path.join(STAGING, f), { force: true });
}

function runDiff() {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, 'diff-refresh.js'), '--json'],
      { encoding: 'utf8' });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    // non-zero exit is expected whenever review is needed
    return { code: e.status, json: JSON.parse(e.stdout) };
  }
}

// The real committed table we will diff against.
const apm = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'core-apm.json'), 'utf8'));
const combined = apm.sections.find(s => s.heading === 'All APM agents (combined view)');
const REAL_COLS = combined.columns.slice();
const REAL_ROWS = combined.rows.map(r => r.slice());

// Back up anything a test might modify.
fs.mkdirSync(TMP, { recursive: true });
fs.copyFileSync(path.join(DATA_DIR, 'core-apm.json'), path.join(TMP, 'core-apm.json'));
const restoreApm = () =>
  fs.copyFileSync(path.join(TMP, 'core-apm.json'), path.join(DATA_DIR, 'core-apm.json'));

group('diff: no changes');
{
  clearStaging();
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'All APM agents (combined view)', columns: REAL_COLS, rows: REAL_ROWS }]);
  const { code, json } = runDiff();
  ok('reports zero findings', json.findings.length === 0, JSON.stringify(json.findings.slice(0, 2)));
  ok('exits 0 when nothing to review', code === 0, 'exit ' + code);
}

group('diff: row added -> auto');
{
  clearStaging();
  const rows = REAL_ROWS.concat([['Rust agent', '`1.x`', '≥ `9.2`']]);
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'All APM agents (combined view)', columns: REAL_COLS, rows }]);
  const { code, json } = runDiff();
  const add = json.findings.find(f => f.kind === 'rows-added');
  ok('addition detected', !!add);
  ok('severity is auto', add && add.severity === 'auto');
  ok('the new row is carried', add && add.rows[0][0] === 'Rust agent');
  ok('exits 0 — additions alone need no review', code === 0, 'exit ' + code);
  ok('counts 1 auto, 0 review', json.counts.auto === 1 && json.counts.review === 0,
    JSON.stringify(json.counts));
}

group('diff: --apply-additions actually writes');
{
  clearStaging();
  const rows = REAL_ROWS.concat([['Rust agent', '`1.x`', '≥ `9.2`']]);
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'All APM agents (combined view)', columns: REAL_COLS, rows }]);
  execFileSync(process.execPath, [path.join(HERE, 'diff-refresh.js'), '--apply-additions'],
    { encoding: 'utf8' });
  const after = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'core-apm.json'), 'utf8'));
  const sec = after.sections.find(s => s.heading === 'All APM agents (combined view)');
  ok('row was appended to data/', sec.rows.some(r => r[0] === 'Rust agent'));
  ok('row count grew by exactly 1', sec.rows.length === REAL_ROWS.length + 1,
    'got ' + sec.rows.length);
  restoreApm();
  const restored = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'core-apm.json'), 'utf8'));
  ok('fixture restored cleanly',
    restored.sections.find(s => s.heading === 'All APM agents (combined view)')
      .rows.length === REAL_ROWS.length);
}

group('diff: cell changed -> REVIEW, never auto');
{
  clearStaging();
  const rows = REAL_ROWS.map(r => r.slice());
  const i = rows.findIndex(r => r[0] === 'Go agent');
  rows[i][2] = '≥ `9.9`';   // pretend Elastic raised the floor
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'All APM agents (combined view)', columns: REAL_COLS, rows }]);
  const { code, json } = runDiff();
  const ch = json.findings.find(f => f.kind === 'cells-changed');
  ok('change detected', !!ch);
  ok('severity is review', ch && ch.severity === 'review');
  ok('before/after both reported', ch && ch.cells[0].before === '≥ `6.5`' &&
    ch.cells[0].after === '≥ `9.9`', ch && JSON.stringify(ch.cells[0]));
  ok('exits non-zero to block CI', code === 1, 'exit ' + code);
  ok('no additions were queued', json.counts.auto === 0);
}

group('diff: multi-row subjects are keyed correctly (regression)');
{
  // REGRESSION GUARD. "Go agent" appears twice in the combined table (1.x and
  // 2.x), as do Ruby (3.x/4.x) and JavaScript RUM (4.x/5.x). Keying rows on
  // column 0 alone collapsed them in a Map, so a change on the SECOND row was
  // silently dropped — the worst possible failure for a safety tool.
  clearStaging();
  const rows = REAL_ROWS.map(r => r.slice());
  const second = rows.findIndex(r => r[0] === 'Go agent' && r[1] === '`2.x`');
  ok('fixture really has a shadowed second Go row', second !== -1);
  rows[second][2] = '≥ `9.9`';
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'All APM agents (combined view)', columns: REAL_COLS, rows }]);
  const { code, json } = runDiff();
  const ch = json.findings.find(f => f.kind === 'cells-changed');
  ok('change on the SECOND Go row is detected', !!ch,
    JSON.stringify(json.findings.map(f => f.kind)));
  ok('the row label disambiguates which Go row', ch && /2\.x/.test(ch.row),
    ch && ch.row);
  ok('the 1.x row is NOT falsely reported',
    json.findings.filter(f => f.kind === 'cells-changed').length === 1,
    JSON.stringify(json.findings.filter(f => f.kind === 'cells-changed')));
  ok('no spurious added/removed from the duplicate keys',
    !json.findings.some(f => f.kind === 'rows-added' || f.kind === 'rows-removed'),
    JSON.stringify(json.findings.map(f => f.kind)));
  ok('exits non-zero', code === 1, 'exit ' + code);
}

group('diff: genuinely ambiguous rows escalate rather than guess');
{
  clearStaging();
  // Two rows identical in every key column but differing in the value column.
  writeStaging('apm-agents', 'a.md', [{
    heading: 'All APM agents (combined view)',
    columns: REAL_COLS,
    rows: [['Dup agent', '`1.x`', '≥ `1.0`'], ['Dup agent', '`1.x`', '≥ `2.0`']],
  }]);
  const { code, json } = runDiff();
  ok('ambiguity is reported', json.findings.some(f => f.kind === 'ambiguous-rows'),
    JSON.stringify(json.findings.map(f => f.kind)));
  ok('severity is review', json.findings.find(f => f.kind === 'ambiguous-rows').severity === 'review');
  ok('exits non-zero', code === 1);
}

group('diff: row removed -> REVIEW');
{
  clearStaging();
  const rows = REAL_ROWS.filter(r => r[0] !== 'PHP agent');
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'All APM agents (combined view)', columns: REAL_COLS, rows }]);
  const { code, json } = runDiff();
  const rm = json.findings.find(f => f.kind === 'rows-removed');
  ok('removal detected', !!rm);
  ok('severity is review', rm && rm.severity === 'review');
  ok('explains the ambiguity', rm && /parse missed them/.test(rm.detail));
  ok('exits non-zero', code === 1);
}

group('diff: columns changed -> REVIEW, no row diff attempted');
{
  clearStaging();
  writeStaging('apm-agents', 'a.md', [{
    heading: 'All APM agents (combined view)',
    columns: ['Agent', 'Version', 'Integration', 'Notes'],
    rows: [['Go agent', '`1.x`', '≥ `6.5`', 'n/a']],
  }]);
  const { code, json } = runDiff();
  const cc = json.findings.find(f => f.kind === 'columns-changed');
  ok('column drift detected', !!cc);
  ok('severity is review', cc && cc.severity === 'review');
  ok('no rows-removed noise from the reshape',
    !json.findings.some(f => f.kind === 'rows-removed'),
    JSON.stringify(json.findings.map(f => f.kind)));
  ok('exits non-zero', code === 1);
}

group('diff: brand-new table -> REVIEW');
{
  clearStaging();
  writeStaging('apm-agents', 'a.md', [{
    heading: 'Some heading Elastic just added',
    columns: ['X', 'Y'], rows: [['1', '2']],
  }]);
  const { code, json } = runDiff();
  const nt = json.findings.find(f => f.kind === 'new-table');
  ok('new table detected', !!nt);
  ok('severity is review', nt && nt.severity === 'review');
  ok('exits non-zero', code === 1);
}

group('diff: fetch problems surface as review');
{
  clearStaging();
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'All APM agents (combined view)', columns: REAL_COLS, rows: REAL_ROWS }],
    ['markdown fetch failed (404)']);
  const { code, json } = runDiff();
  ok('fetch problem reported', json.findings.some(f => f.kind === 'fetch-problem'));
  ok('exits non-zero', code === 1);
}

group('diff: predicts which rule quotes would break');
{
  // The Java-agent known-issue rule quotes a sentence stored in core-apm.json's
  // notes. Simulate the docs changing a cell that a rule quotes.
  clearStaging();
  const sec = apm.sections.find(s => s.heading === 'Java agent');
  const rows = sec.rows.map(r => r.slice());
  rows[0][1] = '≥ `7.0`';
  writeStaging('apm-agents', 'a.md',
    [{ heading: 'Java agent', columns: sec.columns, rows }]);
  const { json } = runDiff();
  ok('change detected on the Java agent table',
    json.findings.some(f => f.kind === 'cells-changed' && f.heading === 'Java agent'));
  ok('quotesAtRisk is an array (may be empty for a non-quoted cell)',
    Array.isArray(json.quotesAtRisk));
}

group('diff: rule-quote risk fires on quoted text');
{
  clearStaging();
  // 'path-apm-server-otel' quotes: "Telemetry might ingest but mapping,
  // enrichment, and troubleshooting are not guaranteed." — which lives in a
  // row of the EDOT SDK ingestion table.
  const sdk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'core-edot-sdks-compat.json'), 'utf8'));
  const isec = sdk.sections.find(s => s.heading === 'Support matrix for EDOT SDK ingestion');
  const rows = isec.rows.map(r => r.slice());
  const ri = rows.findIndex(r => /APM Server OTel intake/.test(r[0]));
  rows[ri][2] = 'This path is now fully supported.';
  writeStaging('edot-sdks-compat', 'sdks.md',
    [{ heading: isec.heading, columns: isec.columns, rows }]);
  const { code, json } = runDiff();
  ok('cell change detected', json.findings.some(f => f.kind === 'cells-changed'));
  ok('the affected rule is named',
    json.quotesAtRisk.some(r => r.ruleId === 'path-apm-server-otel'),
    JSON.stringify(json.quotesAtRisk));
  ok('exits non-zero', code === 1);
}

/* ---------------------------------------------------------------- cleanup */
clearStaging();
restoreApm();
fs.rmSync(TMP, { recursive: true, force: true });
if (fs.existsSync(STAGING) && !fs.readdirSync(STAGING).length) {
  fs.rmSync(STAGING, { recursive: true, force: true });
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
if (fail) { console.log('REFRESH TESTS FAILED'); process.exit(1); }
console.log('ALL REFRESH TESTS PASSED');
