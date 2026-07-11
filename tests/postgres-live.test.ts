import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { PostgresAdapter, type PostgresSql } from "@valv/postgres"
import { Valv } from "@valv/core"

// A real Postgres (PGlite runs the actual Postgres engine compiled to WASM),
// wrapped in the minimal PostgresSql surface the adapter needs. This exercises
// the full path — emit → bind → execute → serialize — against a live engine,
// which the compile-only tests can't catch.
interface Queryable {
  query(query: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

function pgliteClient(db: PGlite): PostgresSql {
  const wrap = (exec: Queryable): PostgresSql => ({
    async unsafe(query: string, parameters: unknown[] = []) {
      const res = await exec.query(query, parameters)
      return res.rows as unknown[]
    },
    // A real transaction so the adapter's `SET LOCAL` settings (statement
    // timeout, UTC timezone) are scoped exactly as they are against postgres.js.
    async begin<T>(cb: (sql: PostgresSql) => Promise<T>): Promise<T> {
      return db.transaction((tx) => cb(wrap(tx as Queryable))) as Promise<T>
    },
  })
  return wrap(db as Queryable)
}

let db: PGlite
let valv: Valv<Record<string, never>>

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE users (
      id serial PRIMARY KEY,
      email text NOT NULL,
      created_at timestamptz NOT NULL
    );
    INSERT INTO users (email, created_at) VALUES
      ('a@x.com', '2024-01-05T10:00:00Z'),
      ('b@x.com', '2024-01-20T10:00:00Z'),
      ('c@x.com', '2024-02-10T10:00:00Z'),
      ('d@x.com', '2024-02-15T10:00:00Z'),
      ('e@x.com', '2024-02-28T10:00:00Z'),
      ('f@x.com', '2024-03-01T10:00:00Z');
  `)
  const adapter = new PostgresAdapter(pgliteClient(db))
  valv = new Valv({ adapter, defaultPolicy: "allow-all" })
  await valv.loadSchema()
})

afterAll(async () => {
  await db.close()
})

describe("postgres live: dateTrunc + group by date", () => {
  it("buckets signups by month", async () => {
    const rows = (await valv.run(
      {
        from: "users",
        select: [
          {
            fn: "dateTrunc",
            args: [
              { kind: "col", name: "created_at" },
              { kind: "value", value: "month" },
            ],
            as: "bucket",
          },
          { fn: "count", args: [], as: "signups" },
        ],
        groupBy: ["bucket"],
        orderBy: [{ col: "bucket", dir: "asc" }],
      },
      {},
    )) as Array<{ bucket: unknown; signups: unknown }>

    expect(rows.map((r) => [r.bucket, r.signups])).toEqual([
      ["2024-01-01T00:00:00.000Z", 2],
      ["2024-02-01T00:00:00.000Z", 3],
      ["2024-03-01T00:00:00.000Z", 1],
    ])
  })

  it("groups by a raw date column", async () => {
    const rows = (await valv.run(
      {
        from: "users",
        select: [{ col: "created_at" }, { fn: "count", args: [], as: "n" }],
        groupBy: [{ col: "created_at" }],
        orderBy: [{ col: "created_at", dir: "asc" }],
      },
      {},
    )) as Array<{ created_at: unknown; n: unknown }>

    expect(rows).toHaveLength(6)
    expect(rows[0].n).toBe(1)
  })

  it("filters by a date range then buckets", async () => {
    const rows = (await valv.run(
      {
        from: "users",
        select: [
          {
            fn: "dateTrunc",
            args: [
              { kind: "col", name: "created_at" },
              { kind: "value", value: "month" },
            ],
            as: "bucket",
          },
          { fn: "count", args: [], as: "signups" },
        ],
        where: {
          kind: "cmp",
          op: ">=",
          left: { kind: "col", name: "created_at" },
          right: { kind: "value", value: "2024-02-01T00:00:00Z" },
        },
        groupBy: ["bucket"],
        orderBy: [{ col: "bucket", dir: "asc" }],
      },
      {},
    )) as Array<{ bucket: unknown; signups: unknown }>

    expect(rows.map((r) => [r.bucket, r.signups])).toEqual([
      ["2024-02-01T00:00:00.000Z", 3],
      ["2024-03-01T00:00:00.000Z", 1],
    ])
  })
})

// valv's whole point is running as a read-only role, and Postgres's
// information_schema.table_constraints view is empty for a SELECT-only role that
// doesn't own the table — so keys are read from pg_catalog instead. This locks
// that: introspecting *as* such a role must still resolve PKs and FKs.
describe("postgres live: introspection under a read-only role", () => {
  let rodb: PGlite

  beforeAll(async () => {
    rodb = new PGlite()
    await rodb.exec(`
      CREATE TABLE customers ( id serial PRIMARY KEY, name text );
      CREATE TABLE orders (
        id serial PRIMARY KEY,
        customer_id integer NOT NULL REFERENCES customers(id),
        total numeric NOT NULL
      );
      CREATE ROLE app_ro NOLOGIN;
      GRANT USAGE ON SCHEMA public TO app_ro;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_ro;
    `)
    // Drop to a SELECT-only, non-owning role for the rest of the session, so
    // table_constraints is empty for these tables and keys must come from
    // pg_catalog — reverting the pg_catalog queries makes this test fail.
    await rodb.exec(`SET ROLE app_ro`)
  })

  afterAll(async () => {
    await rodb.close()
  })

  it("still resolves primary keys and foreign keys via pg_catalog", async () => {
    const { resources } = await new PostgresAdapter(pgliteClient(rodb)).introspect()

    expect(resources.orders.fields.id).toMatchObject({ isId: true, isPrimaryKeyPart: true })
    expect(resources.customers.fields.id).toMatchObject({ isPrimaryKeyPart: true })

    // The belongsTo relation only exists if the FK was visible.
    expect(resources.orders.relations.customer).toMatchObject({
      targetResource: "customers",
      type: "belongsTo",
      foreignKey: "customer_id",
      targetKey: "id",
    })
  })
})
