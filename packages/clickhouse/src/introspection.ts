import type { SchemaMap, ResourceSchema, FieldSchema, FieldType } from "@valv/core"

export interface ClickHouseClient {
  // json() is non-generic here so the interface is structurally compatible with
  // @clickhouse/client's ResultSet (whose json() returns a concrete union type
  // rather than the arbitrary T the generic would require).
  query(params: {
    query: string
    format?: string
    query_params?: Record<string, unknown>
    clickhouse_settings?: Record<string, unknown>
  }): Promise<{ json(): Promise<unknown> }>
}

interface SysColumn {
  table: string
  name: string
  type: string
  position: number
  default_kind: string
  is_in_primary_key: number
}

export async function introspectClickHouse(
  client: ClickHouseClient,
  database?: string,
): Promise<SchemaMap> {
  const db = database ?? (await resolveDatabase(client))

  const columns = await client
    .query({
      query: `
        SELECT table, name, type, position, default_kind, is_in_primary_key
        FROM system.columns
        WHERE database = '${db}'
        ORDER BY table, position
      `,
      format: "JSONEachRow",
    })
    .then((r) => r.json() as Promise<SysColumn[]>)

  // Group columns by table
  const byTable: Record<string, SysColumn[]> = {}
  for (const col of columns) {
    if (!byTable[col.table]) byTable[col.table] = []
    byTable[col.table].push(col)
  }

  const resources: Record<string, ResourceSchema> = {}

  for (const [tableName, cols] of Object.entries(byTable)) {
    const resourceName = tableName
    const fields: Record<string, FieldSchema> = {}

    // Determine the id column: prefer one literally named "id", else first primary key col
    const idColName =
      cols.find((c) => c.name === "id")?.name ??
      cols.find((c) => Number(c.is_in_primary_key) === 1)?.name

    for (const col of cols) {
      const { baseType, isNullable } = unwrapType(col.type)
      const fieldType = mapClickHouseType(baseType)
      if (!fieldType) continue

      const fieldSchema: FieldSchema = {
        name: col.name,
        type: fieldType,
        nativeType: baseType,
        isNullable,
        isId: col.name === idColName,
        isPrimaryKeyPart: Number(col.is_in_primary_key) === 1,
        hasDefaultValue: col.default_kind !== "",
      }

      if (fieldType === "enum") {
        fieldSchema.enumValues = parseEnumValues(baseType)
      }

      fields[col.name] = fieldSchema
    }

    resources[resourceName] = {
      name: resourceName,
      tableName,
      fields,
      relations: {},
    }
  }

  return { resources }
}

async function resolveDatabase(client: ClickHouseClient): Promise<string> {
  const result = await client
    .query({
      query: "SELECT currentDatabase() AS db",
      format: "JSONEachRow",
    })
    .then((r) => r.json() as Promise<{ db: string }[]>)
  return result[0]?.db ?? "default"
}

function unwrapType(rawType: string): { baseType: string; isNullable: boolean } {
  let t = rawType.trim()
  let isNullable = false

  if (t.startsWith("Nullable(") && t.endsWith(")")) {
    isNullable = true
    t = t.slice("Nullable(".length, -1)
  }

  if (t.startsWith("LowCardinality(") && t.endsWith(")")) {
    t = t.slice("LowCardinality(".length, -1)
    // LowCardinality(Nullable(X)) is unusual but handle it
    if (t.startsWith("Nullable(") && t.endsWith(")")) {
      isNullable = true
      t = t.slice("Nullable(".length, -1)
    }
  }

  return { baseType: t, isNullable }
}

function mapClickHouseType(t: string): FieldType | null {
  if (t === "String" || t.startsWith("FixedString(")) return "string"
  if (
    t.startsWith("Int") ||
    t.startsWith("UInt") ||
    t.startsWith("Float") ||
    t.startsWith("Decimal")
  )
    return "number"
  if (t === "Bool" || t === "Boolean") return "boolean"
  if (t.startsWith("Date") || t.startsWith("DateTime")) return "date"
  if (t === "UUID") return "uuid"
  if (t.startsWith("Enum8(") || t.startsWith("Enum16(")) return "enum"
  if (
    t.startsWith("Array(") ||
    t.startsWith("Map(") ||
    t.startsWith("Tuple(") ||
    t.startsWith("Nested(") ||
    t === "JSON" ||
    t.startsWith("IPv") ||
    t === "Object('json')"
  )
    return "json"
  return null
}

function parseEnumValues(enumType: string): string[] {
  // Enum8('a' = 1, 'b' = 2) → ['a', 'b']
  const inner = enumType.replace(/^Enum\d+\(/, "").replace(/\)$/, "")
  const values: string[] = []
  for (const entry of inner.split(",")) {
    const match = entry.trim().match(/^'(.*?)'\s*=\s*\d+$/)
    if (match) values.push(match[1])
  }
  return values
}
