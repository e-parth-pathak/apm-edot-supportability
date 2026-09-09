#!/usr/bin/env node
/**
 * check-css.js — static CSS guard for the hidden-attribute cascade.
 *
 * WHY THIS EXISTS
 * ---------------
 * The browse view is a `<div class="layout" hidden>`. The UA stylesheet says
 * `[hidden] { display: none }`, but `.layout { display: grid }` is an author
 * rule, so it WINS — setting `.hidden = true` in JS left every support-matrix
 * card on screen above the checker form.
 *
 * A DOM test cannot catch this: jsdom's getComputedStyle returns "none" for
 * `[hidden]` regardless of competing author rules, so it reports the page as
 * correct while a real browser shows the bug. (Verified — see README.)
 *
 * So this checks the stylesheet as text instead: every element that the app
 * toggles via the `hidden` attribute must either declare no `display`, or be
 * covered by a `[hidden] { display: none !important }` override.
 *
 *   node check-css.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

let errors = 0;
const fail = m => { console.log('  ✗ ' + m); errors++; };
const pass = m => console.log('  ✓ ' + m);

/* -- 1. is there a global !important override for [hidden]? --------------- */

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
const globalOverride =
  /(^|[\s,}])\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/m.test(stripped);

if (globalOverride) {
  pass('[hidden] { display: none !important } is present — cascade is safe');
} else {
  fail('no global `[hidden] { display: none !important }` rule found in styles.css');
}

/* -- 2. which elements does the app toggle via .hidden? ------------------- */

const toggled = new Set();
// e.g.  browse.hidden = isCheck;   /   if (browseFoot) browseFoot.hidden = ...
const varToId = {};
const declRe = /var\s+(\w+)\s*=\s*document\.getElementById\(['"]([^'"]+)['"]\)/g;
let m;
while ((m = declRe.exec(appJs))) varToId[m[1]] = m[2];

const hiddenRe = /(\w+)\.hidden\s*=/g;
while ((m = hiddenRe.exec(appJs))) {
  if (varToId[m[1]]) toggled.add(varToId[m[1]]);
}

if (!toggled.size) fail('could not detect any element toggled via .hidden in app.js');
else pass('elements toggled via .hidden: ' + [...toggled].join(', '));

/* -- 3. for each, does its own class declare a competing `display`? ------- */

for (const id of toggled) {
  // find the element's class list in index.html
  const tagRe = new RegExp('<[^>]*id="' + id + '"[^>]*>', 'i');
  const tag = (html.match(tagRe) || [''])[0];
  const classes = ((tag.match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean);

  for (const cls of classes) {
    const ruleRe = new RegExp('(^|[\\s,}])\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\s*\\{([^}]*)\\}', 'm');
    const rule = stripped.match(ruleRe);
    if (!rule) continue;
    if (/display\s*:/.test(rule[2])) {
      if (globalOverride) {
        pass('#' + id + ' (.' + cls + ') sets `display` but the !important override covers it');
      } else {
        fail('#' + id + ' (.' + cls + ') sets `display` and would beat [hidden] — ' +
          'it would stay visible when toggled hidden');
      }
    }
  }
}

/* -- 4. the .filterbar[hidden] rule must not be the only protection ------- */

if (/\.filterbar\[hidden\]/.test(stripped) && !globalOverride) {
  fail('.filterbar[hidden] is scoped to one element only — other toggled views are unprotected');
}

console.log('\n--- summary ---');
console.log('toggled elements checked : ' + toggled.size);
console.log('errors                   : ' + errors);

if (errors) {
  console.log('\nCSS CHECK FAILED — a view toggled with the hidden attribute can still render.');
  process.exit(1);
}
console.log('\nCSS CHECK PASSED — hidden views cannot be overridden by author display rules.');
