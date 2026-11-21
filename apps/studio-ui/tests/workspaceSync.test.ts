import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeSeedPlacements,
  syncSharedPlacements,
  workspaceGridsForIndexedDb,
} from "../src/lib/workspaceSync.ts";
import type {
  PrefabPlacement,
  TerrainHeightImport,
  TerrainMaskImport,
} from "../src/wizard/types.ts";

const NATIVE_HEIGHTMAP: TerrainHeightImport = {
  name: "height.raw",
  resolution: 2049,
  encoding: "raw16",
  data: "AAAA",
  minHeight: -500,
  maxHeight: 500,
  verticalScale: 1,
};

const NATIVE_MASK: TerrainMaskImport = {
  id: "mask-0",
  name: "splat.png",
  kind: "splat",
  channel: 0,
  resolution: 4097,
  data: "AAAA",
};

function placement(id: string, x: number, name = `Prefab ${id}`): PrefabPlacement {
  return {
    id,
    assetId: `assets/${id}.prefab`,
    name,
    position: { x, y: 0, z: 0 },
    rotationEuler: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    parentId: null,
    collisionRadius: 10,
    collisionHeight: 6,
    flatten: true,
    flattenRadius: 20,
    flattenFalloff: 8,
    clearFoliage: true,
    noBuildZone: true,
    lootTier: 2,
    lootProfile: "",
    ioWiring: "",
    npcCount: 0,
    locked: false,
  };
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

test("non-uniform scale edits reach the map copy without aliasing", () => {
  const map = [placement("a", 10)];
  const monument = [
    {
      ...placement("a", 10),
      scale: { x: 2, y: 1, z: 1 },
    },
  ];
  const synced = syncSharedPlacements(map, monument);
  assert.notEqual(synced, map);
  assert.deepEqual(synced[0].scale, { x: 2, y: 1, z: 1 });
  assert.notEqual(synced[0].scale, monument[0].scale);
});

test("unchanged placements keep array identity", () => {
  const map = [placement("a", 10)];
  assert.equal(syncSharedPlacements(map, [placement("a", 10)]), map);
});

test("a browser workspace switch flushes imported grids to IndexedDB", () => {
  const grids = workspaceGridsForIndexedDb(
    { heightmap: NATIVE_HEIGHTMAP, masks: [NATIVE_MASK] },
    false,
  );
  assert.equal(grids?.heightmap, NATIVE_HEIGHTMAP);
  assert.deepEqual(grids?.masks, [NATIVE_MASK]);
});

test("a desktop workspace switch never touches IndexedDB", () => {
  assert.equal(
    workspaceGridsForIndexedDb({ heightmap: NATIVE_HEIGHTMAP, masks: [NATIVE_MASK] }, true),
    null,
  );
});

test("a workspace switch without grids skips the grid store", () => {
  assert.equal(workspaceGridsForIndexedDb({ heightmap: undefined, masks: [] }, false), null);
});

test("re-opening a prefab in Monument keeps the existing monument work", () => {
  const existing = [placement("a", 10), placement("b", 20)];
  const merged = mergeSeedPlacements(existing, [placement("a", 33, "Edited")]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, "a");
  assert.equal(merged[1].position.x, 33);
  assert.equal(merged[0], existing[1]);
});
