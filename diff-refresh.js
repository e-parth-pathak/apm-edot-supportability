#!/usr/bin/env node
/**
 * diff-refresh.js — compare .refresh-staging/ against committed data/.
 *
 * POLICY (chosen deliberately)
 * ----------------------------
 *   ADDED rows      -> safe to auto-apply. New rows cannot invalidate an
 *                      existing citation; they only extend a table.
 *   CHANGED cells   -> ALWAYS require review. A changed cell can silently
 *                      flip a verdict the checkers report.
 *   REMOVED rows    -> ALWAYS require review. Removal may mean Elastic dropped
 *                      support, or may mean the parse broke. Cannot tell apart.
 *   NEW/GONE tables -> require review.
 *
 * It also reports which rules.json quotes would stop being grounded, because
 * that is the failure mode that would break the checkers rather than the
 * browse view.
 *
 *   node diff-refresh.js              # report only
 *   node diff-refresh.js --apply-additions
 *   node diff-refresh.js --json       # machine-readable, for CI
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const DATA_DIR = path.join(HERE, 'data');
const STAGING = path.join(HERE, '.refresh-staging');

const argv = process.argv.slice(2);
const APPLY_ADDITIONS = argv.includes('--apply-additions');
const AS_JSON = argv.includes('--json');

if (!fs.existsSync(STAGING)) {
  console.error('No .refresh-staging/ directory. Run: node refresh.js');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sources.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rules.json'), 'utf8'));

/* ------------------------------------------------------------------ utils */

const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/**
 * Row identity.
 *
 * The first column alone is NOT unique. Several real tables list one subject
 * across multiple rows — "Go agent" appears for both `1.x` and `2.x`, Ruby for
 * `3.x`/`4.x`, JavaScript RUM for `4.x`/`5.x`. Keying on column 0 collapsed
 * those into one Map entry and silently hid changes on the shadowed row.
 *
 * So the key is every column EXCEPT the last one, which is treated as the
 * "value" being compared. For a 2-column table that means column 0 identifies
 * and column 1 is the value; for the 3-column combined table, columns 0-1
 * identify (agent + agent version) and column 2 is the integration floor.
 *
 * Tables where even that is ambiguous are handled by the duplicate-key guard
 * below, which escalates to review rather than guessing.
 */
function rowKey(row, colCount) {
  const n = Math.max(1, (colCount || row.length) - 1);
  return row.slice(0, n).map(c => norm(c).toLowerCase()).join(' ⟂ ');
}

/** Index rows by key, reporting any key that appears more than once. */
function indexRows(rows, colCount) {
  const map = new Map();
  const dupes = [];
  for (const r of rows || []) {
    const k = rowKey(r, colCount);
    if (map.has(k)) dupes.push(k);
    else map.set(k, r);
  }
  return { map, dupes };
}

function loadDataset(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stagedFor(datasetId) {
  return fs.readdirSync(STAGING)
    .filter(f => f.startsWith(datasetId + '__') && f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(STAGING, f), 'utf8')));
}

/** Match a staged table to a committed section by heading, then by columns. */
function matchSection(sections, table) {
  const byHeading = sections.find(s =>
    s.type === 'table' && norm(s.heading).toLowerCase() === norm(table.heading || '').toLowerCase());
  if (byHeading) return byHeading;

  const sig = t => (t.columns || []).map(c => norm(c).toLowerCase()).join('|');
  return sections.find(s => s.type === 'table' && sig(s) === sig(table)) || null;
}

/* ------------------------------------------------------------------- diff */

const findings = [];
const additionsToApply = [];   // { file, sectionHeading, rows: [...] }

for (const d of manifest.datasets) {
  const staged = stagedFor(d.datasetId);
  if (!staged.length) continue;

  const ds = loadDataset(d.file);
  if (!ds) {
    findings.push({ kind: 'dataset-missing', datasetId: d.datasetId, file: d.file, severity: 'review' });
    continue;
  }

  const fetchErrors = staged.flatMap(s => s.errors || []);
  if (fetchErrors.length) {
    findings.push({
      kind: 'fetch-problem', datasetId: d.datasetId, severity: 'review',
      detail: fetchErrors.join(' | '),
    });
  }

  const stagedTables = staged.flatMap(s => (s.tables || []).map(t => ({ ...t, mdPath: s.mdPath })));
  const stagedLists = staged.flatMap(s => (s.lists || []).map(l => ({ ...l, mdPath: s.mdPath })));
  const seenSections = new Set();

  /* ---- list sections -------------------------------------------------
     Same policy as tables: new items are additive and safe; changed or
     removed items can flip a documented claim and always need review.
     Synthetics is almost entirely lists, so without this its data cannot
     be refreshed at all. ------------------------------------------------ */
  for (const list of stagedLists) {
    if (!list.items || !list.items.length) continue;

    const sec = (ds.sections || []).find(s =>
      s.type === 'list' && norm(s.heading).toLowerCase() === norm(list.heading || '').toLowerCase());
    if (!sec) continue;   // a list with no matching section is not evidence of drift
    seenSections.add(sec.heading);

    const nowItems = (sec.items || []).map(norm);
    const newItems = list.items.map(norm);
    const nowSet = new Set(nowItems.map(i => i.toLowerCase()));
    const newSet = new Set(newItems.map(i => i.toLowerCase()));

    const addedItems = newItems.filter(i => !nowSet.has(i.toLowerCase()));
    const removedItems = nowItems.filter(i => !newSet.has(i.toLowerCase()));

    if (addedItems.length && !removedItems.length) {
      findings.push({
        kind: 'list-items-added', datasetId: d.datasetId, severity: 'auto',
        heading: sec.heading, rows: addedItems.map(i => [i]),
      });
      additionsToApply.push({
        file: d.file, sectionHeading: sec.heading, listItems: addedItems,
      });
    } else if (addedItems.length || removedItems.length) {
      // Both together usually means an item was REWORDED, not added+removed.
      // That is a content change, so it goes to review rather than auto-apply.
      findings.push({
        kind: 'list-items-changed', datasetId: d.datasetId, severity: 'review',
        heading: sec.heading,
        detail: (addedItems.length ? addedItems.length + ' new' : '') +
          (addedItems.length && removedItems.length ? ' and ' : '') +
          (removedItems.length ? removedItems.length + ' missing' : '') +
          ' item(s). If an item was reworded this is one edit, not two — check before applying.',
        added: addedItems, removed: removedItems,
      });
    }
  }

  for (const table of stagedTables) {
    if (!table.rows || !table.rows.length) continue;

    const sec = matchSection(ds.sections || [], table);
    if (!sec) {
      findings.push({
        kind: 'new-table', datasetId: d.datasetId, severity: 'review',
        heading: table.heading, columns: table.columns, rowCount: table.rows.length,
        detail: 'A table in the docs has no matching section in data/' + d.file +
          '. Elastic may have added a table, or the heading changed.',
      });
      continue;
    }
    seenSections.add(sec.heading);

    // Column drift is always review-worthy: it reshapes every row.
    const colsNow = (sec.columns || []).map(norm);
    const colsNew = (table.columns || []).map(norm);
    if (colsNow.join('|') !== colsNew.join('|')) {
      findings.push({
        kind: 'columns-changed', datasetId: d.datasetId, severity: 'review',
        heading: sec.heading, before: colsNow, after: colsNew,
      });
      continue; // do not row-diff against different columns
    }

    const nowIdx = indexRows(sec.rows, colsNow.length);
    const newIdx = indexRows(table.rows, colsNew.length);
    const nowByKey = nowIdx.map;
    const newByKey = newIdx.map;

    // If either side has genuinely ambiguous rows, a row-level diff cannot be
    // trusted — escalate instead of reporting a possibly-wrong result.
    if (nowIdx.dupes.length || newIdx.dupes.length) {
      findings.push({
        kind: 'ambiguous-rows', datasetId: d.datasetId, severity: 'review',
        heading: sec.heading,
        detail: 'Rows share an identifying key, so additions/changes cannot be told apart ' +
          'reliably: ' + [...new Set([...nowIdx.dupes, ...newIdx.dupes])].slice(0, 5).join('; ') +
          '. Compare this table by hand.',
      });
      continue;
    }

    // added
    const added = [];
    for (const [k, r] of newByKey) {
      if (!nowByKey.has(k)) added.push(r);
    }
    if (added.length) {
      findings.push({
        kind: 'rows-added', datasetId: d.datasetId, severity: 'auto',
        heading: sec.heading, rows: added,
      });
      additionsToApply.push({ file: d.file, sectionHeading: sec.heading, rows: added });
    }

    // removed
    const removed = [];
    for (const [k, r] of nowByKey) {
      if (!newByKey.has(k)) removed.push(r);
    }
    if (removed.length) {
      findings.push({
        kind: 'rows-removed', datasetId: d.datasetId, severity: 'review',
        heading: sec.heading, rows: removed,
        detail: 'Row(s) present in data/ but not in the refreshed docs. Either Elastic ' +
          'removed them, or the markdown parse missed them. Verify before deleting.',
      });
    }

    // changed — compare every column; the key columns are equal by
    // construction, so any difference is in the value column(s).
    for (const [k, newRow] of newByKey) {
      const oldRow = nowByKey.get(k);
      if (!oldRow) continue;
      const cells = [];
      for (let i = 0; i < colsNow.length; i++) {
        if (norm(oldRow[i]) !== norm(newRow[i])) {
          cells.push({ column: colsNow[i], before: oldRow[i], after: newRow[i] });
        }
      }
      if (cells.length) {
        findings.push({
          kind: 'cells-changed', datasetId: d.datasetId, severity: 'review',
          heading: sec.heading,
          row: k.split(' ⟂ ').join(' · '),
          cells,
        });
      }
    }
  }
}

/* ------------------------------------- which rule quotes would break? ---- */

/**
 * A rule's quote must appear verbatim in its dataset. If a refresh changes a
 * sentence a rule quotes, the rule silently loses its grounding — check-quotes
 * would fail on the next build. Predict that here, before anything is applied.
 */
function quotesAtRisk() {
  const risks = [];
  const changed = findings.filter(f => f.kind === 'cells-changed' || f.kind === 'rows-removed');
  if (!changed.length) return risks;

  const changedText = new Set();
  for (const f of changed) {
    if (f.cells) f.cells.forEach(c => { changedText.add(norm(c.before)); });
    if (f.rows) f.rows.forEach(r => r.forEach(c => changedText.add(norm(c))));
  }

  for (const r of rules.rules) {
    const q = norm(r.quote);
    for (const t of changedText) {
      if (!t || t.length < 12) continue;
      if (q.includes(t) || t.includes(q)) {
        risks.push({ ruleId: r.id, datasetId: r.datasetId, quote: r.quote.slice(0, 120), matchedChange: t.slice(0, 120) });
        break;
      }
    }
  }
  return risks;
}

const risks = quotesAtRisk();

/* ----------------------------------------------------------------- apply */

let applied = 0;
if (APPLY_ADDITIONS && additionsToApply.length) {
  const byFile = new Map();
  for (const a of additionsToApply) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }
  for (const [file, list] of byFile) {
    const p = path.join(DATA_DIR, file);
    const ds = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const a of list) {
      const sec = ds.sections.find(s => s.heading === a.sectionHeading);
      if (!sec) continue;
      if (a.listItems) {
        sec.items = sec.items || [];
        sec.items.push(...a.listItems);
        applied += a.listItems.length;
      } else if (a.rows) {
        sec.rows.push(...a.rows);
        applied += a.rows.length;
      }
    }
    fs.writeFileSync(p, JSON.stringify(ds, null, 2) + '\n');
  }
}

/* ---------------------------------------------------------------- report */

const autoCount = findings.filter(f => f.severity === 'auto').length;
const reviewCount = findings.filter(f => f.severity === 'review').length;

if (AS_JSON) {
  console.log(JSON.stringify({
    findings, quotesAtRisk: risks,
    counts: { auto: autoCount, review: reviewCount, appliedRows: applied },
  }, null, 2));
} else {
  console.log('Refresh diff\n');
  if (!findings.length) {
    console.log('  No differences. The committed data matches the docs as fetched.');
  }

  for (const f of findings) {
    const tag = f.severity === 'auto' ? '[auto]  ' : '[REVIEW]';
    console.log(tag + ' ' + f.kind + '  ' + f.datasetId + (f.heading ? '  — ' + f.heading : ''));
    if (f.detail) console.log('         ' + f.detail);
    if (f.before) console.log('         before: ' + JSON.stringify(f.before));
    if (f.after) console.log('         after : ' + JSON.stringify(f.after));
    if (f.cells) f.cells.forEach(c =>
      console.log('         row "' + f.row + '" · ' + c.column +
        '\n           - ' + JSON.stringify(c.before) + '\n           + ' + JSON.stringify(c.after)));
    if (f.added) f.added.slice(0, 5).forEach(r => console.log('         + ' + JSON.stringify(r)));
    if (f.removed) f.removed.slice(0, 5).forEach(r => console.log('         - ' + JSON.stringify(r)));
    if (f.rows) f.rows.slice(0, 6).forEach(r => console.log('         · ' + JSON.stringify(r)));
    if (f.rows && f.rows.length > 6) console.log('         … and ' + (f.rows.length - 6) + ' more');
    console.log();
  }

  if (risks.length) {
    console.log('RULE QUOTES AT RISK (' + risks.length + ')');
    console.log('These rules quote text that this refresh would change. Applying the change');
    console.log('without updating the rule would make check-quotes.js fail:\n');
    risks.forEach(r => {
      console.log('  ' + r.ruleId + '  (dataset: ' + r.datasetId + ')');
      console.log('    quote  : ' + r.quote);
      console.log('    changed: ' + r.matchedChange + '\n');
    });
  }

  console.log('--- summary ---');
  console.log('auto-applicable (additions) : ' + autoCount);
  console.log('needs review                : ' + reviewCount);
  console.log('rule quotes at risk         : ' + risks.length);
  if (APPLY_ADDITIONS) console.log('rows applied                : ' + applied);
  else if (autoCount) console.log('\nTo apply additions only: node diff-refresh.js --apply-additions');
  if (reviewCount) console.log('\nReview items were NOT applied. Edit data/*.json by hand, then: npm run check');
}

// Exit non-zero when a human must look. CI uses this.
if (reviewCount || risks.length) process.exitCode = 1;
