#!/usr/bin/env node
/**
 * dev.js — dev loop: verify + build, start the server, then rebuild on change.
 *
 *   node dev.js          -> http://localhost:3000
 *
 * Watches data/*.json and the three source files in public/ (index.html,
 * styles.css, app.js). It deliberately does NOT watch the generated files
 * (public/data.json, public/standalone.html, public/artifact.html) — that
 * would cause a rebuild loop.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const SOURCE_FILES = ['index.html', 'styles.css', 'app.js', 'engine.js', 'checkers.js']
  .map(f => path.join(HERE, 'public', f));
const DATA_DIR = path.join(HERE, 'data');

function run(script) {
  const r = spawnSync(process.execPath, [path.join(HERE, script)], { stdio: 'inherit' });
  return r.status === 0;
}

function rebuild(reason) {
  console.log('\n─── rebuild (' + reason + ') ' + new Date().toLocaleTimeString() + ' ───');
  if (!run('verify.js')) {
    console.log('\n!! verify.js failed — build skipped. Fix the data and save again.');
    return;
  }
  if (!run('check-quotes.js')) {
    console.log('\n!! check-quotes.js failed — a rule cites text not in the scraped docs. Build skipped.');
    return;
  }
  if (!run('check-css.js')) {
    console.log('\n!! check-css.js failed — a hidden view could still render. Build skipped.');
    return;
  }
  if (!run('build.js')) {
    console.log('\n!! build.js failed.');
    return;
  }
  console.log('Ready. Reload http://localhost:' + (process.env.PORT || 3000));
}

// Initial build must succeed before we bother starting the server.
console.log('=== initial verify + build ===');
if (!run('verify.js') || !run('check-quotes.js') || !run('check-css.js') || !run('build.js')) {
  console.error('\nInitial build failed. Not starting the server.');
  process.exit(1);
}

const server = spawn(process.execPath, [path.join(HERE, 'server.js')], { stdio: 'inherit' });
server.on('exit', code => process.exit(code || 0));

// Debounce: editors often fire several events for one save.
let timer = null;
function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(reason), 150);
}

fs.watch(DATA_DIR, (_e, file) => {
  if (file && file.endsWith('.json')) schedule('data/' + file);
});

for (const f of SOURCE_FILES) {
  fs.watchFile(f, { interval: 300 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) schedule('public/' + path.basename(f));
  });
}

console.log('\nWatching data/*.json and public/{index.html,styles.css,app.js,engine.js,checkers.js}.');
console.log('Ctrl-C to stop.\n');

process.on('SIGINT', () => { server.kill('SIGINT'); process.exit(0); });
