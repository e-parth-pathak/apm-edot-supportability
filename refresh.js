#!/usr/bin/env node
/**
 * refresh.js — re-pull the compatibility data from Elastic's docs.
 *
 * STRATEGY (cross-checked, per the project's no-hallucination rule)
 * ----------------------------------------------------------------
 *  1. MARKDOWN is the parse source. Each page's .md file lives in
 *     elastic/docs-content or elastic/opentelemetry (the "Edit this page"
 *     target). Tables parse cleanly and carry no site boilerplate.
 *  2. LIVE HTML is the cross-check. Every value parsed from markdown must also
 *     appear in the rendered page. A value present in one but not the other is
 *     reported as a conflict and never auto-applied.
 *  3. Nothing is written to data/ by this script except pure additions
 *     (see apply-refresh.js). Modified and removed rows always need review.
 *
 * Output: .refresh-staging/<datasetId>.json  plus  .refresh-staging/report.json
 *
 *   node refresh.js                  # fetch everything
 *   node refresh.js --only java,php  # fetch specific datasets
 *   node refresh.js --offline        # re-run the diff on existing staging data
 *   node refresh.js --resolve-paths  # list repo trees to fix sources.json paths
 *
 * NOTE ON VERIFICATION: this script's network paths could not be executed in
 * the environment where it was written (elastic.co and raw.githubusercontent
 * were both unreachable). The parsing and diffing logic IS covered by
 * test-refresh.js against recorded fixtures. Treat the first real run as
 * needing a human eye — it prints everything it does and writes nothing to
 * data/ on its own.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const DATA_DIR = path.join(HERE, 'data');
const STAGING = path.join(HERE, '.refresh-staging');
const MANIFEST = path.join(DATA_DIR, 'sources.json');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const optOf = name => {
  const i = argv.findIndex(a => a === '--' + name);
  return i >= 0 ? argv[i + 1] : null;
};

const OFFLINE = has('--offline');
const RESOLVE_PATHS = has('--resolve-paths');
const ONLY = (optOf('only') || '').split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT_MS = 25000;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

/* ------------------------------------------------------------------ fetch */

async function get(url, accept) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'accept': accept || 'text/plain',
        'user-agent': 'apm-edot-supportability-refresh (+https://github.com/e-parth-pathak/apm-edot-supportability)',
      },
    });
    const body = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, body, url };
  } catch (e) {
    return { ok: false, status: 0, body: '', url, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

/* ----------------------------------------------------- markdown table parse */

/**
 * Extract GitHub-flavoured markdown tables, keyed by the heading above them.
 * Returns [{ heading, anchor, columns, rows }].
 *
 * Deliberately conservative: it only recognises a table when a header row is
 * followed by a `|---|---|` separator with a matching column count. Anything
 * ambiguous is skipped and reported rather than guessed at.
 */
function parseMarkdownTables(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let heading = null, anchor = null, inCode = false;

  const splitRow = line => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    // split on unescaped pipes that are not inside inline code
    const cells = [];
    let cur = '', tick = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '`') tick = !tick;
      if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;

    // Headings carry an explicit anchor in one of two syntaxes:
    //   Elastic docs-builder :  ## Go agent [go-agent]
    //   Common markdown attr :  ## Go agent {#go-agent}
    // Both must be stripped from the heading text, or heading-matching in
    // diff-refresh.js will never line up with the committed section headings.
    const h = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (h) {
      let text = h[2];
      anchor = null;

      const curly = text.match(/\{#([^}\s]+)\}\s*$/);
      if (curly) { anchor = curly[1]; text = text.slice(0, curly.index); }

      const square = text.match(/\[([A-Za-z0-9._-]+)\]\s*$/);
      if (!anchor && square) { anchor = square[1]; text = text.slice(0, square.index); }

      heading = text.trim();
      continue;
    }

    if (!/\|/.test(line)) continue;
    const sep = lines[i + 1];
    if (!sep || !/^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(sep) || !/\|/.test(sep)) continue;

    const columns = splitRow(line);
    const sepCells = splitRow(sep);
    if (sepCells.length !== columns.length) continue;

    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const r = lines[j];
      if (!r.trim() || !/\|/.test(r)) break;
      if (/^\s*#{1,6}\s/.test(r)) break;
      const cells = splitRow(r);
      while (cells.length < columns.length) cells.push('');
      rows.push(cells.slice(0, columns.length));
    }

    out.push({ heading, anchor, columns, rows });
    i = j - 1;
  }
  return out;
}

/* ------------------------------------------------------------ cross-check */

/** Strip markdown to comparable plain text. */
function plain(s) {
  return String(s == null ? '' : s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Very rough HTML-to-text, adequate for containment checks. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, '’').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does every non-trivial cell parsed from markdown also appear in the rendered
 * page? Returns the cells that do not.
 */
function crossCheck(tables, htmlText) {
  const missing = [];
  if (!htmlText) return { checked: 0, missing, skipped: true };
  let checked = 0;
  const hay = htmlText.replace(/’/g, "'");

  for (const t of tables) {
    for (const row of t.rows) {
      for (const cell of row) {
        const p = plain(cell).replace(/’/g, "'");
        // Skip trivia: empty, single symbols, pure punctuation.
        if (p.length < 4) continue;
        checked++;
        if (hay.indexOf(p) === -1) {
          missing.push({ heading: t.heading, cell: p.slice(0, 140) });
        }
      }
    }
  }
  return { checked, missing, skipped: false };
}

/* ------------------------------------------------------- path resolution */

/**
 * List a repo's markdown tree so a human can fix sources.json when a path
 * 404s. Uses the git trees API (one call per repo, no token needed for public
 * repos, though rate-limited).
 */
async function resolvePaths() {
  for (const [key, r] of Object.entries(manifest.repos)) {
    const url = r.apiBase + 'git/trees/' + r.branch + '?recursive=1';
    console.log('\n=== ' + key + ' — ' + url);
    const res = await get(url, 'application/vnd.github+json');
    if (!res.ok) {
      console.log('  FAILED (' + (res.error || res.status) + ')');
      continue;
    }
    let tree;
    try { tree = JSON.parse(res.body).tree || []; }
    catch (e) { console.log('  unparseable response'); continue; }

    const wanted = manifest.datasets
      .flatMap(d => d.pages)
      .filter(p => p.repo === key)
      .map(p => p.mdPath);

    const md = tree.filter(n => n.path.endsWith('.md')).map(n => n.path);
    console.log('  ' + md.length + ' markdown files in tree');
    for (const w of wanted) {
      const exact = md.includes(w);
      if (exact) { console.log('  ✓ ' + w); continue; }
      const base = path.basename(w);
      const near = md.filter(m => m.endsWith('/' + base)).slice(0, 5);
      console.log('  ✗ ' + w);
      near.forEach(n => console.log('      candidate: ' + n));
      if (!near.length) {
        const dir = path.dirname(w);
        const sameDir = md.filter(m => m.startsWith(dir.split('/').slice(0, -1).join('/'))).slice(0, 8);
        sameDir.forEach(n => console.log('      nearby: ' + n));
      }
    }
  }
}

/* --------------------------------------------------------------- refresh */

async function fetchPage(page, repo) {
  const rawUrl = repo.rawBase + page.mdPath;
  const result = {
    liveUrl: page.liveUrl, mdPath: page.mdPath, rawUrl,
    md: null, mdStatus: null, html: null, htmlStatus: null,
    tables: [], crossCheck: null, errors: [],
  };

  const mdRes = await get(rawUrl, 'text/plain');
  result.mdStatus = mdRes.status || mdRes.error;
  if (mdRes.ok) {
    result.md = mdRes.body;
    result.tables = parseMarkdownTables(mdRes.body);
  } else {
    result.errors.push('markdown fetch failed (' + (mdRes.error || mdRes.status) +
      ') — check mdPath in data/sources.json, then run: node refresh.js --resolve-paths');
  }

  const htmlRes = await get(page.liveUrl, 'text/html');
  result.htmlStatus = htmlRes.status || htmlRes.error;
  if (htmlRes.ok) {
    result.html = htmlToText(htmlRes.body);
    if (!result.html || result.html.length < 500) {
      result.errors.push('rendered page returned little or no text (' + (result.html || '').length +
        ' chars) — the page may be empty or unpublished');
    }
  } else {
    result.errors.push('live page fetch failed (' + (htmlRes.error || htmlRes.status) + ')');
  }

  if (result.tables.length && result.html) {
    result.crossCheck = crossCheck(result.tables, result.html);
    if (result.crossCheck.missing.length) {
      result.errors.push(result.crossCheck.missing.length +
        ' cell(s) parsed from markdown were NOT found in the rendered page — ' +
        'markdown may be ahead of the published site, or the parse is wrong. Not auto-applying.');
    }
  }

  return result;
}

async function main() {
  if (RESOLVE_PATHS) { await resolvePaths(); return; }

  fs.mkdirSync(STAGING, { recursive: true });

  const targets = manifest.datasets.filter(d => !ONLY.length || ONLY.includes(d.datasetId));
  if (!targets.length) {
    console.error('No datasets matched --only ' + ONLY.join(','));
    process.exit(1);
  }

  const report = {
    startedAt: new Date().toISOString(),
    mode: OFFLINE ? 'offline (no fetch)' : 'cross-checked fetch',
    datasets: [],
    reachable: null,
  };

  if (OFFLINE) {
    console.log('--offline: skipping all network calls.');
    console.log('Run "node diff-refresh.js" to diff whatever is already in .refresh-staging/.');
    return;
  }

  // Fail fast and clearly if there is simply no network.
  const probe = await get(manifest.repos.opentelemetry.rawBase + 'README.md', 'text/plain');
  report.reachable = probe.ok;
  if (!probe.ok) {
    console.error('\nCANNOT REACH raw.githubusercontent.com (' + (probe.error || probe.status) + ').');
    console.error('refresh.js needs outbound HTTPS to raw.githubusercontent.com and www.elastic.co.');
    console.error('Nothing was written. Existing data/ is untouched.\n');
    fs.writeFileSync(path.join(STAGING, 'report.json'), JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log('Refreshing ' + targets.length + ' dataset(s)\n');

  for (const d of targets) {
    console.log('── ' + d.datasetId + '  (' + d.file + ')');
    const entry = { datasetId: d.datasetId, file: d.file, pages: [], tables: 0, errors: [] };

    for (const page of d.pages) {
      const repo = manifest.repos[page.repo];
      const r = await fetchPage(page, repo);
      entry.pages.push({
        liveUrl: r.liveUrl, mdPath: r.mdPath,
        mdStatus: r.mdStatus, htmlStatus: r.htmlStatus,
        tables: r.tables.length,
        crossChecked: r.crossCheck ? r.crossCheck.checked : 0,
        crossCheckMissing: r.crossCheck ? r.crossCheck.missing : [],
        errors: r.errors,
      });
      entry.tables += r.tables.length;
      entry.errors.push(...r.errors);

      const flag = r.errors.length ? '!' : '✓';
      console.log('   ' + flag + ' ' + page.mdPath +
        '  md=' + r.mdStatus + ' html=' + r.htmlStatus +
        ' tables=' + r.tables.length +
        (r.crossCheck ? ' xcheck=' + r.crossCheck.checked +
          (r.crossCheck.missing.length ? ' MISSING=' + r.crossCheck.missing.length : '') : ''));
      r.errors.forEach(e => console.log('       ' + e));

      // Stage the parsed tables for the differ.
      const stagePath = path.join(STAGING, d.datasetId + '__' +
        page.mdPath.replace(/[\/]/g, '_') + '.json');
      fs.writeFileSync(stagePath, JSON.stringify({
        datasetId: d.datasetId, liveUrl: r.liveUrl, mdPath: r.mdPath,
        fetchedAt: new Date().toISOString(),
        tables: r.tables, errors: r.errors,
      }, null, 2));
    }

    report.datasets.push(entry);
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(STAGING, 'report.json'), JSON.stringify(report, null, 2));

  const withErrors = report.datasets.filter(d => d.errors.length);
  console.log('\n--- summary ---');
  console.log('datasets fetched : ' + report.datasets.length);
  console.log('tables parsed    : ' + report.datasets.reduce((a, d) => a + d.tables, 0));
  console.log('with problems    : ' + withErrors.length);
  console.log('staging dir      : .refresh-staging/');
  console.log('\nNothing in data/ was modified. Next: node diff-refresh.js');

  if (withErrors.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
