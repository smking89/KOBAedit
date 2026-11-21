import type { BaseMeshAsset } from "../lib/demoAssets";

export interface MeshGroup {
  key: string;
  name: string;
  parts: BaseMeshAsset[];
}

/**
 * Collapse explicit multi-part exports (`ak47u_part01.glb`, `ak47u_part02.glb`)
 * into one parent entry while keeping every part selectable when expanded.
 */
export function groupMeshAssets(meshes: BaseMeshAsset[]): MeshGroup[] {
  const groups = new Map<string, MeshGroup>();
  for (const mesh of meshes) {
    const match = mesh.name.match(/^(.*?)[._-](?:part|piece)[._-]?(\d{1,3})$/i);
    const base = match?.[1]?.replace(/[._-]+$/, "") ?? mesh.name;
    const key = match ? base.toLowerCase() : mesh.id;
    const name = match ? base : mesh.name;
    const current = groups.get(key);
    if (current) current.parts.push(mesh);
    else groups.set(key, { key, name, parts: [mesh] });
  }
  return [...groups.values()];
}
