import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Box3, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const glb = readFileSync(new URL("./fixtures/fixture-cube.glb", import.meta.url));

test("skin fixture GLB parses into one mesh", async () => {
  const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  let meshes = 0;
  gltf.scene.traverse((node) => {
    if (node.type === "Mesh") meshes += 1;
  });
  assert.equal(meshes, 1);
  const size = new Box3().setFromObject(gltf.scene).getSize(new Vector3());
  assert.ok(Math.abs(size.x - 0.7) < 1e-4, `x size ${size.x}`);
  assert.ok(Math.abs(size.y - 0.1) < 1e-4, `y size ${size.y}`);
});
