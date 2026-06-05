import type { PrismaClient } from "@prisma/client"
import type {
  VistalAdapter,
  SchemaMap,
  ResolvedQuery,
  FilterNode,
  ResolvedInclude,
} from "@vistal/core"
import { encodeCursor } from "@vistal/core"
import { introspectPrisma } from "./introspection"

export class PrismaAdapter implements VistalAdapter {
  constructor(
    private prisma: PrismaClient,
    private schemaPath?: string,
  ) {}

  async introspect(): Promise<SchemaMap> {
    const path = this.schemaPath ?? "./prisma/schema.prisma"
    return introspectPrisma(path)
  }

  async execute(query: ResolvedQuery): Promise<unknown> {
    // Convert snake_case resource name to camelCase for Prisma client accessor
    const clientKey = toCamelCase(query.resource)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (this.prisma as any)[clientKey]
    if (!model) {
      throw new Error(
        `Prisma model not found for resource: ${query.resource} (tried key: ${clientKey})`,
      )
    }

    const where = query.filters ? translateFilter(query.filters) : undefined
    const select = buildSelect(query.fields)
    const include = query.include ? buildInclude(query.include) : undefined

    // Prisma: use select for scalar fields, merge nested relation objects into the same select
    const selectWithIncludes = include ? { ...select, ...include } : select

    switch (query.operation) {
      case "find": {
        // The builder guarantees sort + pagination (with primaryKey/cursorField)
        // for finds; fall back defensively for directly-constructed queries.
        const pag = query.pagination
        const pk = pag?.primaryKey ?? "id"
        const sort = query.sort ?? { field: pk, direction: "asc" as const }
        const dir = sort.direction

        const args: Record<string, unknown> = { select: selectWithIncludes }

        // orderBy: sort field + primary-key tiebreaker for a total, stable order.
        args.orderBy = sort.field === pk ? [{ [pk]: dir }] : [{ [sort.field]: dir }, { [pk]: dir }]

        // Keyset WHERE from the cursor; falls back to offset/skip when no cursor.
        let effectiveWhere = where
        if (pag?.keyset) {
          const op = dir === "asc" ? "gt" : "lt"
          const ks = pag.keyset
          const keysetWhere =
            sort.field === pk
              ? { [pk]: { [op]: ks.id } }
              : {
                  OR: [
                    { [sort.field]: { [op]: ks.sortValue } },
                    { AND: [{ [sort.field]: ks.sortValue }, { [pk]: { [op]: ks.id } }] },
                  ],
                }
          effectiveWhere = where ? { AND: [where, keysetWhere] } : keysetWhere
        } else if (pag?.offset !== undefined) {
          args.skip = pag.offset
        }
        if (effectiveWhere) args.where = effectiveWhere

        // Fetch one extra row to detect whether another page exists.
        const limit = pag?.limit
        if (limit !== undefined) args.take = limit + 1

        let results = (await model.findMany(args)) as Record<string, unknown>[]
        const hasMore = limit !== undefined && results.length > limit
        if (hasMore) results = results.slice(0, limit)

        let nextCursor: string | undefined
        if (hasMore && results.length > 0) {
          const last = results[results.length - 1]
          nextCursor = encodeCursor({
            sortField: sort.field,
            direction: dir,
            sortValue: serializeCursorValue(last[sort.field]),
            id: serializeCursorValue(last[pk]),
          })
        }

        // Strip fields added only for cursor bookkeeping before returning.
        if (query.internalFields?.length) {
          for (const row of results) {
            for (const f of query.internalFields) delete row[f]
          }
        }

        const data = query.include ? applyBelongsToFilters(results, query.include) : results
        return { data, nextCursor, hasMore }
      }

      case "findOne": {
        const args: Record<string, unknown> = { select: selectWithIncludes }
        if (where) args.where = where
        const result = await model.findFirst(args)
        return result && query.include ? applyBelongsToFiltersOne(result, query.include) : result
      }

      case "create": {
        return model.create({
          data: query.data ?? {},
          select: selectWithIncludes,
        })
      }

      case "update": {
        // Use updateMany with the full where (id + policy row filter) to enforce scoping.
        // A row in a different tenant won't match and won't be updated.
        const fullWhere = where ?? {}
        const result = await model.updateMany({
          where: fullWhere,
          data: query.data ?? {},
        })
        return result // { count: N }
      }

      case "delete": {
        // Use deleteMany with the full where for the same scoping guarantee.
        const fullWhere = where ?? {}
        return model.deleteMany({ where: fullWhere }) // { count: N }
      }

      case "aggregate": {
        return executeAggregate(model, query, where)
      }

      default:
        throw new Error(`Unsupported operation: ${query.operation}`)
    }
  }
}

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, l) => l.toUpperCase())
}

// Normalize a value for embedding in a cursor so it JSON-round-trips and the
// decoded value can be compared by Prisma on the next page (Date → ISO string,
// Prisma Decimal → number). Mirrors the duck-typing in core's serializeResult.
function serializeCursorValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    if (typeof v.toNumber === "function" && typeof v.toFixed === "function") {
      return (value as { toNumber(): number }).toNumber()
    }
  }
  return value
}

function buildSelect(fields: string[]): Record<string, true> {
  const select: Record<string, true> = {}
  for (const field of fields) {
    select[field] = true
  }
  return select
}

function buildInclude(include: Record<string, ResolvedInclude>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, rel] of Object.entries(include)) {
    const relSelect = buildSelect(rel.fields)
    const relWhere = rel.filters ? translateFilter(rel.filters) : undefined
    result[name] = {
      select: relSelect,
      // Prisma supports `where` on toMany relations only.
      // For belongsTo we enforce the filter post-fetch via applyBelongsToFilters.
      ...(relWhere && rel.type !== "belongsTo" ? { where: relWhere } : {}),
    }
  }
  return result
}

// For array results: null out any belongsTo includes that don't satisfy the relation's row filter
function applyBelongsToFilters(
  results: unknown[],
  include: Record<string, ResolvedInclude>,
): unknown[] {
  return results.map((r) => applyBelongsToFiltersOne(r, include))
}

function applyBelongsToFiltersOne(
  result: unknown,
  include: Record<string, ResolvedInclude>,
): unknown {
  if (!result || typeof result !== "object") return result
  const out = { ...(result as Record<string, unknown>) }
  for (const [relationName, rel] of Object.entries(include)) {
    if (rel.type !== "belongsTo" || !rel.filters) continue
    const related = out[relationName]
    if (related && typeof related === "object") {
      if (!matchesFilter(related as Record<string, unknown>, rel.filters)) {
        out[relationName] = null
      }
    }
  }
  return out
}

// In-memory filter evaluation for post-fetch enforcement of belongsTo policy
// filters. Mirrors the full FilterNode vocabulary so rich/disjunctive policy
// predicates are enforced rather than silently passed.
export function matchesFilter(obj: Record<string, unknown>, filter: FilterNode): boolean {
  switch (filter.type) {
    case "eq":
      return obj[filter.field] === filter.value
    case "in":
      return (filter.values as unknown[]).includes(obj[filter.field])
    case "range": {
      const v = obj[filter.field] as number | string | Date | null | undefined
      if (v === null || v === undefined) return false
      if (filter.gte !== undefined && !(v >= (filter.gte as typeof v))) return false
      if (filter.lte !== undefined && !(v <= (filter.lte as typeof v))) return false
      if (filter.gt !== undefined && !(v > (filter.gt as typeof v))) return false
      if (filter.lt !== undefined && !(v < (filter.lt as typeof v))) return false
      return true
    }
    case "like": {
      const v = obj[filter.field]
      if (typeof v !== "string") return false
      const hay = v.toLowerCase()
      const needle = filter.value.toLowerCase()
      if (filter.mode === "startsWith") return hay.startsWith(needle)
      if (filter.mode === "endsWith") return hay.endsWith(needle)
      return hay.includes(needle)
    }
    case "null": {
      const v = obj[filter.field]
      const isNull = v === null || v === undefined
      return filter.isNull ? isNull : !isNull
    }
    case "and":
      return filter.filters.every((f) => matchesFilter(obj, f))
    case "or":
      return filter.filters.some((f) => matchesFilter(obj, f))
    case "not":
      return !matchesFilter(obj, filter.filter)
  }
}

async function executeAggregate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  query: ResolvedQuery,
  where: Record<string, unknown> | undefined,
): Promise<unknown> {
  const aggs = query.aggregations ?? []
  const groupBy = query.groupBy

  if (groupBy && groupBy.length > 0) {
    // Prisma groupBy
    const _agg: Record<string, unknown> = {}
    for (const a of aggs) {
      if (!_agg[`_${a.fn}`]) _agg[`_${a.fn}`] = {}
      ;(_agg[`_${a.fn}`] as Record<string, boolean>)[a.field] = true
    }
    const args: Record<string, unknown> = { by: groupBy, ..._agg }
    if (where) args.where = where
    return model.groupBy(args)
  }

  // Prisma aggregate
  const _agg: Record<string, unknown> = {}
  for (const a of aggs) {
    if (a.fn === "count") {
      _agg._count = _agg._count ? _agg._count : {}
      if (a.field === "*") {
        _agg._count = true
      } else {
        ;(_agg._count as Record<string, boolean>)[a.field] = true
      }
    } else {
      if (!_agg[`_${a.fn}`]) _agg[`_${a.fn}`] = {}
      ;(_agg[`_${a.fn}`] as Record<string, boolean>)[a.field] = true
    }
  }
  if (Object.keys(_agg).length === 0) _agg._count = true

  const args: Record<string, unknown> = { ..._agg }
  if (where) args.where = where
  return model.aggregate(args)
}

export function translateFilter(node: FilterNode): Record<string, unknown> {
  switch (node.type) {
    case "eq":
      return { [node.field]: node.value }

    case "in":
      return { [node.field]: { in: node.values } }

    case "range": {
      const rangeObj: Record<string, unknown> = {}
      if (node.gte !== undefined) rangeObj.gte = node.gte
      if (node.lte !== undefined) rangeObj.lte = node.lte
      if (node.gt !== undefined) rangeObj.gt = node.gt
      if (node.lt !== undefined) rangeObj.lt = node.lt
      return { [node.field]: rangeObj }
    }

    case "like": {
      const mode = "insensitive"
      return { [node.field]: { [node.mode ?? "contains"]: node.value, mode } }
    }

    case "null":
      return { [node.field]: node.isNull ? null : { not: null } }

    case "and":
      return { AND: node.filters.map(translateFilter) }

    case "or":
      return { OR: node.filters.map(translateFilter) }

    case "not":
      return { NOT: translateFilter(node.filter) }
  }
}
