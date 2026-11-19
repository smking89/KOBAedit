import type { PrefabPlacement } from "../wizard/types";

/**
 * Monument workspaces opened from a map prefab share that prefab's id, so
 * edits made while assembling the monument can flow back to the map copy.
 * Placements with ids the map does not know are left alone, and an unchanged
 * list keeps its identity so React does not re-render for nothing.
 */
export function syncSharedPlacements(
  mapPlacements: PrefabPlacement[],
  monumentPlacements: PrefabPlacement[],
): PrefabPlacement[] {
  if (!mapPlacements.length || !monumentPlacements.length) return mapPlacements;
  const byId = new Map(monumentPlacements.map((placement) => [placement.id, placement]));
  let changed = false;
  const next = mapPlacements.map((placement) => {
    const source = byId.get(placement.id);
    if (!source) return placement;
    const same =
      source.name === placement.name &&
      source.position.x === placement.position.x &&
      source.position.y === placement.position.y &&
      source.position.z === placement.position.z &&
      source.rotationEuler.x === placement.rotationEuler.x &&
      source.rotationEuler.y === placement.rotationEuler.y &&
      source.rotationEuler.z === placement.rotationEuler.z &&
      source.scale === placement.scale;
    if (same) return placement;
    changed = true;
    return {
      ...placement,
      name: source.name,
      position: { ...source.position },
      rotationEuler: { ...source.rotationEuler },
      scale: source.scale,
    };
  });
  return changed ? next : mapPlacements;
}

/**
 * Opening a prefab in Monument mode must not throw away the monument work that
 * is already there: the clicked prefab replaces its own copy and everything
 * else is kept in place.
 */
export function mergeSeedPlacements(
  existing: PrefabPlacement[],
  seeds: PrefabPlacement[],
): PrefabPlacement[] {
  if (!seeds.length) return existing;
  const seedIds = new Set(seeds.map((seed) => seed.id));
  return [...existing.filter((placement) => !seedIds.has(placement.id)), ...seeds];
}
