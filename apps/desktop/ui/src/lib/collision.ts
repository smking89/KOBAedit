/**
 * Collision proxies are boxes sized by `collisionRadius` / `collisionHeight`
 * and then transformed by the placement's scale and rotation. Validation and
 * the viewport both use these helpers so the numbers a user sees and the
 * numbers the exporter checks cannot drift apart.
 */

import type { PrefabPlacement } from "../wizard/types";

export interface CollisionExtents {
  /** World-space half extent along the map X axis after yaw and scale. */
  halfX: number;
  /** World-space half extent along the map Z axis after yaw and scale. */
  halfZ: number;
  /** World-space collision height after vertical scale. */
  height: number;
  /** Conservative horizontal reach used for overlap checks. */
  reach: number;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveScale(value: number | undefined): number {
  return Math.max(0.001, Math.abs(finite(value, 1)));
}

export function collisionExtents(
  placement: Pick<
    PrefabPlacement,
    "collisionRadius" | "collisionHeight" | "scale" | "rotationEuler"
  >,
): CollisionExtents {
  const radius = Math.max(0, finite(placement.collisionRadius, 0));
  const height = Math.max(0, finite(placement.collisionHeight, 0));
  const scaleX = positiveScale(placement.scale?.x);
  const scaleY = positiveScale(placement.scale?.y);
  const scaleZ = positiveScale(placement.scale?.z);
  // Yaw is the only rotation that changes the horizontal footprint; tilt is
  // ignored so the checks stay conservative and match the wireframe proxy.
  const yaw = (finite(placement.rotationEuler?.y, 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const halfX = radius * (cos * scaleX + sin * scaleZ);
  const halfZ = radius * (sin * scaleX + cos * scaleZ);
  return {
    halfX,
    halfZ,
    height: height * scaleY,
    reach: Math.max(halfX, halfZ),
  };
}
