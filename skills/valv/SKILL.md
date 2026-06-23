---
name: valv
description: >-
  Query a database through the valv MCP and turn the results into charts in a
  single self-contained HTML file (Chart.js). Use whenever the user asks to
  chart, graph, plot, visualize, or "show me" data from their database — e.g.
  "visualize revenue by month", "chart signups per week", "graph orders by
  status". Requires the valv MCP server to be configured.
---

# valv — visualize your database with charts

Answer a data question by **querying the user's database with valv and rendering the
result as a chart in a standalone HTML file**. valv gives you read access through a
structured query (never SQL) that is validated and policy-scoped on the server; your
job is to find the right data, fetch it, and visualize it.

## When to use this

The user asks to *see* data, not just read it: "visualize…", "chart…", "graph…",
"plot…", "show me … over time / by category / as a breakdown". If they only want a
number or a table, just `query` and answer — don't build a chart unless asked.

## The valv tools

The valv MCP exposes exactly four tools. Discovery is policy-filtered, so it only ever
shows what the caller is allowed to read.

- `list_resources` — the tables/resources you can query.
- `search_resources` — find a resource by name/keyword.
- `describe_resource` — columns and types for one resource. **Always describe before
  querying** so you use real column names and don't guess.
- `query` — run one structured query. The model emits JSON (columns, filters,
  aggregates, grouping, ordering, limit) — **never raw SQL**. valv validates it,
  injects the policy's row filter, compiles it, and returns rows.

A query is plain JSON, e.g. revenue per status:

```jsonc
{
  "from": "orders",
  "select": [
    { "col": "status" },
    { "fn": "sum", "args": [{ "kind": "col", "name": "total" }], "as": "revenue" }
  ],
  "groupBy": ["status"],
  "orderBy": [{ "col": "revenue", "dir": "desc" }],
  "limit": 20
}
```

For time series, bucket with a function and group by the alias (e.g.
`toStartOfInterval` / `date_trunc`, depending on the dialect surfaced by
`describe_resource`).

## Workflow

1. **Understand the ask.** What's the measure (y), the dimension (x / series), and any
   filter or time range? Pick the chart type up front (see below).
2. **Discover.** `list_resources` (or `search_resources`) to find the table, then
   `describe_resource` to get exact column names and types. Don't skip this.
3. **Query.** Emit one `query` that returns exactly the rows the chart needs — already
   aggregated and grouped server-side, not raw rows you reshape client-side. Add a
   sane `limit`. If valv rejects the query (unknown column, denied field, bad
   function), read the error and fix the query — don't work around it.
4. **Render.** Write one self-contained HTML file (template below) with the rows inlined
   as JSON and a Chart.js config. One question → one file.
5. **Open it** for the user (`open <file>.html` on macOS) and tell them the path and what
   the chart shows. Mention the query you ran in one line.

## Picking a chart type

- **Time series / trend** → `line`.
- **Category comparison** (counts/sums by group) → `bar` (horizontal if many/long labels).
- **Part-of-whole** (≤ ~6 slices) → `doughnut`. More than that → bar.
- **Two measures correlated** → `scatter`.
- Multiple series → one dataset per series on a shared x-axis.

Don't invent data, smooth, or extrapolate. Chart exactly what the query returned. If a
result is empty, say so — don't render an empty chart.

## HTML template

One file, no build step, no local assets. Chart.js loads from the pinned CDN. Inline the
query result as a JSON literal so the file is portable and works offline-after-load.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{TITLE}}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0f1016;           /* deep charcoal, never pure black */
      --surface: #161822;      /* the chart card, one step lighter */
      --fg: #e8eaf0;           /* headings */
      --muted: #8b909c;        /* subtitle, axis labels */
      --faint: #5b606b;        /* footnote */
      --line: rgba(255, 255, 255, 0.05);  /* hairline borders + gridlines */
      --accent: #6d6af5;       /* single accent (indigo-violet) — swap the hue to retheme */
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; justify-content: center;
      background:
        radial-gradient(900px 420px at 18% -8%, rgba(109, 106, 245, 0.10), transparent 60%),
        var(--bg);
      color: var(--fg);
      font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    main { width: 100%; max-width: 940px; padding: clamp(2rem, 6vw, 5rem) clamp(1.25rem, 4vw, 2.5rem); }
    .eyebrow {
      display: inline-flex; align-items: center; gap: .5rem; margin-bottom: 1rem;
      font-size: .72rem; letter-spacing: .14em; text-transform: uppercase; color: var(--muted);
    }
    h1 { margin: 0 0 .5rem; max-width: 30ch; font-size: clamp(1.3rem, 3vw, 1.7rem);
         font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; }
    p.sub { margin: 0 0 2.5rem; color: var(--muted); font-size: .9rem; }
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
            padding: 1.5rem 1.5rem .75rem; }
    .chart-wrap { position: relative; height: 52vh; min-height: 320px; }
    footer { margin-top: 1.5rem; color: var(--faint); font-size: .78rem; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">{{EYEBROW}}</div>
    <h1>{{TITLE}}</h1>
    <p class="sub">{{SUBTITLE}}</p>
    <div class="card"><div class="chart-wrap"><canvas id="chart"></canvas></div></div>
    <footer>{{FOOTER}}</footer>
  </main>
  <script>
    // Rows returned by the valv `query` tool, inlined verbatim.
    const rows = {{ROWS_JSON}};

    // Minimal dark theme — set once, applies to every chart type.
    const ACCENT = "#6d6af5";
    Chart.defaults.color = "#8b909c";
    Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
    Chart.defaults.font.size = 12;

    // Lazy accent gradient (needs the chart area to exist). For vertical bars/lines
    // make it vertical: createLinearGradient(0, chartArea.top, 0, chartArea.bottom).
    const accentFill = ctx => {
      const { ctx: c, chartArea } = ctx.chart;
      if (!chartArea) return "rgba(109, 106, 245, 0.6)";
      const g = c.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
      g.addColorStop(0, "rgba(109, 106, 245, 0.9)");
      g.addColorStop(1, "rgba(109, 106, 245, 0.35)");
      return g;
    };

    new Chart(document.getElementById("chart"), {
      type: "{{CHART_TYPE}}",
      data: {
        labels: rows.map(r => r["{{X_KEY}}"]),
        datasets: [{
          label: "{{SERIES_LABEL}}",
          data: rows.map(r => r["{{Y_KEY}}"]),
          backgroundColor: accentFill,
          borderColor: ACCENT,
          borderWidth: 0,
          borderRadius: 2,
          borderSkipped: false,
          tension: 0.3,            // smooths line charts; harmless elsewhere
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },   // turn on only for multi-series
          tooltip: {
            backgroundColor: "#1d2027", borderColor: "rgba(255,255,255,0.08)", borderWidth: 1,
            titleColor: "#e8eaf0", bodyColor: "#b6bcc6", padding: 12, cornerRadius: 5,
            displayColors: false,
          },
        },
        scales: {
          x: { grid: { color: "rgba(255,255,255,0.055)" }, border: { display: false },
               ticks: { color: "#7b818c", maxRotation: 0 } },
          y: { beginAtZero: true, grid: { color: "rgba(255,255,255,0.055)" },
               border: { display: false }, ticks: { color: "#9aa0ab" } },
        },
      },
    });
  </script>
</body>
</html>
```

**Use the `chart.umd.min.js` build, not `chart.min.js`** — the latter is an ES module
and throws "Cannot use import statement" / "Chart is not defined" when loaded as a plain
`<script>`. Fill every `{{…}}`: `EYEBROW` (a 1–3 word kicker, e.g. "Revenue"), `TITLE`
(the question in plain words), `SUBTITLE` (the scope — rows, range, filters), `FOOTER`
(source: which resource via valv), `CHART_TYPE`, `ROWS_JSON` (the actual rows from
`query`), `X_KEY` / `Y_KEY` / `SERIES_LABEL` (real column names/aliases). For multiple
series, add more `datasets` and turn the legend on. Keep the **dark, minimal, single-accent**
look — retheme by changing one hue (`--accent` + the `accentFill` rgba + glow), don't add a
second bright color unless a series genuinely needs distinguishing.

## Conventions

- **Server-side aggregation.** Group, sum, count, and bucket in the `query`, not in JS.
  The chart consumes ready-to-plot rows.
- **One file per question**, named for the question (e.g. `revenue-by-month.html`). Write
  it in the working directory unless the user says otherwise.
- **Never fabricate.** Every point on the chart traces to a returned row. No mock data,
  no filler.
- **Surface failures.** If valv denies a column or the query errors, report it plainly
  and adjust — don't silently swap in something else or render a partial result as if
  complete.
- **Stay read-only.** Visualization only ever reads. Don't use valv's write tools here.
