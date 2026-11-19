#!/usr/bin/env node
// Guards the cross-platform path rule: asset and texture filenames are
// lowercase everywhere, so Windows, Linux and iPadOS resolve the same file.
//
// Usage: node scripts/check-asset-names.mjs

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// `apps/desktop/src-tauri/icons` is exempt: MSIX requires the generated
// Square150x150Logo.png / StoreLogo.png casing verbatim.
const roots = ["apps/desktop/ui/public", "engine"];
const ignored = new Set(["__pycache__", "node_modules", ".pytest_cache", ".ruff_cache"]);
const offenders = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    // Only names the app ships or resolves at runtime: skip tooling sources.
    if (/\.(py|ts|tsx|js|mjs|json|md|toml|lock)$/i.test(entry)) continue;
    if (entry !== entry.toLowerCase()) offenders.push(relative(process.cwd(), path));
  }
}

for (const root of roots) {
  try {
    walk(root);
  } catch {
    // A missing optional root is not a failure.
  }
}

if (offenders.length) {
  console.error("Asset filenames must be lowercase:");
  for (const path of offenders) console.error(`  ${path}`);
  process.exit(1);
}

console.log("Asset filenames are lowercase.");
