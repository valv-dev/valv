// Copy the canonical valv skill into dist so it ships with the published package
// (files: ["dist"]). The skill itself lives at the repo root; this keeps a single
// source of truth and avoids committing a duplicate inside the package.
import { mkdirSync, copyFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url)) // packages/mcp/scripts
const src = join(here, "..", "..", "..", "skills", "valv", "SKILL.md")
const destDir = join(here, "..", "dist", "skill")

mkdirSync(destDir, { recursive: true })
copyFileSync(src, join(destDir, "SKILL.md"))
