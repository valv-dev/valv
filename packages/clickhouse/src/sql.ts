import type { FilterNode } from "@vistal/core"

export function quoteIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`"
}

export function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "boolean") return v ? "1" : "0"
  if (typeof v === "number") {
    if (!isFinite(v)) throw new Error(`Non-finite number value not allowed in query: ${v}`)
    return String(v)
  }
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0")
    const y = v.getUTCFullYear()
    const mo = pad(v.getUTCMonth() + 1)
    const d = pad(v.getUTCDate())
    const h = pad(v.getUTCHours())
    const mi = pad(v.getUTCMinutes())
    const s = pad(v.getUTCSeconds())
    return `'${y}-${mo}-${d} ${h}:${mi}:${s}'`
  }
  if (typeof v === "string") return `'${escapeString(v)}'`
  return `'${escapeString(JSON.stringify(v))}'`
}

export function compileFilter(node: FilterNode): string {
  switch (node.type) {
    case "eq":
      if (node.value === null || node.value === undefined) {
        return `${quoteIdent(node.field)} IS NULL`
      }
      return `${quoteIdent(node.field)} = ${formatValue(node.value)}`

    case "in": {
      if (node.values.length === 0) return "1 = 0"
      const list = node.values.map(formatValue).join(", ")
      return `${quoteIdent(node.field)} IN (${list})`
    }

    case "range": {
      const parts: string[] = []
      if (node.gte !== undefined) parts.push(`${quoteIdent(node.field)} >= ${formatValue(node.gte)}`)
      if (node.lte !== undefined) parts.push(`${quoteIdent(node.field)} <= ${formatValue(node.lte)}`)
      if (node.gt  !== undefined) parts.push(`${quoteIdent(node.field)} > ${formatValue(node.gt)}`)
      if (node.lt  !== undefined) parts.push(`${quoteIdent(node.field)} < ${formatValue(node.lt)}`)
      return parts.join(" AND ")
    }

    case "like": {
      const escaped = escapeLikePattern(node.value)
      let pattern: string
      if (node.mode === "startsWith") pattern = `${escaped}%`
      else if (node.mode === "endsWith") pattern = `%${escaped}`
      else pattern = `%${escaped}%`
      return `${quoteIdent(node.field)} ILIKE '${escapeString(pattern)}'`
    }

    case "null":
      return node.isNull
        ? `${quoteIdent(node.field)} IS NULL`
        : `${quoteIdent(node.field)} IS NOT NULL`

    case "and":
      if (node.filters.length === 0) return "1 = 1"
      return "(" + node.filters.map(compileFilter).join(" AND ") + ")"

    case "or":
      if (node.filters.length === 0) return "1 = 0"
      return "(" + node.filters.map(compileFilter).join(" OR ") + ")"

    case "not":
      return `NOT (${compileFilter(node.filter)})`
  }
}
