import { collisionExtents } from "./collision";
import type { PrefabPlacement } from "../wizard/types";

/**
 * Walk-mode validation helpers.
 *
 * The editor has no real collision geometry for prefabs — only the collision
 * proxy boxes it already draws — so the checks here are explicit about that:
 * jump prediction uses Rust's jump numbers, and capsule collisions are tested
 * against the same proxy boxes the viewport renders.
 */

export const JUMP_VELOCITY = 8.12;
export const WALK_GRAVITY = 22;
export const CAPSULE_RADIUS = 0.45;
export const CAPSULE_HEIGHT = 1.8;
export const CROUCH_CAPSULE_HEIGHT = 0.9;

export interface JumpArcPoint {
  x: number;
  y: number;
  z: number;
  t: number;
}

/** Apex of the jump arc in metres: v² / (2g) ≈ 1.50 m for 8.12 m/s. */
export function jumpApex(velocity = JUMP_VELOCITY, gravity = WALK_GRAVITY): number {
  return (velocity * velocity) / (2 * gravity);
}

/** Seconds from take-off to landing on level ground: 2v / g. */
export function jumpDuration(velocity = JUMP_VELOCITY, gravity = WALK_GRAVITY): number {
  return (2 * velocity) / gravity;
}

/**
 * Predicted parabola from the current walk position. `velocityX/Z` is the
 * walker's planar movement, so a running jump lands farther than a standing
 * one; `groundAt` clips the trace where it would enter the terrain.
 */
export function jumpArc(
  start: { x: number; y: number; z: number },
  velocityX: number,
  velocityZ: number,
  groundAt: (x: number, z: number) => number,
  steps = 24,
  velocityY = JUMP_VELOCITY,
  gravity = WALK_GRAVITY,
): JumpArcPoint[] {
  const points: JumpArcPoint[] = [];
  const duration = jumpDuration(velocityY, gravity);
  for (let index = 0; index <= steps; index += 1) {
    const t = (duration * index) / steps;
    const x = start.x + velocityX * t;
    const z = start.z + velocityZ * t;
    const y = start.y + velocityY * t - 0.5 * gravity * t * t;
    points.push({ x, y, z, t });
    if (index > 0 && y <= groundAt(x, z)) break;
  }
  return points;
}

export interface CapsuleCheck {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

export interface CapsuleHit {
  placementId: string;
  name: string;
  /** Horizontal distance from the capsule axis to the proxy box, metres. */
  gap: number;
}

/**
 * Capsule vs collision-proxy boxes. A capsule is a vertical cylinder, so the
 * test is horizontal box expansion plus a vertical interval overlap.
 */
export function capsuleHits(
  capsule: CapsuleCheck,
  placements: Pick<
    PrefabPlacement,
    "id" | "name" | "position" | "collisionRadius" | "collisionHeight" | "scale" | "rotationEuler"
  >[],
): CapsuleHit[] {
  const hits: CapsuleHit[] = [];
  const capsuleTop = capsule.y + capsule.height;
  for (const placement of placements) {
    const extents = collisionExtents(placement);
    if (extents.halfX <= 0 || extents.halfZ <= 0 || extents.height <= 0) continue;
    const bottom = placement.position.y;
    const top = bottom + extents.height;
    if (capsuleTop <= bottom || capsule.y >= top) continue;
    const dx = Math.max(0, Math.abs(capsule.x - placement.position.x) - extents.halfX);
    const dz = Math.max(0, Math.abs(capsule.z - placement.position.z) - extents.halfZ);
    const gap = Math.hypot(dx, dz);
    if (gap > capsule.radius) continue;
    hits.push({ placementId: placement.id, name: placement.name, gap });
  }
  return hits.sort((a, b) => a.gap - b.gap);
}
