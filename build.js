#!/usr/bin/env node
/**
 * build.js — merges data/*.json into public/data.json (served by server.js)
 * and public/standalone.html (single self-contained file, data inlined).
 *
 * Every dataset entry keeps the exact source doc URL it was scraped from.
 * No data is transformed, inferred, or added here — only grouped and ordered.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Display order + grouping. Keys are the `id` inside each data file. */
const ORDER = [
  { file: 'core-apm.json',                group: 'Classic APM' },

  { file: 'core-edot-sdk-features.json',  group: 'EDOT SDKs' },
  { file: 'sdk-dotnet.json',              group: 'EDOT SDKs', title: 'EDOT .NET' },
  { file: 'sdk-java.json',                group: 'EDOT SDKs', title: 'EDOT Java' },
  { file: 'sdk-node.json',                group: 'EDOT SDKs', title: 'EDOT Node.js' },
  { file: 'sdk-php.json',                 group: 'EDOT SDKs', title: 'EDOT PHP' },
  { file: 'sdk-python.json',              group: 'EDOT SDKs', title: 'EDOT Python' },
  { file: 'sdk-android.json',             group: 'EDOT SDKs', title: 'EDOT Android' },
  { file: 'sdk-ios.json',                 group: 'EDOT SDKs', title: 'EDOT iOS' },
  { file: 'sdk-browser.json',             group: 'EDOT SDKs', title: 'EDOT Browser' },

  { file: 'core-edot-features.json',      group: 'EDOT compatibility' },
  { file: 'core-edot-collectors.json',    group: 'EDOT compatibility' },
  { file: 'core-edot-sdks-compat.json',   group: 'EDOT compatibility' },
  { file: 'core-edot-vs-upstream.json',   group: 'EDOT compatibility' },
  { file: 'core-edot-limitations.json',   group: 'EDOT compatibility' },
  { file: 'core-edot-nomenclature.json',  group: 'EDOT compatibility' },
  { file: 'core-edot-data-streams.json',  group: 'EDOT compatibility' },

  { file: 'core-synthetics.json',         group: 'Synthetics' },
];

function load() {
  const datasets = [];
  const problems = [];

  for (const entry of ORDER) {
    const p = path.join(DATA_DIR, entry.file);
    if (!fs.existsSync(p)) { problems.push(`MISSING FILE: ${entry.file}`); continue; }
    let d;
    try { d = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { problems.push(`BAD JSON in ${entry.file}: ${e.message}`); continue; }

    d.group = entry.group;
    d.title = d.title || entry.title || d.language || d.id;
    d.sourceFile = entry.file;
    d.sections = d.sections || [];

    // Integrity: every section must carry a source URL.
    d.sections.forEach((s, i) => {
      if (!s.sourceUrl) problems.push(`${entry.file} section[${i}] "${s.heading}" has NO sourceUrl`);
    });
    if (!d.sources || !d.sources.length) problems.push(`${entry.file} has no top-level sources[]`);

    datasets.push(d);
  }
  return { datasets, problems };
}

function stats(datasets) {
  let tables = 0, rows = 0, lists = 0, items = 0, prose = 0;
  for (const d of datasets) for (const s of d.sections) {
    if (s.type === 'table') { tables++; rows += (s.rows || []).length; }
    else if (s.type === 'list') { lists++; items += (s.items || []).length; }
    else prose++;
  }
  return { datasets: datasets.length, tables, rows, lists, items, prose };
}

const { datasets, problems } = load();
const allSources = [];
const seen = new Set();
for (const d of datasets) for (const s of d.sources || []) {
  if (!seen.has(s.url)) { seen.add(s.url); allSources.push({ ...s, group: d.group }); }
}

// The cited rules engine travels with the data so the checkers work offline
// and inside the single-file builds.
let rules = null;
const rulesPath = path.join(DATA_DIR, 'rules.json');
if (fs.existsSync(rulesPath)) {
  try {
    rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    (rules.rules || []).forEach((r, i) => {
      if (!r.quote) problems.push(`rules.json rule[${i}] "${r.id}" has NO quote`);
      if (!r.sourceUrl) problems.push(`rules.json rule[${i}] "${r.id}" has NO sourceUrl`);
    });
  } catch (e) {
    problems.push(`BAD JSON in rules.json: ${e.message}`);
  }
} else {
  problems.push('MISSING FILE: rules.json — the checkers will be disabled');
}

const bundle = {
  generatedAt: new Date().toISOString(),
  note: 'Every value in this bundle is a verbatim transcription of the linked Elastic documentation page. Each section carries the exact source URL (with anchor) it came from.',
  stats: stats(datasets),
  sources: allSources,
  datasets,
  rules,
};

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(path.join(PUBLIC_DIR, 'data.json'), JSON.stringify(bundle, null, 2));

// ---- standalone single-file build -------------------------------------------
const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
const engineJs = fs.readFileSync(path.join(PUBLIC_DIR, 'engine.js'), 'utf8');
const checkersJs = fs.readFileSync(path.join(PUBLIC_DIR, 'checkers.js'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

// NOTE: use function replacers. The doc text contains sequences like `$` + backtick
// and `$&`, which String.replace would otherwise interpret as replacement patterns
// and silently corrupt the inlined bundle.
const inlineJson = JSON.stringify(bundle).replace(/</g, '\\u003c');
const standalone = html
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script src="engine.js"></script>', () => `<script>\n${engineJs}\n</script>`)
  .replace('<script src="checkers.js"></script>', () => `<script>\n${checkersJs}\n</script>`)
  .replace(
    '<script src="app.js"></script>',
    () => `<script>window.__BUNDLED_DATA__ = ${inlineJson};</script>\n<script>\n${js}\n</script>`
  );

if (/<script src="(engine|checkers|app)\.js"><\/script>/.test(standalone)) {
  console.error('FATAL: a script tag was not inlined into standalone.html.');
  process.exit(1);
}

// Guard: the inlined bundle must still parse.
try {
  const m = standalone.match(/window\.__BUNDLED_DATA__ = ([\s\S]*?);<\/script>/);
  if (!m) throw new Error('bundle marker not found in standalone.html');
  JSON.parse(m[1].replace(/\\u003c/g, '<'));
} catch (e) {
  console.error('FATAL: standalone.html bundle is not valid JSON — ' + e.message);
  process.exit(1);
}
fs.writeFileSync(path.join(PUBLIC_DIR, 'standalone.html'), standalone);

// ---- artifact variant ------------------------------------------------------
// Same page, but defaults to light on first load instead of following
// prefers-color-scheme, because it renders inside a light-mode host UI.
// The light/dark toggle still works and still persists.
const artifact = standalone
  .replace(
    "      saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)\n        ? 'dark' : 'light';",
    () => "      saved = 'light';"
  )
  .replace(':root {', () => ':root { color-scheme: light;')
  .replace('[data-theme="dark"] {', () => '[data-theme="dark"] { color-scheme: dark;');

if (artifact.indexOf("saved = 'light';") === -1 || artifact.indexOf('color-scheme: light;') === -1) {
  console.error('FATAL: artifact.html theme patch did not apply — app.js/styles.css changed shape.');
  process.exit(1);
}
fs.writeFileSync(path.join(PUBLIC_DIR, 'artifact.html'), artifact);

console.log('Built public/data.json, public/standalone.html and public/artifact.html');
console.log('Stats:', JSON.stringify(bundle.stats));
if (problems.length) {
  console.log('\nINTEGRITY PROBLEMS (' + problems.length + '):');
  problems.forEach(p => console.log('  - ' + p));
  process.exitCode = 1;
} else {
  console.log('Integrity check: OK — every section has a source URL, every dataset has sources[].');
}
