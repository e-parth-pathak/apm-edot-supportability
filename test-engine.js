#!/usr/bin/env node
/**
 * test-engine.js — unit tests for the compatibility evaluator.
 *
 * Asserts that known profiles produce the verdicts the Elastic docs state, and
 * — just as importantly — that undocumented combinations produce
 * 'not-documented' rather than a fabricated verdict.
 *
 *   node test-engine.js          (run after: node build.js)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const E = require('./public/engine.js');

const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'rules.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

const stack = p => E.checkStack(p, bundle, rules);
const find = (fs_, re) => fs_.filter(f => re.test(f.subject + ' ' + f.headline));
const has = (fs_, re, verdict) => find(fs_, re).some(f => f.verdict === verdict);

/* ---------------------------------------------------- version utilities */
group('version helpers');
ok('parseVersion 8.18 -> [8,18,0]', JSON.stringify(E.parseVersion('8.18')) === '[8,18,0]');
ok('parseVersion 9.x -> [9,0,0]', JSON.stringify(E.parseVersion('9.x')) === '[9,0,0]');
ok('parseVersion v1.4.0+ -> [1,4,0]', JSON.stringify(E.parseVersion('v1.4.0+')) === '[1,4,0]');
ok('8.17 < 8.18', E.cmp(E.parseVersion('8.17'), E.parseVersion('8.18')) === -1);

group('stack band mapping (documented columns)');
ok('8.15 -> ELK < 8.16', E.bandFor('8.15', rules.stackBands.collector).id === 'lt-8.16');
ok('8.16 -> ELK 8.16 - 8.17', E.bandFor('8.16', rules.stackBands.collector).id === '8.16-8.17');
ok('8.17.3 -> ELK 8.16 - 8.17', E.bandFor('8.17.3', rules.stackBands.collector).id === '8.16-8.17');
ok('8.18 -> ELK 8.18 - 8.19', E.bandFor('8.18', rules.stackBands.collector).id === '8.18-8.19');
ok('8.19.2 -> ELK 8.18 - 8.19', E.bandFor('8.19.2', rules.stackBands.collector).id === '8.18-8.19');
ok('9.0 -> ELK 9.0 and later', E.bandFor('9.0', rules.stackBands.collector).id === '9.0+');
ok('9.2 -> ELK 9.0 and later', E.bandFor('9.2', rules.stackBands.collector).id === '9.0+');

/* --------------------------------------------- checker 1: agent vs stack */
group('checker 1 — Elastic Agent 9.x vs Stack');
ok('Agent 9.1 + Stack 9.0 => supported',
  has(stack({ stackVersion: '9.0', agentVersion: '9.1' }), /Elastic Agent 9\.x \+ Stack/, 'supported'));
ok('Agent 9.1 + Stack 8.18 => supported',
  has(stack({ stackVersion: '8.18', agentVersion: '9.1' }), /Elastic Agent 9\.x \+ Stack/, 'supported'));
ok('Agent 9.1 + Stack 8.16 => not-supported (compatible, unsupported)',
  has(stack({ stackVersion: '8.16', agentVersion: '9.1' }), /Elastic Agent 9\.x \+ Stack/, 'not-supported'));
ok('Agent 9.1 + Stack 8.15 => incompatible',
  has(stack({ stackVersion: '8.15', agentVersion: '9.1' }), /Elastic Agent 9\.x \+ Stack/, 'incompatible'));
ok('Stack 8.18 also raises the config-compatibility advisory',
  find(stack({ stackVersion: '8.18', agentVersion: '9.1' }), /Configuration on Stack/).length === 1);
ok('Stack 9.0 does NOT raise the config advisory',
  find(stack({ stackVersion: '9.0', agentVersion: '9.1' }), /Configuration on Stack/).length === 0);

group('checker 1 — Agent 8.x is undocumented, not guessed');
{
  const f = stack({ stackVersion: '8.18', agentVersion: '8.16' });
  const hit = find(f, /Elastic Agent 8\.16/);
  ok('Agent 8.16 yields exactly one finding', hit.length === 1);
  ok('...and its verdict is not-documented', hit[0] && hit[0].verdict === 'not-documented');
  ok('...and it cites a doc page', !!(hit[0] && hit[0].sourceUrl));
  ok('no supported/incompatible verdict is invented for Agent 8.x',
    !f.some(x => /Elastic Agent 8/.test(x.subject) && x.verdict !== 'not-documented'));
}

/* ------------------------------------------------ checker 1: paths */
group('checker 1 — ingestion paths');
ok('agent-gateway => supported',
  has(stack({ path: 'agent-gateway' }), /Ingestion path/, 'supported'));
ok('managed-otlp => supported',
  has(stack({ path: 'managed-otlp' }), /Ingestion path/, 'supported'));
ok('apm-server-otel => not-supported',
  has(stack({ path: 'apm-server-otel' }), /Ingestion path/, 'not-supported'));
{
  const f = find(stack({ path: 'apm-server-otel' }), /Ingestion path/)[0];
  ok('apm-server-otel finding carries a remedy', !!f.remedy);
  ok('...and the remedy is itself quoted', !!f.remedyQuote && !!f.remedySourceUrl);
}

/* ------------------------------------------------ checker 1: SDKs */
group('checker 1 — EDOT SDK vs Elastic Agent');
ok('EDOT Java + Agent 9.1 => supported',
  has(stack({ agentVersion: '9.1', edotSdks: [{ name: 'EDOT Java', version: '1.5.0' }] }),
      /EDOT Java.*Elastic Agent/, 'supported'));
ok('EDOT Java + Agent 8.17 => not-supported',
  has(stack({ agentVersion: '8.17', edotSdks: [{ name: 'EDOT Java' }] }),
      /EDOT Java.*Elastic Agent/, 'not-supported'));
ok('EDOT Java + Agent 8.15 => incompatible',
  has(stack({ agentVersion: '8.15', edotSdks: [{ name: 'EDOT Java' }] }),
      /EDOT Java.*Elastic Agent/, 'incompatible'));
ok('EDOT Browser => not-documented (absent from the applies-to list)',
  has(stack({ agentVersion: '9.1', edotSdks: [{ name: 'EDOT Browser', version: '0.1.0' }] }),
      /EDOT Browser/, 'not-documented'));

/* --------------------------------------------- checker 1: classic agents */
group('checker 1 — classic APM agents');
{
  const f = stack({ classicAgents: [{ name: 'Java agent', version: '1.40.0' }] });
  ok('Java agent 1.40.0 reports the integration floor >= 6.5',
    find(f, /Requires APM integration/).some(x => /6\.5/.test(x.headline)));
  ok('Java agent < 1.43.0 raises the known-issue warning',
    f.some(x => x.ruleId === 'classic-java-agent-known-issue'));
  ok('Java agent 1.45.0 does NOT raise it',
    !stack({ classicAgents: [{ name: 'Java agent', version: '1.45.0' }] })
      .some(x => x.ruleId === 'classic-java-agent-known-issue'));
  ok('Go agent 2.x reports integration >= 6.5',
    find(stack({ classicAgents: [{ name: 'Go agent', version: '2.1.0' }] }), /Requires APM integration/)
      .some(x => /6\.5/.test(x.headline)));
  ok('unknown classic agent => not-documented',
    has(stack({ classicAgents: [{ name: 'Fortran agent' }] }), /Fortran/, 'not-documented'));
}

group('checker 1 — mixing agents is a blocker');
{
  const f = stack({ classicAgents: [{ name: 'Java agent', version: '1.45.0' }], edotSdks: [{ name: 'EDOT Java' }] });
  const hit = f.filter(x => x.ruleId === 'no-mixing-agents');
  ok('declaring both raises the no-mixing blocker', hit.length === 1);
  ok('...severity is blocker', hit[0] && hit[0].severity === 'blocker');
  ok('EDOT SDK alone does not raise it',
    !stack({ edotSdks: [{ name: 'EDOT Java' }] }).some(x => x.ruleId === 'no-mixing-agents'));
}

group('checker 1 — service.name charset');
ok('valid name passes', has(stack({ serviceName: 'cart-service' }), /service\.name/, 'supported'));
ok('name with a dot is flagged incompatible', has(stack({ serviceName: 'cart.service' }), /service\.name/, 'incompatible'));
ok('name with a slash is flagged', has(stack({ serviceName: 'team/cart' }), /service\.name/, 'incompatible'));
ok('spaces and underscores are allowed', has(stack({ serviceName: 'cart service_v2' }), /service\.name/, 'supported'));

group('checker 1 — metric hazards are path-aware');
ok('cumulative histograms + agent-gateway => blocker',
  stack({ path: 'agent-gateway', cumulativeHistograms: true })
    .some(x => x.ruleId === 'histogram-cumulative-es-exporter' && x.severity === 'blocker'));
ok('cumulative histograms + managed-otlp => supported, no blocker',
  (() => {
    const f = stack({ path: 'managed-otlp', cumulativeHistograms: true });
    return f.some(x => x.ruleId === 'histogram-cumulative-managed-otlp-ok')
        && !f.some(x => x.ruleId === 'histogram-cumulative-es-exporter');
  })());
ok('cumulative histograms + apm-server-otel => not-documented, not silent',
  (() => {
    const f = stack({ path: 'apm-server-otel', cumulativeHistograms: true });
    const hit = f.filter(x => x.ruleId === 'histogram-temporality-apm-server-intake');
    return hit.length === 1 && hit[0].verdict === 'not-documented' && !!hit[0].sourceUrl;
  })());
ok('cumulative histograms with NO path chosen => still reported as not-documented',
  stack({ cumulativeHistograms: true })
    .some(x => x.ruleId === 'histogram-temporality-apm-server-intake'));
ok('the not-documented fallback does NOT fire when a real rule matched',
  !stack({ path: 'agent-gateway', cumulativeHistograms: true })
    .some(x => x.ruleId === 'histogram-temporality-apm-server-intake'));
ok('exemplars flagged as not-available', stack({ exemplars: true }).some(x => x.ruleId === 'exemplars-dropped'));
ok('managed k8s flagged', stack({ managedKubernetes: true }).some(x => x.ruleId === 'managed-k8s-permissions'));

group('checker 1 — OS / platform');
ok('macOS => not-supported', has(stack({ os: 'macos' }), /macos/, 'not-supported'));
ok('windows => not-supported', has(stack({ os: 'windows' }), /windows/, 'not-supported'));
ok('linux => no OS finding', find(stack({ os: 'linux' }), /Elastic Agent on/).length === 0);
ok('openshift => supported', has(stack({ platform: 'openshift' }), /Platform/, 'supported'));
ok('aws-lambda => compatible-unsupported', has(stack({ platform: 'aws-lambda' }), /Platform/, 'compatible-unsupported'));

group('checker 1 — empty profile stays silent');
ok('no input produces no findings', stack({}).length === 0);

/* -------------------------------------------------- checker 2: migration */
group('checker 2 — migration gaps');
const mig = p => E.checkMigration(p, bundle, rules);
ok('catalogue is non-empty', E.migrationCatalogue(rules).length >= 10);
ok('rum => preview (keep classic RUM agent)',
  mig({ featureIds: ['rum'] })[0].verdict === 'preview');
ok('universal-profiling => not-available',
  mig({ featureIds: ['universal-profiling'] })[0].verdict === 'not-available');
ok('tail-based-sampling => not-supported',
  mig({ featureIds: ['tail-based-sampling'] })[0].verdict === 'not-supported');
ok('tbs finding carries its 4 documented caveats',
  (mig({ featureIds: ['tail-based-sampling'] })[0].caveats || []).length === 4);
ok('tbs-managed-cloud => incompatible',
  mig({ featureIds: ['tbs-managed-cloud'] })[0].verdict === 'incompatible');
ok('central-mgmt-sdks => supported',
  mig({ featureIds: ['central-mgmt-sdks'] })[0].verdict === 'supported');
ok('central-mgmt-collectors => incompatible',
  mig({ featureIds: ['central-mgmt-collectors'] })[0].verdict === 'incompatible');
ok('managed-log-processing carries a quoted remedy',
  !!mig({ featureIds: ['managed-log-processing'] })[0].remedyQuote);
ok('unknown feature => not-documented',
  mig({ featureIds: ['telepathy'] })[0].verdict === 'not-documented');
ok('every migration finding is cited',
  mig({ featureIds: E.migrationCatalogue(rules).map(c => c.featureId) })
    .every(f => f.quote && f.sourceUrl));

/* --------------------------------------------------- checker 3: features */
group('checker 3 — feature availability by language');
const fm = E.featureMatrix(bundle, rules);
ok('matrix parsed', !!fm);
ok('8 languages', fm.languages.length === 8, 'got ' + fm.languages.length);
ok('18 features', fm.features.length === 18, 'got ' + fm.features.length);

group('checker 3 — cell parsing');
ok('"✅ 1.0+" => supported 1.0+',
  (() => { const c = E.readCell('✅ 1.0+'); return c.verdict === 'supported' && c.version === '1.0+'; })());
ok('"𝐓 0.1.0+" => preview',
  E.readCell('𝐓 0.1.0+').verdict === 'preview');
ok('"❌" => not-available', E.readCell('❌').verdict === 'not-available');
ok('"➖" => not-applicable', E.readCell('➖').verdict === 'not-applicable');
ok('footnote markers are captured, not swallowed into the version',
  (() => { const c = E.readCell('✅ 1.0+¹'); return c.version === '1.0+' && c.footnotes.length === 1; })());

group('checker 3 — known matrix facts');
const feat = labels => E.checkFeatures({ featureLabels: labels }, bundle, rules);
{
  const r = feat(['Inferred spans'])[('rows')][0];
  const byLang = {};
  r.cells.forEach(c => { byLang[c.language] = c; });
  ok('Inferred spans: Java supported', byLang['Java'].verdict === 'supported');
  ok('Inferred spans: PHP preview', byLang['PHP'].verdict === 'preview');
  ok('Inferred spans: .NET not-available', byLang['.NET'].verdict === 'not-available');
  ok('Inferred spans carries the EDOT-only note', r.notes.some(n => /Elastic OpenTelemetry only/.test(n.quote)));
}
{
  const r = feat(['Profiling integration']).rows[0];
  const byLang = {};
  r.cells.forEach(c => { byLang[c.language] = c; });
  ok('Profiling: Java preview only', byLang['Java'].verdict === 'preview');
  ok('Profiling: Python not-available', byLang['Python'].verdict === 'not-available');
}
{
  const r = feat(['Crash reporting']).rows[0];
  const byLang = {};
  r.cells.forEach(c => { byLang[c.language] = c; });
  ok('Crash reporting: Android supported 1.6.0+',
    byLang['Android'].verdict === 'supported' && byLang['Android'].version === '1.6.0+');
  ok('Crash reporting: .NET not-applicable', byLang['.NET'].verdict === 'not-applicable');
}
ok('Agent health monitoring is unavailable everywhere',
  feat(['Agent health monitoring']).rows[0].cells.every(c => c.verdict === 'not-available'));
ok('unknown feature label marked missing', feat(['Telepathy']).rows[0].missing === true);

group('checker 3 — languages satisfying a feature set');
{
  const sat = E.languagesSatisfying({ featureLabels: ['Inferred spans'] }, bundle, rules, false);
  const yes = sat.filter(s => s.satisfies).map(s => s.language);
  ok('only Java satisfies "Inferred spans" at GA', yes.length === 1 && yes[0] === 'Java', 'got ' + yes.join(','));
  const satP = E.languagesSatisfying({ featureLabels: ['Inferred spans'] }, bundle, rules, true);
  const yesP = satP.filter(s => s.satisfies).map(s => s.language);
  ok('accepting preview adds PHP', yesP.length === 2 && yesP.indexOf('PHP') !== -1, 'got ' + yesP.join(','));
}
{
  const sat = E.languagesSatisfying(
    { featureLabels: ['Zero-code instrumentation', 'Inferred spans'] }, bundle, rules, false);
  const yes = sat.filter(s => s.satisfies).map(s => s.language);
  ok('zero-code + inferred spans at GA => Java only', yes.length === 1 && yes[0] === 'Java', 'got ' + yes.join(','));
  ok('blockers are reported for languages that fail',
    sat.find(s => s.language === '.NET').blockers.length === 1);
}
{
  const sat = E.languagesSatisfying({ featureLabels: ['Agent health monitoring'] }, bundle, rules, true);
  ok('impossible feature set => no language satisfies', sat.every(s => !s.satisfies));
}

/* ------------------------------------------------------ citation invariant */
group('citation invariant across all checkers');
{
  const all = []
    .concat(stack({
      stackVersion: '8.18', agentVersion: '9.1', path: 'apm-server-otel',
      edotSdks: [{ name: 'EDOT Java', version: '1.5' }, { name: 'EDOT Browser', version: '0.1' }],
      classicAgents: [{ name: 'Java agent', version: '1.40.0' }],
      os: 'macos', platform: 'aws-lambda', managedKubernetes: true,
      cumulativeHistograms: true, exemplars: true,
      usesNonEdotSdk: true, usesNonEdotCollector: true,
      serviceName: 'cart.service',
    }))
    .concat(mig({ featureIds: E.migrationCatalogue(rules).map(c => c.featureId) }));

  ok('kitchen-sink profile produces findings', all.length > 15, 'got ' + all.length);
  const uncited = all.filter(f => !f.sourceUrl);
  ok('every finding carries a sourceUrl', uncited.length === 0,
    uncited.map(f => f.subject).join(' | '));
  const noEvidence = all.filter(f => !f.quote && !f.detail);
  ok('every finding carries a quote or a documented detail', noEvidence.length === 0,
    noEvidence.map(f => f.subject).join(' | '));
  const badSev = all.filter(f => ['blocker', 'warning', 'ok', 'info'].indexOf(f.severity) === -1);
  ok('every finding has a valid severity', badSev.length === 0);
  ok('all sourceUrls are elastic.co or an allow-listed doc host',
    all.every(f => /^https:\/\/(www\.elastic\.co|opentelemetry\.io|github\.com)/.test(f.sourceUrl)));
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
if (fail) { console.log('TESTS FAILED'); process.exit(1); }
console.log('ALL TESTS PASSED');
