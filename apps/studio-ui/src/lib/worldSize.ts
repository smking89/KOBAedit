/**
 * World sizing rules for Rust maps.
 *
 * Rust worlds are square and the height layer is `size + 1` samples across, so
 * the map size is an exact authoring choice rather than a preset list. The
 * wizard offers the common server sizes for convenience and accepts any value
 * from `WORLD_SIZE_MIN` up; there is no upper clamp here because the only real
 * limits are the machine's memory and the export layer budget.
 *
 * Sizes snap to 50 m: Rust terrain grids divide evenly at that step, and the
 * splat/biome grid is derived from the size, so a ragged number buys nothing.
 */

export const WORLD_SIZE_MIN = 1000;
/** Slider reach. The numeric field accepts larger values. */
export const WORLD_SIZE_MAX = 16000;
export const WORLD_SIZE_STEP = 50;

/** Stock server sizes offered as one-click chips. */
export const WORLD_SIZE_PRESETS = [2000, 3500, 4250, 5000, 6000, 8000, 16000] as const;

/** Round to the nearest whole metre on the 50 m grid, never below the minimum. */
export function snapWorldSize(sizeMetres: number): number {
  if (!Number.isFinite(sizeMetres)) return WORLD_SIZE_MIN;
  const rounded = Math.round(sizeMetres / WORLD_SIZE_STEP) * WORLD_SIZE_STEP;
  return Math.max(WORLD_SIZE_MIN, rounded);
}

export interface TerrainFootprint {
  /** Height-layer samples across (`size + 1`). */
  samples: number;
  /** Splat/biome/topology grid across (next power of two at or above size / 2). */
  splatResolution: number;
  /** terrain + height + water, uint16. */
  heightMiB: number;
  /** Eight splat planes, four biome planes, int32 topology and alpha. */
  maskMiB: number;
  totalMiB: number;
}

/**
 * Bytes the exporter allocates for a map of this size.
 *
 * Mirrors `generate_terrain` in the engine: three uint16 grids on the
 * `(size + 1)²` lattice, and 17 bytes per texel on the power-of-two mask grid.
 */
export const MIB = 1024 * 1024;
/** uint16 height grids the exporter writes: terrain, height and water. */
export const HEIGHT_GRIDS = 3;
/** splat 8 + biome 4 + topology 4 + alpha 1 bytes per mask texel. */
export const MASK_BYTES_PER_TEXEL = 8 + 4 + 4 + 1;

/** Mask grid the generator allocates: next power of two at or above size / 2. */
export function splatResolutionFor(sizeMetres: number): number {
  const wanted = Math.max(1, Math.floor(Math.max(1, Math.round(sizeMetres)) * 0.5));
  let resolution = 1;
  while (resolution < wanted) resolution <<= 1;
  return resolution;
}

/** One uint16 height grid, for the imported-heightmap readout. */
export function heightmapMiB(resolution: number): number {
  return Math.round((resolution * resolution * 2) / MIB);
}

/**
 * Bytes the exporter allocates for a map of this size.
 *
 * The splat grid and byte counts come from `splatResolutionFor` and the shared
 * constants above; `engine/tests/test_terrain_footprint.py` pins the fixture to
 * `koba-engine`'s `terrain_footprint`, so the badge cannot drift from export.
 */
export function terrainFootprint(sizeMetres: number): TerrainFootprint {
  const size = Math.max(1, Math.round(sizeMetres));
  const samples = size + 1;
  const splatResolution = splatResolutionFor(size);
  const heightBytes = samples * samples * 2 * HEIGHT_GRIDS;
  const maskBytes = splatResolution * splatResolution * MASK_BYTES_PER_TEXEL;
  const toMiB = (bytes: number) => Math.round(bytes / MIB);

  return {
    samples,
    splatResolution,
    heightMiB: toMiB(heightBytes),
    maskMiB: toMiB(maskBytes),
    totalMiB: toMiB(heightBytes + maskBytes),
  };
}
