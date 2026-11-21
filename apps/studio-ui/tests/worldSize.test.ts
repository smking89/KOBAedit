import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { heightmapMiB, splatResolutionFor, terrainFootprint } from "../src/lib/worldSize.ts";

type Row = {
  sizeMetres: number;
  samples: number;
  splatResolution: number;
  heightMiB: number;
  maskMiB: number;
  totalMiB: number;
};

const rows: Row[] = JSON.parse(
  readFileSync(new URL("./fixtures/terrain-footprint.json", import.meta.url), "utf8"),
);

test("terrain footprint matches the engine fixture byte for byte", () => {
  for (const row of rows) {
    const { sizeMetres, ...expected } = row;
    assert.deepEqual(terrainFootprint(sizeMetres), expected, `${sizeMetres} m drifted`);
  }
});

test("mask grid is the next power of two above half the map", () => {
  assert.equal(splatResolutionFor(2000), 1024);
  assert.equal(splatResolutionFor(4500), 4096);
  assert.equal(splatResolutionFor(8000), 4096);
  assert.equal(splatResolutionFor(16050), 8192);
});

test("heightmap readout counts one uint16 grid", () => {
  assert.equal(heightmapMiB(1025), Math.round((1025 * 1025 * 2) / (1024 * 1024)));
  assert.equal(heightmapMiB(4097), 32);
});
