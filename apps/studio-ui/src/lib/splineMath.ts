import type { RouteSpline, SplineNode } from "../wizard/types";

export interface SplinePoint {
  x: number;
  y: number;
  z: number;
}

function distance(a: SplinePoint, b: SplinePoint): number {
  return Math.max(1e-4, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) ** 0.5);
}

function lerp(a: SplinePoint, b: SplinePoint, weight: number): SplinePoint {
  return {
    x: a.x + (b.x - a.x) * weight,
    y: a.y + (b.y - a.y) * weight,
    z: a.z + (b.z - a.z) * weight,
  };
}

/** Centripetal Catmull-Rom, matching the engine's Python sampler. */
function catmullPoint(
  p0: SplinePoint,
  p1: SplinePoint,
  p2: SplinePoint,
  p3: SplinePoint,
  t: number,
): SplinePoint {
  const t0 = 0;
  const t1 = t0 + distance(p0, p1);
  const t2 = t1 + distance(p1, p2);
  const t3 = t2 + distance(p2, p3);
  const local = t1 + (t2 - t1) * t;
  const a1 = lerp(p0, p1, (local - t0) / (t1 - t0));
  const a2 = lerp(p1, p2, (local - t1) / (t2 - t1));
  const a3 = lerp(p2, p3, (local - t2) / (t3 - t2));
  const b1 = lerp(a1, a2, (local - t0) / (t2 - t0));
  const b2 = lerp(a2, a3, (local - t1) / (t3 - t1));
  return lerp(b1, b2, (local - t1) / (t2 - t1));
}

function cubic(
  p0: SplinePoint,
  p1: SplinePoint,
  p2: SplinePoint,
  p3: SplinePoint,
  t: number,
): SplinePoint {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: p0.x * w0 + p1.x * w1 + p2.x * w2 + p3.x * w3,
    y: p0.y * w0 + p1.y * w1 + p2.y * w2 + p3.y * w3,
    z: p0.z * w0 + p1.z * w1 + p2.z * w2 + p3.z * w3,
  };
}

export function sampleSplineNodes(
  nodes: SplineNode[],
  closed: boolean,
  curve: RouteSpline["curve"],
  samplesPerSegment = 12,
): SplinePoint[] {
  const points: SplinePoint[] = nodes.map((node) => ({ x: node.x, y: node.y, z: node.z }));
  if (points.length < 2) return points;
  const count = points.length;
  const at = (index: number): SplinePoint => {
    if (closed) return points[((index % count) + count) % count];
    return points[Math.max(0, Math.min(count - 1, index))];
  };
  const segments = closed ? count : count - 1;
  const samples: SplinePoint[] = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const p0 = at(segment - 1);
    const p1 = at(segment);
    const p2 = at(segment + 1);
    const p3 = at(segment + 2);
    for (let step = 0; step < samplesPerSegment; step += 1) {
      const t = step / samplesPerSegment;
      if (curve === "bezier") {
        const c1 = {
          x: p1.x + (p2.x - p0.x) / 6,
          y: p1.y + (p2.y - p0.y) / 6,
          z: p1.z + (p2.z - p0.z) / 6,
        };
        const c2 = {
          x: p2.x - (p3.x - p1.x) / 6,
          y: p2.y - (p3.y - p1.y) / 6,
          z: p2.z - (p3.z - p1.z) / 6,
        };
        samples.push(cubic(p1, c1, c2, p2, t));
      } else {
        samples.push(catmullPoint(p0, p1, p2, p3, t));
      }
    }
  }
  samples.push(at(closed ? 0 : count - 1));
  return samples;
}

/**
 * Nearest point *on* a polyline, not just its vertices. Connectors use this so
 * a road that runs straight past a prefab is joined where it passes, not at
 * whichever node happens to sit closest.
 */
export function closestPointOnPolyline(
  points: SplinePoint[],
  x: number,
  z: number,
): (SplinePoint & { distance: number }) | null {
  if (!points.length) return null;
  if (points.length === 1) {
    return { ...points[0], distance: Math.hypot(points[0].x - x, points[0].z - z) };
  }
  let best: (SplinePoint & { distance: number }) | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const distance = Math.hypot(px - x, pz - z);
    if (!best || distance < best.distance) {
      best = { x: px, y: a.y + (b.y - a.y) * t, z: pz, distance };
    }
  }
  return best;
}

export interface RouteShape {
  nodes: SplineNode[];
  closed: boolean;
  curve: RouteSpline["curve"];
}

/**
 * Where a prefab connector should join the road network: the nearest point on
 * any road, or the closest map edge when there is no road yet. `null` means
 * the prefab already touches a road and a stub would be pointless.
 */
export function connectorTarget(
  roads: RouteShape[],
  position: { x: number; z: number },
  clearance: number,
  inset: number,
): { x: number; z: number } | null {
  let best: { x: number; z: number; distance: number } | null = null;
  for (const road of roads) {
    const nearest = closestPointOnPolyline(
      sampleSplineNodes(road.nodes, road.closed, road.curve, 24),
      position.x,
      position.z,
    );
    if (nearest && (!best || nearest.distance < best.distance)) {
      best = { x: nearest.x, z: nearest.z, distance: nearest.distance };
    }
  }
  if (best) {
    return best.distance <= clearance ? null : { x: best.x, z: best.z };
  }
  const edges = [
    { x: -inset, z: position.z },
    { x: inset, z: position.z },
    { x: position.x, z: -inset },
    { x: position.x, z: inset },
  ];
  return edges.reduce((closest, candidate) =>
    Math.hypot(candidate.x - position.x, candidate.z - position.z) <
    Math.hypot(closest.x - position.x, closest.z - position.z)
      ? candidate
      : closest,
  );
}

export function splineLength(points: SplinePoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
      points[index].z - points[index - 1].z,
    );
  }
  return total;
}
