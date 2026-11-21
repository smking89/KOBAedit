/**
 * Shared draft factories.
 *
 * The reducer, the prompt command registry and any future importer all build
 * placements and splines here, so defaults (flatten radius, collision, cave
 * elevation, spline width) live in exactly one place.
 */

import type {
  Bounds3,
  PrefabAsset,
  PrefabPlacement,
  RouteSpline,
  SplineKind,
} from "../wizard/types";

function uid(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

export function collisionFromBounds(bounds: Bounds3 | null | undefined): {
  radius: number;
  height: number;
} {
  if (!bounds) return { radius: 12, height: 8 };
  const width = Math.abs(bounds.max[0] - bounds.min[0]);
  const depth = Math.abs(bounds.max[2] - bounds.min[2]);
  const height = Math.abs(bounds.max[1] - bounds.min[1]);
  return {
    radius:
      Number.isFinite(width) && Number.isFinite(depth)
        ? Math.max(2, Math.round(Math.max(width, depth) / 2))
        : 12,
    height: Number.isFinite(height) ? Math.max(2, Math.round(height)) : 8,
  };
}

export function flattenRadiusFromBounds(
  bounds: Bounds3 | null | undefined,
  fallback = 40,
): number {
  if (!bounds) return fallback;
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[2] - bounds.min[2];
  const footprint = Math.max(width, depth);
  if (!Number.isFinite(footprint) || footprint <= 0) return fallback;
  return Math.max(8, Math.round(footprint * 0.55 + 4));
}

export function createPlacement(
  asset: PrefabAsset,
  index = 0,
  at?: { x: number; z: number },
): PrefabPlacement {
  const angle = (index % 8) * (Math.PI / 4);
  const radius = Math.min(400, 90 + index * 18);
  const collision = collisionFromBounds(asset.bounds);
  return {
    id: uid("prefab"),
    assetId: asset.id,
    name: asset.name,
    // Dropping on the terrain supplies the world position; the spiral is only a
    // fallback for adding from a list button.
    position: at
      ? { x: Math.round(at.x), y: 0, z: Math.round(at.z) }
      : {
          x: Math.round(Math.cos(angle) * radius),
          y: 0,
          z: Math.round(Math.sin(angle) * radius),
        },
    rotationEuler: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    parentId: null,
    collisionRadius: collision.radius,
    collisionHeight: collision.height,
    flatten: true,
    flattenRadius: asset.flattenRadius || flattenRadiusFromBounds(asset.bounds),
    flattenFalloff: 18,
    clearFoliage: true,
    noBuildZone: true,
    lootTier: 2,
    lootProfile: "",
    ioWiring: "",
    npcCount: 0,
    locked: false,
  };
}

export function createSpline(kind: SplineKind, index: number): RouteSpline {
  const names: Record<SplineKind, string> = {
    road: "Road",
    river: "River",
    rail: "Rail",
    apc: "APC Route",
    cargo: "Cargo Route",
    chinook: "Chinook Route",
    powerline: "Powerline",
    cave: "Cave Tunnel",
  };
  const offset = index * 120;
  const cave = kind === "cave";
  return {
    id: uid("spline"),
    name: `${names[kind]} ${index}`,
    kind,
    width: cave ? 4.5 : kind === "river" ? 22 : kind === "road" ? 9 : 6,
    closed: false,
    autoRoute: !cave,
    curve: "catmull-rom",
    tension: 0.5,
    deformTerrain: kind === "road" || kind === "river",
    paintSplat: !cave,
    topologyFlag: kind === "road" || kind === "rail" ? "path_clear" : null,
    ceilingHeight: cave ? 4 : undefined,
    roughness: cave ? 0.35 : undefined,
    cavePreset: cave ? "natural" : undefined,
    // Cave nodes carry an absolute tunnel elevation, so the default path dips
    // under the surface and rises into a portal at the far end.
    nodes: cave
      ? [
          { x: -700 + offset, y: -4, z: -500 },
          { x: -200 + offset, y: -12, z: 0 },
          { x: 400 + offset, y: -9, z: 480 },
          { x: 880, y: 3, z: 880 },
        ]
      : [
          { x: -900 + offset, y: 0, z: -600 },
          { x: -300 + offset, y: 0, z: 0 },
          { x: 500 + offset, y: 0, z: 450 },
          { x: 950, y: 0, z: 900 },
        ],
  };
}
