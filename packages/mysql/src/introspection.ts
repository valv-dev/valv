import type { SchemaMap, ResourceSchema, FieldSchema, FieldType, RelationSchema } from "@valv/core"

// The structural slice of a mysql2/promise `Connection` this adapter needs:
// `query(sql, values)` resolving to mysql2's `[rows, fields]` tuple. The package
// never imports mysql2 — the consumer passes their own client (and owns its
// connection lifecycle and credentials). A dedicated connection is expected
// (not a shared pool), so the session settings in `execute` apply to the query.
export interface MySqlClient {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>
}

// Run a query and return just the rows (mysql2 resolves `[rows, fields]`).
async function rows<T>(client: MySqlClient, sql: string): Promise<T[]> {
  const [result] = await client.query(sql)
  return (result ?? []) as T[]
}

// MySQL's "schema" is the database, so every table lives in the connection's
// current database — introspection scopes to database() and the emitter leaves
// table names bare (they resolve against that default database). Cross-database
// querying would need db-qualified names; widen when a real need appears.

interface ColumnRow {
  table_name: string
  column_name: string
  data_type: string
  column_type: string
  is_nullable: string
  column_key: string
  has_default: number
}

interface FkRow {
  table_name: string
  column_name: string
  constraint_name: string
  foreign_table_name: string
  foreign_column_name: string
}

export async function introspectMysql(client: MySqlClient): Promise<SchemaMap> {
  const [columns, fks] = await Promise.all([
    rows<ColumnRow>(
      client,
      `select c.table_name as table_name, c.column_name as column_name,
              c.data_type as data_type, c.column_type as column_type,
              c.is_nullable as is_nullable, c.column_key as column_key,
              (c.column_default is not null) as has_default
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
       where t.table_type = 'BASE TABLE' and c.table_schema = database()
       order by c.table_name, c.ordinal_position`,
    ),
    rows<FkRow>(
      client,
      `select k.table_name as table_name, k.column_name as column_name,
              k.constraint_name as constraint_name,
              k.referenced_table_name as foreign_table_name,
              k.referenced_column_name as foreign_column_name
       from information_schema.key_column_usage k
       where k.table_schema = database() and k.referenced_table_name is not null
       order by k.table_name, k.constraint_name, k.ordinal_position`,
    ),
  ])

  // Group FK columns by constraint so composite FKs (>1 column) can be detected
  // and skipped — valv relations carry a single join key, so a composite FK
  // can't be represented and is dropped rather than emitted wrong.
  const fkByConstraint = new Map<
    string,
    { table: string; localColumns: string[]; foreignTable: string; foreignColumns: string[] }
  >()
  for (const r of fks) {
    // Constraint names are unique per table, not per database, so key on both.
    const id = `${r.table_name}.${r.constraint_name}`
    const entry = fkByConstraint.get(id) ?? {
      table: r.table_name,
      localColumns: [],
      foreignTable: r.foreign_table_name,
      foreignColumns: [],
    }
    entry.localColumns.push(r.column_name)
    entry.foreignColumns.push(r.foreign_column_name)
    fkByConstraint.set(id, entry)
  }

  const columnsByTable = new Map<string, ColumnRow[]>()
  for (const r of columns) {
    const list = columnsByTable.get(r.table_name) ?? []
    list.push(r)
    columnsByTable.set(r.table_name, list)
  }

  const resources: Record<string, ResourceSchema> = {}
  for (const [tableName, cols] of columnsByTable) {
    const pkCols = cols.filter((c) => c.column_key === "PRI").map((c) => c.column_name)
    // Prefer a column literally named "id", else the first primary key column.
    const idCol = cols.find((c) => c.column_name === "id")?.column_name ?? pkCols[0]

    const fields: Record<string, FieldSchema> = {}
    for (const col of cols) {
      const type = mapMysqlType(col.data_type, col.column_type)
      const field: FieldSchema = {
        name: col.column_name,
        type,
        nativeType: col.column_type,
        isNullable: col.is_nullable === "YES",
        isId: col.column_name === idCol,
        isPrimaryKeyPart: pkCols.includes(col.column_name),
        hasDefaultValue: Boolean(Number(col.has_default)),
      }
      if (type === "enum") field.enumValues = parseEnumValues(col.column_type)
      fields[col.column_name] = field
    }

    resources[tableName] = { name: tableName, tableName, fields, relations: {} }
  }

  addRelations(resources, fkByConstraint)
  return { resources }
}

// Turn single-column FK constraints into relations on both ends: a `belongsTo`
// on the table that owns the FK, and the inverse `hasMany` on the referenced
// table — so the model can traverse orders → customer and customer → orders.
function addRelations(
  resources: Record<string, ResourceSchema>,
  fkByConstraint: Map<
    string,
    { table: string; localColumns: string[]; foreignTable: string; foreignColumns: string[] }
  >,
): void {
  for (const fk of fkByConstraint.values()) {
    if (fk.localColumns.length !== 1) continue // composite FK — not representable
    const localColumn = fk.localColumns[0]
    const foreignColumn = fk.foreignColumns[0]
    const owner = resources[fk.table]
    const target = resources[fk.foreignTable]
    if (!owner || !target) continue

    const belongsToName = uniqueName(
      owner.relations,
      localColumn.endsWith("_id") ? localColumn.slice(0, -3) : fk.foreignTable,
    )
    owner.relations[belongsToName] = {
      name: belongsToName,
      targetResource: fk.foreignTable,
      type: "belongsTo",
      foreignKey: localColumn,
      targetKey: foreignColumn,
    }

    const hasManyName = uniqueName(target.relations, pluralize(fk.table))
    target.relations[hasManyName] = {
      name: hasManyName,
      targetResource: fk.table,
      type: "hasMany",
      // For hasMany the FK lives on the owning (child) table; targetKey is the
      // referenced column back on this (parent) table.
      foreignKey: localColumn,
      targetKey: foreignColumn,
    }
  }
}

function uniqueName(existing: Record<string, RelationSchema>, base: string): string {
  if (!(base in existing)) return base
  let n = 2
  while (`${base}_${n}` in existing) n++
  return `${base}_${n}`
}

function pluralize(name: string): string {
  return name.endsWith("s") ? name : `${name}s`
}

// enum('a','b','c') → ["a", "b", "c"]. MySQL escapes a literal quote by doubling
// it inside the value; unescape on the way out.
function parseEnumValues(columnType: string): string[] {
  const inner = columnType.replace(/^enum\(/i, "").replace(/\)$/, "")
  const values: string[] = []
  const re = /'((?:[^']|'')*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner))) values.push(m[1].replace(/''/g, "'"))
  return values
}

// Coarse cross-dialect type from MySQL's information_schema.data_type. `tinyint(1)`
// is MySQL's idiomatic boolean (what BOOL/BOOLEAN alias to), so it maps to boolean;
// wider integers stay numeric. Unknown/blob/spatial types fall through to string.
function mapMysqlType(dataType: string, columnType: string): FieldType {
  const t = dataType.toLowerCase()
  if (columnType.toLowerCase() === "tinyint(1)") return "boolean"
  if (
    [
      "tinyint",
      "smallint",
      "mediumint",
      "int",
      "integer",
      "bigint",
      "decimal",
      "dec",
      "numeric",
      "float",
      "double",
      "real",
      "bit",
      "year",
    ].includes(t)
  )
    return "number"
  if (t === "date" || t === "datetime" || t === "timestamp" || t === "time") return "date"
  if (t === "json") return "json"
  if (t === "enum") return "enum"
  return "string"
}
