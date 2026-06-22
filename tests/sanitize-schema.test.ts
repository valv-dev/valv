import { describe, it, expect } from "vitest"
import { sanitizeSchemaText } from "@valv/prisma"

describe("sanitizeSchemaText", () => {
  it("renames a relation field that collides with a scalar column", () => {
    // The shape `prisma db pull` produces for a `user.image` column alongside an
    // `image` table that references `user` — two fields both named `image`.
    const src = `model user {
  id       String  @id
  image    String?
  download download[]
  image    image[]

  @@map("user")
}
`
    const { text, renames } = sanitizeSchemaText(src)

    expect(renames).toEqual([{ model: "user", from: "image", to: "image_rel" }])
    // Scalar keeps its real name; only the later (relation) field is renamed.
    expect(text).toContain("  image    String?")
    expect(text).toMatch(/^\s*image_rel\s+image\[\]/m)
    expect(text).not.toMatch(/^\s*image\s+image\[\]/m)
  })

  it("leaves a clean schema untouched", () => {
    const src = `model order {
  id     String @id
  status String
  total  Int
}
`
    const { text, renames } = sanitizeSchemaText(src)
    expect(renames).toHaveLength(0)
    expect(text).toBe(src)
  })

  it("bumps the suffix when the renamed field would also collide", () => {
    const src = `model t {
  a     String
  a     a[]
  a_rel String
}
`
    const { renames } = sanitizeSchemaText(src)
    expect(renames).toEqual([{ model: "t", from: "a", to: "a_rel2" }])
  })

  it("scopes uniqueness per block and ignores attributes/comments", () => {
    const src = `model a {
  // a comment
  name String
  @@index([name])
}

model b {
  name String
  name b_other[]
}
`
    const { renames } = sanitizeSchemaText(src)
    // `name` recurs across blocks but only collides within `b`.
    expect(renames).toEqual([{ model: "b", from: "name", to: "name_rel" }])
  })
})
