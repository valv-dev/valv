/** Serialize a query result so it's safe to send to an LLM.
 *
 *  - Prisma Decimal   → number  (duck-typed via .toNumber() — works even when minified)
 *  - Date             → ISO 8601 string
 *  - BigInt           → string  (JSON.stringify would throw)
 *  - Arrays / objects → recursed
 */
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
