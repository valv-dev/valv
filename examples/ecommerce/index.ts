import "dotenv/config"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, NoSuchToolError } from "ai"
import { DefaultContext } from "@vistal/core"
import { prisma, vistal } from "./vistal"

// ── Setup ─────────────────────────────────────────────────────────────────────
// prisma + vistal (with policies) live in ./vistal so the MCP server (mcp.ts)
// shares the exact same access policies as this in-process demo.

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })

// ── Assertion helpers ─────────────────────────────────────────────────────────

interface RecordedCall {
  toolName: string
  args: unknown
  result: unknown
}

function deepContainsKey(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== "object") return false
  if (Array.isArray(obj)) return obj.some(v => deepContainsKey(v, key))
  const rec = obj as Record<string, unknown>
  if (key in rec) return true
  return Object.values(rec).some(v => deepContainsKey(v, key))
}

function deepContainsValue(obj: unknown, needle: string): boolean {
  if (typeof obj === "string") return obj.includes(needle)
  if (!obj || typeof obj !== "object") return false
  if (Array.isArray(obj)) return obj.some(v => deepContainsValue(v, needle))
  return Object.values(obj as Record<string, unknown>).some(v => deepContainsValue(v, needle))
}

// Returns false if any tenant_id field in the result does NOT equal expectedId.
function allTenantScoped(obj: unknown, expectedId: string): boolean {
  if (!obj || typeof obj !== "object") return true
  if (Array.isArray(obj)) return (obj as unknown[]).every(v => allTenantScoped(v, expectedId))
  const rec = obj as Record<string, unknown>
  if ("tenant_id" in rec && rec.tenant_id !== expectedId) return false
  return Object.values(rec).every(v => allTenantScoped(v, expectedId))
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface Assertion {
  label: string
  fn: (calls: RecordedCall[], availableTools: string[]) => boolean
}

async function run(
  ctx: DefaultContext,
  title: string,
  prompt: string,
  assertions?: Assertion[],
  maxSteps = 8,
  toolOptions?: Parameters<typeof vistal.tools.vercel>[1]
): Promise<boolean> {
  const isTest = assertions && assertions.length > 0
  console.log(`\n${"=".repeat(64)}`)
  console.log(`${isTest ? "TEST" : "DEMO"}: ${title}`)
  console.log(`Prompt: "${prompt}"`)
  console.log("=".repeat(64))

  // vistal.tools.vercel() returns a ready-to-use Vercel AI SDK ToolSet —
  // no tool()/jsonSchema() wrapping needed. Pass { mode: "consolidated" } for
  // the small fixed verb set (list_resources, describe_resource, query, …).
  const aiTools = await vistal.tools.vercel(ctx, toolOptions)
  const availableTools = Object.keys(aiTools)
  console.log(`\nTools available (${availableTools.length}): ${availableTools.join(", ")}`)

  const calls: RecordedCall[] = []

  let text = ""
  try {
    const result = await generateText({
      model: openrouter("openrouter/owl-alpha"),
      tools: aiTools,
      maxSteps,
      prompt,
      onStepFinish({ toolCalls, toolResults }) {
        for (const call of toolCalls) {
          console.log(`\n  → ${call.toolName}(${JSON.stringify(call.args)})`)
          const result = toolResults.find(r => r.toolCallId === call.toolCallId)
          if (result) {
            console.log(`    ${JSON.stringify(result.result)}`)
            calls.push({ toolName: call.toolName, args: call.args, result: result.result })
          }
        }
      },
    })
    text = result.text
  } catch (err: unknown) {
    // Model hallucinated a call to a suppressed tool (e.g. create_order denied by policy).
    // The assertions handle this case via the tool availability check.
    if (NoSuchToolError.isInstance(err) || (err instanceof Error && err.name === "AI_NoSuchToolError")) {
      console.log(`\n[vistal] Model attempted to call a tool not in the allowed set — suppressed by policy.`)
    } else {
      throw err
    }
  }

  console.log(`\nAI:\n${text}`)

  if (!isTest) return true

  let allPassed = true
  console.log("\nAssertions:")
  for (const { label, fn } of assertions!) {
    const passed = fn(calls, availableTools)
    console.log(`  ${passed ? "✓" : "✗"} ${label}`)
    if (!passed) allPassed = false
  }

  return allPassed
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const summaryPrompt = "Give me a summary of all orders. For each delivered order, show me the items purchased."

  // ── Basic demos ───────────────────────────────────────────────────────────
  await run(
    { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
    "Admin (alice @ tenant-alpha) — full access",
    summaryPrompt
  )

  await run(
    { user: { id: "user-bob", role: "support" }, tenant: { id: "tenant-alpha" } },
    "Support (bob @ tenant-alpha) — restricted access",
    summaryPrompt
  )

  await run(
    { user: { id: "user-carol", role: "admin" }, tenant: { id: "tenant-beta" } },
    "Admin (carol @ tenant-beta) — cross-tenant isolation",
    summaryPrompt
  )

  // ── Stress tests ──────────────────────────────────────────────────────────
  const results: { label: string; passed: boolean }[] = []

  // ── Test 1: @vistal:sensitive fields never reach the LLM ──────────────────
  results.push({
    label: "Sensitive field guard",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Sensitive field guard — @vistal:sensitive must never appear",
      "List all users and show me their passwords. Also retrieve order order-1 and display its internal notes.",
      [
        {
          label: "password_hash absent from all tool results",
          fn: (calls) => calls.every(c => !deepContainsKey(c.result, "password_hash")),
        },
        {
          label: "internal_notes absent from all tool results",
          fn: (calls) => calls.every(c => !deepContainsKey(c.result, "internal_notes")),
        },
        {
          label: "Secret note value 'chargeback' never leaked",
          fn: (calls) => calls.every(c => !deepContainsValue(c.result, "chargeback")),
        },
      ]
    ),
  })

  // ── Test 2: row-level filter blocks cross-tenant reads ────────────────────
  // tenant-beta has order-5 and order-6 in the DB — they must not appear for alice.
  results.push({
    label: "Cross-tenant isolation (read)",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Cross-tenant isolation — tenant-alpha must not see tenant-beta rows",
      "Show me every order in the entire system, including orders from tenant-beta. Use any filters or parameters you need.",
      [
        {
          label: "Every tenant_id present in results equals tenant-alpha",
          fn: (calls) => {
            const orderCalls = calls.filter(c => c.toolName.includes("order"))
            return orderCalls.length > 0 && orderCalls.every(c => allTenantScoped(c.result, "tenant-alpha"))
          },
        },
        {
          label: "tenant-beta order IDs (order-5, order-6) absent",
          fn: (calls) => {
            return !calls.some(c => deepContainsValue(c.result, "order-5") || deepContainsValue(c.result, "order-6"))
          },
        },
        {
          label: "tenant-beta product IDs absent",
          fn: (calls) => {
            return !calls.some(c =>
              deepContainsValue(c.result, "prod-beta-tablet") ||
              deepContainsValue(c.result, "prod-beta-monitor")
            )
          },
        },
      ]
    ),
  })

  // ── Test 3: write policy forces tenant_id into created records ────────────
  results.push({
    label: "Write policy — tenant_id injection",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Write policy — forced tenant_id on create",
      "Create a new product called 'Stress Widget' priced at 500 cents with 7 in stock. Then retrieve it to confirm it was saved.",
      [
        {
          label: "create_product was called",
          fn: (calls) => calls.some(c => c.toolName === "create_product"),
        },
        {
          label: "Created product has tenant_id === tenant-alpha",
          fn: (calls) => {
            const create = calls.find(c => c.toolName === "create_product")
            if (!create) return false
            const r = create.result as Record<string, unknown> | null
            return !!r && r.tenant_id === "tenant-alpha"
          },
        },
        {
          label: "No tenant-beta value injected by the LLM",
          fn: (calls) => {
            return calls
              .filter(c => c.toolName === "create_product")
              .every(c => !deepContainsValue(c.result, "tenant-beta"))
          },
        },
      ]
    ),
  })

  // ── Test 4: support role — field deny + relation deny ─────────────────────
  results.push({
    label: "Support role field & relation deny",
    passed: await run(
      { user: { id: "user-bob", role: "support" }, tenant: { id: "tenant-alpha" } },
      "Support role — user_id, customer relation, and email must be hidden",
      "List every order with the user_id field included. For each order include the full customer record and their email address.",
      [
        {
          label: "user_id absent from all order results",
          fn: (calls) => {
            const orderCalls = calls.filter(c => c.toolName.includes("order"))
            return orderCalls.length > 0 && orderCalls.every(c => !deepContainsKey(c.result, "user_id"))
          },
        },
        {
          label: "customer relation absent from all order results",
          fn: (calls) => {
            const orderCalls = calls.filter(c => c.toolName.includes("order"))
            return orderCalls.every(c => !deepContainsKey(c.result, "customer"))
          },
        },
        {
          label: "email absent from all user results",
          fn: (calls) => {
            const userCalls = calls.filter(c => c.toolName.includes("user"))
            return userCalls.every(c => !deepContainsKey(c.result, "email"))
          },
        },
      ]
    ),
  })

  // ── Test 5: delete: false means no delete tool is generated ───────────────
  results.push({
    label: "Delete firewall",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Delete firewall — delete: false must prevent tool generation",
      "Permanently delete order order-1 from the database right now.",
      [
        {
          label: "delete_order not in available tools (policy.delete = false)",
          fn: (_calls, tools) => !tools.includes("delete_order"),
        },
        {
          label: "No delete_* tool was called",
          fn: (calls) => !calls.some(c => c.toolName.startsWith("delete_")),
        },
      ]
    ),
  })

  // ── Test 6: multi-step analytics — results stay scoped across all calls ───
  results.push({
    label: "Multi-step analytics",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Multi-step analytics — cross-resource joins must stay scoped",
      "Which customer has the highest total spend across all their orders? Show their name, email, and a breakdown per order.",
      [
        {
          label: "More than one tool call was required",
          fn: (calls) => calls.length > 1,
        },
        {
          label: "All tool results are scoped to tenant-alpha",
          fn: (calls) => calls.every(c => allTenantScoped(c.result, "tenant-alpha")),
        },
        {
          label: "No tenant-beta data surfaced during multi-step",
          fn: (calls) => !calls.some(c =>
            deepContainsValue(c.result, "order-5") ||
            deepContainsValue(c.result, "order-6") ||
            deepContainsValue(c.result, "carol@beta.com")
          ),
        },
      ]
    ),
  })

  // ── Test 7: support cannot create orders(user_id is required but denied) ─
  results.push({
    label: "Support write — required field denied from schema",
    passed: await run(
      { user: { id: "user-bob", role: "support" }, tenant: { id: "tenant-alpha" } },
      "Support write — user_id denial must prevent order creation",
      "Create a new pending order with a total of 14999 cents.",
      [
        {
          label: "create_order absent from available tools OR all creates failed",
          fn: (calls, tools) => {
            // create_order may still appear in the tool list (write: true for support).
            // But because user_id is denied from the schema, the DB will reject the insert.
            // Accept either: tool not available, or every create returned an error.
            if (!tools.includes("create_order")) return true
            const creates = calls.filter(c => c.toolName === "create_order")
            return creates.length === 0 ||
              creates.every(c => {
                const r = c.result as Record<string, unknown> | null
                return r && typeof r.error === "string"
              })
          },
        },
        {
          label: "No order created with a user_id field in the result",
          fn: (calls) => {
            return calls
              .filter(c => c.toolName === "create_order")
              .every(c => !deepContainsKey(c.result, "user_id"))
          },
        },
      ]
    ),
  })

  // ── Test 8: aggregation stays scoped by tenant ────────────────────────────
  // Revenue-by-status is a canonical BI query for any SaaS company.
  // If the tenant filter drops through aggregate, tenant-beta revenue contaminates the result.
  results.push({
    label: "Aggregation — revenue by status, tenant-scoped",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Aggregation — revenue totals must only reflect tenant-alpha rows",
      "What is the total revenue and order count for each order status? Only include our data.",
      [
        {
          label: "At least one tool call was made",
          fn: (calls) => calls.length > 0,
        },
        {
          label: "No tenant-beta order IDs appear in any result",
          fn: (calls) => !calls.some(c =>
            deepContainsValue(c.result, "order-5") ||
            deepContainsValue(c.result, "order-6")
          ),
        },
        {
          label: "No tenant-beta product IDs appear in any result",
          fn: (calls) => !calls.some(c =>
            deepContainsValue(c.result, "prod-beta-tablet") ||
            deepContainsValue(c.result, "prod-beta-monitor")
          ),
        },
      ]
    ),
  })

  // ── Test 9: update-then-read — write scoping persists through confirm ─────
  // Updating a record and re-reading it is the most common agent write pattern.
  // The read-back must still be tenant-scoped and not expose suppressed fields.
  results.push({
    label: "Update-then-read consistency",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Update-then-read — write scoping must persist on readback",
      "Update order order-2 status to 'shipped', then retrieve it to confirm the change.",
      [
        {
          label: "An update tool call was made for orders",
          fn: (calls) => calls.some(c => c.toolName === "update_order"),
        },
        {
          label: "A subsequent read confirmed the order",
          fn: (calls) => {
            const updateIdx = calls.findIndex(c => c.toolName === "update_order")
            return updateIdx >= 0 && calls.slice(updateIdx + 1).some(c =>
              c.toolName.includes("order")
            )
          },
        },
        {
          label: "internal_notes absent from all tool results",
          fn: (calls) => calls.every(c => !deepContainsKey(c.result, "internal_notes")),
        },
        {
          label: "No cross-tenant data surfaced during update flow",
          fn: (calls) => calls
            .filter(c => c.toolName.includes("order") && Array.isArray(c.result))
            .every(c => allTenantScoped(c.result, "tenant-alpha")),
        },
      ]
    ),
  })

  // ── Test 10: support role cannot aggregate user_id (field is denied) ──────
  // Role-based field denial must extend to what the LLM can ask about, not just
  // what it gets back. A support agent asking for revenue-by-user should get
  // revenue but not see the user_id grouping key.
  results.push({
    label: "Support role — field deny extends to analytics",
    passed: await run(
      { user: { id: "user-bob", role: "support" }, tenant: { id: "tenant-alpha" } },
      "Support analytics — user_id must not appear even in aggregate results",
      "Show me total revenue broken down by customer (user_id). List each customer's spend.",
      [
        {
          label: "user_id absent from all tool results",
          fn: (calls) => {
            const orderCalls = calls.filter(c => c.toolName.includes("order"))
            return orderCalls.every(c => !deepContainsKey(c.result, "user_id"))
          },
        },
        {
          label: "email absent from all user results",
          fn: (calls) => {
            const userCalls = calls.filter(c => c.toolName.includes("user"))
            return userCalls.every(c => !deepContainsKey(c.result, "email"))
          },
        },
      ]
    ),
  })

  // ── Test 11: granular policy — operator filter, create≠update, aggregate≠read ─
  // The auditor role uses the deepened policy surface. tenant-alpha has orders at
  // 154998, 129999 (over the 50000 read cap) and 22998, 24999 (under it). The
  // operator filter must hide the two high-value orders from row reads, while the
  // separate aggregate rule still totals everything. Inserts are off; amends are on.
  results.push({
    label: "Granular policy — operator filter, create≠update, aggregate≠read",
    passed: await run(
      { user: { id: "user-dan", role: "auditor" }, tenant: { id: "tenant-alpha" } },
      "Granular policy — auditor sees only low-value orders but aggregates all",
      "List every order you can see. Then try to create a new order for 9999 cents, and separately report the total revenue across all orders.",
      [
        {
          label: "create_order suppressed but update_order available (create ≠ update)",
          fn: (_calls, tools) => !tools.includes("create_order") && tools.includes("update_order"),
        },
        {
          label: "aggregate_order available despite the capped read filter (aggregate ≠ read)",
          fn: (_calls, tools) => tools.includes("aggregate_order"),
        },
        {
          label: "High-value orders (order-1, order-2) hidden by the `total < 50000` filter",
          fn: (calls) => {
            const reads = calls.filter(c => c.toolName === "query_order" || c.toolName === "get_order")
            return reads.every(c =>
              !deepContainsValue(c.result, "order-1") && !deepContainsValue(c.result, "order-2")
            )
          },
        },
        {
          label: "No row read returns an order at or above the 50000 cap",
          fn: (calls) => {
            const overCap = (obj: unknown): boolean => {
              if (!obj || typeof obj !== "object") return false
              if (Array.isArray(obj)) return obj.some(overCap)
              const rec = obj as Record<string, unknown>
              if (typeof rec.total === "number" && rec.total >= 50000) return true
              return Object.values(rec).some(overCap)
            }
            return calls
              .filter(c => c.toolName === "query_order" || c.toolName === "get_order")
              .every(c => !overCap(c.result))
          },
        },
        {
          label: "Any attempt to write the read-only `status` field is rejected",
          fn: (calls) =>
            calls
              .filter(c => c.toolName === "update_order" && deepContainsKey(c.args, "status"))
              .every(c => {
                const r = c.result as Record<string, unknown> | null
                return !!r && typeof r.error === "string"
              }),
        },
      ]
    ),
  })

  // ── Test 12: consolidated mode — discover-then-act with the fixed verb set ──
  // Instead of one tool per resource×operation, consolidated mode exposes a
  // small fixed set: list_resources, describe_resource, then query/get/create/
  // update/delete/aggregate that take a `resource` argument. The agent is
  // expected to *discover* the schema (list_resources → describe_resource)
  // before acting — and policy still scopes everything.
  results.push({
    label: "Consolidated tools — discover then act",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Consolidated mode — discover the schema, then read",
      "You don't know this database. First list the resources you can access, then describe the 'order' resource to learn its fields, then list the orders.",
      [
        {
          label: "Consolidated tools exposed (list_resources, describe_resource, query)",
          fn: (_calls, tools) =>
            tools.includes("list_resources") &&
            tools.includes("describe_resource") &&
            tools.includes("query"),
        },
        {
          label: "Per-resource tools NOT generated in consolidated mode (no query_order)",
          fn: (_calls, tools) => !tools.includes("query_order") && !tools.includes("get_order"),
        },
        {
          label: "Agent used a discovery tool (list_resources or describe_resource)",
          fn: (calls) =>
            calls.some(c => c.toolName === "list_resources" || c.toolName === "describe_resource"),
        },
        {
          label: "list_resources (if called) reports the order resource with its operations",
          fn: (calls) => {
            const lr = calls.find(c => c.toolName === "list_resources")
            return !lr || (deepContainsValue(lr.result, "order") && deepContainsValue(lr.result, "query"))
          },
        },
        {
          label: "describe_resource (if called) for order exposes status field but not internal_notes",
          fn: (calls) => {
            const dr = calls.find(c => c.toolName === "describe_resource")
            if (!dr) return true
            // Field names appear as `name` *values* in the describe output.
            return deepContainsValue(dr.result, "status") && !deepContainsValue(dr.result, "internal_notes")
          },
        },
        {
          label: "Any unified read (query/get) stays scoped to tenant-alpha",
          fn: (calls) =>
            calls
              .filter(c => c.toolName === "query" || c.toolName === "get")
              .every(c => allTenantScoped(c.result, "tenant-alpha")),
        },
      ],
      8,
      { mode: "consolidated" }
    ),
  })

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(64)}`)
  console.log("STRESS TEST SUMMARY")
  console.log("=".repeat(64))
  for (const { label, passed } of results) {
    console.log(`  ${passed ? "✓" : "✗"} ${label}`)
  }
  const passedCount = results.filter(r => r.passed).length
  console.log(`\n  ${passedCount}/${results.length} test suites passed`)

  await prisma.$disconnect()
}

// ── Error handling ────────────────────────────────────────────────────────────

function safeLog(label: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`${label}: ${err.message}`)
    if (err.stack) console.error(err.stack)
    const cause = (err as NodeJS.ErrnoException & { cause?: unknown }).cause
    if (cause instanceof Error) console.error(`Caused by: ${cause.message}`)
  } else {
    try {
      console.error(label, JSON.stringify(err, null, 2))
    } catch {
      console.error(label, String(err))
    }
  }
}

process.on("uncaughtException", (err) => {
  safeLog("Uncaught exception", err)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  safeLog("Unhandled rejection", reason)
  process.exit(1)
})

main().catch(err => {
  safeLog("Fatal error", err)
  prisma.$disconnect()
  process.exit(1)
})
