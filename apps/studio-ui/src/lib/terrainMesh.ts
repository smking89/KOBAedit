import * as THREE from "three";

import type { TerrainPreview } from "./procedural.ts";

/**
 * Terrain mesh at a given subdivision count, with every height sampled from
 * the shared preview grid.
 *
 * The grid stays at full resolution no matter which mesh LOD is shown, so a
 * coarser mesh only changes how many triangles are drawn. Heights, splat,
 * biome, topology and alpha texels are identical at every zoom level.
 */
export function buildTerrainGeometry(
  preview: TerrainPreview,
  sizeMetres: number,
  segments: number,
): THREE.BufferGeometry {
  const resolution = preview.resolution;
  const vertexCount = segments + 1;
  const positions = new Float32Array(vertexCount * vertexCount * 3);
  const uvs = new Float32Array(vertexCount * vertexCount * 2);
  const indices: number[] = [];

  for (let row = 0; row < vertexCount; row += 1) {
    for (let column = 0; column < vertexCount; column += 1) {
      const index = row * vertexCount + column;
      const u = column / segments;
      const v = row / segments;
      const worldX = u * sizeMetres - sizeMetres / 2;
      const worldZ = v * sizeMetres - sizeMetres / 2;
      const gridX = Math.min(resolution - 1, Math.round(u * (resolution - 1)));
      const gridZ = Math.min(resolution - 1, Math.round(v * (resolution - 1)));
      positions[index * 3] = worldX;
      positions[index * 3 + 1] = preview.heights[gridZ * resolution + gridX];
      positions[index * 3 + 2] = worldZ;
      uvs[index * 2] = u;
      uvs[index * 2 + 1] = v;
    }
  }

  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * vertexCount + column;
      const b = a + 1;
      const c = a + vertexCount;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
