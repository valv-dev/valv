#!/usr/bin/env node
// Bump a workspace package's version and keep sibling dependency ranges in sync.
//
// Usage:
//   node scripts/version.mjs <package> <patch|minor|major|x.y.z>
//
// Examples:
//   node scripts/version.mjs core minor          # 0.2.0 -> 0.3.0
//   node scripts/version.mjs @valv/prisma patch # 0.2.1 -> 0.2.2
//   node scripts/version.mjs mcp 1.0.0            # set explicit version
//
// When a package is bumped, any sibling that depends on it via a semver
// range (e.g. "^0.2.0") is updated to point at the new version. Siblings
// that use the "*" workspace range are left untouched.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const BUMPS = new Set(["patch", "minor", "major"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function bumpSemver(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) fail(`cannot bump non-semver version "${version}"`);
  let [major, minor, patch] = m.slice(1).map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function loadPackages() {
  const pkgs = new Map();
  for (const name of readdirSync(PACKAGES_DIR)) {
    const path = join(PACKAGES_DIR, name, "package.json");
    let json;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    pkgs.set(json.name, { path, json });
  }
  return pkgs;
}

function writePackage(entry) {
  writeFileSync(entry.path, JSON.stringify(entry.json, null, 2) + "\n");
}

function main() {
  const [target, spec] = process.argv.slice(2);
  if (!target || !spec) {
    fail("usage: node scripts/version.mjs <package> <patch|minor|major|x.y.z>");
  }

  const pkgs = loadPackages();
  const fullName = target.startsWith("@valv/") ? target : `@valv/${target}`;
  const entry = pkgs.get(fullName);
  if (!entry) {
    fail(`unknown package "${target}" (known: ${[...pkgs.keys()].join(", ")})`);
  }

  const oldVersion = entry.json.version;
  const newVersion = BUMPS.has(spec) ? bumpSemver(oldVersion, spec) : spec;
  if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
    fail(`"${spec}" is not a valid bump type or semver version`);
  }

  entry.json.version = newVersion;
  writePackage(entry);
  console.log(`${fullName}: ${oldVersion} -> ${newVersion}`);

  // Sync sibling dependency ranges that pin this package via a semver range.
  for (const [name, sibling] of pkgs) {
    if (name === fullName) continue;
    let changed = false;
    for (const field of DEP_FIELDS) {
      const deps = sibling.json[field];
      const range = deps?.[fullName];
      if (!range || range === "*" || range === "workspace:*") continue;
      const prefix = range.match(/^[\^~]/)?.[0] ?? "";
      deps[fullName] = `${prefix}${newVersion}`;
      console.log(`  ${name}: ${field}.${fullName} ${range} -> ${deps[fullName]}`);
      changed = true;
    }
    if (changed) writePackage(sibling);
  }
}

main();
