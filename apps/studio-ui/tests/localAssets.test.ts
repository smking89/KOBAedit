import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/fixture-cube.glb", import.meta.url));
const script = join(repo, "engine/scripts/index_local_assets.py");

test("local scanner collapses duplicates and keeps variants and part groups", () => {
  const root = mkdtempSync(join(tmpdir(), "koba-assets-"));
  try {
    const a = join(root, "PackA/Assets");
    const b = join(root, "PackB/Assets");
    mkdirSync(join(a, "Mesh"), { recursive: true });
    mkdirSync(join(a, "Texture2D"), { recursive: true });
    mkdirSync(join(b, "Mesh"), { recursive: true });
    copyFileSync(fixture, join(a, "Mesh/rifle_part01.glb"));
    copyFileSync(fixture, join(a, "Mesh/rifle_part02.glb"));
    copyFileSync(fixture, join(b, "Mesh/rifle_part01.glb")); // exact duplicate
    copyFileSync(fixture, join(b, "Mesh/ak47.glb"));
    const variant = readFileSync(fixture);
    variant[variant.length - 1] ^= 0xff; // same filename, different content
    writeFileSync(join(a, "Mesh/ak47.glb"), variant);
    writeFileSync(join(a, "Texture2D/wood.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const db = join(root, "index.db");
    const result = spawnSync("python3", [script, a, b, "--db", db, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scanned.mesh, 5);
    assert.equal(report.scanned.texture2d, 1);
    assert.equal(report.unique, 5); // 2 ak47 variants + rifle parts + texture
    assert.equal(report.duplicatesCollapsed, 1);
    assert.equal(report.sameNameVariants, 1);
    assert.equal(report.partGroups, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// Needs python3 and the sqlite3 CLI on PATH, which Windows CI runners lack.
test("rescan prunes files deleted from a scanned root", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "koba-stale-"));
  try {
    const assets = join(root, "Assets/Mesh");
    mkdirSync(assets, { recursive: true });
    copyFileSync(fixture, join(assets, "keep.glb"));
    copyFileSync(fixture, join(assets, "remove.glb"));
    const db = join(root, "index.db");
    const scan = () =>
      spawnSync("python3", [script, join(root, "Assets"), "--db", db, "--json"], {
        encoding: "utf8",
      });
    assert.equal(scan().status, 0);
    rmSync(join(assets, "remove.glb"));
    assert.equal(scan().status, 0);
    const dump = spawnSync("sqlite3", [db, "select count(*) from local_assets"], {
      encoding: "utf8",
    });
    assert.equal(dump.status, 0, "sqlite3 is required for this assertion");
    assert.equal(dump.stdout.trim(), "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
