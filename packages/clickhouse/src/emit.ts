import type { Dialect } from "@valv/core"

const INTERVAL_UNITS = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"] as const

// ClickHouse uses backtick identifiers (escaping `\` then `` ` ``) and typed
// named placeholders `{pN:Type}`. The type is the one schema-derived string that
// reaches SQL, so its characters are allowlisted — a malformed hand-defined type
// can't break out of the placeholder.
const SAFE_TYPE = /^[A-Za-z0-9_(), '=]+$/

export const clickhouseDialect: Dialect = {
  quoteId(id) {
    return "`" + id.replace(/\\/g, "\\\\").replace(/`/g, "``") + "`"
  },
  placeholder(index, type) {
    if (!SAFE_TYPE.test(type)) {
      throw new Error(`[valv/clickhouse] unsafe column type "${type}"`)
    }
    return `{p${index}:${type}}`
  },
  functions: {
    // Parametric aggregate: quantileTiming(level)(column). `level` is a finite
    // number in [0, 1], so inlining it can't carry SQL.
    quantileTiming: {
      args: [{ kind: "number", range: [0, 1] }, { kind: "column" }],
      render: ([level, c]) => `quantileTiming(${level})(${c})`,
    },
    // Time bucketing for series — fixed grains.
    toDate: { args: [{ kind: "column" }], render: ([c]) => `toDate(${c})` },
    toStartOfHour: { args: [{ kind: "column" }], render: ([c]) => `toStartOfHour(${c})` },
    toStartOfDay: { args: [{ kind: "column" }], render: ([c]) => `toStartOfDay(${c})` },
    // Arbitrary-grain bucketing: toStartOfInterval(ts, INTERVAL n unit). The unit
    // is membership-checked, the magnitude is a finite number — both safe inlined.
    toStartOfInterval: {
      args: [{ kind: "column" }, { kind: "number" }, { kind: "enum", values: INTERVAL_UNITS }],
      render: ([c, n, unit]) => `toStartOfInterval(${c}, INTERVAL ${n} ${unit!.toUpperCase()})`,
    },
    // Distinct counts.
    uniqExact: { args: [{ kind: "column" }], render: ([c]) => `uniqExact(${c})` },
    uniq: { args: [{ kind: "column" }], render: ([c]) => `uniq(${c})` },
    // Conditional aggregation — the predicate's literals become bound params.
    countIf: { args: [{ kind: "predicate" }], render: ([p]) => `countIf(${p})` },
    sumIf: {
      args: [{ kind: "column" }, { kind: "predicate" }],
      render: ([c, p]) => `sumIf(${c}, ${p})`,
    },
  },
}
