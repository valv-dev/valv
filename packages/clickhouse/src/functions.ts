import type { FnDef } from "@valv/core"

const INTERVAL_UNITS = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"] as const

// ClickHouse-specific functions, merged over the standard aggregates in core's
// BASE_FUNCTIONS at emit time. This is the list that grows as analytics needs
// expand; the dialect's quoting/placeholder rules in dialect.ts stay put.
export const clickhouseFunctions: Record<string, FnDef> = {
  // Parametric aggregate quantileTiming(level)(column); level is a finite number
  // in [0, 1], safe to inline.
  quantileTiming: {
    args: [{ kind: "number", range: [0, 1] }, { kind: "column" }],
    render: ([level, c]) => `quantileTiming(${level})(${c})`,
  },

  // Fixed-grain time bucketing.
  toDate: { args: [{ kind: "column" }], render: ([c]) => `toDate(${c})` },
  toStartOfHour: { args: [{ kind: "column" }], render: ([c]) => `toStartOfHour(${c})` },
  toStartOfDay: { args: [{ kind: "column" }], render: ([c]) => `toStartOfDay(${c})` },

  // Arbitrary-grain bucketing toStartOfInterval(ts, INTERVAL n unit); unit is
  // membership-checked and n is finite, so both are safe inlined.
  toStartOfInterval: {
    args: [{ kind: "column" }, { kind: "number" }, { kind: "enum", values: INTERVAL_UNITS }],
    render: ([c, n, unit]) => `toStartOfInterval(${c}, INTERVAL ${n} ${unit!.toUpperCase()})`,
  },

  // Distinct counts.
  uniqExact: { args: [{ kind: "column" }], render: ([c]) => `uniqExact(${c})` },
  uniq: { args: [{ kind: "column" }], render: ([c]) => `uniq(${c})` },

  // Conditional aggregation; the predicate's literals become bound params.
  countIf: { args: [{ kind: "predicate" }], render: ([p]) => `countIf(${p})` },
  sumIf: { args: [{ kind: "column" }, { kind: "predicate" }], render: ([c, p]) => `sumIf(${c}, ${p})` },
}
