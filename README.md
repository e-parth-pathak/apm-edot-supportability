# Elastic APM · EDOT · Synthetics — Compatibility & Support Matrix

> Repo: [`e-parth-pathak/apm-edot-supportability`](https://github.com/e-parth-pathak/apm-edot-supportability)

An interactive Node.js app that consolidates Elastic's compatibility and support
matrices into one searchable, filterable UI with light/dark mode — plus three checkers
that take your setup and tell you where the holes are, with a doc citation for every
verdict.

**Every value in the UI is a verbatim transcription of an Elastic documentation page,
and every table row links back to the exact page and anchor it came from.** Nothing is
inferred, computed, or paraphrased into a compatibility claim. Where the docs state
something in prose rather than a table, the prose is reproduced as-is.

## Requirements

Node ≥ 18. **No dependencies** — `npm install` isn't needed and does nothing. Everything
uses Node built-ins (`http`, `fs`, `path`, `child_process`).

## Quick start

```bash
git clone https://github.com/e-parth-pathak/apm-edot-supportability.git
cd apm-edot-supportability
npm run dev          # → http://localhost:3000
```

The build outputs (`public/data.json`, `public/standalone.html`, `public/artifact.html`)
are gitignored and regenerated on first run, so a fresh clone has no stale data.

## Dev

```bash
npm run dev          # or: node dev.js
```

Then open <http://localhost:3000>. `dev.js` verifies, builds, starts the server, and
watches for changes:

- edit any `data/*.json` → re-verifies and rebuilds, then reload the browser
- edit any hand-edited file in `public/` → **just reload**; `index.html` loads them
  directly, so a rebuild is only needed to refresh `standalone.html` / `artifact.html`
- if any gate fails, the build is skipped and the last good bundle keeps serving — fix
  it and save again

It does not watch the generated files (`data.json`, `standalone.html`, `artifact.html`);
that would loop. Set `PORT` to change the port: `PORT=8080 npm run dev`.

## Production / one-off

```bash
npm start            # node build.js && node server.js
```

Individually:

| Command | Does |
| --- | --- |
| `npm run verify` | Citation + integrity checks, rule-quote grounding, and the CSS cascade guard. |
| `npm run build` | `data/*.json` → `public/data.json`, `public/standalone.html`, `public/artifact.html` |
| `npm run test` | build + engine tests + UI tests |
| `npm run check` | Everything: verify + grounding + CSS guard + build + both test suites. **Use this in CI.** |
| `npm run serve` | Serves `public/` on `:3000` without rebuilding |
| `npm run dev` | verify + grounding + CSS guard + build + serve + watch |

`npm run check` is the full gate. `build.js` also runs its own integrity pass and exits
non-zero if any section or rule lost its citation, so `npm run build` alone is a usable
minimum.

### Build outputs

| File | Use |
| --- | --- |
| `public/data.json` | Fetched by `index.html` at runtime; also served at `/api/data` |
| `public/standalone.html` | Single self-contained file (data + CSS + JS inlined). Open via `file://` or drop on any static host. First load follows `prefers-color-scheme`. |
| `public/artifact.html` | Same, but defaults to light on first load for embedding in a light-mode host UI. Toggle still works. |

## Two modes

**Browse matrices** — the searchable reference view over all 47 matrices.

**Check my setup** — three interactive checkers that take your details and find the holes:

1. **My stack** — Stack version, Elastic Agent version, ingestion path, EDOT SDKs, classic
   APM agents, OS/platform, `service.name`, plus flags for cumulative histograms, exemplars
   and managed Kubernetes. Returns a verdict per component.
2. **Migration gaps** — tick the capabilities you use on classic APM today; get back what
   has no EDOT equivalent, what needs rework, and what migrates cleanly.
3. **Feature by language** — pick required features; get the EDOT SDKs that have them all,
   at which version, and why the others don't qualify.

Inputs persist in `localStorage` only. Nothing is sent anywhere — the whole engine runs
client-side off the bundled data.

## Verify the citations

```bash
npm run check      # verify + grounding + CSS guard + build + engine tests + UI tests
```

Five independent gates, each of which fails the build:

| Gate | Asserts |
| --- | --- |
| `node verify.js` | Every rendered section has a `sourceUrl`; row/column counts match; all URLs well-formed and on an allow-listed host; no non-`http(s)` inline links. |
| `node check-quotes.js` | **Every rule's `quote` appears verbatim in the scraped dataset it names.** A rule cannot cite text that isn't in the docs we actually read. |
| `node check-css.js` | Every element toggled via the `hidden` attribute is actually un-paintable — i.e. no author `display` rule can override it. See below. |
| `node test-engine.js` | 94 assertions: version banding, per-checker verdicts against known doc facts, and the invariant that *every* finding carries a `sourceUrl` and evidence. |
| `node test-ui.js` | 53 assertions driving the real page in jsdom: both modes, all three forms, and that every finding rendered to a user has a doc link. |

Current results:

```
verify        files 18 | sections 148 | with sourceUrl 148 (100%) | rows 281 | errors 0
check-quotes  rules 40 | quotes checked 48 | undocumented cases 7 | errors 0
check-css     toggled elements checked 5 | errors 0
test-engine   94 passed, 0 failed
test-ui       53 passed, 0 failed
```

### Why there's a separate CSS gate

The browse view is `<div class="layout" hidden>`. The UA stylesheet has
`[hidden] { display: none }`, but `.layout { display: grid }` is an *author* rule, so it
wins — setting `.hidden = true` in JS left all 18 support-matrix cards rendered above the
checker form. Real bug, shipped briefly.

A DOM test cannot catch it. jsdom's `getComputedStyle` returns `"none"` for `[hidden]`
regardless of competing author rules, so the page tests reported everything as correct
while a browser showed the matrices. Verified directly:

```js
new JSDOM('<div class="layout" hidden></div><style>.layout{display:grid}</style>')
// getComputedStyle(...).display === "none"   // wrong — a browser says "grid"
```

So `check-css.js` reads the stylesheet as text: it finds every element `app.js` toggles via
`.hidden`, looks up the classes on that element in `index.html`, and fails if any class
declares a `display` that isn't neutralised by a global
`[hidden] { display: none !important }`. Removing the fix makes it fail by name
(`#browse-view (.layout) sets display and would beat [hidden]`).

`test-ui.js` now asserts only that the hidden *attribute* lands on the right containers,
with a comment pointing here — the paint question is deliberately out of its scope.

`test-ui.js` needs jsdom, which is deliberately **not** a saved dependency — the app itself
has none. Install it only when you want to run UI tests: `npm i --no-save jsdom`. Without
it the test skips cleanly rather than failing.

## How the checkers avoid guessing

The engine holds no compatibility knowledge. Everything lives in `data/rules.json`, where
each rule carries the doc sentence that justifies it:

```json
{
  "id": "path-apm-server-otel",
  "kind": "ingestion-path",
  "verdict": "not-supported",
  "headline": "EDOT SDKs sending directly to APM Server's OTel intake is not supported",
  "quote": "Telemetry might ingest but mapping, enrichment, and troubleshooting are not guaranteed.",
  "sourceUrl": "https://www.elastic.co/.../compatibility/sdks#support-matrix-for-edot-sdk-ingestion",
  "datasetId": "edot-sdks-compat",
  "remedy": "…", "remedyQuote": "…", "remedySourceUrl": "…"
}
```

`rules.json` also has an `undocumented` block — combinations the engine **refuses** to
judge, each with the reason and a doc link. These surface in the UI as *Not documented*
rather than a verdict. There are 7:

| Case | Why no verdict |
| --- | --- |
| EDOT Browser vs Agent version | Browser is absent from the "applies to all EDOT SDKs" list on the SDKs page |
| Android version support | The Android supported-technologies page returned an empty body; no version table exists |
| EDOT Java version tables | Java delegates to upstream OTel Java Instrumentation; version ranges live in that repo |
| Elastic Agent 8.x vs Stack | Only Agent 9.x has a published compatibility table |
| Classic agent vs Stack version | Classic agents are versioned against the *APM integration*, not the Stack |
| Histogram temporality on APM Server intake | Documented for Managed OTLP and the Collector ES exporter only |
| Synthetics vs EDOT | The Synthetics matrix makes no statement about EDOT or OTLP |

That last one is worth knowing about: a ticked input that matches no documented rule is
reported as *Not documented* rather than silently dropped, because silence reads as
"you're fine" — which is exactly the wrong message for an undocumented combination.

## UI

| Feature | Notes |
| --- | --- |
| Light / dark mode | Toggle in the header. Persists in `localStorage`; first visit follows `prefers-color-scheme`. |
| Global filter | Searches every table cell, column header, list item, section note and prose block. Press `/` to focus, `Esc` to blur. |
| Status filter | Supported / GA · Tech preview · Not supported · Incompatible / Not available. Applies to the matrix tables. |
| Per-row citation | Every table row ends in a `docs ↗` link to the exact source anchor. |
| Section citation | Every section header has a **Source doc** pill. |
| Legend | The EDOT SDK feature matrix renders Elastic's own ✅ / 𝐓 / ➖ / ❌ legend, with a link to it. |
| Footer | Lists all 26 source pages plus the scrape timestamp. |

## Sources scraped (26 pages)

**Classic APM**
- [APM agent compatibility](https://www.elastic.co/docs/solutions/observability/apm/apm-agent-compatibility)

**EDOT / OpenTelemetry compatibility** (the landing page and all 7 sub-pages)
- [Compatibility and support (index)](https://www.elastic.co/docs/reference/opentelemetry/compatibility/index.html)
- [Features](https://www.elastic.co/docs/reference/opentelemetry/compatibility/features)
- [Collectors](https://www.elastic.co/docs/reference/opentelemetry/compatibility/collectors)
- [SDKs](https://www.elastic.co/docs/reference/opentelemetry/compatibility/sdks)
- [Elastic OpenTelemetry compared to upstream](https://www.elastic.co/docs/reference/opentelemetry/compatibility/edot-vs-upstream)
- [Limitations](https://www.elastic.co/docs/reference/opentelemetry/compatibility/limitations)
- [Nomenclature](https://www.elastic.co/docs/reference/opentelemetry/compatibility/nomenclature)
- [Data streams comparison](https://www.elastic.co/docs/reference/opentelemetry/compatibility/data-streams)

**EDOT SDKs** (overview plus each language page and its supported-technologies page)
- [EDOT SDKs overview](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks)
- [.NET](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/dotnet) · [supported technologies](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/dotnet/supported-technologies)
- [Java](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/java) · [supported technologies](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/java/supported-technologies)
- [Node.js](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node) · [supported technologies](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/supported-technologies)
- [PHP](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/php) · [supported technologies](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/php/supported-technologies)
- [Python](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/python) · [supported technologies](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/python/supported-technologies)
- [Android](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/android) · [automatic instrumentation](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/android/automatic-instrumentation)
- [iOS](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/ios) · [automatic instrumentation](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/ios/automatic-instrumentation)
- [Browser](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/browser) · [supported technologies](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/browser/supported-technologies)

**Synthetics**
- [Synthetics support matrix](https://www.elastic.co/docs/solutions/observability/synthetics/support-matrix)

## Things worth knowing about the data

These are stated plainly in the UI too, but they're the places where "there is no table"
is the honest answer:

1. **`.../edot-sdks/android/supported-technologies` returned an empty body.** The Android
   instrumentation data therefore comes from
   [`.../android/automatic-instrumentation`](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/android/automatic-instrumentation).
   Neither Android page publishes a version/API-level compatibility table, so none is shown.
   This is recorded in `data/sdk-android.json` as `scrapeNote` and rendered in the UI.
2. **EDOT Java publishes no version tables of its own.** Its supported-technologies page
   delegates to upstream OpenTelemetry Java Instrumentation ("supports JVM (OpenJDK, OpenJ9)
   versions 8+", "all the application servers documented by the OpenTelemetry Java agent").
   The prose is reproduced verbatim with links out, rather than inventing a table.
3. **Combined views are labelled.** The "All APM agents" and "Synthetics components" tables
   are stitched together from the per-agent / per-component sections of a single source page,
   purely for at-a-glance reading. Each says so in its notes, and the original per-section
   tables are rendered below it unmodified.
4. **Footnote markers are preserved as superscripts** (`Compatible⁴`, `Host view¹`,
   `✅ 1.0+¹`) with the footnote text in the section notes, matching the source pages.
5. **Status colouring is presentational only.** It is keyed off the exact status words
   Elastic uses (`Supported`, `Not supported`, `Compatible`, `Incompatible`, `Yes`, `No`,
   ✅ / 𝐓 / ➖ / ❌). No cell's meaning is changed, and the raw text is always shown.

## Layout

```
apm-edot-compatibility-matrix/
├── package.json
├── dev.js                 verify + grounding + CSS guard + build + serve + watch
├── build.js               data/*.json -> public/{data.json,standalone.html,artifact.html}
├── server.js              zero-dependency static server + /api/data
├── verify.js              citation & integrity checks on the datasets
├── check-quotes.js        grounds every rule quote against the scraped data
├── check-css.js           guards the hidden-attribute cascade (see above)
├── test-engine.js         94 unit tests for the evaluator
├── test-ui.js             53 tests driving the real page in jsdom
├── data/
│   ├── rules.json         the cited rules engine  (40 rules, 7 undocumented cases)
│   └── *.json             18 scraped datasets, one per doc page (or per language)
└── public/
    ├── index.html         hand-edited
    ├── styles.css         hand-edited — light/dark theme tokens
    ├── engine.js          hand-edited — pure evaluator, no DOM (also used by tests)
    ├── checkers.js        hand-edited — the three forms + finding cards
    ├── app.js             hand-edited — browse view, search, filters, theme, modes
    ├── data.json          GENERATED
    ├── standalone.html    GENERATED — single-file build
    └── artifact.html      GENERATED — single-file build, light-default
```

Sources are `data/*.json` and the five hand-edited files in `public/`. The three
`GENERATED` files are rewritten on every build — don't edit them.

`engine.js` is deliberately DOM-free and dual-exports (browser global + CommonJS), so
`test-engine.js` exercises byte-for-byte the same code the page runs.

### Adding a rule

1. Add it to `data/rules.json` with a `quote`, `sourceUrl` and `datasetId`.
2. The quote must appear **verbatim** in that dataset. If the sentence you want to cite
   isn't in `data/*.json` yet, transcribe it into the relevant dataset's `notes` first —
   don't reword the quote to fit.
3. `npm run check`. `check-quotes.js` will tell you if the quote isn't grounded.

Step 2 is the load-bearing one: it's what stops a rule from citing a sentence that sounds
right but isn't actually on the page. It already caught one during development.

### Refreshing the data

The doc pages change. To refresh, re-read the source pages and edit the matching
`data/*.json` file, keeping the schema:

```json
{
  "id": "…", "language": "…",
  "sources": [{ "title": "…", "url": "https://…" }],
  "sections": [
    { "heading": "…", "sourceUrl": "https://…#anchor", "type": "table",
      "columns": ["…"], "rows": [["…"]], "notes": ["…"] },
    { "heading": "…", "sourceUrl": "https://…#anchor", "type": "list",
      "items": ["…"], "notes": [] },
    { "heading": "…", "sourceUrl": "https://…#anchor", "type": "prose",
      "text": "…", "notes": [] }
  ]
}
```

Then `node verify.js && node build.js`. `sourceUrl` is mandatory on every section —
`verify.js` fails the build without it, which is what keeps the "no uncited data" rule
enforceable rather than aspirational.
