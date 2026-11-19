import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

import { readAttachment } from "../src/koba/attachments.ts";

test("reads .bundle archives as project bundles", async () => {
  const archive = zipSync({
    "project.json": strToU8(JSON.stringify({ projectKind: "map" })),
    "maps/island.map": strToU8("map"),
    "prefabs/harbor.prefab": strToU8("prefab"),
  });
  const file = new File([archive], "island.bundle", { type: "application/octet-stream" });
  const attachment = await readAttachment(file);
  assert.equal(attachment.kind, "zip");
  assert.equal(attachment.zip?.entries, 3);
  assert.deepEqual(attachment.zip?.mapFiles, ["maps/island.map"]);
  assert.deepEqual(attachment.zip?.prefabFiles, ["prefabs/harbor.prefab"]);
});

test("rejects real Unity AssetBundles with an actionable message", async () => {
  const header = new Uint8Array(64);
  header.set([...new TextEncoder().encode("UnityFS\0")], 0);
  const file = new File([header], "shared.bundle", { type: "application/octet-stream" });
  await assert.rejects(readAttachment(file), /real Unity AssetBundle \(UnityFS\)/);
  await assert.rejects(readAttachment(file), /Bundles folder/);
});
