import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { isTauri, loadLocalMeshBytes, localTexture } from "../lib/ipc";

/**
 * Local GLBs are parsed once per path and instantiated from a cached scene.
 * Geometry buffers and texture maps stay shared between instances, which is
 * what makes a 20-part weapon reuse GPU memory instead of duplicating every
 * part. Materials are cloned because the skin painter mutates them per subject.
 */
const scenes = new Map<string, Promise<THREE.Group | null>>();
const localTextures = new Map<string, Promise<THREE.Texture | null>>();

async function parseScene(path: string): Promise<THREE.Group | null> {
  const bytes = await loadLocalMeshBytes(path);
  if (!bytes) return null;
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, "");
  return gltf.scene;
}

function cachedScene(path: string): Promise<THREE.Group | null> {
  let pending = scenes.get(path);
  if (!pending) {
    pending = parseScene(path).catch(() => null);
    scenes.set(path, pending);
  }
  return pending;
}

/** Clone a cached local scene without duplicating geometry or image maps. */
export async function instantiateLocalScene(path: string): Promise<THREE.Group | null> {
  const source = await cachedScene(path);
  if (!source) return null;
  const clone = source.clone(true);
  clone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.userData.kobaSharedGeometry = true;
    const material = object.material as THREE.Material | THREE.Material[];
    object.material = Array.isArray(material)
      ? material.map((entry) => entry.clone())
      : material.clone();
  });
  return clone;
}

async function loadLocalTexture(name: string): Promise<THREE.Texture | null> {
  if (!isTauri() || !name) return null;
  const url = await localTexture(name);
  if (!url) return null;
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Resolve a material's texture slot from the indexed `Texture2D/` folder. The
 * data URL and decoded THREE.Texture are both cached by name, so repeated metal
 * and rubber slots do not decode the same PNG for every part.
 */
export async function attachLocalTextureByName(
  material: THREE.MeshStandardMaterial,
  name: string,
): Promise<boolean> {
  const key = name.trim();
  if (!isTauri() || material.map || !key) return false;
  let pending = localTextures.get(key);
  if (!pending) {
    pending = loadLocalTexture(key).catch(() => null);
    localTextures.set(key, pending);
  }
  const texture = await pending;
  if (!texture) return false;
  material.map = texture;
  material.needsUpdate = true;
  return true;
}

export async function attachLocalTexture(material: THREE.MeshStandardMaterial): Promise<boolean> {
  return attachLocalTextureByName(material, material.name);
}
