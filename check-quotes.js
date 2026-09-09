#!/usr/bin/env node
/**
 * check-quotes.js — grounding check for the rules engine.
 *
 * Every rule in data/rules.json declares a `quote`. This script asserts that
 * quote appears VERBATIM somewhere in the scraped dataset it names (datasetId),
 * so a rule can never cite text that isn't actually in the Elastic docs we read.
 *
 * Also checks: remedyQuote, caveats[].quote, and that every sourceUrl host is
 * allow-listed.
 *
 *   node check-quotes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const RULES = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rules.json'), 'utf8'));

const ALLOWED_HOSTS = [
  'www.elastic.co', 'elastic.co', 'opentelemetry.io', 'github.com',
  'docs.redhat.com', 'aws-otel.github.io', 'learn.microsoft.com',
  'dotnet.microsoft.com', 'packagist.org', 'platform.openai.com',
  'docs.aws.amazon.com', 'boto3.amazonaws.com', 'www.apache.org',
];

let errors = 0, warnings = 0, checked = 0;
const fail = m => { console.log('  ✗ ' + m); errors++; };
const warn = m => { console.log('  ! ' + m); warnings++; };

/** Flatten a dataset file into one big searchable string. */
function datasetText(id) {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && f !== 'rules.json');
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    if (d.id === id) return { file: f, text: JSON.stringify(d) };
  }
  return null;
}

const cache = new Map();
function textFor(id) {
  if (!cache.has(id)) cache.set(id, datasetText(id));
  return cache.get(id);
}

/**
 * JSON.stringify escapes the text, so compare against the escaped form too.
 * Normalises the curly/straight apostrophe difference only — nothing else.
 */
function contains(haystack, needle) {
  const variants = [
    needle,
    JSON.stringify(needle).slice(1, -1),
    needle.replace(/'/g, '’'),
    JSON.stringify(needle.replace(/'/g, '’')).slice(1, -1),
    needle.replace(/’/g, "'"),
    JSON.stringify(needle.replace(/’/g, "'")).slice(1, -1),
  ];
  return variants.some(v => haystack.indexOf(v) !== -1);
}

function checkUrl(url, where) {
  let host;
  try { host = new URL(url).hostname; }
  catch (e) { return fail(where + ': not a valid URL: ' + url); }
  if (!ALLOWED_HOSTS.includes(host)) fail(where + ': host not allow-listed: ' + host);
}

function checkQuote(quote, datasetId, where) {
  checked++;
  if (!quote) return fail(where + ': no quote');
  if (!datasetId) return warn(where + ': no datasetId, cannot ground the quote');
  const ds = textFor(datasetId);
  if (!ds) return fail(where + ': datasetId "' + datasetId + '" matches no dataset file');
  if (!contains(ds.text, quote)) {
    fail(where + ': quote NOT FOUND verbatim in ' + ds.file + '\n      quote: ' +
      JSON.stringify(quote.slice(0, 120) + (quote.length > 120 ? '…' : '')));
  }
}

console.log('Grounding ' + RULES.rules.length + ' rules against data/*.json\n');

for (const r of RULES.rules) {
  const where = 'rule "' + r.id + '"';
  if (!r.id) fail('a rule has no id');
  if (!r.kind) fail(where + ': no kind');
  if (!r.sourceUrl) fail(where + ': no sourceUrl');
  else checkUrl(r.sourceUrl, where);

  checkQuote(r.quote, r.datasetId, where);

  if (r.remedyQuote) {
    checkQuote(r.remedyQuote, r.remedyDatasetId || r.datasetId, where + ' (remedyQuote)');
    if (r.remedySourceUrl) checkUrl(r.remedySourceUrl, where + ' (remedySourceUrl)');
  }
  (r.caveats || []).forEach((c, i) => {
    checkQuote(c.quote, r.datasetId, where + ' caveat[' + i + ']');
    if (c.sourceUrl) checkUrl(c.sourceUrl, where + ' caveat[' + i + '] sourceUrl');
  });

  // A rule that reads a live table must name a section that exists.
  if (r.readsFrom) {
    const ds = textFor(r.readsFrom.datasetId);
    if (!ds) fail(where + ': readsFrom.datasetId "' + r.readsFrom.datasetId + '" not found');
    else if (ds.text.indexOf(JSON.stringify(r.readsFrom.sectionHeading).slice(1, -1)) === -1) {
      fail(where + ': readsFrom.sectionHeading "' + r.readsFrom.sectionHeading + '" not found in ' + ds.file);
    }
  }
}

// Undocumented cases must also cite a page.
for (const c of (RULES.undocumented && RULES.undocumented.cases) || []) {
  const where = 'undocumented case "' + c.id + '"';
  if (!c.headline) fail(where + ': no headline');
  if (!c.detail) fail(where + ': no detail');
  if (!c.sourceUrl) fail(where + ': no sourceUrl');
  else checkUrl(c.sourceUrl, where);
}

console.log('\n--- summary ---');
console.log('rules              : ' + RULES.rules.length);
console.log('quotes checked     : ' + checked);
console.log('undocumented cases : ' + ((RULES.undocumented && RULES.undocumented.cases) || []).length);
console.log('errors             : ' + errors);
console.log('warnings           : ' + warnings);

if (errors) { console.log('\nGROUNDING FAILED — a rule cites text not present in the scraped docs.'); process.exit(1); }
console.log('\nGROUNDING PASSED — every rule quote appears verbatim in the scraped doc data.');
