import { getDMMF } from "@prisma/internals"
import type { SchemaMap, ResourceSchema, FieldSchema, FieldType, RelationSchema } from "@valv/core"

export async function introspectPrisma(schemaPath: string): Promise<SchemaMap> {
  const dmmf = await getDMMF({ datamodelPath: schemaPath })

  const enumMap: Record<string, string[]> = {}
  for (const e of dmmf.datamodel.enums) {
    enumMap[e.name] = e.values.map((v) => v.name)
  }

  const resources: Record<string, ResourceSchema> = {}

  // Index models by name so a relation can resolve its inverse end (needed to
  // find the FK for hasMany / 1:1-inverse, which lives on the *other* table).
  const modelsByName: Record<string, (typeof dmmf.datamodel.models)[number]> = {}
  for (const model of dmmf.datamodel.models) modelsByName[model.name] = model

  for (const model of dmmf.datamodel.models) {
    const resourceName = toResourceName(model.name)
    const fields: Record<string, FieldSchema> = {}
    const relations: Record<string, RelationSchema> = {}

    const modelDescription = parseDescription(model.documentation)

    for (const field of model.fields) {
      if (field.relationName) {
        const relation = buildRelationSchema(field, modelsByName)
        if (relation) {
          relations[field.name] = relation
        }
        continue
      }

      const fieldType = mapPrismaType(field.type, enumMap)
      if (!fieldType) continue

      const doc = field.documentation ?? ""
      const fieldSchema: FieldSchema = {
        name: field.name,
        type: fieldType,
        // Prisma's scalar type (String/Int/…). Not the DB native type, but PG/MySQL
        // bind params positionally and don't need one — only ClickHouse does.
        nativeType: field.type,
        isNullable: !field.isRequired,
        isId: field.isId,
        isPrimaryKeyPart: field.isId,
        hasDefaultValue: field.hasDefaultValue || field.isUpdatedAt || false,
        description: parseDescription(doc) ?? undefined,
        sensitive: parseSensitive(doc),
      }

      if (fieldType === "enum") {
        fieldSchema.enumValues = enumMap[field.type] ?? []
      }

      fields[field.name] = fieldSchema
    }

    resources[resourceName] = {
      name: resourceName,
      tableName: model.name,
      fields,
      relations,
      description: modelDescription ?? undefined,
    }
  }

  return { resources }
}

export function toResourceName(modelName: string): string {
  return modelName
    .replace(/([A-Z])/g, (match, letter, offset) =>
      offset === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`,
    )
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

export function toClientKey(resourceName: string): string {
  return resourceName.replace(/_([a-z])/g, (_, l) => l.toUpperCase())
}

function mapPrismaType(prismaType: string, enumMap: Record<string, string[]>): FieldType | null {
  switch (prismaType) {
    case "String":
      return "string"
    case "Int":
    case "Float":
    case "Decimal":
      return "number"
    case "Boolean":
      return "boolean"
    case "DateTime":
      return "date"
    case "Json":
      return "json"
    case "Bytes":
      return "string"
    default:
      // Only treat as enum if it's actually in the enum map
      if (enumMap[prismaType]) return "enum"
      return null
  }
}

interface RelField {
  name: string
  type: string
  isList: boolean
  relationName?: string | null
  relationFromFields?: readonly string[]
  relationToFields?: readonly string[]
}

interface RelModel {
  name: string
  fields: readonly RelField[]
}

// Resolve a relation field to its join keys. Four shapes:
//   1. local FK present (relationFromFields)  → belongsTo, FK on THIS table.
//   2. list, inverse owns the FK              → hasMany, FK on the TARGET table.
//   3. scalar, no local FK                    → 1:1 inverse side; FK on TARGET.
//   4. list, NEITHER side owns a FK           → implicit many-to-many (Prisma
//      hides the junction table). Joins through it aren't supported yet, so it's
//      typed manyToMany and resolveJoins rejects it cleanly — without this it
//      would be mistaken for a hasMany with an empty FK and emit broken SQL.
// For (2)/(3) the keys come from the inverse field on the target model (matched
// by relationName). targetKey is the column the FK references on the owning side.
function buildRelationSchema(
  field: RelField,
  modelsByName: Record<string, RelModel>,
): RelationSchema | null {
  const targetResource = toResourceName(field.type)

  // (1) This side owns the FK — the common belongsTo (e.g. order.customerId).
  if (field.relationFromFields && field.relationFromFields.length > 0) {
    return {
      name: field.name,
      targetResource,
      type: "belongsTo",
      foreignKey: field.relationFromFields[0],
      targetKey: field.relationToFields?.[0],
    }
  }

  // (2)/(3) The FK lives on the target — find the inverse field that owns it.
  const inverse = modelsByName[field.type]?.fields.find(
    (f) => f.relationName === field.relationName && (f.relationFromFields?.length ?? 0) > 0,
  )

  // (4) A list with no owning FK on either side: implicit many-to-many.
  if (!inverse && field.isList) {
    return { name: field.name, targetResource, type: "manyToMany", foreignKey: "" }
  }

  return {
    name: field.name,
    targetResource,
    type: field.isList ? "hasMany" : "belongsTo",
    // FK column on the target table, and the column it references back on us.
    foreignKey: inverse?.relationFromFields?.[0] ?? "",
    targetKey: inverse?.relationToFields?.[0],
  }
}

function parseDescription(doc?: string): string | null {
  if (!doc) return null
  const match = doc.match(/@valv:description\s+"([^"]+)"/)
  return match ? match[1] : null
}

function parseSensitive(doc: string): boolean {
  return /@valv:sensitive/.test(doc)
}
