/* ---------------------------------------------------------------------------
   checkers.js — the three interactive checkers.

   Renders forms, calls CompatEngine, renders cited findings. Holds no
   compatibility knowledge of its own: every verdict and every quote comes
   back from the engine, which reads data/rules.json.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var DATA = null, RULES = null, E = null;
  var LS_KEY = 'edot-matrix-profile';

  /* --------------------------------------------------------------- utils */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function md(s) {
    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  var VERDICT_LABEL = {
    'supported': 'Supported',
    'compatible-unsupported': 'Compatible · not supported',
    'incompatible': 'Incompatible',
    'not-supported': 'Not supported',
    'not-available': 'Not available',
    'not-applicable': 'Not applicable',
    'preview': 'Technical preview',
    'not-documented': 'Not documented',
  };

  var SEV_ICON = { blocker: '✕', warning: '!', ok: '✓', info: 'i' };

  /* ------------------------------------------------------- finding cards */

  function findingCard(f) {
    var cites = '';
    if (f.quote) {
      cites +=
        '<blockquote class="cite-quote">' + md(f.quote) +
        (f.sourceUrl ? '<a class="cite-src" href="' + esc(f.sourceUrl) +
          '" target="_blank" rel="noopener noreferrer">Elastic docs ↗</a>' : '') +
        '</blockquote>';
    } else if (f.sourceUrl) {
      cites += '<p class="cite-only"><a href="' + esc(f.sourceUrl) +
        '" target="_blank" rel="noopener noreferrer">Elastic docs ↗</a></p>';
    }

    var caveats = '';
    if (f.caveats && f.caveats.length) {
      caveats = '<div class="caveats"><div class="caveats-h">Documented caveats</div><ul>' +
        f.caveats.map(function (c) {
          return '<li><strong>' + md(c.quote) + '</strong> ' + md(c.detail) +
            (c.sourceUrl ? ' <a href="' + esc(c.sourceUrl) +
              '" target="_blank" rel="noopener noreferrer">↗</a>' : '') + '</li>';
        }).join('') + '</ul></div>';
    }

    var remedy = '';
    if (f.remedy) {
      remedy = '<div class="remedy"><div class="remedy-h">What to do instead</div>' +
        '<p>' + md(f.remedy) + '</p>' +
        (f.remedyQuote ? '<blockquote class="cite-quote">' + md(f.remedyQuote) +
          (f.remedySourceUrl ? '<a class="cite-src" href="' + esc(f.remedySourceUrl) +
            '" target="_blank" rel="noopener noreferrer">Elastic docs ↗</a>' : '') +
          '</blockquote>' : '') + '</div>';
    }

    return '<article class="finding sev-' + esc(f.severity) + '">' +
      '<div class="finding-icon" aria-hidden="true">' + (SEV_ICON[f.severity] || 'i') + '</div>' +
      '<div class="finding-body">' +
        '<div class="finding-top">' +
          '<span class="verdict v-' + esc(f.verdict) + '">' + esc(VERDICT_LABEL[f.verdict] || f.verdict) + '</span>' +
          '<span class="finding-subject">' + esc(f.subject) + '</span>' +
        '</div>' +
        '<p class="finding-headline">' + md(f.headline) + '</p>' +
        (f.detail ? '<p class="finding-detail">' + md(f.detail) + '</p>' : '') +
        cites + caveats + remedy +
      '</div>' +
    '</article>';
  }

  function summaryBar(findings) {
    var n = { blocker: 0, warning: 0, ok: 0, info: 0 };
    findings.forEach(function (f) { n[f.severity] = (n[f.severity] || 0) + 1; });
    var verdict = n.blocker ? 'Holes found' : (n.warning ? 'Supported with caveats' : (n.ok ? 'Looks supported' : 'Nothing to report'));
    var cls = n.blocker ? 'blocker' : (n.warning ? 'warning' : (n.ok ? 'ok' : 'info'));
    return '<div class="summary sum-' + cls + '">' +
      '<div class="summary-verdict">' + esc(verdict) + '</div>' +
      '<div class="summary-counts">' +
        '<span class="sc sc-blocker">' + n.blocker + ' blocker' + (n.blocker === 1 ? '' : 's') + '</span>' +
        '<span class="sc sc-warning">' + n.warning + ' caveat' + (n.warning === 1 ? '' : 's') + '</span>' +
        '<span class="sc sc-ok">' + n.ok + ' clear</span>' +
        '<span class="sc sc-info">' + n.info + ' not documented</span>' +
      '</div></div>';
  }

  function renderFindings(host, findings, emptyMsg) {
    if (!findings.length) {
      host.innerHTML = '<div class="empty-result">' + esc(emptyMsg) + '</div>';
      return;
    }
    var order = { blocker: 0, warning: 1, info: 2, ok: 3 };
    var sorted = findings.slice().sort(function (a, b) { return order[a.severity] - order[b.severity]; });
    host.innerHTML = summaryBar(findings) + sorted.map(findingCard).join('');
  }

  /* ------------------------------------------------------ profile memory */

  function saveProfile(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) {} }
  function loadProfile() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }

  /* =====================================================================
     CHECKER 1 — my stack
     ===================================================================== */

  var SDK_NAMES = ['EDOT .NET', 'EDOT Java', 'EDOT Node.js', 'EDOT PHP', 'EDOT Python', 'EDOT Android', 'EDOT iOS', 'EDOT Browser'];
  var CLASSIC_NAMES = ['APM AWS Lambda extension', 'Go agent', 'iOS agent', 'Java agent', '.NET agent',
                       'Node.js agent', 'PHP agent', 'Python agent', 'Ruby agent', 'JavaScript RUM agent'];

  function checkerStack() {
    var saved = loadProfile();
    var wrap = el('<section class="checker" id="checker-stack">' +
      '<header class="checker-head">' +
        '<h2>Is my stack supported?</h2>' +
        '<p>Enter what you run. Every verdict below is quoted from Elastic\'s docs; combinations Elastic doesn\'t document are reported as <em>not documented</em> rather than guessed.</p>' +
      '</header>' +
      '<form class="form-grid" id="f-stack">' +
        '<label><span>Elastic Stack version</span>' +
          '<input name="stackVersion" placeholder="e.g. 8.18 or 9.1" autocomplete="off"></label>' +
        '<label><span>Elastic Agent / EDOT Collector version</span>' +
          '<input name="agentVersion" placeholder="e.g. 9.1" autocomplete="off"></label>' +
        '<label><span>Ingestion path</span>' +
          '<select name="path">' +
            '<option value="">— select —</option>' +
            '<option value="agent-gateway">Elastic Agent (Gateway)</option>' +
            '<option value="managed-otlp">Elastic Cloud Managed OTLP Endpoint</option>' +
            '<option value="apm-server-otel">APM Server OTel intake</option>' +
          '</select></label>' +
        '<label><span>Collector OS</span>' +
          '<select name="os">' +
            '<option value="">— not specified —</option>' +
            '<option value="linux">Linux</option>' +
            '<option value="macos">macOS</option>' +
            '<option value="windows">Windows</option>' +
          '</select></label>' +
        '<label><span>Platform</span>' +
          '<select name="platform">' +
            '<option value="">— none / self-managed —</option>' +
            '<option value="openshift">Red Hat OpenShift</option>' +
            '<option value="aws-lambda">AWS Lambda</option>' +
          '</select></label>' +
        '<label><span>service.name</span>' +
          '<input name="serviceName" placeholder="e.g. cart-service" autocomplete="off"></label>' +

        '<fieldset class="fs-full"><legend>EDOT SDKs in use</legend><div class="chips" data-group="edotSdks">' +
          SDK_NAMES.map(function (n) {
            return '<label class="chk"><input type="checkbox" value="' + esc(n) + '"><span>' + esc(n) + '</span></label>';
          }).join('') +
        '</div></fieldset>' +

        '<fieldset class="fs-full"><legend>Classic Elastic APM agents in use</legend><div class="chips" data-group="classicAgents">' +
          CLASSIC_NAMES.map(function (n) {
            return '<label class="chk"><input type="checkbox" value="' + esc(n) + '"><span>' + esc(n) + '</span></label>';
          }).join('') +
        '</div><label class="sub"><span>Java agent version (for the &lt;1.43.0 known issue)</span>' +
          '<input name="javaAgentVersion" placeholder="e.g. 1.40.0" autocomplete="off"></label>' +
        '</fieldset>' +

        '<fieldset class="fs-full"><legend>Also tell us about</legend><div class="chips">' +
          '<label class="chk"><input type="checkbox" name="cumulativeHistograms"><span>Cumulative-temporality histograms</span></label>' +
          '<label class="chk"><input type="checkbox" name="exemplars"><span>Metric exemplars</span></label>' +
          '<label class="chk"><input type="checkbox" name="managedKubernetes"><span>Managed K8s (GKE Autopilot / Fargate)</span></label>' +
          '<label class="chk"><input type="checkbox" name="usesNonEdotSdk"><span>Non-EDOT OTel SDKs</span></label>' +
          '<label class="chk"><input type="checkbox" name="usesNonEdotCollector"><span>Non-Elastic Collector build</span></label>' +
        '</div></fieldset>' +

        '<div class="form-actions fs-full">' +
          '<button type="submit" class="btn-primary">Check for holes</button>' +
          '<button type="reset" class="btn-ghost">Reset</button>' +
          '<span class="form-hint">Your inputs stay in this browser (localStorage). Nothing is sent anywhere.</span>' +
        '</div>' +
      '</form>' +
      '<div class="results" id="r-stack"></div>' +
    '</section>');

    var form = wrap.querySelector('#f-stack');
    var out = wrap.querySelector('#r-stack');

    function readForm() {
      var fd = new FormData(form);
      var p = {
        stackVersion: (fd.get('stackVersion') || '').trim(),
        agentVersion: (fd.get('agentVersion') || '').trim(),
        path: fd.get('path') || '',
        os: fd.get('os') || '',
        platform: fd.get('platform') || '',
        serviceName: (fd.get('serviceName') || '').trim(),
        cumulativeHistograms: !!fd.get('cumulativeHistograms'),
        exemplars: !!fd.get('exemplars'),
        managedKubernetes: !!fd.get('managedKubernetes'),
        usesNonEdotSdk: !!fd.get('usesNonEdotSdk'),
        usesNonEdotCollector: !!fd.get('usesNonEdotCollector'),
        edotSdks: [], classicAgents: [],
      };
      form.querySelectorAll('[data-group="edotSdks"] input:checked').forEach(function (i) {
        p.edotSdks.push({ name: i.value });
      });
      var jv = (fd.get('javaAgentVersion') || '').trim();
      form.querySelectorAll('[data-group="classicAgents"] input:checked').forEach(function (i) {
        p.classicAgents.push({ name: i.value, version: i.value === 'Java agent' ? jv : '' });
      });
      return p;
    }

    function restore(p) {
      ['stackVersion', 'agentVersion', 'path', 'os', 'platform', 'serviceName'].forEach(function (k) {
        if (form.elements[k] && p[k]) form.elements[k].value = p[k];
      });
      ['cumulativeHistograms', 'exemplars', 'managedKubernetes', 'usesNonEdotSdk', 'usesNonEdotCollector'].forEach(function (k) {
        if (form.elements[k]) form.elements[k].checked = !!p[k];
      });
      (p.edotSdks || []).forEach(function (s) {
        var i = form.querySelector('[data-group="edotSdks"] input[value="' + s.name.replace(/"/g, '\\"') + '"]');
        if (i) i.checked = true;
      });
      (p.classicAgents || []).forEach(function (a) {
        var i = form.querySelector('[data-group="classicAgents"] input[value="' + a.name.replace(/"/g, '\\"') + '"]');
        if (i) i.checked = true;
        if (a.name === 'Java agent' && a.version && form.elements['javaAgentVersion']) {
          form.elements['javaAgentVersion'].value = a.version;
        }
      });
    }

    function run() {
      var p = readForm();
      saveProfile(p);
      renderFindings(out, E.checkStack(p, DATA, RULES),
        'Nothing entered yet — fill in at least a Stack version and an Elastic Agent version, or pick an ingestion path.');
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); run(); });
    form.addEventListener('reset', function () {
      setTimeout(function () { out.innerHTML = ''; saveProfile({}); }, 0);
    });

    if (saved && Object.keys(saved).length) { restore(saved); setTimeout(run, 0); }
    return wrap;
  }

  /* =====================================================================
     CHECKER 2 — migration gaps
     ===================================================================== */

  function checkerMigration() {
    var cat = E.migrationCatalogue(RULES);
    var wrap = el('<section class="checker" id="checker-migration">' +
      '<header class="checker-head">' +
        '<h2>Classic APM → EDOT: what breaks?</h2>' +
        '<p>Tick the capabilities you rely on today. Anything without an EDOT equivalent is flagged, with the doc sentence that says so.</p>' +
      '</header>' +
      '<form class="form-grid" id="f-mig">' +
        '<fieldset class="fs-full"><legend>Capabilities you use today</legend><div class="chips">' +
          cat.map(function (c) {
            return '<label class="chk"><input type="checkbox" value="' + esc(c.featureId) + '"><span>' + esc(c.label) + '</span></label>';
          }).join('') +
        '</div></fieldset>' +
        '<div class="form-actions fs-full">' +
          '<button type="submit" class="btn-primary">Analyse migration gaps</button>' +
          '<button type="button" class="btn-ghost" id="mig-all">Select all</button>' +
          '<button type="reset" class="btn-ghost">Reset</button>' +
        '</div>' +
      '</form>' +
      '<div class="results" id="r-mig"></div>' +
    '</section>');

    var form = wrap.querySelector('#f-mig');
    var out = wrap.querySelector('#r-mig');

    function run() {
      var ids = [];
      form.querySelectorAll('input[type=checkbox]:checked').forEach(function (i) { ids.push(i.value); });
      renderFindings(out, E.checkMigration({ featureIds: ids }, DATA, RULES),
        'Pick at least one capability to analyse.');
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); run(); });
    form.addEventListener('reset', function () { setTimeout(function () { out.innerHTML = ''; }, 0); });
    wrap.querySelector('#mig-all').addEventListener('click', function () {
      form.querySelectorAll('input[type=checkbox]').forEach(function (i) { i.checked = true; });
      run();
    });
    return wrap;
  }

  /* =====================================================================
     CHECKER 3 — feature availability by language
     ===================================================================== */

  function checkerFeatures() {
    var m = E.featureMatrix(DATA, RULES);
    var wrap = el('<section class="checker" id="checker-features">' +
      '<header class="checker-head">' +
        '<h2>Which EDOT SDK has the features I need?</h2>' +
        '<p>Pick the features you require. Results come straight from Elastic\'s own feature matrix, including the version each feature landed in.</p>' +
      '</header>' +
      '<form class="form-grid" id="f-feat">' +
        '<fieldset class="fs-full"><legend>Features you need</legend><div class="chips">' +
          m.features.map(function (f) {
            return '<label class="chk"><input type="checkbox" value="' + esc(f.label) + '"><span>' + esc(f.label) + '</span></label>';
          }).join('') +
        '</div></fieldset>' +
        '<label class="fs-full inline"><input type="checkbox" name="acceptPreview">' +
          '<span>Technical preview is acceptable</span></label>' +
        '<div class="form-actions fs-full">' +
          '<button type="submit" class="btn-primary">Find matching SDKs</button>' +
          '<button type="reset" class="btn-ghost">Reset</button>' +
        '</div>' +
      '</form>' +
      '<div class="results" id="r-feat"></div>' +
    '</section>');

    var form = wrap.querySelector('#f-feat');
    var out = wrap.querySelector('#r-feat');

    function run() {
      var labels = [];
      form.querySelectorAll('.chips input:checked').forEach(function (i) { labels.push(i.value); });
      if (!labels.length) { out.innerHTML = '<div class="empty-result">Pick at least one feature.</div>'; return; }
      var acceptPreview = !!form.elements['acceptPreview'].checked;
      var res = E.checkFeatures({ featureLabels: labels }, DATA, RULES);
      var sat = E.languagesSatisfying({ featureLabels: labels }, DATA, RULES, acceptPreview);

      var yes = sat.filter(function (s) { return s.satisfies; });
      var verdictCls = yes.length ? (yes.some(function (s) { return s.level === 'preview'; }) ? 'warning' : 'ok') : 'blocker';

      var head = '<div class="summary sum-' + verdictCls + '">' +
        '<div class="summary-verdict">' +
          (yes.length
            ? yes.length + ' SDK' + (yes.length === 1 ? '' : 's') + ' cover' + (yes.length === 1 ? 's' : '') + ' all ' + labels.length + ' feature' + (labels.length === 1 ? '' : 's')
            : 'No single SDK covers all ' + labels.length + ' features') +
        '</div>' +
        '<div class="summary-counts">' + sat.map(function (s) {
          return '<span class="sc ' + (s.satisfies ? (s.level === 'preview' ? 'sc-warning' : 'sc-ok') : 'sc-blocker') + '">' +
            esc(s.language) + '</span>';
        }).join('') + '</div></div>';

      // matrix of just the requested features
      var thead = '<tr><th>Feature</th>' + res.languages.map(function (l) {
        return '<th>' + esc(l) + '</th>';
      }).join('') + '<th>Source</th></tr>';

      var tbody = res.rows.map(function (row) {
        if (row.missing) {
          return '<tr><td>' + esc(row.label) + '</td><td colspan="' + (res.languages.length + 1) +
            '" class="muted">Not present in Elastic\'s feature matrix — no verdict drawn.</td></tr>';
        }
        return '<tr><td>' + esc(row.label) + '</td>' + row.cells.map(function (c) {
          return '<td><span class="pill ' +
            (c.verdict === 'supported' ? 'ok' : c.verdict === 'preview' ? 'warn' :
             c.verdict === 'not-applicable' ? 'na' : 'bad') + '">' + esc(c.raw) + '</span></td>';
        }).join('') +
        '<td class="cite"><a href="' + esc(res.sourceUrl) + '" target="_blank" rel="noopener noreferrer">docs&nbsp;↗</a></td></tr>';
      }).join('');

      var notes = res.rows.reduce(function (acc, r) { return acc.concat(r.notes || []); }, []);
      var seen = {};
      notes = notes.filter(function (n) { if (seen[n.ruleId]) return false; seen[n.ruleId] = 1; return true; });

      var blockerDetail = sat.filter(function (s) { return !s.satisfies && s.blockers.length; }).map(function (s) {
        return '<li><strong>' + esc(s.language) + '</strong> — missing: ' +
          s.blockers.map(function (b) {
            return esc(b.feature) + ' <span class="pill ' +
              (b.cell.verdict === 'preview' ? 'warn' : b.cell.verdict === 'not-applicable' ? 'na' : 'bad') +
              '">' + esc(b.cell.raw || '—') + '</span>';
          }).join(', ') + '</li>';
      }).join('');

      out.innerHTML = head +
        '<div class="tablewrap"><table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' +
        (notes.length ? '<div class="notes"><ul>' + notes.map(function (n) {
          return '<li>' + md(n.quote) + ' <a href="' + esc(n.sourceUrl) +
            '" target="_blank" rel="noopener noreferrer">↗</a></li>';
        }).join('') + '</ul></div>' : '') +
        (res.notes.length ? '<div class="notes"><ul>' + res.notes.map(function (n) {
          return '<li>' + md(n) + '</li>';
        }).join('') + '</ul></div>' : '') +
        (blockerDetail ? '<div class="gap-detail"><h4>Why the other SDKs don\'t qualify</h4><ul>' + blockerDetail + '</ul></div>' : '');
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); run(); });
    form.addEventListener('reset', function () { setTimeout(function () { out.innerHTML = ''; }, 0); });
    return wrap;
  }

  /* ------------------------------------------------------------- mount */

  function mount(host, data, rules, engine) {
    DATA = data; RULES = rules; E = engine;
    host.innerHTML =
      '<div class="checker-nav">' +
        '<button class="cnav is-on" data-target="checker-stack">1 · My stack</button>' +
        '<button class="cnav" data-target="checker-migration">2 · Migration gaps</button>' +
        '<button class="cnav" data-target="checker-features">3 · Feature by language</button>' +
      '</div>' +
      '<div class="checker-host"></div>' +
      '<p class="checker-foot">Verdict vocabulary (Supported / Compatible / Not supported / Incompatible) is Elastic\'s own — see <a href="' +
        esc(RULES.verdictSource) + '" target="_blank" rel="noopener noreferrer">Nomenclature</a>. ' +
        'This tool reports only what the docs state; it never infers a verdict for an undocumented combination.</p>';

    var hostDiv = host.querySelector('.checker-host');
    var built = {
      'checker-stack': checkerStack(),
      'checker-migration': checkerMigration(),
      'checker-features': checkerFeatures(),
    };
    var current = 'checker-stack';
    function show(id) {
      current = id;
      hostDiv.innerHTML = '';
      hostDiv.appendChild(built[id]);
      host.querySelectorAll('.cnav').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.target === id);
      });
    }
    host.querySelectorAll('.cnav').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.target); });
    });
    show(current);
  }

  window.CompatCheckers = { mount: mount };
})();
