/* ---------------------------------------------------------------------------
   Elastic APM / EDOT / Synthetics compatibility matrix explorer.
   Renders data.json. Never derives values — it only formats and filters what
   was transcribed from the Elastic docs, and always shows the source link.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var DATA = null;
  var state = { q: '', status: 'all' };

  /* ------------------------------------------------------------- utilities */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Minimal, safe inline-markdown renderer: links, code, bold, italic. */
  function md(s) {
    var out = esc(s);
    // `code`
    out = out.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    // [text](url) — http/https only
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    // **bold** then *italic*
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  /** Plain text of a cell, for searching. */
  function plain(s) {
    return String(s == null ? '' : s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
      .replace(/[`*]/g, '');
  }

  /**
   * Wraps query hits in <mark>, touching only text nodes — never tag names or
   * attribute values (so hrefs and class names are left intact).
   */
  function highlight(html, q) {
    if (!q) return html;
    var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    // Split into tags and the text between them, then only rewrite the text.
    return String(html).split(/(<[^>]*>)/).map(function (chunk) {
      if (chunk.charAt(0) === '<') return chunk;              // a tag — leave alone
      return chunk.replace(re, function (hit) {               // function replacer:
        return '<mark>' + hit + '</mark>';                    // avoids $-pattern bugs
      });
    }).join('');
  }

  /* -------------------------------------------------- status classification */

  var STATUS_RULES = [
    { cls: 'ok',   bucket: 'supported',   test: /^(✅.*|supported|yes|generally available|ga|compatible)$/i },
    { cls: 'warn', bucket: 'preview',     test: /^(𝐓.*|in technical preview|technical preview|experimental|preview)$/i },
    { cls: 'bad',  bucket: 'unsupported', test: /^(not supported|no)$/i },
    { cls: 'bad',  bucket: 'incompatible',test: /^(❌|incompatible|not available)$/i },
    { cls: 'na',   bucket: 'na',          test: /^(➖|-|n\/a|not applicable|not announced)$/i },
  ];

  /** Returns {cls,bucket} for an exact-ish status cell, else null. */
  function classify(raw) {
    var t = plain(raw).trim();
    // Compatible⁴ / Compatible (footnote markers) still count as compatible
    var base = t.replace(/[¹²³⁴⁵⁶⁷⁸⁹]+$/, '').trim();
    for (var i = 0; i < STATUS_RULES.length; i++) {
      if (STATUS_RULES[i].test.test(base)) return STATUS_RULES[i];
    }
    // "✅ 1.0+" / "𝐓 0.1.0+" style cells
    if (/^✅/.test(base)) return { cls: 'ok', bucket: 'supported' };
    if (/^𝐓/.test(base)) return { cls: 'warn', bucket: 'preview' };
    if (/^❌/.test(base)) return { cls: 'bad', bucket: 'incompatible' };
    if (/^➖/.test(base)) return { cls: 'na', bucket: 'na' };
    return null;
  }

  /** Buckets present in a whole row — used by the status filter. */
  function rowBuckets(cells) {
    var set = {};
    cells.forEach(function (c) {
      var k = classify(c);
      if (k) set[k.bucket] = true;
    });
    return set;
  }

  function renderCell(raw) {
    var k = classify(raw);
    if (k) {
      var t = plain(raw).trim();
      return '<span class="pill ' + k.cls + '">' + esc(t) + '</span>';
    }
    return md(raw);
  }

  /* --------------------------------------------------------------- matching */

  function matchesQuery(text) {
    if (!state.q) return true;
    return text.toLowerCase().indexOf(state.q.toLowerCase()) !== -1;
  }

  function matchesStatus(buckets) {
    if (state.status === 'all') return true;
    return !!buckets[state.status];
  }

  /* ---------------------------------------------------------------- render */

  function sectionHTML(ds, sec) {
    var cite = sec.sourceUrl;
    var body = '';
    var visible = 0, total = 0;

    if (sec.type === 'table') {
      var cols = sec.columns || [];
      // Column headers carry real compatibility values in the matrix-style tables
      // (e.g. "ELK 8.18 - 8.19"), so they are part of what a row is searched by.
      var ctx = ' ' + cols.map(plain).join(' ') +
                ' ' + (sec.notes || []).map(plain).join(' ') +
                ' ' + sec.heading + ' ' + ds.title;
      var rowsHTML = '';
      (sec.rows || []).forEach(function (r) {
        total++;
        var searchText = r.map(plain).join(' ') + ctx;
        var buckets = rowBuckets(r);
        if (!matchesQuery(searchText) || !matchesStatus(buckets)) return;
        visible++;
        var tds = r.map(function (c) { return '<td>' + highlight(renderCell(c), state.q) + '</td>'; }).join('');
        rowsHTML += '<tr>' + tds +
          '<td class="cite"><a href="' + esc(cite) + '" target="_blank" rel="noopener noreferrer" title="' +
          esc(cite) + '">docs&nbsp;↗</a></td></tr>';
      });
      if (!visible) return null;
      var ths = cols.map(function (c) {
        return '<th>' + highlight(md(c), state.q) + '</th>';
      }).join('');
      body = '<div class="tablewrap"><table><thead><tr>' + ths +
        '<th>Source</th></tr></thead><tbody>' + rowsHTML + '</tbody></table></div>';

    } else if (sec.type === 'list') {
      // A status filter is only meaningful for the matrix tables.
      if (state.status !== 'all') return null;
      var lis = '';
      (sec.items || []).forEach(function (it) {
        total++;
        if (!matchesQuery(plain(it) + ' ' + (sec.notes || []).map(plain).join(' ') +
                          ' ' + sec.heading + ' ' + ds.title)) return;
        visible++;
        lis += '<li>' + highlight(md(it), state.q) + '</li>';
      });
      if (!visible) return null;
      body = '<ul class="itemlist">' + lis + '</ul>';

    } else { // prose
      total = 1;
      if (!matchesQuery(plain(sec.text) + ' ' + sec.heading + ' ' + ds.title)) return null;
      if (state.status !== 'all') return null; // prose has no status to filter on
      visible = 1;
      body = '<div class="prose">' + String(sec.text || '').split(/\n\n+/).map(function (p) {
        return '<p>' + highlight(md(p), state.q) + '</p>';
      }).join('') + '</div>';
    }

    var notes = '';
    if (sec.notes && sec.notes.length) {
      notes = '<div class="notes"><ul>' + sec.notes.map(function (n) {
        return '<li>' + md(n) + '</li>';
      }).join('') + '</ul></div>';
    }

    var count = sec.type === 'table'
      ? (visible === total ? total + ' rows' : visible + ' of ' + total + ' rows')
      : (sec.type === 'list' ? (visible === total ? total + ' items' : visible + ' of ' + total + ' items') : '');

    return {
      visible: visible,
      html:
        '<section class="section">' +
          '<header>' +
            '<h3>' + esc(sec.heading) + '</h3>' +
            (count ? '<span class="rowcount">' + count + '</span>' : '') +
            '<a class="doclink" href="' + esc(cite) + '" target="_blank" rel="noopener noreferrer">Source doc</a>' +
          '</header>' +
          body + notes +
        '</section>'
    };
  }

  function datasetHTML(ds) {
    var secs = [];
    var visible = 0;
    (ds.sections || []).forEach(function (sec) {
      var r = sectionHTML(ds, sec);
      if (r) { secs.push(r.html); visible += r.visible; }
    });
    if (!secs.length) return { visible: 0, html: '' };

    var srclinks = (ds.sources || []).map(function (s) {
      return '<a class="doclink" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(s.title) + '</a>';
    }).join('');

    var legend = '';
    if (ds.legend && ds.legend.length) {
      legend = '<div class="legend">' + ds.legend.map(function (l) {
        return '<span><b>' + esc(l.symbol) + '</b>' + esc(l.meaning) + '</span>';
      }).join('') + (ds.legendSourceUrl
        ? ' <a class="doclink" href="' + esc(ds.legendSourceUrl) + '" target="_blank" rel="noopener noreferrer">Legend source</a>'
        : '') + '</div>';
    }

    var scrapeNote = ds.scrapeNote
      ? '<p class="scrapenote"><strong>Scrape note:</strong> ' + md(ds.scrapeNote) + '</p>' : '';

    return {
      visible: visible,
      html:
        '<article class="dataset" id="ds-' + esc(ds.id) + '">' +
          '<header>' +
            '<div class="ds-eyebrow">' + esc(ds.group) + '</div>' +
            '<h2>' + esc(ds.title) + '</h2>' +
            (ds.intro ? '<p class="ds-intro">' + md(ds.intro) + '</p>' : '') +
            legend + scrapeNote +
            '<div class="ds-srclinks">' + srclinks + '</div>' +
          '</header>' +
          secs.join('') +
        '</article>'
    };
  }

  function render() {
    var content = document.getElementById('content');
    var sidebar = document.getElementById('sidebar');
    var groups = {};
    var order = [];
    var html = '';
    var totalVisible = 0;

    DATA.datasets.forEach(function (ds) {
      var r = datasetHTML(ds);
      totalVisible += r.visible;
      html += r.html;
      if (!groups[ds.group]) { groups[ds.group] = []; order.push(ds.group); }
      groups[ds.group].push({ id: ds.id, title: ds.title, n: r.visible });
    });

    content.innerHTML = html || '<div class="noresults">No rows match <strong>' +
      esc(state.q) + '</strong>' + (state.status !== 'all' ? ' with that status filter' : '') + '.</div>';

    sidebar.innerHTML = order.map(function (g) {
      return '<div class="nav-group"><h3>' + esc(g) + '</h3>' + groups[g].map(function (d) {
        return '<a class="nav-link' + (d.n ? '' : ' is-empty') + '" href="#ds-' + esc(d.id) + '">' +
          esc(d.title) + '<span class="n">' + d.n + '</span></a>';
      }).join('') + '</div>';
    }).join('');

    document.getElementById('hitcount').textContent =
      (state.q || state.status !== 'all')
        ? totalVisible + ' matching entr' + (totalVisible === 1 ? 'y' : 'ies')
        : DATA.stats.rows + ' table rows · ' + DATA.stats.items + ' list items · ' +
          DATA.stats.tables + ' matrices across ' + DATA.sources.length + ' doc pages';

    observeSections();
  }

  /* ------------------------------------------------------- active nav state */
  var observer = null;
  function observeSections() {
    if (observer) observer.disconnect();
    if (!('IntersectionObserver' in window)) return;
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var id = e.target.id;
        document.querySelectorAll('.nav-link').forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === '#' + id);
        });
      });
    }, { rootMargin: '-150px 0px -70% 0px' });
    document.querySelectorAll('.dataset').forEach(function (el) { observer.observe(el); });
  }

  /* -------------------------------------------------------------- footer */
  function renderFooter() {
    var byGroup = {};
    var order = [];
    DATA.sources.forEach(function (s) {
      if (!byGroup[s.group]) { byGroup[s.group] = []; order.push(s.group); }
      byGroup[s.group].push(s);
    });
    document.getElementById('all-sources').innerHTML =
      '<h3>All ' + DATA.sources.length + ' source pages</h3><div class="srcgrid">' +
      order.map(function (g) {
        return byGroup[g].map(function (s) {
          return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' +
            esc(g) + ' — ' + esc(s.title) + '</a>';
        }).join('');
      }).join('') + '</div>';

    document.getElementById('stamp').textContent =
      'Data transcribed from Elastic docs on ' + new Date(DATA.generatedAt).toUTCString() +
      ' · ' + DATA.datasets.length + ' datasets · ' + DATA.stats.tables + ' tables · ' +
      DATA.stats.rows + ' rows';
  }

  /* ---------------------------------------------------------------- theme */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('edot-matrix-theme', t); } catch (e) {}
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('edot-matrix-theme'); } catch (e) {}
    if (!saved) {
      saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark' : 'light';
    }
    applyTheme(saved);
    document.getElementById('theme-toggle').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
  }

  /* ----------------------------------------------------------------- wire */
  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); var a = arguments; t = setTimeout(function () { fn.apply(null, a); }, ms); };
  }

  function initControls() {
    var q = document.getElementById('q');
    var clear = document.getElementById('clear-q');
    var run = debounce(function () { state.q = q.value.trim(); render(); }, 140);
    q.addEventListener('input', function () {
      clear.hidden = !q.value;
      run();
    });
    clear.addEventListener('click', function () {
      q.value = ''; clear.hidden = true; state.q = ''; render(); q.focus();
    });
    document.querySelectorAll('.tag-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.tag-btn').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        state.status = b.dataset.status;
        render();
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
      if (e.key === 'Escape' && document.activeElement === q) { q.blur(); }
    });
  }

  /* ------------------------------------------------------- mode switching */
  function initModes(data) {
    var browse = document.getElementById('browse-view');
    var check = document.getElementById('check-view');
    var filterbar = document.getElementById('filterbar');
    var browseFoot = document.getElementById('browse-foot');
    var search = document.getElementById('q').closest('.search');
    var mounted = false;
    var firstPaint = true;

    function show(mode) {
      var isCheck = mode === 'check';
      // Check mode is a focused form: the matrices, the status filters, the
      // search box and the all-sources footer all belong to Browse only.
      browse.hidden = isCheck;
      check.hidden = !isCheck;
      filterbar.hidden = isCheck;
      if (browseFoot) browseFoot.hidden = isCheck;
      if (search) search.style.visibility = isCheck ? 'hidden' : '';
      document.querySelectorAll('.mode-btn').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.mode === mode);
      });
      if (isCheck && !mounted) {
        if (window.CompatCheckers && window.CompatEngine && data.rules) {
          window.CompatCheckers.mount(check, data, data.rules, window.CompatEngine);
          mounted = true;
        } else {
          check.innerHTML = '<div class="noresults">Checkers unavailable: ' +
            (!data.rules ? 'rules.json was not bundled — run <code>node build.js</code>.'
                         : 'engine.js / checkers.js failed to load.') + '</div>';
        }
      }
      // Switching mode should land at the top, not mid-scroll from the
      // previous view. Skip on first paint so a restored mode doesn't jump.
      // Guarded: jsdom has no scrollTo implementation.
      if (!firstPaint && typeof window.scrollTo === 'function') {
        try { window.scrollTo(0, 0); } catch (e) {}
      }
      firstPaint = false;

      try { localStorage.setItem('edot-matrix-mode', mode); } catch (e) {}
    }

    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.mode); });
    });

    var saved = null;
    try { saved = localStorage.getItem('edot-matrix-mode'); } catch (e) {}
    show(saved === 'check' ? 'check' : 'browse');
  }

  function boot(data) {
    DATA = data;
    initTheme();
    initControls();
    renderFooter();
    render();
    initModes(data);
  }

  if (window.__BUNDLED_DATA__) {
    boot(window.__BUNDLED_DATA__);
  } else {
    fetch('data.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(boot)
      .catch(function (err) {
        document.getElementById('content').innerHTML =
          '<div class="noresults">Could not load <code>data.json</code> (' + esc(err.message) +
          ').<br>Run <code>node build.js</code> then <code>node server.js</code>.</div>';
      });
  }
})();
