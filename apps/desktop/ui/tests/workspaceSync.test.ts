import assert from "node:assert/strict";
import test from "node:test";

import { mergeSeedPlacements, syncSharedPlacements } from "../src/lib/workspaceSync.ts";
import type { PrefabPlacement } from "../src/wizard/types.ts";

function placement(id: string, x: number, name = `Prefab ${id}`): PrefabPlacement {
  return {
    id,
    name,
    prefabId: `assets/${id}.prefab`,
    position: { x, y: 0, z: 0 },
    rotationEuler: { x: 0, y: 0, z: 0 },
    scale: 1,
    flatten: true,
    flattenRadius: 20,
    flattenFalloff: 8,
    collisionRadius: 10,
    bounds: { min: [-5, -1, -5], max: [5, 5, 5] },
    category: "Monument",
    topologyFlags: [],
    lootTier: null,
    hasIO: false,
    hasLoot: false,
    hasNpc: false,
  } as unknown as PrefabPlacement;
}

test("monument edits on a shared id flow back to the map copy", () => {
  const map = [placement("a", 10), placement("b", 20)];
  const monument = [
    { ...placement("a", 55, "Moved Airfield"), rotationEuler: { x: 0, y: 90, z: 0 } },
  ];
  const synced = syncSharedPlacements(map, monument);
  assert.notEqual(synced, map);
  assert.deepEqual(synced[0].position, { x: 55, y: 0, z: 0 });
  assert.equal(synced[0].name, "Moved Airfield");
  assert.equal(synced[0].rotationEuler.y, 90);
  // The map-only prefab keeps its own data.
  assert.equal(synced[1], map[1]);
});

test("monument-only placements never leak onto the map", () => {
  const map = [placement("a", 10)];
  const monument = [placement("a", 10), placement("new", 99)];
  const synced = syncSharedPlacements(map, monument);
  assert.equal(synced.length, 1);
  assert.equal(synced, map);
});

test("unchanged placements keep array identity", () => {
  const map = [placement("a", 10)];
  assert.equal(syncSharedPlacements(map, [placement("a", 10)]), map);
});

test("re-opening a prefab in Monument keeps the existing monument work", () => {
  const existing = [placement("a", 10), placement("b", 20)];
  const merged = mergeSeedPlacements(existing, [placement("a", 33, "Edited")]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, "a");
  assert.equal(merged[1].position.x, 33);
  assert.equal(merged[0], existing[1]);
});
