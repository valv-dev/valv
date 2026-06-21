import { resolve } from "node:path"
import type { Valv } from "@valv/core"
import type { ServerConfig } from "./config"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyValv = Valv<any, any>

/**
 * A policy module takes full control of access. Export a default function (or a
 * named `applyPolicies`) that receives the configured valv instance:
 *
 * ```js
 * module.exports = (valv) => {
 *   valv.policy("orders", () => ({ read: true, write: true, delete: false }))
 * }
 * ```
 */
type PolicyModule =
  | ((valv: AnyValv) => void)
  | { default?: (valv: AnyValv) => void; applyPolicies?: (valv: AnyValv) => void }

function loadPolicyFile(path: string, valv: AnyValv): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(resolve(path)) as PolicyModule
  const fn = typeof mod === "function" ? mod : (mod.default ?? mod.applyPolicies)
  if (typeof fn !== "function") {
    throw new Error(
      `Policy file "${path}" must export a function (default export or \`applyPolicies\`).`,
    )
  }
  fn(valv)
}

/**
 * Apply access rules to the valv instance and return the set of resources to
 * expose as tools. When a policy file is supplied it takes full control;
 * otherwise the default is read-only (query/get/aggregate, never write/delete),
 * scoped by the optional table allow/deny lists.
 */
export async function applyAccess(
  valv: AnyValv,
  config: ServerConfig,
): Promise<{ resources: string[] }> {
  const all = await valv.resources()

  if (config.policyFile) {
    loadPolicyFile(config.policyFile, valv)
    // The policy file owns access; expose everything it permits (valv suppresses
    // tools for resources it denies). Allow/deny lists are ignored in this mode.
    return { resources: all }
  }

  // Default: read-only everywhere. (The query path is read-only today; writes
  // get their own policy axes when that slice lands.)
  valv.policy("*", () => ({ read: true }))

  // Table scoping: allow-list first (if given), then deny-list.
  let allowed = config.tables ? all.filter((t: string) => config.tables!.includes(t)) : all
  if (config.exclude) allowed = allowed.filter((t: string) => !config.exclude!.includes(t))

  // Authoritatively deny everything not allowed, so a model can't reach an
  // excluded table even by passing its name to a consolidated verb.
  const allowedSet = new Set(allowed)
  for (const name of all) {
    if (!allowedSet.has(name)) {
      valv.policy(name, () => ({ read: false }))
    }
  }

  return { resources: allowed }
}
