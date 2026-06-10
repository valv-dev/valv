import { describe, it, expect, vi, afterEach } from "vitest"
import { PgNotifyListener, liveTriggersSQL, PrismaAdapter } from "@vistal/prisma"
import type { PgClientLike } from "@vistal/prisma"
import type { ResolvedQuery } from "@vistal/core"

class FakePgClient implements PgClientLike {
  queries: string[] = []
  connected = false
  ended = false
  private handler?: (msg: { channel: string; payload?: string }) => void

  async connect(): Promise<void> {
    this.connected = true
  }
  async query(sql: string): Promise<unknown> {
    this.queries.push(sql)
    return undefined
  }
  async end(): Promise<void> {
    this.ended = true
  }
  on(event: "notification", cb: (msg: { channel: string; payload?: string }) => void): void {
    this.handler = cb
  }
  notify(payload?: string, channel = "vistal_changes"): void {
    this.handler?.({ channel, payload })
  }
}

afterEach(() => {
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe("PgNotifyListener", () => {
  it("connects lazily, LISTENs on the channel, and ends when the last watcher leaves", async () => {
    vi.useFakeTimers()
    const client = new FakePgClient()
    const listener = new PgNotifyListener({
      connectionString: "postgres://x",
      clientFactory: () => client,
    })
    expect(client.connected).toBe(false)

    const unwatch = listener.watch(["Order"], vi.fn())
    await flush()
    expect(client.connected).toBe(true)
    expect(client.queries).toEqual(['LISTEN "vistal_changes"'])

    unwatch()
    await flush()
    expect(client.ended).toBe(true)
  })

  it("routes notifications by table, case-insensitively, with debounce", async () => {
    vi.useFakeTimers()
    const client = new FakePgClient()
    const listener = new PgNotifyListener({
      connectionString: "postgres://x",
      clientFactory: () => client,
      debounceMs: 100,
    })
    const onOrders = vi.fn()
    const onUsers = vi.fn()
    const u1 = listener.watch(["Order"], onOrders)
    const u2 = listener.watch(["User"], onUsers)
    await flush()

    // A burst of order notifications coalesces into one onChange.
    client.notify("order")
    client.notify("ORDER")
    client.notify("order")
    await vi.advanceTimersByTimeAsync(100)
    expect(onOrders).toHaveBeenCalledTimes(1)
    expect(onUsers).not.toHaveBeenCalled()

    // An empty payload notifies every watcher.
    client.notify(undefined)
    await vi.advanceTimersByTimeAsync(100)
    expect(onOrders).toHaveBeenCalledTimes(2)
    expect(onUsers).toHaveBeenCalledTimes(1)

    // Notifications on other channels are ignored.
    client.notify("order", "some_other_channel")
    await vi.advanceTimersByTimeAsync(100)
    expect(onOrders).toHaveBeenCalledTimes(2)

    u1()
    u2()
  })

  it("unwatched watchers no longer fire", async () => {
    vi.useFakeTimers()
    const client = new FakePgClient()
    const listener = new PgNotifyListener({
      connectionString: "postgres://x",
      clientFactory: () => client,
      debounceMs: 50,
    })
    const onChange = vi.fn()
    const keepAlive = listener.watch(["User"], vi.fn()) // keeps the connection open
    const unwatch = listener.watch(["Order"], onChange)
    await flush()

    client.notify("order")
    unwatch() // pending debounce timer must be cancelled
    await vi.advanceTimersByTimeAsync(200)
    expect(onChange).not.toHaveBeenCalled()
    keepAlive()
  })

  it("reports connection failures to onError instead of throwing", async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const listener = new PgNotifyListener({
      connectionString: "postgres://x",
      clientFactory: () => {
        throw new Error("pg not installed")
      },
      onError,
    })
    listener.watch(["Order"], vi.fn())
    await flush()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "pg not installed" }))
  })

  it("rejects unsafe channel names", () => {
    expect(
      () => new PgNotifyListener({ connectionString: "postgres://x", channel: "bad;DROP" }),
    ).toThrow(/channel/)
  })
})

describe("liveTriggersSQL", () => {
  it("emits the notify function and idempotent per-table triggers", () => {
    const sql = liveTriggersSQL(["Order", "User"])
    expect(sql[0]).toContain("CREATE OR REPLACE FUNCTION vistal_notify()")
    expect(sql[0]).toContain("pg_notify('vistal_changes', TG_TABLE_NAME)")
    expect(sql).toContainEqual(
      expect.stringContaining('DROP TRIGGER IF EXISTS "vistal_notify_Order"'),
    )
    expect(sql).toContainEqual(
      expect.stringContaining(
        'AFTER INSERT OR UPDATE OR DELETE ON "Order" FOR EACH STATEMENT EXECUTE FUNCTION vistal_notify()',
      ),
    )
  })

  it("rejects unsafe identifiers", () => {
    expect(() => liveTriggersSQL(['Order"; DROP TABLE x;--'])).toThrow(/table name/)
    expect(() => liveTriggersSQL(["Order"], "bad channel")).toThrow(/channel/)
  })
})

describe("PrismaAdapter live wiring", () => {
  it("exposes subscribe only when live is configured", () => {
    const prisma = {} as import("@prisma/client").PrismaClient
    expect(new PrismaAdapter(prisma).subscribe).toBeUndefined()
    expect(new PrismaAdapter(prisma, "./schema.prisma").subscribe).toBeUndefined()
    const live = new PrismaAdapter(prisma, {
      live: { connectionString: "postgres://x", clientFactory: () => new FakePgClient() },
    })
    expect(typeof live.subscribe).toBe("function")
  })

  it("watches the queried table and included relations' tables", async () => {
    vi.useFakeTimers()
    const client = new FakePgClient()
    const prisma = {} as import("@prisma/client").PrismaClient
    const adapter = new PrismaAdapter(prisma, {
      live: { connectionString: "postgres://x", clientFactory: () => client, debounceMs: 10 },
    })

    const query: ResolvedQuery = {
      resource: "order",
      operation: "find",
      fields: ["id"],
      include: {
        customer: { resource: "user", type: "belongsTo", foreignKey: "user_id", fields: ["id"] },
      },
    }
    const onChange = vi.fn()
    const unsubscribe = adapter.subscribe!(query, onChange)
    await flush()

    client.notify("order")
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenCalledTimes(1)

    client.notify("user") // included relation's table also triggers
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenCalledTimes(2)

    client.notify("unrelated_table")
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenCalledTimes(2)

    unsubscribe()
  })
})
