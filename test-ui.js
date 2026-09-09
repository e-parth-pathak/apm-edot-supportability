#!/usr/bin/env node
/**
 * test-ui.js — drives the real UI in a headless DOM (jsdom).
 *
 * Confirms the page renders, both modes work, all three checker forms produce
 * findings, and — the invariant that matters — every finding shown to a user
 * carries a link to an Elastic doc page.
 *
 *   npm i --no-save jsdom
 *   node build.js && node test-ui.js
 *
 * jsdom is a dev-only, unsaved dependency; the app itself has none.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('SKIPPED: jsdom is not installed.  Run:  npm i --no-save jsdom');
  process.exit(0);
}

const FILE = path.join(__dirname, 'public', 'standalone.html');
if (!fs.existsSync(FILE)) {
  console.error('public/standalone.html missing — run: node build.js');
  process.exit(1);
}

// jsdom defines window.scrollTo but throws "Not implemented" on call, which
// prints a virtual-console error on every mode switch. Stub it out — real
// scroll behaviour isn't what this suite is testing.
const { VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  if (!/Not implemented: Window's scrollTo/.test(e.message)) console.error(e.message);
});

const dom = new JSDOM(fs.readFileSync(FILE, 'utf8'), {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://local.test/',
  virtualConsole: vc,
});
dom.window.scrollTo = () => {};
const w = dom.window, d = w.document;
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
};
const group = n => console.log('\n' + n);

const pageErrors = [];
w.addEventListener('error', e => pageErrors.push(e.message));

(async () => {
  await wait(900);

  group('shell');
  ok('page rendered the browse view', d.querySelectorAll('.dataset').length === 18);
  ok('two mode buttons exist', d.querySelectorAll('.mode-btn').length === 2);
  ok('browse view visible by default', !d.getElementById('browse-view').hidden);
  ok('check view hidden by default', d.getElementById('check-view').hidden);
  ok('engine is available on the page', typeof w.CompatEngine === 'object');
  ok('checkers module is available', typeof w.CompatCheckers === 'object');
  ok('rules travelled with the bundle', !!(w.__BUNDLED_DATA__ && w.__BUNDLED_DATA__.rules));

  group('mode switching');
  // Assert the hidden ATTRIBUTE is set on the right containers. Whether the
  // browser actually paints them is a CSS-cascade question that jsdom cannot
  // answer (its getComputedStyle returns "none" for [hidden] regardless of
  // competing author rules) — that is check-css.js's job, not this file's.
  const attrHidden = id => d.getElementById(id).hidden === true;

  ok('browse view not hidden before switching', !attrHidden('browse-view'));
  d.querySelector('[data-mode="check"]').click();
  await wait(400);
  ok('check view un-hidden', !attrHidden('check-view'));
  ok('browse view marked hidden', attrHidden('browse-view'));
  ok('status filterbar marked hidden in check mode', attrHidden('filterbar'));
  ok('all-sources footer marked hidden in check mode', attrHidden('browse-foot'));
  ok('three checker tabs render', d.querySelectorAll('.cnav').length === 3);
  ok('checker 1 mounted by default', !!d.getElementById('f-stack'));
  ok('the checker form lives inside the check view',
    d.getElementById('check-view').contains(d.getElementById('f-stack')));
  ok('every dataset card sits inside the hidden browse view',
    [...d.querySelectorAll('.dataset')].every(el => !!el.closest('#browse-view')));

  /* ---------------------------------------------------------- checker 1 */
  group('checker 1 — profile with known holes');
  const f = d.getElementById('f-stack');
  f.elements['stackVersion'].value = '8.18';
  f.elements['agentVersion'].value = '9.1';
  f.elements['path'].value = 'apm-server-otel';
  f.elements['serviceName'].value = 'cart.service';
  f.querySelector('[data-group="edotSdks"] input[value="EDOT Java"]').checked = true;
  f.querySelector('[data-group="edotSdks"] input[value="EDOT Browser"]').checked = true;
  f.elements['cumulativeHistograms'].checked = true;
  f.querySelector('button[type=submit]').click();
  await wait(400);

  const c1 = [...d.querySelectorAll('#r-stack .finding')];
  const text1 = d.getElementById('r-stack').textContent;
  ok('findings rendered', c1.length >= 6, 'got ' + c1.length);
  ok('summary says holes were found',
    /Holes found/.test(d.querySelector('#r-stack .summary-verdict').textContent));
  ok('APM Server intake flagged Not supported', /Not supported/.test(text1) && /APM Server/.test(text1));
  ok('bad service.name flagged', /service\.name/.test(text1) && /Incompatible/.test(text1));
  ok('EDOT Browser reported Not documented', /Not documented/.test(text1) && /Browser/.test(text1));
  ok('Stack 8.18 + Agent 9.x reported Supported', /Supported/.test(text1));
  // Elastic documents temporality for the Managed OTLP endpoint and the
  // Collector ES exporter only — not for APM Server's OTel intake. On this
  // path the engine must say "not documented", not stay silent.
  ok('cumulative histograms on an undocumented path reported, not swallowed',
    /temporality/i.test(text1) && /Not documented/.test(text1));
  ok('a remedy block is shown', d.querySelectorAll('#r-stack .remedy').length >= 1);
  ok('EVERY finding carries a doc link',
    c1.every(el => el.querySelector('.cite-src, .cite-only a')),
    c1.filter(el => !el.querySelector('.cite-src, .cite-only a'))
      .map(el => el.querySelector('.finding-subject').textContent).join(' | '));
  ok('every doc link points at an allow-listed host',
    [...d.querySelectorAll('#r-stack a[href]')].every(a =>
      /^https:\/\/(www\.elastic\.co|opentelemetry\.io|github\.com)/.test(a.href)));

  group('checker 1 — a clean profile');
  f.reset();
  await wait(200);
  f.elements['stackVersion'].value = '9.1';
  f.elements['agentVersion'].value = '9.1';
  f.elements['path'].value = 'agent-gateway';
  f.elements['serviceName'].value = 'cart-service';
  f.elements['os'].value = 'linux';
  f.querySelector('[data-group="edotSdks"] input[value="EDOT Java"]').checked = true;
  f.querySelector('button[type=submit]').click();
  await wait(400);
  const clean = d.querySelector('#r-stack .summary-verdict').textContent;
  ok('clean profile does not report blockers', /Looks supported|Supported with caveats/.test(clean), 'got: ' + clean);
  ok('no blocker cards on a clean profile', d.querySelectorAll('#r-stack .finding.sev-blocker').length === 0);

  /* ---------------------------------------------------------- checker 2 */
  group('checker 2 — migration gaps');
  d.querySelector('[data-target="checker-migration"]').click();
  await wait(300);
  ok('migration form mounted', !!d.getElementById('f-mig'));
  d.getElementById('mig-all').click();
  await wait(400);
  const c2 = [...d.querySelectorAll('#r-mig .finding')];
  const text2 = d.getElementById('r-mig').textContent;
  ok('a finding per capability', c2.length >= 10, 'got ' + c2.length);
  ok('Universal profiling reported Not available', /Universal profiling/.test(text2) && /Not available/.test(text2));
  ok('RUM reported as Technical preview', /RUM/.test(text2) && /Technical preview/.test(text2));
  ok('TBS documented caveats rendered', d.querySelectorAll('#r-mig .caveats li').length === 4);
  ok('EVERY migration finding carries a quoted citation',
    c2.every(el => el.querySelector('.cite-src')),
    c2.filter(el => !el.querySelector('.cite-src'))
      .map(el => el.querySelector('.finding-subject').textContent).join(' | '));

  /* ---------------------------------------------------------- checker 3 */
  group('checker 3 — feature availability');
  d.querySelector('[data-target="checker-features"]').click();
  await wait(300);
  const ff = d.getElementById('f-feat');
  ok('feature form mounted', !!ff);
  ok('18 feature checkboxes', ff.querySelectorAll('.chips input').length === 18,
    'got ' + ff.querySelectorAll('.chips input').length);

  const pick = lbl => {
    const i = [...ff.querySelectorAll('.chips input')].find(x => x.value === lbl);
    if (i) { i.checked = true; return true; }
    return false;
  };
  ok('can select "Inferred spans"', pick('Inferred spans'));
  ok('can select "Zero-code instrumentation"', pick('Zero-code instrumentation'));
  ff.querySelector('button[type=submit]').click();
  await wait(400);

  const sum3 = d.querySelector('#r-feat .summary-verdict').textContent;
  ok('GA-only: exactly 1 SDK covers both', /^1 SDK covers all 2 features$/.test(sum3), 'got: ' + sum3);
  ok('Java is marked as satisfying',
    [...d.querySelectorAll('#r-feat .summary-counts .sc')]
      .some(s => s.textContent === 'Java' && /sc-ok|sc-warning/.test(s.className)));
  ok('matrix shows the 2 requested rows', d.querySelectorAll('#r-feat tbody tr').length === 2);
  ok('per-row doc link present', d.querySelectorAll('#r-feat td.cite a').length === 2);
  ok('gap explanations listed for failing SDKs', d.querySelectorAll('#r-feat .gap-detail li').length >= 5);
  ok('footnote/EDOT-only notes surfaced', d.querySelectorAll('#r-feat .notes li').length >= 1);

  ff.elements['acceptPreview'].checked = true;
  ff.querySelector('button[type=submit]').click();
  await wait(400);
  ok('accepting preview widens the result to 2 SDKs',
    /^2 SDKs cover all 2 features$/.test(d.querySelector('#r-feat .summary-verdict').textContent),
    'got: ' + d.querySelector('#r-feat .summary-verdict').textContent);

  group('checker 3 — impossible feature set');
  ff.reset();
  await wait(200);
  pick('Agent health monitoring');
  ff.querySelector('button[type=submit]').click();
  await wait(400);
  ok('no SDK claimed for an unavailable feature',
    /^No single SDK covers/.test(d.querySelector('#r-feat .summary-verdict').textContent));

  /* -------------------------------------------------------------- misc */
  group('theme + returning to browse');
  const before = d.documentElement.getAttribute('data-theme');
  d.getElementById('theme-toggle').click();
  await wait(200);
  ok('theme toggles inside checker mode', d.documentElement.getAttribute('data-theme') !== before);
  d.querySelector('[data-mode="browse"]').click();
  await wait(300);
  ok('browse view still renders all rows', d.querySelectorAll('#content tbody tr').length === 281);
  ok('browse view un-hidden again', !attrHidden('browse-view'));
  ok('status filterbar returns', !attrHidden('filterbar'));
  ok('all-sources footer returns', !attrHidden('browse-foot'));
  ok('check view marked hidden again', attrHidden('check-view'));

  group('no page errors');
  ok('no uncaught script errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
  if (fail) { console.log('UI TESTS FAILED'); process.exit(1); }
  console.log('ALL UI TESTS PASSED');
  process.exit(0);
})();
