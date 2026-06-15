import "dotenv/config"
import { createClient } from "@clickhouse/client"

const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  database: process.env.CLICKHOUSE_DATABASE ?? "analytics",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
})

async function seed() {
  console.log("Creating tables…")

  await ch.command({ query: "DROP TABLE IF EXISTS orders" })
  await ch.command({ query: "DROP TABLE IF EXISTS users" })
  await ch.command({ query: "DROP TABLE IF EXISTS events" })

  await ch.command({
    query: `
      CREATE TABLE users
      (
        id            String,
        tenant_id     String,
        name          String  COMMENT '@valv:description "Display name"',
        email         String  COMMENT '@valv:description "Contact email"',
        role          String  COMMENT '@valv:description "User role"',
        password_hash Nullable(String) COMMENT '@valv:sensitive'
      )
      ENGINE = MergeTree
      ORDER BY (tenant_id, id)
      COMMENT '@valv:description "Platform users"'
    `,
  })

  await ch.command({
    query: `
      CREATE TABLE orders
      (
        id             String,
        tenant_id      String,
        user_id        String,
        status         Enum8('pending'=1, 'shipped'=2, 'delivered'=3, 'cancelled'=4)
                         COMMENT '@valv:description "Current order status"',
        total          Int64   COMMENT '@valv:description "Order total in cents"',
        internal_notes Nullable(String) COMMENT '@valv:sensitive',
        created_at     DateTime DEFAULT now()
      )
      ENGINE = MergeTree
      ORDER BY (tenant_id, id)
      COMMENT '@valv:description "Customer purchase orders"'
    `,
  })

  await ch.command({
    query: `
      CREATE TABLE events
      (
        id          String,
        tenant_id   String,
        user_id     String,
        event_type  String   COMMENT '@valv:description "Type of event"',
        properties  String   COMMENT '@valv:description "JSON event properties"',
        occurred_at DateTime DEFAULT now()
      )
      ENGINE = MergeTree
      ORDER BY (tenant_id, occurred_at)
      COMMENT '@valv:description "Analytics events"'
    `,
  })

  console.log("Seeding users…")

  await ch.insert({
    table: "users",
    values: [
      { id: "user-alice", tenant_id: "tenant-alpha", name: "Alice",  email: "alice@alpha.com",  role: "admin",   password_hash: "hash-alice" },
      { id: "user-bob",   tenant_id: "tenant-alpha", name: "Bob",    email: "bob@alpha.com",    role: "analyst", password_hash: "hash-bob" },
      { id: "user-carol", tenant_id: "tenant-beta",  name: "Carol",  email: "carol@beta.com",   role: "admin",   password_hash: "hash-carol" },
    ],
    format: "JSONEachRow",
  })

  console.log("Seeding orders…")

  await ch.insert({
    table: "orders",
    values: [
      { id: "order-1", tenant_id: "tenant-alpha", user_id: "user-alice", status: "delivered", total: 154998, internal_notes: "chargeback risk",  created_at: "2024-01-10 10:00:00" },
      { id: "order-2", tenant_id: "tenant-alpha", user_id: "user-alice", status: "shipped",   total: 129999, internal_notes: "priority customer", created_at: "2024-01-12 11:00:00" },
      { id: "order-3", tenant_id: "tenant-alpha", user_id: "user-bob",   status: "delivered", total: 22998,  internal_notes: "",                  created_at: "2024-01-14 09:00:00" },
      { id: "order-4", tenant_id: "tenant-alpha", user_id: "user-bob",   status: "pending",   total: 24999,  internal_notes: "",                  created_at: "2024-01-16 14:00:00" },
      { id: "order-5", tenant_id: "tenant-beta",  user_id: "user-carol", status: "delivered", total: 89900,  internal_notes: "",                  created_at: "2024-01-11 08:00:00" },
      { id: "order-6", tenant_id: "tenant-beta",  user_id: "user-carol", status: "shipped",   total: 34500,  internal_notes: "",                  created_at: "2024-01-15 16:00:00" },
    ],
    format: "JSONEachRow",
  })

  console.log("Seeding events…")

  await ch.insert({
    table: "events",
    values: [
      { id: "evt-1", tenant_id: "tenant-alpha", user_id: "user-alice", event_type: "page_view",  properties: '{"page":"/dashboard"}',    occurred_at: "2024-01-10 10:05:00" },
      { id: "evt-2", tenant_id: "tenant-alpha", user_id: "user-alice", event_type: "purchase",   properties: '{"order_id":"order-1"}',   occurred_at: "2024-01-10 10:10:00" },
      { id: "evt-3", tenant_id: "tenant-alpha", user_id: "user-bob",   event_type: "page_view",  properties: '{"page":"/orders"}',       occurred_at: "2024-01-14 09:05:00" },
      { id: "evt-4", tenant_id: "tenant-alpha", user_id: "user-bob",   event_type: "purchase",   properties: '{"order_id":"order-3"}',   occurred_at: "2024-01-14 09:15:00" },
      { id: "evt-5", tenant_id: "tenant-beta",  user_id: "user-carol", event_type: "page_view",  properties: '{"page":"/analytics"}',   occurred_at: "2024-01-11 08:05:00" },
      { id: "evt-6", tenant_id: "tenant-beta",  user_id: "user-carol", event_type: "purchase",   properties: '{"order_id":"order-5"}',   occurred_at: "2024-01-11 08:10:00" },
    ],
    format: "JSONEachRow",
  })

  console.log("Done. Tables: users, orders, events")
  await ch.close()
}

seed().catch(err => {
  console.error(err)
  process.exit(1)
})
