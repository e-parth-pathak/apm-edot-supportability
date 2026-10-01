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
const EXPLAIN = has('--explain');
const EXPLAIN_N = parseInt(optOf('explain-limit') || '6', 10);
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

/**
 * Extract bullet lists and prose paragraphs, keyed by the heading above them.
 * Returns { lists: [{heading, anchor, items}], prose: [{heading, anchor, text}] }.
 *
 * Several datasets — Synthetics most of all — carry their compatibility data in
 * bullets rather than tables. Without this, refresh.js reports `tables=0` and
 * silently cannot detect any change to them.
 *
 * NESTING: the original transcription FLATTENED nested bullets into one list
 * (see data/core-synthetics.json "Private Locations", where the `elastic-agent`
 * variants are siblings of their parent bullet). This parser flattens the same
 * way, so a refresh does not report every nested item as a change. Marker style
 * (-, *, +) is normalised away for the same reason.
 */
function parseMarkdownProse(md) {
  const lines = md.split(/\r?\n/);
  const lists = [];
  const prose = [];
  let heading = null, anchor = null, inCode = false;
  let curList = null, para = [];

  const flushPara = () => {
    const text = para.join(' ').trim();
    para = [];
    if (text && heading) prose.push({ heading, anchor, text });
  };
  const flushList = () => {
    if (curList && curList.items.length) lists.push(curList);
    curList = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) { inCode = !inCode; flushPara(); flushList(); continue; }
    if (inCode) continue;

    const h = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (h) {
      flushPara(); flushList();
      let text = h[2];
      anchor = null;
      const curly = text.match(/\{#([^}\s]+)\}\s*$/);
      if (curly) { anchor = curly[1]; text = text.slice(0, curly.index); }
      const square = text.match(/\[([A-Za-z0-9._-]+)\]\s*$/);
      if (!anchor && square) { anchor = square[1]; text = text.slice(0, square.index); }
      heading = text.trim();
      continue;
    }

    // Skip table rows — parseMarkdownTables owns those.
    if (/^\s*\|/.test(line)) { flushPara(); flushList(); continue; }

    const bullet = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!curList) curList = { heading, anchor, items: [] };
      curList.items.push(bullet[3].trim());   // flattened, marker dropped
      continue;
    }

    if (!line.trim()) { flushPara(); flushList(); continue; }

    // A continuation line indented under the previous bullet belongs to it.
    if (curList && /^\s{2,}\S/.test(line) && curList.items.length) {
      curList.items[curList.items.length - 1] += ' ' + line.trim();
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();

  return { lists, prose };
}

/* ------------------------------------------------------------ cross-check */

/**
 * Strip markdown to text comparable against the RENDERED page.
 *
 * Elastic's docs-builder source is not plain markdown. Two constructs broke
 * the first live cross-check (55 of 65 cells "missing" on features.md):
 *
 *   {{product.apm}}   — a substitution variable. The source says
 *                       "{{product.apm}}", the page says "APM". Comparing the
 *                       raw token can never match.
 *   [Compatible]      — a REFERENCE-style link whose target is defined
 *                       elsewhere in the file. Only inline [text](url) was
 *                       being unwrapped, so the brackets survived into the
 *                       comparison and never matched the rendered text.
 *
 * Both are formatting, not content — so they are normalised away rather than
 * reported as drift. Anything left unresolved is still compared verbatim.
 */
function plain(s) {
  return String(s == null ? '' : s)
    // inline links:    [text](url)  -> text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // reference links: [text][ref]  -> text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // shortcut refs:   [text]       -> text   (target defined elsewhere)
    .replace(/\[([^\]\n]+)\]/g, '$1')
    // docs-builder substitutions: {{product.apm}} -> dropped, the rendered
    // value is unknown to us and must not be compared as a literal token.
    .replace(/\{\{[^}]*\}\}/g, ' ')
    // applies_to / directive blocks leak markers into cells
    .replace(/:{3,}/g, ' ')
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
        // Skip trivia: empty, single symbols, pure punctuation. A cell that was
        // nothing but a {{substitution}} normalises to empty and lands here —
        // correctly, since we cannot know its rendered value to compare.
        if (p.length < 4) continue;
        // Skip cells that are only a version/symbol token; these appear
        // verbatim in dozens of places and match trivially either way.
        if (/^[✅𝐓➖❌\s\d.x+v≥<>-]+$/.test(p)) continue;
        checked++;
        if (hay.indexOf(p) === -1) {
          const m = { heading: t.heading, cell: p.slice(0, 140) };
          // Diagnose WHY it missed, so a miss is actionable rather than a count.
          // The common causes are all benign formatting differences, not drift.
          const head = p.slice(0, 24);
          const idx = hay.indexOf(head);
          if (idx !== -1) {
            m.reason = 'prefix-found-suffix-differs';
            m.htmlNearby = hay.slice(idx, idx + Math.max(60, p.length + 20));
          } else {
            const words = p.split(' ').filter(w => w.length > 3);
            const anchorWord = words.find(w => hay.indexOf(w) !== -1);
            if (anchorWord) {
              const wi = hay.indexOf(anchorWord);
              m.reason = 'partial-word-match';
              m.htmlNearby = hay.slice(Math.max(0, wi - 30), wi + 90);
            } else {
              m.reason = 'absent-from-rendered-page';
            }
          }
          missing.push(m);
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
      if (md.includes(w)) { console.log('  ✓ ' + w); continue; }
      console.log('  ✗ ' + w);
      const base = path.basename(w);
      const near = md.filter(m => m.endsWith('/' + base)).slice(0, 6);
      near.forEach(n => console.log('      candidate: ' + n));
      if (!near.length) {
        // Fall back to the parent directory listing so a renamed folder is obvious.
        const parent = path.dirname(path.dirname(w));
        const sameArea = md.filter(m => m.startsWith(parent + '/')).slice(0, 12);
        if (sameArea.length) sameArea.forEach(n => console.log('      nearby: ' + n));
        else console.log('      (nothing under ' + parent + '/ — the whole area may have moved)');
      }
    }

    // Print the SDK doc tree in full: that is where every 404 landed, and the
    // directory naming is the thing that cannot be guessed from the URL slug.
    const sdkDocs = md.filter(m => /edot-sdks?\//.test(m));
    if (sdkDocs.length) {
      console.log('\n  --- all EDOT SDK markdown in this repo (' + sdkDocs.length + ') ---');
      sdkDocs.forEach(n => console.log('    ' + n));
    }
  }

  // If the per-language SDK pages are not in elastic/opentelemetry, they live
  // in the individual SDK repos (docs-builder assembles them into one site).
  // Probe candidate repos rather than guessing paths into sources.json.
  await probeSdkRepos();
}

/**
 * The 8 per-language EDOT SDK pages are not in elastic/opentelemetry — the
 * first live run proved the repo holds exactly one edot-sdks markdown file.
 * Each SDK is its own repo. This probes the likely repo names and prints the
 * markdown files each one actually publishes, so sources.json can be corrected
 * from observed fact rather than convention.
 */
async function probeSdkRepos() {
  const candidates = {
    dotnet:  ['elastic-otel-dotnet'],
    java:    ['elastic-otel-java'],
    node:    ['elastic-otel-node'],
    php:     ['elastic-otel-php'],
    python:  ['elastic-otel-python'],
    android: ['elastic-otel-android'],
    ios:     ['elastic-otel-ios', 'apm-agent-ios'],
    browser: ['elastic-otel-rum-js', 'elastic-otel-browser'],
  };

  console.log('\n\n=== probing per-SDK repos for their docs ===');
  console.log('(the 8 language pages are not in elastic/opentelemetry)\n');

  const resolved = {};

  for (const [sdk, repos] of Object.entries(candidates)) {
    let done = false;
    for (const repo of repos) {
      if (done) break;
      const url = 'https://api.github.com/repos/elastic/' + repo + '/git/trees/main?recursive=1';
      const res = await get(url, 'application/vnd.github+json');
      if (!res.ok) {
        console.log('  ' + sdk.padEnd(8) + ' elastic/' + repo.padEnd(26) + ' -> ' +
          (res.status === 404 ? 'no such repo' : (res.error || res.status)));
        continue;
      }
      let tree;
      try { tree = JSON.parse(res.body).tree || []; } catch (e) { continue; }
      const docs = tree.map(n => n.path)
        .filter(p => p.endsWith('.md') && /docs?\//.test(p) && !/node_modules/.test(p));
      console.log('  ' + sdk.padEnd(8) + ' elastic/' + repo.padEnd(26) + ' -> ' +
        docs.length + ' markdown file(s) under docs/');
      docs.slice(0, 20).forEach(p => console.log('           ' + p));
      if (docs.length > 20) console.log('           … ' + (docs.length - 20) + ' more');
      if (docs.length) { resolved[sdk] = { repo: 'elastic/' + repo, docs: docs.slice(0, 20) }; done = true; }
    }
  }

  if (Object.keys(resolved).length) {
    console.log('\n--- suggested sources.json repo entries (VERIFY before pasting) ---');
    for (const [sdk, r] of Object.entries(resolved)) {
      const idx = r.docs.find(p => /index\.md$/.test(p)) || r.docs[0];
      const sup = r.docs.find(p => /supported-technologies\.md$/.test(p)) ||
                  r.docs.find(p => /automatic-instrumentation\.md$/.test(p));
      console.log('  ' + sdk + ':');
      console.log('    repo   : ' + r.repo);
      console.log('    index  : ' + idx);
      if (sup) console.log('    support: ' + sup);
    }
  }

  console.log('\nPaste the corrected repo + mdPath into data/sources.json,');
  console.log('then set each entry\'s "verified" to "resolved-from-tree".');
}

/* --------------------------------------------------------------- refresh */

async function fetchPage(page, repo) {
  const rawUrl = repo.rawBase + page.mdPath;
  const result = {
    liveUrl: page.liveUrl, mdPath: page.mdPath, rawUrl,
    md: null, mdStatus: null, html: null, htmlStatus: null,
    tables: [], lists: [], prose: [], crossCheck: null, errors: [],
  };

  // mdPath: null means "we know there is no markdown source configured for
  // this page" (see knownGaps in sources.json). Skipping is honest; retrying a
  // path we have proven does not exist would just manufacture a 404 每 run.
  if (!page.mdPath) {
    result.mdStatus = 'skipped';
    result.noMarkdownSource = true;
    result.errors.push('no markdown source configured (' +
      (page.verified || 'unresolved') + ') — cannot detect drift for this page. ' +
      'Run: node refresh.js --resolve-paths');
  } else {
    const mdRes = await get(rawUrl, 'text/plain');
    result.mdStatus = mdRes.status || mdRes.error;
    if (mdRes.ok) {
      result.md = mdRes.body;
      result.tables = parseMarkdownTables(mdRes.body);
      const p = parseMarkdownProse(mdRes.body);
      result.lists = p.lists;
      result.prose = p.prose;
    } else {
      result.errors.push('markdown fetch failed (' + (mdRes.error || mdRes.status) +
        ') — check mdPath in data/sources.json, then run: node refresh.js --resolve-paths');
    }
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

  // Cross-check list items alongside table cells: a list item is just as much
  // a compatibility claim as a cell, and Synthetics has almost nothing else.
  const listAsTables = result.lists.map(l => ({
    heading: l.heading, columns: ['item'], rows: l.items.map(i => [i]),
  }));
  if ((result.tables.length || listAsTables.length) && result.html) {
    result.crossCheck = crossCheck(result.tables.concat(listAsTables), result.html);
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
    const entry = { datasetId: d.datasetId, file: d.file, pages: [], tables: 0, lists: 0, errors: [] };

    for (const page of d.pages) {
      const repo = manifest.repos[page.repo];
      const r = await fetchPage(page, repo);
      entry.pages.push({
        liveUrl: r.liveUrl, mdPath: r.mdPath,
        mdStatus: r.mdStatus, htmlStatus: r.htmlStatus,
        tables: r.tables.length,
        lists: r.lists.length,
        crossChecked: r.crossCheck ? r.crossCheck.checked : 0,
        crossCheckMissing: r.crossCheck ? r.crossCheck.missing : [],
        errors: r.errors,
      });
      entry.tables += r.tables.length;
      entry.lists += r.lists.length;
      entry.errors.push(...r.errors);

      const flag = r.errors.length ? '!' : '✓';
      console.log('   ' + flag + ' ' + page.mdPath +
        '  md=' + r.mdStatus + ' html=' + r.htmlStatus +
        ' tables=' + r.tables.length + ' lists=' + r.lists.length +
        (r.crossCheck ? ' xcheck=' + r.crossCheck.checked +
          (r.crossCheck.missing.length ? ' MISSING=' + r.crossCheck.missing.length : '') : ''));
      r.errors.forEach(e => console.log('       ' + e));

      if (EXPLAIN && r.crossCheck && r.crossCheck.missing.length) {
        const byReason = {};
        r.crossCheck.missing.forEach(m => {
          byReason[m.reason] = (byReason[m.reason] || 0) + 1;
        });
        console.log('       reasons: ' + JSON.stringify(byReason));
        r.crossCheck.missing.slice(0, EXPLAIN_N).forEach(m => {
          console.log('       ── ' + m.reason);
          console.log('          md   : ' + JSON.stringify(m.cell));
          if (m.htmlNearby) console.log('          html : ' + JSON.stringify(m.htmlNearby));
        });
        if (r.crossCheck.missing.length > EXPLAIN_N) {
          console.log('       … ' + (r.crossCheck.missing.length - EXPLAIN_N) + ' more');
        }
      }

      // Stage the parsed tables for the differ.
      const stagePath = path.join(STAGING, d.datasetId + '__' +
        page.mdPath.replace(/[\/]/g, '_') + '.json');
      fs.writeFileSync(stagePath, JSON.stringify({
        datasetId: d.datasetId, liveUrl: r.liveUrl, mdPath: r.mdPath,
        fetchedAt: new Date().toISOString(),
        tables: r.tables, lists: r.lists, prose: r.prose, errors: r.errors,
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
  console.log('lists parsed     : ' + report.datasets.reduce((a, d) => a + (d.lists || 0), 0));
  console.log('with problems    : ' + withErrors.length);
  console.log('staging dir      : .refresh-staging/');
  console.log('\nNothing in data/ was modified. Next: node diff-refresh.js');

  if (withErrors.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
