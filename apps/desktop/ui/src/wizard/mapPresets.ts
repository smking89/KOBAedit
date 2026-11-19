import type { TerrainSettings } from "./types";

/**
 * One-click terrain starters.
 *
 * Every preset is a patch applied through `patchTerrain`; `floorHeight` makes
 * the generator emit an exact elevation instead of noise, so "flat sandbox" and
 * "open ocean" are literal rather than approximate. `undefined` in a patch
 * clears a previously chosen floor.
 */
export interface TerrainStarter {
  id: string;
  title: string;
  meta: string;
  body: string;
  patch: Partial<TerrainSettings>;
}

export const MAP_STARTERS: TerrainStarter[] = [
  {
    id: "ocean",
    title: "Open Ocean",
    meta: "water world",
    body: "Whole map 55 m under the water line with a sand bed. Build islands, rigs or water bases from zero.",
    patch: {
      preset: "flat",
      floorHeight: -55,
      floorSplat: "sand",
      floorBiome: "temperate",
      waterLevel: 0,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.05,
      biomeWeights: [0.1, 0.85, 0.05, 0],
    },
  },
  {
    id: "sandbox-temperate",
    title: "Temperate Sandbox",
    meta: "flat grass",
    body: "Flat buildable grass plain above water. Every pad, spline and prefab starts from the same elevation.",
    patch: {
      preset: "flat",
      floorHeight: 24,
      floorSplat: "grass",
      floorBiome: "temperate",
      waterLevel: 0,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.5,
      biomeWeights: [0.1, 0.8, 0.1, 0],
    },
  },
  {
    id: "sandbox-arid",
    title: "Arid Sandbox",
    meta: "flat sand",
    body: "Flat desert plain above water, painted with sand and an arid biome mask.",
    patch: {
      preset: "flat",
      floorHeight: 24,
      floorSplat: "sand",
      floorBiome: "arid",
      waterLevel: 0,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.15,
      biomeWeights: [0.85, 0.1, 0.05, 0],
    },
  },
  {
    id: "sandbox-arctic",
    title: "Arctic Sandbox",
    meta: "flat snow",
    body: "Flat snowfield above water with an arctic biome mask and a cold sky.",
    patch: {
      preset: "flat",
      floorHeight: 24,
      floorSplat: "snow",
      floorBiome: "arctic",
      waterLevel: 0,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.2,
      biomeWeights: [0.05, 0.1, 0.05, 0.8],
    },
  },
  {
    id: "sandbox-jungle",
    title: "Jungle Sandbox",
    meta: "flat forest",
    body: "Flat jungle floor above water: forest splat over a temperate biome mask.",
    patch: {
      preset: "flat",
      floorHeight: 24,
      floorSplat: "forest",
      floorBiome: "temperate",
      waterLevel: 0,
      mountainScale: 0.1,
      detail: 0.15,
      treeDensity: 0.9,
      biomeWeights: [0.05, 0.85, 0.1, 0],
    },
  },
  {
    id: "procedural-island",
    title: "Procedural Island",
    meta: "generated",
    body: "The full generator: mountains, valleys and coastlines from the seed and water level.",
    patch: {
      preset: "islands",
      floorHeight: undefined,
      floorSplat: undefined,
      floorBiome: undefined,
      waterLevel: -8,
      mountainScale: 1,
      detail: 0.55,
      treeDensity: 0.7,
      biomeWeights: [0.15, 0.65, 0.15, 0.05],
    },
  },
];

/** Ground planes for monument/prefab projects: a small clean testing stage. */
export const MONUMENT_FLOORS: TerrainStarter[] = [
  {
    id: "floor-sand",
    title: "Sand",
    meta: "beach",
    body: "Beach sand with a temperate sky.",
    patch: {
      preset: "flat",
      floorHeight: 20,
      floorSplat: "sand",
      floorBiome: "arid",
      waterLevel: -40,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.1,
      biomeWeights: [0.6, 0.25, 0.1, 0.05],
    },
  },
  {
    id: "floor-grass",
    title: "Grass",
    meta: "temperate",
    body: "Grass plain with a temperate biome mask.",
    patch: {
      preset: "flat",
      floorHeight: 20,
      floorSplat: "grass",
      floorBiome: "temperate",
      waterLevel: -40,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.4,
      biomeWeights: [0.1, 0.8, 0.1, 0],
    },
  },
  {
    id: "floor-snow",
    title: "Snow",
    meta: "arctic",
    body: "Snowfield with an arctic biome mask and a pale sky.",
    patch: {
      preset: "flat",
      floorHeight: 20,
      floorSplat: "snow",
      floorBiome: "arctic",
      waterLevel: -40,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.15,
      biomeWeights: [0.05, 0.1, 0.05, 0.8],
    },
  },
  {
    id: "floor-rock",
    title: "Rock",
    meta: "cliff",
    body: "Rock and stone floor for cliffside monuments.",
    patch: {
      preset: "flat",
      floorHeight: 20,
      floorSplat: "rock",
      floorBiome: "temperate",
      waterLevel: -40,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.2,
      biomeWeights: [0.3, 0.3, 0.3, 0.1],
    },
  },
  {
    id: "floor-water",
    title: "Water",
    meta: "offshore",
    body: "Shallow water stage: the floor sits 8 m under the water line.",
    patch: {
      preset: "flat",
      floorHeight: -8,
      floorSplat: "sand",
      floorBiome: "temperate",
      waterLevel: 0,
      mountainScale: 0.1,
      detail: 0.1,
      treeDensity: 0.1,
      biomeWeights: [0.1, 0.8, 0.1, 0],
    },
  },
];

/** True when every field in `patch` already matches the terrain. */
export function matchesStarter(terrain: TerrainSettings, patch: Partial<TerrainSettings>): boolean {
  const current = terrain as unknown as Record<string, unknown>;
  const wanted = patch as unknown as Record<string, unknown>;
  return Object.keys(wanted).every((key) => {
    const value = wanted[key];
    const have = current[key];
    if (Array.isArray(value)) {
      return Array.isArray(have) && value.every((entry, index) => entry === have[index]);
    }
    return have === value;
  });
}
