#!/usr/bin/env node
/**
 * check-freshness.js — build gate on data age.
 *
 * Compatibility docs change. Data that silently ages is worse than data
 * labelled stale, because the checkers give confident verdicts either way.
 * This gate makes age a build-visible fact.
 *
 *   node check-freshness.js            warn past maxAgeDays, fail past hard limit
 *   node check-freshness.js --strict   fail at maxAgeDays (used by the weekly job)
 *
 * Thresholds live in data/sources.json (maxAgeDays, maxAgeDaysHardFail).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STRICT = process.argv.includes('--strict');

const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sources.json'), 'utf8'));
const freshPath = path.join(DATA_DIR, 'freshness.json');

if (!fs.existsSync(freshPath)) {
  console.error('✗ data/freshness.json is missing — cannot establish data provenance.');
  process.exit(1);
}
const fresh = JSON.parse(fs.readFileSync(freshPath, 'utf8'));

const soft = manifest.maxAgeDays || 45;
const hard = manifest.maxAgeDaysHardFail || 120;

if (!fresh.lastRefreshed) {
  console.error('✗ freshness.json has no lastRefreshed date.');
  process.exit(1);
}

const then = new Date(fresh.lastRefreshed + 'T00:00:00Z');
if (isNaN(then.getTime())) {
  console.error('✗ lastRefreshed is not a valid YYYY-MM-DD date: ' + fresh.lastRefreshed);
  process.exit(1);
}

const ageDays = Math.floor((Date.now() - then.getTime()) / 86400000);

console.log('Data freshness');
console.log('  last refreshed : ' + fresh.lastRefreshed + '  (' + ageDays + ' days ago)');
console.log('  method         : ' + (fresh.method || 'unknown'));
console.log('  cross-checked  : ' + (fresh.crossChecked ? 'yes' : 'no'));
console.log('  pages covered  : ' + (fresh.pagesCovered != null ? fresh.pagesCovered : '?'));
console.log('  thresholds     : warn > ' + soft + 'd, fail > ' + hard + 'd' +
  (STRICT ? '  (--strict: fail > ' + soft + 'd)' : ''));

const commits = Object.keys(fresh.sourceCommits || {}).length;
console.log('  source commits : ' + (commits ? commits + ' recorded' : 'none recorded'));

if (!fresh.crossChecked) {
  console.log('\n  ! This data was not produced by a cross-checked refresh.js run.');
  console.log('    ' + (fresh.crossCheckNote || ''));
}

let exit = 0;
if (ageDays > hard) {
  console.log('\n✗ STALE: data is ' + ageDays + ' days old, past the hard limit of ' + hard + '.');
  console.log('  Run: node refresh.js && node diff-refresh.js');
  exit = 1;
} else if (ageDays > soft) {
  const label = STRICT ? '✗ STALE' : '! AGEING';
  console.log('\n' + label + ': data is ' + ageDays + ' days old (threshold ' + soft + ').');
  console.log('  Run: node refresh.js && node diff-refresh.js');
  if (STRICT) exit = 1;
} else {
  console.log('\n✓ FRESH: within the ' + soft + '-day window.');
}

process.exit(exit);
