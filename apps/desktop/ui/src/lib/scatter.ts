import type { Bounds3 } from "../wizard/types";

/**
 * Smart scatter stamps.
 *
 * Placement-only scatter: it reuses the prefab library entries the editor
 * already draws (proxy geometry included), so there is no silent promise of
 * interior-aware placement. Spots are rejection-sampled against the map edge,
 * water, existing footprints and each other with a seeded RNG, so the same
 * seed always produces the same stamp.
 */

export interface ScatterSpot {
  x: number;
  z: number;
  y: number;
  rotation: number;
  scale: number;
}

export interface ScatterBlocked {
  x: number;
  z: number;
  radius: number;
}

export interface ScatterRequest {
  seed: number;
  count: number;
  centre: { x: number; z: number };
  radius: number;
  /** Minimum centre-to-centre spacing of scattered spots. */
  minSpacing: number;
  /** Max yaw jitter in degrees, applied symmetrically. */
  rotationJitter: number;
  /** Symmetric scale jitter, e.g. 0.15 → 0.85–1.15. */
  scaleJitter: number;
  mapHalf: number;
  waterLevel: number;
  heightAt: (x: number, z: number) => number;
  blocked: ScatterBlocked[];
}

/** Deterministic 32-bit RNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spacing that keeps prefab footprints from piling up. */
export function scatterSpacing(bounds: Bounds3 | null | undefined, fallback = 10): number {
  if (!bounds) return fallback;
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[2] - bounds.min[2];
  const footprint = Math.max(width, depth);
  if (!Number.isFinite(footprint) || footprint <= 0) return fallback;
  return Math.max(4, footprint * 0.5);
}

export function scatterSpots(request: ScatterRequest): ScatterSpot[] {
  const spots: ScatterSpot[] = [];
  if (request.count <= 0 || request.radius <= 0) return spots;
  const random = seededRandom(request.seed);
  const edge = Math.max(0, request.mapHalf - 4);
  const attempts = Math.max(64, request.count * 40);

  for (let attempt = 0; attempt < attempts && spots.length < request.count; attempt += 1) {
    const angle = random() * Math.PI * 2;
    // sqrt keeps the stamp even across the disc instead of clumping at the centre.
    const distance = Math.sqrt(random()) * request.radius;
    const x = request.centre.x + Math.cos(angle) * distance;
    const z = request.centre.z + Math.sin(angle) * distance;
    if (Math.abs(x) > edge || Math.abs(z) > edge) continue;
    const surface = request.heightAt(x, z);
    if (surface < request.waterLevel + 0.5) continue;
    if (
      request.blocked.some(
        (block) => Math.hypot(block.x - x, block.z - z) < block.radius + request.minSpacing * 0.5,
      )
    ) {
      continue;
    }
    if (spots.some((spot) => Math.hypot(spot.x - x, spot.z - z) < request.minSpacing)) continue;

    spots.push({
      x,
      z,
      y: surface,
      rotation: Math.round((random() * 2 - 1) * request.rotationJitter),
      scale: Number(
        (1 + (random() * 2 - 1) * Math.min(0.9, Math.max(0, request.scaleJitter))).toFixed(3),
      ),
    });
  }

  return spots;
}
