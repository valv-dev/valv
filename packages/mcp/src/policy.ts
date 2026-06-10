import { resolve } from "node:path"
import type { Vistal } from "@vistal/core"
import type { ServerConfig } from "./config"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyVistal = Vistal<any, any>

/**
 * A policy module takes full control of access. Export a default function (or a
 * named `applyPolicies`) that receives the configured vistal instance:
 *
 * ```js
 * module.exports = (vistal) => {
 *   vistal.policy("orders", () => ({ read: true, write: true, delete: false }))
 * }
 * ```
 */
type PolicyModule =
  | ((vistal: AnyVistal) => void)
  | { default?: (vistal: AnyVistal) => void; applyPolicies?: (vistal: AnyVistal) => void }

function loadPolicyFile(path: string, vistal: AnyVistal): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(resolve(path)) as PolicyModule
  const fn = typeof mod === "function" ? mod : (mod.default ?? mod.applyPolicies)
  if (typeof fn !== "function") {
    throw new Error(
      `Policy file "${path}" must export a function (default export or \`applyPolicies\`).`,
    )
  }
  fn(vistal)
}

/**
 * Apply access rules to the vistal instance and return the set of resources to
 * expose as tools. When a policy file is supplied it takes full control;
 * otherwise the default is read-only (query/get/aggregate, never write/delete),
 * scoped by the optional table allow/deny lists.
 */
export async function applyAccess(
  vistal: AnyVistal,
  config: ServerConfig,
): Promise<{ resources: string[] }> {
  const all = await vistal.resources()

  if (config.policyFile) {
    loadPolicyFile(config.policyFile, vistal)
    // The policy file owns access; expose everything it permits (vistal suppresses
    // tools for resources it denies). Allow/deny lists are ignored in this mode.
    return { resources: all }
  }

  // Default: read-only everywhere.
  vistal.policy("*", () => ({ read: true, aggregate: true, write: false, delete: false }))

  // Table scoping: allow-list first (if given), then deny-list.
  let allowed = config.tables ? all.filter((t: string) => config.tables!.includes(t)) : all
  if (config.exclude) allowed = allowed.filter((t: string) => !config.exclude!.includes(t))

  // Authoritatively deny everything not allowed, so a model can't reach an
  // excluded table even by passing its name to a consolidated verb.
  const allowedSet = new Set(allowed)
  for (const name of all) {
    if (!allowedSet.has(name)) {
      vistal.policy(name, () => ({ read: false, write: false, delete: false }))
    }
  }

  return { resources: allowed }
}
