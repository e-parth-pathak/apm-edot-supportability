## Elastic APM · EDOT · Synthetics — Compatibility & Support Matrix

A zero-dependency Node.js app that consolidates Elastic's compatibility and support
matrices into one searchable UI, plus three checkers that take your setup and tell you
where the holes are — with a documentation citation behind every verdict.

**Every value is a verbatim transcription of an Elastic doc page.** Nothing is inferred,
computed, or paraphrased into a compatibility claim. Where the docs state something in
prose rather than a table, the prose is reproduced as-is.

### Download

`standalone.html` (attached) is the whole app in one file — data, CSS and JS inlined.
Open it with `file://`, no install required. For the full project including the refresh
tooling, clone the repo and run `npm run dev`.

---

## What's in it

### Browse — 47 matrices from 26 doc pages

| | |
|---|---|
| Datasets | 18 |
| Tables / rows | 47 / 281 |
| List items | 138 |
| Source doc pages | 26 |

Covers APM agent compatibility, the EDOT/OpenTelemetry compatibility landing page and all
7 sub-pages, the EDOT SDK overview plus each of the 8 per-language SDK pages, and the
Synthetics support matrix. Global search across every cell, column header, list item and
note; status filters; light/dark mode. **Every table row links back to the exact page and
anchor it came from.**

### Check my setup — three cited checkers

1. **Is my stack supported?** — Stack version, Elastic Agent version, ingestion path, EDOT
   SDKs, classic APM agents, OS/platform, `service.name`, plus flags for cumulative
   histograms, exemplars and managed Kubernetes. Returns a verdict per component.
2. **Classic APM → EDOT migration gaps** — tick what you use today; get back what has no
   EDOT equivalent, what needs rework, and what migrates cleanly.
3. **Which EDOT SDK has the features I need?** — pick required features; get the SDKs that
   cover them all, at which version, and why the others don't qualify.

Runs entirely client-side. Inputs persist in `localStorage` only; nothing is sent anywhere.

### How it avoids guessing

The engine holds no compatibility knowledge of its own. All 40 rules live in
`data/rules.json`, each carrying the doc sentence that justifies it. `check-quotes.js`
asserts every quote appears **verbatim** in the scraped dataset it names — a rule
cannot cite text that isn't in a page we actually read.

`rules.json` also declares **7 combinations the engine refuses to judge**, each with the
reason and a doc link. These surface as *Not documented* rather than a verdict:

| Case | Why no verdict |
|---|---|
| EDOT Browser vs Agent version | Absent from the "applies to all EDOT SDKs" list |
| Android version support | No version table exists on either Android page |
| EDOT Java version tables | Java delegates to upstream OTel Java Instrumentation |
| Elastic Agent 8.x vs Stack | Only Agent 9.x has a published compatibility table |
| Classic agent vs Stack version | Classic agents version against the *APM integration* |
| Histogram temporality on APM Server intake | Documented for Managed OTLP and the Collector ES exporter only |
| Synthetics vs EDOT | The Synthetics matrix makes no statement about EDOT or OTLP |

A ticked input that matches no documented rule is reported as *Not documented* rather than
silently dropped — silence reads as "you're fine", which is the wrong message for an
undocumented combination.

### Keeping it fresh

```bash
npm run refresh          # fetch + diff, writes nothing
npm run refresh:apply    # same, but auto-applies row additions only
npm run refresh:paths    # probe repo trees to fix a moved markdown path
npm run freshness        # how old is the committed data?
```

Markdown from `elastic/docs-content` and `elastic/opentelemetry` is the parse source; the
rendered page is cross-checked against it. Row **additions** are auto-applicable; changed
cells, removed rows, column drift, new tables and ambiguous rows **always require review**.
`diff-refresh.js` predicts which rule quotes a refresh would un-ground *before* anything
is written.

Staleness is visible in three places: a UI banner (amber past 45 days, red past 120), a
`check-freshness.js` build gate, and a weekly CI job that opens a `data-drift` issue.

### Seven CI gates

| Gate | Asserts |
|---|---|
| `verify.js` | Every rendered section has a `sourceUrl` (148/148) |
| `check-quotes.js` | Every rule quote appears verbatim in the scraped data |
| `check-css.js` | Hidden views can't be overridden by author `display` rules |
| `check-freshness.js` | Data age against the 45/120-day thresholds |
| `test-engine.js` | 94 assertions on the evaluator |
| `test-ui.js` | 53 assertions driving the real page in jsdom |
| `test-refresh.js` | 106 assertions on the refresh pipeline (offline fixtures) |

`npm run check` runs all of it. Zero runtime dependencies; `jsdom` is dev-only and unsaved.

---

## Known limitations

Read these before relying on the refresh tooling.

**1. 8 of 18 datasets cannot be refreshed from markdown.** The per-language EDOT SDK pages
are not in `elastic/opentelemetry` — that repo publishes exactly one EDOT SDK markdown file
(`docs/reference/edot-sdks/index.md`). Each SDK ships from its own repo and docs-builder
assembles the site. Those 16 pages carry `mdPath: null` with the evidence recorded under
`knownGaps` in `data/sources.json`.

Their committed data **is valid** — it was transcribed from the rendered pages — but drift
in them will not be detected until the SDK repos are wired up. `npm run refresh:paths`
probes the candidate `elastic-otel-*` repos and prints what each publishes.

**2. A full refresh cycle has never completed end to end with live data.** The first live
run (2026-09-21) found the defects listed below and wrote nothing. The guards did hold
under real conditions: the run was invoked with `--apply-additions` and `data/` came back
byte-identical. But no fetch → diff → apply cycle has yet produced a real change.

**3. Markdown path confidence varies.** Of 26 pages: 7 paths were read directly off an
"Edit this page" link, 3 are convention-based, 16 are the unresolved SDK pages above. The
`verified` field in `sources.json` records which is which.

**4. Freshness thresholds are a judgement call.** 45/120 days was chosen to catch Elastic's
roughly quarterly Stack minors. If the EDOT SDKs move faster in practice, tighten
`maxAgeDays` in `data/sources.json`.

---

## Fixed since the first live run

The refresh pipeline was written in an environment with no access to `elastic.co` or
`raw.githubusercontent.com`, so its network paths shipped unverified. The first real run
surfaced two defects and one wrong assumption:

- **The cross-check was wrong, not the docs.** It reported 55 of 65 cells "missing" on
  `features.md`. Elastic's source is docs-builder markdown, not plain markdown:
  `{{product.apm}}` substitutions and reference-style links `[Compatible]` both survived
  normalisation and could never match rendered text. Both are formatting, not drift. Added
  `--explain`, which classifies each miss and shows the rendered text beside the markdown —
  that diagnosed it in one run.
- **Lists and prose were invisible to refresh.** Synthetics reported `tables=0` despite
  fetching fine, because its matrix is bullets. List and prose extraction now runs per
  heading, flattening nested bullets to match the original transcription, and list items
  diff under the same additions-auto / changes-review policy.
- **A changed cell could go undetected.** Row identity keyed on the first column alone, but
  "Go agent" appears twice (`1.x` and `2.x`), as do Ruby and JavaScript RUM — the duplicates
  collapsed and a change on the shadowed row vanished. Rows are now keyed on all
  identifying columns, with a guard that escalates genuinely ambiguous tables to review.
- **The browse matrices rendered above the checker form.** `.layout { display: grid }` beats
  the UA stylesheet's `[hidden] { display: none }`, so toggling the attribute did nothing
  visually. jsdom can't detect this class of bug — it reports `display: none` regardless —
  so `check-css.js` now guards the cascade statically.

---

**Elastic's documentation is the authoritative source.** This tool is a convenience layer
over it. If a page has changed since the scrape date shown in the UI, the doc wins.
