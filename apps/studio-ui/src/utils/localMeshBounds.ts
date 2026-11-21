import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import type { Bounds3 } from "../wizard/types";

/** Compute the placement AABB for a dragged local GLB. */
export async function computeLocalMeshBounds(bytes: Uint8Array): Promise<Bounds3> {
  const copy = bytes.slice();
  const gltf = await new GLTFLoader().parseAsync(copy.buffer, "");
  const box = new THREE.Box3().setFromObject(gltf.scene);
  if (box.isEmpty()) {
    return { min: [-1, -1, -1], max: [1, 1, 1] };
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    min: [center.x - size.x / 2, center.y - size.y / 2, center.z - size.z / 2],
    max: [center.x + size.x / 2, center.y + size.y / 2, center.z + size.z / 2],
  };
}
