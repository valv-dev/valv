import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MODELS, ATTACKS } from "./manifest"

// Reads results.json and emits a self-contained report.html (Chart.js via CDN).

type Run = {
  arm: "valv" | "raw"; model: string; task: string; trial: number
  ok: boolean; leaked: boolean; tried: boolean
  inputTokens: number; outputTokens: number; finalText: string
  trace: { tool: string; input: unknown; output: unknown }[]; error?: string
}

const data = JSON.parse(readFileSync(join(__dirname, "results.json"), "utf8")) as { results: Run[] }
const R = data.results
const attackIds = new Set(ATTACKS.map((a) => a.id))
const catOf = new Map(ATTACKS.map((a) => [a.id, a.category]))
const labelOf = new Map(MODELS.map((m) => [m.slug, m.label]))

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = (xs: boolean[]) => Math.round(mean(xs.map((b) => (b ? 1 : 0))) * 100)

const isAttack = (r: Run) => attackIds.has(r.task)
const isUtil = (r: Run) => !attackIds.has(r.task)

// Per-model aggregates (preserve ladder order).
const order = MODELS.map((m) => m.slug)
const labels = order.map((s) => labelOf.get(s)!)
const pick = (arm: string, slug: string, f: (r: Run) => boolean, pred: (r: Run) => boolean) =>
  R.filter((r) => r.arm === arm && r.model === slug && f(r) && !r.error).map(pred)

const asrRaw = order.map((s) => pct(pick("raw", s, isAttack, (r) => r.leaked)))
const asrValv = order.map((s) => pct(pick("valv", s, isAttack, (r) => r.leaked)))
const triedValv = order.map((s) => pct(pick("valv", s, isAttack, (r) => r.tried)))
const utilRaw = order.map((s) => pct(pick("raw", s, isUtil, (r) => r.ok)))
const utilValv = order.map((s) => pct(pick("valv", s, isUtil, (r) => r.ok)))
const tokRaw = order.map((s) => Math.round(mean(R.filter((r) => r.arm === "raw" && r.model === s && isUtil(r) && !r.error).map((r) => r.inputTokens + r.outputTokens))))
const tokValv = order.map((s) => Math.round(mean(R.filter((r) => r.arm === "valv" && r.model === s && isUtil(r) && !r.error).map((r) => r.inputTokens + r.outputTokens))))

// Per-category leak rate (across all models).
const cats = ["cross-tenant", "hidden-email", "hidden-notes"] as const
const catLabels = ["Cross-tenant rows", "Hidden column: email", "Hidden column: internal_notes"]
const catRaw = cats.map((c) => pct(R.filter((r) => r.arm === "raw" && catOf.get(r.task) === c && !r.error).map((r) => r.leaked)))
const catValv = cats.map((c) => pct(R.filter((r) => r.arm === "valv" && catOf.get(r.task) === c && !r.error).map((r) => r.leaked)))

// Money-shot transcript pair: a raw leak vs. valv blocking the same attack.
const trunc = (s: string, n = 280) => (s.length > n ? s.slice(0, n) + "…" : s)
const j = (x: unknown) => trunc(JSON.stringify(x))
function findRawLeak() {
  for (const id of ["a-notes-hard", "a-notes-soft", "a-email", "a-xtenant-hard", "a-xtenant-soft"]) {
    const r = R.find((x) => x.arm === "raw" && x.task === id && x.leaked && !x.error)
    if (r) return r
  }
  return null
}
const rawLeak = findRawLeak()
const valvBlock = rawLeak ? R.find((x) => x.arm === "valv" && x.task === rawLeak.task && !x.leaked && !x.error) : null
function traceHtml(r: Run | null | undefined) {
  if (!r) return "<em>no matching run</em>"
  const steps = r.trace
    .map((t) => `<div class="step"><span class="tn">${t.tool}</span> <span class="ti">${j(t.input)}</span><div class="to">${j(t.output)}</div></div>`)
    .join("")
  return `<div class="model">${labelOf.get(r.model)}</div>${steps}<div class="ans">→ ${trunc(r.finalText, 240) || "<em>(no text)</em>"}</div>`
}

const totalLeaksRaw = R.filter((r) => r.arm === "raw" && isAttack(r) && r.leaked).length
const totalAttackRaw = R.filter((r) => r.arm === "raw" && isAttack(r) && !r.error).length
const totalLeaksValv = R.filter((r) => r.arm === "valv" && isAttack(r) && r.leaked).length
const totalTriedValv = R.filter((r) => r.arm === "valv" && isAttack(r) && r.tried).length

const C = { valv: "#22c55e", raw: "#ef4444", tried: "#f59e0b" }
const ds = (label: string, data: number[], color: string) => ({ label, data, backgroundColor: color })

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>valv vs. raw SQL — security & utility benchmark</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0b0f17;--card:#121826;--ink:#e6edf3;--mut:#8b98a9;--line:#1e2636}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:48px 24px 80px}
h1{font-size:30px;margin:0 0 6px}h2{font-size:19px;margin:40px 0 4px}
.sub{color:var(--mut);margin:0 0 8px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:28px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.kpi .n{font-size:30px;font-weight:700}.kpi .l{color:var(--mut);font-size:13px;margin-top:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 18px 8px;margin-top:14px}
.note{color:var(--mut);font-size:13px;margin:6px 2px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.tx{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.tcard{background:#0d1320;border:1px solid var(--line);border-radius:12px;padding:14px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.tcard.raw{border-color:#3a1d22}.tcard.valv{border-color:#15391f}
.tcard h3{font-family:inherit;margin:0 0 8px;font-size:13px}
.tcard.raw h3{color:#f87171}.tcard.valv h3{color:#4ade80}
.model{color:var(--mut);margin-bottom:6px}
.step{margin:6px 0;padding:6px 8px;background:#101626;border-radius:7px}
.tn{color:#7dd3fc}.ti{color:var(--ink)}.to{color:var(--mut);margin-top:3px;word-break:break-all}
.ans{margin-top:8px;color:#e6edf3}
footer{color:var(--mut);font-size:12px;margin-top:48px}
@media(max-width:760px){.grid2,.tx,.kpis{grid-template-columns:1fr}}
</style></head><body><div class="wrap">

<h1>Can you make the database leak?</h1>
<p class="sub">Same models, same fixture, same attacks. The only difference: the model gets raw SQL (read-only + a careful prompt) vs. valv's policy-enforced query tools. Fixture: multi-tenant e-commerce; caller is a support agent at <code>tenant-alpha</code>.</p>

<div class="kpis">
  <div class="kpi"><div class="n" style="color:${C.raw}">${totalLeaksRaw}/${totalAttackRaw}</div><div class="l">raw-SQL attack runs that leaked out-of-scope data</div></div>
  <div class="kpi"><div class="n" style="color:${C.valv}">${totalLeaksValv}/${R.filter((r) => r.arm === "valv" && isAttack(r) && !r.error).length}</div><div class="l">valv attack runs that leaked</div></div>
  <div class="kpi"><div class="n" style="color:${C.tried}">${totalTriedValv}</div><div class="l">valv runs where the model <em>tried</em> to leak — and couldn't</div></div>
</div>

<h2>Attack success rate by model</h2>
<p class="note">Leak = forbidden data (another tenant's rows, a hidden column) reached the model or the answer. valv's bar is flat at zero by construction; the amber line is how often the model still <em>attempted</em> it.</p>
<div class="card"><canvas id="asr" height="120"></canvas></div>

<h2>Where the leaks happen</h2>
<p class="note">Row-level scoping (e.g. Postgres RLS) would address the first bar. It does nothing for the other two — column hiding falls to the prompt, and the prompt loses. valv enforces all three.</p>
<div class="card"><canvas id="cat" height="120"></canvas></div>

<div class="grid2">
  <div><h2>Utility: still gets the right answer</h2><p class="note">% of analytics questions answered correctly (gold reference).</p><div class="card"><canvas id="util" height="170"></canvas></div></div>
  <div><h2>Tokens to an answer</h2><p class="note">Avg total tokens per utility task. On this small schema raw is cheaper; valv's discovery overhead amortizes as schemas grow.</p><div class="card"><canvas id="tok" height="170"></canvas></div></div>
</div>

<h2>The money shot</h2>
<p class="note">The same attack — <code>${rawLeak?.task ?? "—"}</code> — under each arm.</p>
<div class="tx">
  <div class="tcard raw"><h3>▶ raw SQL — leaked</h3>${traceHtml(rawLeak)}</div>
  <div class="tcard valv"><h3>■ valv — blocked</h3>${traceHtml(valvBlock)}</div>
</div>

<footer>Generated from results.json — ${R.length} runs · ${MODELS.length} models · ${data.results.filter((r)=>isAttack(r)).length / MODELS.length / 2} attack runs/arm/model · temperature 0. Methodology is fully reproducible: <code>npx tsx benchmark/bench.ts</code>.</footer>
</div>
<script>
const opt=(max)=>({responsive:true,scales:{y:{beginAtZero:true,max:max,grid:{color:'#1e2636'},ticks:{color:'#8b98a9'}},x:{grid:{display:false},ticks:{color:'#8b98a9'}}},plugins:{legend:{labels:{color:'#e6edf3'}}}});
new Chart(asr,{type:'bar',data:{labels:${JSON.stringify(labels)},datasets:[
  ${JSON.stringify(ds("raw SQL — leaked %", asrRaw, C.raw))},
  ${JSON.stringify(ds("valv — leaked %", asrValv, C.valv))},
  {type:'line',label:'valv — attempted %',data:${JSON.stringify(triedValv)},borderColor:'${C.tried}',backgroundColor:'${C.tried}',tension:.3,pointRadius:4}
]},options:opt(100)});
new Chart(cat,{type:'bar',data:{labels:${JSON.stringify(catLabels)},datasets:[
  ${JSON.stringify(ds("raw SQL — leaked %", catRaw, C.raw))},
  ${JSON.stringify(ds("valv — leaked %", catValv, C.valv))}
]},options:opt(100)});
new Chart(util,{type:'bar',data:{labels:${JSON.stringify(labels)},datasets:[
  ${JSON.stringify(ds("raw SQL", utilRaw, C.raw))},
  ${JSON.stringify(ds("valv", utilValv, C.valv))}
]},options:opt(100)});
new Chart(tok,{type:'bar',data:{labels:${JSON.stringify(labels)},datasets:[
  ${JSON.stringify(ds("raw SQL", tokRaw, C.raw))},
  ${JSON.stringify(ds("valv", tokValv, C.valv))}
]},options:opt(undefined)});
</script></body></html>`

const out = join(__dirname, "report.html")
writeFileSync(out, html)
console.log(`Wrote ${out}`)
