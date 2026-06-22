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
    body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 900px; color: #1a1a1a; }
    h1 { font-size: 1.25rem; margin: 0 0 1.5rem; }
    .chart-wrap { position: relative; height: 60vh; }
  </style>
</head>
<body>
  <h1>{{TITLE}}</h1>
  <div class="chart-wrap"><canvas id="chart"></canvas></div>
  <script>
    // Rows returned by the valv `query` tool, inlined verbatim.
    const rows = {{ROWS_JSON}};

    new Chart(document.getElementById("chart"), {
      type: "{{CHART_TYPE}}",
      data: {
        labels: rows.map(r => r["{{X_KEY}}"]),
        datasets: [{
          label: "{{SERIES_LABEL}}",
          data: rows.map(r => r["{{Y_KEY}}"]),
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        scales: { y: { beginAtZero: true } },
      },
    });
  </script>
</body>
</html>
```

**Use the `chart.umd.min.js` build, not `chart.min.js`** — the latter is an ES module
and throws "Cannot use import statement" / "Chart is not defined" when loaded as a plain
`<script>`. Replace every `{{…}}`: `TITLE` (the question in plain words), `CHART_TYPE`, `ROWS_JSON`
(the actual rows from `query`), `X_KEY` / `Y_KEY` / `SERIES_LABEL` (real column
names/aliases from the query). For multiple series, add more `datasets`. Keep colors to
Chart.js defaults unless the user asks for styling.

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
