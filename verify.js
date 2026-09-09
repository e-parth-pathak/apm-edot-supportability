#!/usr/bin/env node
/**
 * verify.js — citation & integrity checks on data/*.json.
 *
 * Fails if anything shown in the UI would lack a documentation reference,
 * or if a source URL points somewhere outside the allow-listed doc domains.
 *
 *   node verify.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ALLOWED_HOSTS = [
  'www.elastic.co',
  'elastic.co',
  'opentelemetry.io',
  'github.com',
  'docs.redhat.com',
  'aws-otel.github.io',
  'learn.microsoft.com',
  'dotnet.microsoft.com',
  'packagist.org',
  'platform.openai.com',
  'docs.aws.amazon.com',
  'boto3.amazonaws.com',
  'www.apache.org',
];

let errors = 0, warnings = 0;
const fail = m => { console.log('  ✗ ' + m); errors++; };
const warn = m => { console.log('  ! ' + m); warnings++; };

// rules.json is the rules engine, not a scraped dataset — it has its own
// schema and its own checker (check-quotes.js), so it is excluded here.
const NOT_A_DATASET = ['rules.json'];

const files = fs.readdirSync(DATA_DIR)
  .filter(f => f.endsWith('.json') && !NOT_A_DATASET.includes(f))
  .sort();
let sections = 0, tables = 0, rows = 0, cited = 0;
const urls = new Set();

console.log('Verifying ' + files.length + ' data files in data/\n');

for (const f of files) {
  console.log(f);
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }
  catch (e) { fail('unparseable JSON: ' + e.message); continue; }

  if (!d.id) fail('missing top-level "id"');
  if (!Array.isArray(d.sources) || !d.sources.length) fail('missing top-level "sources" array');
  (d.sources || []).forEach(s => {
    if (!s.url) fail('a source has no url');
    else urls.add(s.url);
  });

  if (!Array.isArray(d.sections)) { fail('missing "sections" array'); continue; }

  d.sections.forEach((s, i) => {
    sections++;
    const where = `section[${i}] "${s.heading || '(no heading)'}"`;
    if (!s.heading) fail(where + ': no heading');
    if (!s.sourceUrl) { fail(where + ': NO sourceUrl — would appear uncited in the UI'); return; }
    cited++;
    urls.add(s.sourceUrl);

    let host;
    try { host = new URL(s.sourceUrl).hostname; }
    catch (e) { fail(where + ': sourceUrl is not a valid URL: ' + s.sourceUrl); return; }
    if (!ALLOWED_HOSTS.includes(host)) fail(where + ': sourceUrl host not allow-listed: ' + host);

    if (s.type === 'table') {
      tables++;
      if (!Array.isArray(s.columns) || !s.columns.length) fail(where + ': table has no columns');
      if (!Array.isArray(s.rows) || !s.rows.length) warn(where + ': table has no rows');
      (s.rows || []).forEach((r, ri) => {
        rows++;
        if (!Array.isArray(r)) return fail(where + ` row[${ri}] is not an array`);
        if (r.length !== (s.columns || []).length) {
          fail(where + ` row[${ri}] has ${r.length} cells but ${s.columns.length} columns`);
        }
      });
    } else if (s.type === 'list') {
      if (!Array.isArray(s.items) || !s.items.length) warn(where + ': list has no items');
    } else if (s.type === 'prose') {
      if (!s.text) fail(where + ': prose has no text');
    } else {
      fail(where + ': unknown type "' + s.type + '"');
    }
  });
}

// Any markdown link in any string must be http(s) — no javascript: etc.
const raw = files.map(f => fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).join('\n');
const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
let m;
while ((m = linkRe.exec(raw))) {
  if (!/^https?:\/\//.test(m[1]) && !/^#/.test(m[1])) {
    fail('non-http inline link found: ' + m[1]);
  }
}

console.log('\n--- summary ---');
console.log('files           : ' + files.length);
console.log('sections        : ' + sections);
console.log('  with sourceUrl: ' + cited + (cited === sections ? '  (100%)' : '  <-- GAP'));
console.log('tables          : ' + tables);
console.log('table rows      : ' + rows);
console.log('distinct URLs   : ' + urls.size);
console.log('errors          : ' + errors);
console.log('warnings        : ' + warnings);

if (errors) { console.log('\nVERIFY FAILED'); process.exit(1); }
console.log('\nVERIFY PASSED — every rendered section carries a documentation reference.');
