/* ---------------------------------------------------------------------------
   engine.js — cited compatibility evaluator.

   Pure functions: profile in, findings out. No DOM, no fetch. Runs in the
   browser (loaded as a plain script) and in Node (module.exports), so the
   unit tests exercise exactly the code the UI runs.

   Contract: every finding carries `quote` + `sourceUrl` copied from a rule in
   data/rules.json, whose text check-quotes.js has already grounded against the
   scraped docs. The engine NEVER composes a verdict of its own — where the
   docs are silent it emits {verdict:'not-documented'} with the reason.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CompatEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------ versions */

  /** "8.18.2" -> [8,18,2]. Tolerates "9.x", "v1.4.0+", "≥ 6.5". */
  function parseVersion(s) {
    if (s == null) return null;
    var m = String(s).match(/(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?/);
    if (!m) return null;
    var num = function (v) { return v == null || v === 'x' ? 0 : parseInt(v, 10); };
    return [num(m[1]), num(m[2]), num(m[3])];
  }

  function cmp(a, b) {
    if (!a || !b) return null;
    for (var i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function gte(a, b) { var c = cmp(a, b); return c === null ? null : c >= 0; }
  function lt(a, b) { var c = cmp(a, b); return c === null ? null : c < 0; }

  /** Which documented band does this version fall into? */
  function bandFor(version, bands) {
    var v = parseVersion(version);
    if (!v) return null;
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      var okMin = b.min == null || gte(v, parseVersion(b.min));
      var okMax = b.maxExclusive == null || lt(v, parseVersion(b.maxExclusive));
      if (okMin && okMax) return b;
    }
    return null;
  }

  /* -------------------------------------------------------------- lookup */

  function findDataset(bundle, id) {
    var list = bundle.datasets || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function findSection(bundle, datasetId, heading) {
    var ds = findDataset(bundle, datasetId);
    if (!ds) return null;
    for (var i = 0; i < (ds.sections || []).length; i++) {
      if (ds.sections[i].heading === heading) return ds.sections[i];
    }
    return null;
  }

  function ruleById(rules, id) {
    for (var i = 0; i < rules.rules.length; i++) if (rules.rules[i].id === id) return rules.rules[i];
    return null;
  }

  function undocumented(rules, id) {
    var cases = (rules.undocumented && rules.undocumented.cases) || [];
    for (var i = 0; i < cases.length; i++) if (cases[i].id === id) return cases[i];
    return null;
  }

  /** Strip markdown so a doc string can be compared / shown as plain text. */
  function plain(s) {
    return String(s == null ? '' : s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
      .replace(/[`*]/g, '')
      .trim();
  }

  /* ------------------------------------------------------------- finding */

  function finding(o) {
    return {
      severity: o.severity,                 // blocker | warning | ok | info
      verdict: o.verdict,                   // see rules.json verdicts
      subject: o.subject,
      headline: o.headline,
      detail: o.detail || null,
      quote: o.quote || null,
      sourceUrl: o.sourceUrl || null,
      remedy: o.remedy || null,
      remedyQuote: o.remedyQuote || null,
      remedySourceUrl: o.remedySourceUrl || null,
      ruleId: o.ruleId || null,
      caveats: o.caveats || null,
    };
  }

  var SEVERITY_OF = {
    'incompatible': 'blocker',
    'not-supported': 'blocker',
    'not-available': 'blocker',
    'preview': 'warning',
    'compatible-unsupported': 'warning',
    'not-documented': 'info',
    'not-applicable': 'info',
    'supported': 'ok',
  };

  function sev(verdict) { return SEVERITY_OF[verdict] || 'info'; }

  /* =====================================================================
     CHECKER 1 — "is my stack supported?"
     ===================================================================== */

  /**
   * profile = {
   *   stackVersion: '8.18',
   *   agentVersion: '9.1',            // Elastic Agent / EDOT Collector
   *   path: 'agent-gateway' | 'managed-otlp' | 'apm-server-otel',
   *   edotSdks: [{ name:'EDOT Java', version:'1.5.0' }],
   *   classicAgents: [{ name:'Java agent', version:'1.40.0' }],
   *   os: 'linux' | 'macos' | 'windows',
   *   platform: 'none' | 'openshift' | 'aws-lambda',
   *   managedKubernetes: bool, cumulativeHistograms: bool, exemplars: bool,
   *   usesNonEdotSdk: bool, usesNonEdotCollector: bool,
   *   serviceName: 'cart-service'
   * }
   */
  function checkStack(profile, bundle, rules) {
    var out = [];
    var p = profile || {};

    // --- Elastic Agent vs Stack -----------------------------------------
    var collectorRule = ruleById(rules, 'collector-stack-band');
    var agentV = parseVersion(p.agentVersion);
    var agentIs9x = agentV && agentV[0] === 9;

    if (!p.stackVersion || !p.agentVersion) {
      // nothing entered yet — stay silent rather than guess
    } else if (!agentIs9x) {
      var u = undocumented(rules, 'collector-8x-vs-stack');
      out.push(finding({
        severity: 'info', verdict: 'not-documented',
        subject: 'Elastic Agent ' + p.agentVersion + ' + Stack ' + p.stackVersion,
        headline: u.headline, detail: u.detail, sourceUrl: u.sourceUrl,
        ruleId: 'collector-8x-vs-stack',
      }));
    } else {
      var band = bandFor(p.stackVersion, rules.stackBands.collector);
      if (!band) {
        out.push(finding({
          severity: 'info', verdict: 'not-documented',
          subject: 'Elastic Agent 9.x + Stack ' + p.stackVersion,
          headline: 'Stack version does not map to a documented column',
          detail: 'The compatibility table covers ELK < 8.16, 8.16-8.17, 8.18-8.19 and 9.0 and later.',
          sourceUrl: rules.stackBands.collectorSourceUrl,
        }));
      } else {
        var cell = collectorRule.table[band.id];
        var verdict = cell.support === 'Supported' ? 'supported'
          : cell.compatibility === 'Incompatible' ? 'incompatible' : 'not-supported';
        out.push(finding({
          severity: sev(verdict), verdict: verdict,
          subject: 'Elastic Agent 9.x + Stack ' + p.stackVersion + ' (' + band.label + ')',
          headline: 'Compatibility: ' + cell.compatibility + ' · Level of support: ' + cell.support,
          quote: collectorRule.quote, sourceUrl: collectorRule.sourceUrl,
          ruleId: collectorRule.id,
        }));

        var cfg = ruleById(rules, 'collector-config-8.18-8.19');
        if (cfg.when.stackBand.indexOf(band.id) !== -1) {
          out.push(finding({
            severity: 'warning', verdict: 'supported',
            subject: 'Configuration on Stack ' + p.stackVersion,
            headline: cfg.headline, quote: cfg.quote, sourceUrl: cfg.sourceUrl, ruleId: cfg.id,
          }));
        }
      }
    }

    // --- ingestion path --------------------------------------------------
    if (p.path) {
      var pathRules = rules.rules.filter(function (r) { return r.kind === 'ingestion-path'; });
      for (var i = 0; i < pathRules.length; i++) {
        var r = pathRules[i];
        if (r.pathId !== p.path) continue;
        var v = r.verdict === 'not-supported' ? 'not-supported' : 'supported';
        out.push(finding({
          severity: sev(v), verdict: v,
          subject: 'Ingestion path: ' + r.label,
          headline: r.headline || (r.label + ' — ' + (v === 'supported' ? 'Supported' : 'Not supported')),
          quote: r.quote, sourceUrl: r.sourceUrl,
          remedy: r.remedy, remedyQuote: r.remedyQuote, remedySourceUrl: r.remedySourceUrl,
          ruleId: r.id,
        }));
      }
    }

    // --- EDOT SDKs vs Agent ---------------------------------------------
    var sdkRule = ruleById(rules, 'sdk-agent-band');
    (p.edotSdks || []).forEach(function (sdk) {
      if (!sdk || !sdk.name) return;

      if (sdkRule.appliesToSdks.indexOf(sdk.name) === -1) {
        var ub = undocumented(rules, 'edot-browser-vs-agent-band');
        out.push(finding({
          severity: 'info', verdict: 'not-documented',
          subject: sdk.name + (sdk.version ? ' ' + sdk.version : ''),
          headline: ub.headline, detail: ub.detail, sourceUrl: ub.sourceUrl,
          ruleId: 'edot-browser-vs-agent-band',
        }));
        return;
      }
      if (!p.agentVersion) return;

      var ab = bandFor(p.agentVersion, rules.stackBands.agent);
      if (!ab) {
        out.push(finding({
          severity: 'info', verdict: 'not-documented',
          subject: sdk.name, headline: 'Elastic Agent version does not map to a documented column',
          sourceUrl: rules.stackBands.agentSourceUrl,
        }));
        return;
      }
      var c = sdkRule.table[ab.id];
      var vv = c.support === 'Supported' ? 'supported'
        : c.compatibility === 'Incompatible' ? 'incompatible' : 'not-supported';
      out.push(finding({
        severity: sev(vv), verdict: vv,
        subject: sdk.name + (sdk.version ? ' ' + sdk.version : '') + ' + Elastic Agent ' + ab.label,
        headline: 'Compatibility: ' + c.compatibility + ' · Level of support: ' + c.support,
        quote: sdkRule.quote, sourceUrl: sdkRule.sourceUrl, ruleId: sdkRule.id,
      }));
    });

    // --- classic agents vs APM integration -------------------------------
    if ((p.classicAgents || []).length) {
      var sec = findSection(bundle, 'apm-agents', 'All APM agents (combined view)');
      var uc = undocumented(rules, 'classic-agent-vs-stack-version');
      (p.classicAgents || []).forEach(function (ag) {
        if (!ag || !ag.name) return;
        var matches = (sec ? sec.rows : []).filter(function (row) { return plain(row[0]) === ag.name; });
        if (!matches.length) {
          out.push(finding({
            severity: 'info', verdict: 'not-documented',
            subject: ag.name, headline: 'Not listed on the APM agent compatibility page',
            sourceUrl: 'https://www.elastic.co/docs/solutions/observability/apm/apm-agent-compatibility',
          }));
          return;
        }
        // Report the documented integration floor for the matching major line.
        var chosen = matches[0];
        if (ag.version) {
          var major = parseVersion(ag.version)[0];
          for (var k = 0; k < matches.length; k++) {
            if (parseVersion(matches[k][1])[0] === major) { chosen = matches[k]; break; }
          }
        }
        out.push(finding({
          severity: 'info', verdict: 'not-documented',
          subject: ag.name + (ag.version ? ' ' + ag.version : '') + ' (line ' + plain(chosen[1]) + ')',
          headline: 'Requires APM integration ' + plain(chosen[2]),
          detail: uc.detail,
          quote: ruleById(rules, 'classic-agent-integration-versions').quote,
          sourceUrl: 'https://www.elastic.co/docs/solutions/observability/apm/apm-agent-compatibility',
          ruleId: 'classic-agent-integration-versions',
        }));

        // Java agent known issue
        var jk = ruleById(rules, 'classic-java-agent-known-issue');
        if (ag.name === jk.trigger.classicAgent && ag.version &&
            lt(parseVersion(ag.version), parseVersion(jk.trigger.agentVersionBelow))) {
          out.push(finding({
            severity: 'warning', verdict: jk.verdict,
            subject: ag.name + ' ' + ag.version,
            headline: jk.headline, quote: jk.quote, sourceUrl: jk.sourceUrl, ruleId: jk.id,
          }));
        }
      });
    }

    // --- mixing classic agent + EDOT SDK in one process -------------------
    if ((p.classicAgents || []).length && (p.edotSdks || []).length) {
      var mix = ruleById(rules, 'no-mixing-agents');
      out.push(finding({
        severity: 'blocker', verdict: mix.verdict,
        subject: 'Classic APM agent and EDOT SDK both declared',
        headline: mix.headline,
        detail: 'This is a blocker only if both run in the same application process. If they instrument different services, disregard.',
        quote: mix.quote, sourceUrl: mix.sourceUrl, ruleId: mix.id,
      }));
    }

    // --- service.name charset --------------------------------------------
    if (p.serviceName) {
      var sn = ruleById(rules, 'service-name-charset');
      if (!new RegExp(sn.regex).test(p.serviceName)) {
        out.push(finding({
          severity: 'blocker', verdict: sn.verdict,
          subject: 'service.name = "' + p.serviceName + '"',
          headline: sn.headline, quote: sn.quote, sourceUrl: sn.sourceUrl, ruleId: sn.id,
        }));
      } else {
        out.push(finding({
          severity: 'ok', verdict: 'supported',
          subject: 'service.name = "' + p.serviceName + '"',
          headline: 'Matches the required pattern ' + sn.regex,
          quote: sn.quote, sourceUrl: sn.sourceUrl, ruleId: sn.id,
        }));
      }
    }

    // --- trigger-driven hazards / advisories ------------------------------
    var flagRules = [
      ['cumulativeHistograms', 'histogram-cumulative-es-exporter'],
      ['cumulativeHistograms', 'histogram-cumulative-managed-otlp-ok'],
      ['exemplars', 'exemplars-dropped'],
      ['managedKubernetes', 'managed-k8s-permissions'],
      ['usesNonEdotSdk', 'other-sdk-distributions'],
      ['usesNonEdotCollector', 'other-collector-distributions'],
    ];
    var flagMatched = {};
    flagRules.forEach(function (pair) {
      if (!p[pair[0]]) return;
      var r = ruleById(rules, pair[1]);
      // Path-scoped rules only fire on the paths Elastic documents them for.
      if (r.trigger && r.trigger.path && r.trigger.path.indexOf(p.path) === -1) return;
      flagMatched[pair[0]] = true;
      out.push(finding({
        severity: sev(r.verdict), verdict: r.verdict,
        subject: r.headline, headline: r.headline,
        quote: r.quote, sourceUrl: r.sourceUrl,
        remedy: r.remedy, remedyQuote: r.remedyQuote, remedySourceUrl: r.remedySourceUrl,
        ruleId: r.id,
      }));
    });

    // A ticked box that matched no documented rule must say so out loud rather
    // than silently disappearing — silence reads as "fine", which it isn't.
    var flagFallbacks = { cumulativeHistograms: 'histogram-temporality-apm-server-intake' };
    Object.keys(flagFallbacks).forEach(function (flag) {
      if (!p[flag] || flagMatched[flag]) return;
      var u = undocumented(rules, flagFallbacks[flag]);
      if (!u) return;
      out.push(finding({
        severity: 'info', verdict: 'not-documented',
        subject: u.headline, headline: u.headline,
        detail: u.detail, sourceUrl: u.sourceUrl, ruleId: u.id,
      }));
    });

    // --- OS / platform ----------------------------------------------------
    ['macos-collector-not-supported', 'windows-collector-not-supported'].forEach(function (id) {
      var r = ruleById(rules, id);
      if (p.os && r.trigger.os.indexOf(p.os) !== -1) {
        out.push(finding({
          severity: sev(r.verdict), verdict: r.verdict,
          subject: 'Elastic Agent on ' + p.os, headline: r.headline,
          detail: r.extra, quote: r.quote, sourceUrl: r.sourceUrl, ruleId: r.id,
        }));
      }
    });
    ['openshift-use-redhat-build', 'aws-lambda-use-adot'].forEach(function (id) {
      var r = ruleById(rules, id);
      if (p.platform && r.trigger.platform.indexOf(p.platform) !== -1) {
        out.push(finding({
          severity: sev(r.verdict), verdict: r.verdict,
          subject: 'Platform: ' + p.platform, headline: r.headline,
          quote: r.quote, sourceUrl: r.sourceUrl, ruleId: r.id,
        }));
      }
    });

    return out;
  }

  /* =====================================================================
     CHECKER 2 — classic APM -> EDOT migration gaps
     ===================================================================== */

  /** profile = { featureIds: ['rum','tail-based-sampling', ...] } */
  function checkMigration(profile, bundle, rules) {
    var wanted = (profile && profile.featureIds) || [];
    var gapRules = rules.rules.filter(function (r) { return r.kind === 'migration-gap'; });
    var out = [];

    wanted.forEach(function (fid) {
      var r = null;
      for (var i = 0; i < gapRules.length; i++) if (gapRules[i].featureId === fid) { r = gapRules[i]; break; }
      if (!r) {
        out.push(finding({
          severity: 'info', verdict: 'not-documented',
          subject: fid,
          headline: 'No documented EDOT migration statement for this capability',
          detail: 'Elastic’s limitations page does not list this capability, so no verdict is drawn.',
          sourceUrl: 'https://www.elastic.co/docs/reference/opentelemetry/compatibility/limitations',
        }));
        return;
      }
      out.push(finding({
        severity: sev(r.verdict), verdict: r.verdict,
        subject: r.label, headline: r.headline, detail: r.extra,
        quote: r.quote, sourceUrl: r.sourceUrl,
        remedy: r.remedy, remedyQuote: r.remedyQuote, remedySourceUrl: r.remedySourceUrl,
        caveats: r.caveats || null, ruleId: r.id,
      }));
    });

    return out;
  }

  /** Everything Checker 2 can answer, for building the form. */
  function migrationCatalogue(rules) {
    return rules.rules
      .filter(function (r) { return r.kind === 'migration-gap'; })
      .map(function (r) {
        return { featureId: r.featureId, label: r.label, verdict: r.verdict };
      });
  }

  /* =====================================================================
     CHECKER 3 — feature availability by language
     ===================================================================== */

  var SYMBOL_VERDICT = { '✅': 'supported', '𝐓': 'preview', '➖': 'not-applicable', '❌': 'not-available' };

  /** Split a matrix cell like "✅ 1.0+" or "𝐓 v1.4.0+²" into parts. */
  function readCell(cell) {
    var t = plain(cell);
    var sym = t.charAt(0);
    if (!SYMBOL_VERDICT[sym]) {
      // multi-byte 𝐓 is 2 code units
      sym = t.slice(0, 2);
    }
    var verdict = SYMBOL_VERDICT[sym];
    if (!verdict) return { verdict: 'not-documented', symbol: null, version: null, raw: t };
    var rest = t.slice(sym.length).trim();
    var footnotes = (rest.match(/[¹²³⁴⁵⁶⁷⁸⁹]/g) || []);
    return {
      verdict: verdict,
      symbol: sym,
      version: rest.replace(/[¹²³⁴⁵⁶⁷⁸⁹]/g, '').trim() || null,
      footnotes: footnotes,
      raw: t,
    };
  }

  /** The feature matrix, parsed. */
  function featureMatrix(bundle, rules) {
    var lookup = ruleById(rules, 'feature-matrix-lookup');
    var sec = findSection(bundle, lookup.readsFrom.datasetId, lookup.readsFrom.sectionHeading);
    if (!sec) return null;
    return {
      languages: sec.columns.slice(1),
      features: sec.rows.map(function (row) {
        return { label: plain(row[0]), cells: row.slice(1) };
      }),
      notes: sec.notes || [],
      sourceUrl: sec.sourceUrl,
    };
  }

  /** profile = { featureLabels: ['Inferred spans', 'Central configuration'] } */
  function checkFeatures(profile, bundle, rules) {
    var m = featureMatrix(bundle, rules);
    if (!m) return { languages: [], rows: [], notes: [], sourceUrl: null };
    var wanted = (profile && profile.featureLabels) || [];
    var noteRules = rules.rules.filter(function (r) { return r.kind === 'feature-note'; });

    var rows = wanted.map(function (label) {
      var feat = null;
      for (var i = 0; i < m.features.length; i++) if (m.features[i].label === label) { feat = m.features[i]; break; }
      if (!feat) {
        return { label: label, missing: true, cells: [], notes: [] };
      }
      var notes = noteRules.filter(function (r) {
        return label.indexOf(r.featureMatch) !== -1;
      }).map(function (r) {
        return { quote: r.quote, sourceUrl: r.sourceUrl, ruleId: r.id };
      });
      return {
        label: label,
        missing: false,
        cells: m.languages.map(function (lang, i) {
          var c = readCell(feat.cells[i]);
          c.language = lang;
          c.severity = sev(c.verdict);
          return c;
        }),
        notes: notes,
      };
    });

    return { languages: m.languages, rows: rows, notes: m.notes, sourceUrl: m.sourceUrl };
  }

  /** Given required features, which languages satisfy ALL of them? */
  function languagesSatisfying(profile, bundle, rules, acceptPreview) {
    var res = checkFeatures(profile, bundle, rules);
    return res.languages.map(function (lang, i) {
      var ok = true, worst = 'supported', blockers = [];
      res.rows.forEach(function (row) {
        if (row.missing) { ok = false; return; }
        var c = row.cells[i];
        var pass = c.verdict === 'supported' || (acceptPreview && c.verdict === 'preview');
        if (!pass) { ok = false; blockers.push({ feature: row.label, cell: c }); }
        else if (c.verdict === 'preview') worst = 'preview';
      });
      return { language: lang, satisfies: ok, level: ok ? worst : null, blockers: blockers };
    });
  }

  return {
    parseVersion: parseVersion,
    cmp: cmp,
    bandFor: bandFor,
    plain: plain,
    readCell: readCell,
    featureMatrix: featureMatrix,
    migrationCatalogue: migrationCatalogue,
    checkStack: checkStack,
    checkMigration: checkMigration,
    checkFeatures: checkFeatures,
    languagesSatisfying: languagesSatisfying,
    SEVERITY_OF: SEVERITY_OF,
  };
});
