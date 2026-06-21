import type { Dialect } from "@valv/core"
import { clickhouseFunctions } from "./functions"

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
  functions: clickhouseFunctions,
}
