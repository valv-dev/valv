// Make a query result JSON-safe for an LLM: Decimal → number, Date → ISO string,
// BigInt → string, recursing through arrays and objects.
export function serializeResult(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    return value.map(serializeResult)
  }

  if (typeof value === "bigint") {
    return value.toString()
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    // Duck-type Decimal.js — constructor name is minified in Prisma's build ("i" not "Decimal"),
    // but prototype method names are preserved as public API so this check is reliable.
    if (typeof v.toNumber === "function" && typeof v.toFixed === "function") {
      return (value as { toNumber(): number }).toNumber()
    }

    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = serializeResult(val)
    }
    return out
  }

  return value
}
