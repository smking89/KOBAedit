"""Spline math and mesh extrusion for roads, rivers, rails and route paths.

The wizard edits control points in 2D (X/Z) and the engine produces:

* a resampled centreline that follows the terrain,
* a ribbon mesh (positions / normals / UVs / triangle indices) that the Three.js
  viewport uploads directly, and the Python side can export.

Curves are centripetal Catmull-Rom, which avoids the cusps and self-intersections
a uniform parameterization produces on tight road bends.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

Point3 = tuple[float, float, float]


@dataclass(slots=True)
class RibbonMesh:
    positions: list[float] = field(default_factory=list)
    normals: list[float] = field(default_factory=list)
    uvs: list[float] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)
    length: float = 0.0
    sample_count: int = 0

    @property
    def vertex_count(self) -> int:
        return len(self.positions) // 3

    def to_dict(self) -> dict[str, object]:
        return {
            "positions": self.positions,
            "normals": self.normals,
            "uvs": self.uvs,
            "indices": self.indices,
            "length": self.length,
            "sampleCount": self.sample_count,
        }


def _centripetal(p0: Point3, p1: Point3, p2: Point3, p3: Point3, t: float) -> Point3:
    def distance(a: Point3, b: Point3) -> float:
        return max(1e-4, math.dist(a, b) ** 0.5)

    t0 = 0.0
    t1 = t0 + distance(p0, p1)
    t2 = t1 + distance(p1, p2)
    t3 = t2 + distance(p2, p3)
    local = t1 + (t2 - t1) * t

    def lerp(a: Point3, b: Point3, ta: float, tb: float, at: float) -> Point3:
        weight = (at - ta) / (tb - ta)
        return tuple(a[i] + (b[i] - a[i]) * weight for i in range(3))  # type: ignore[return-value]

    a1 = lerp(p0, p1, t0, t1, local)
    a2 = lerp(p1, p2, t1, t2, local)
    a3 = lerp(p2, p3, t2, t3, local)
    b1 = lerp(a1, a2, t0, t2, local)
    b2 = lerp(a2, a3, t1, t3, local)
    return lerp(b1, b2, t1, t2, local)  # type: ignore[return-value]


def sample_catmull_rom(
    control_points: Sequence[Point3],
    samples_per_segment: int = 12,
    closed: bool = False,
) -> list[Point3]:
    """Sample a centripetal Catmull-Rom curve through ``control_points``."""
    points = [tuple(map(float, point)) for point in control_points]
    if len(points) < 2:
        return points
    if samples_per_segment < 1:
        raise ValueError("samples_per_segment must be >= 1")

    if closed:
        padded = [points[-1], *points, points[0], points[1]]
        segments = len(points)
    else:
        padded = [points[0], *points, points[-1]]
        segments = len(points) - 1

    out: list[Point3] = []
    for segment in range(segments):
        p0, p1, p2, p3 = padded[segment : segment + 4]
        steps = samples_per_segment if segment < segments - 1 else samples_per_segment + 1
        for step in range(steps):
            t = step / samples_per_segment
            out.append(_centripetal(p0, p1, p2, p3, t))
    if closed and out:
        out.pop()  # duplicate of the first point
    return out


def resample_by_spacing(points: Sequence[Point3], spacing: float) -> list[Point3]:
    """Resample a polyline to roughly uniform arc-length spacing."""
    if len(points) < 2 or spacing <= 0:
        return [tuple(map(float, p)) for p in points]
    out: list[Point3] = [tuple(map(float, points[0]))]  # type: ignore[list-item]
    distance_to_next = spacing
    for start, end in zip(points, points[1:]):
        segment = math.dist(start, end)
        if segment <= 1e-6:
            continue
        travelled = 0.0
        while segment - travelled >= distance_to_next:
            travelled += distance_to_next
            t = travelled / segment
            out.append(
                tuple(start[i] + (end[i] - start[i]) * t for i in range(3))  # type: ignore[arg-type]
            )
            distance_to_next = spacing
        distance_to_next -= segment - travelled
    last = tuple(map(float, points[-1]))
    if math.dist(out[-1], last) > spacing * 0.25:
        out.append(last)  # type: ignore[arg-type]
    return out


def polyline_length(points: Sequence[Point3]) -> float:
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def conform_to_terrain(
    points: Sequence[Point3],
    sample_height,
    offset: float = 0.0,
) -> list[Point3]:
    """Project XZ points onto the terrain surface; ``sample_height(x, z) -> metres``."""
    return [(x, sample_height(x, z) + offset, z) for x, _y, z in points]


def terrain_hugging_ribbon(
    centreline: Sequence[Point3],
    width: float,
    *,
    uv_scale: float = 1.0,
    closed: bool = False,
) -> RibbonMesh:
    """Extrude a flat ribbon along a centreline.

    Vertices are emitted left/right per sample. The normal is the surface
    up-vector tilted by the local slope so the ribbon shades like the terrain.
    """
    points = list(centreline)
    if len(points) < 2:
        raise ValueError("a ribbon needs at least two centreline points")
    if closed and points[0] != points[-1]:
        points.append(points[0])

    mesh = RibbonMesh()
    half_width = max(0.05, width) * 0.5
    distance = 0.0

    for index, point in enumerate(points):
        if index == 0:
            tangent = _normalize(_sub(points[1], points[0]))
        elif index == len(points) - 1:
            tangent = _normalize(_sub(points[-1], points[-2]))
        else:
            tangent = _normalize(_sub(points[index + 1], points[index - 1]))

        side = _normalize(_cross((0.0, 1.0, 0.0), tangent))
        if abs(side[0]) + abs(side[2]) < 1e-5:
            side = (1.0, 0.0, 0.0)

        slope = math.atan2(tangent[1], math.hypot(tangent[0], tangent[2]))
        normal = _normalize((side[0] * 0.0, math.cos(slope), 0.0))

        if index > 0:
            distance += math.dist(points[index - 1], point)

        for sign in (-1.0, 1.0):
            mesh.positions.extend(
                (
                    point[0] + side[0] * half_width * sign,
                    point[1] + side[1] * half_width * sign,
                    point[2] + side[2] * half_width * sign,
                )
            )
            mesh.normals.extend(normal)
            mesh.uvs.extend((0.0 if sign < 0 else 1.0, distance / max(1e-3, uv_scale)))

    for index in range(len(points) - 1):
        base = index * 2
        mesh.indices.extend(
            (
                base,
                base + 2,
                base + 1,
                base + 1,
                base + 2,
                base + 3,
            )
        )

    mesh.length = distance
    mesh.sample_count = len(points)
    return mesh


def smooth_path(
    control_points: Sequence[Point3],
    spacing: float = 3.0,
    closed: bool = False,
    samples_per_segment: int = 16,
) -> list[Point3]:
    """Convenience: through-points -> evenly spaced centreline."""
    if len(control_points) < 2:
        return [tuple(map(float, p)) for p in control_points]
    curve = sample_catmull_rom(control_points, samples_per_segment, closed)
    return resample_by_spacing(curve, spacing)


def _sub(a: Point3, b: Point3) -> Point3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Point3, b: Point3) -> Point3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _normalize(vector: Point3) -> Point3:
    length = math.sqrt(sum(component * component for component in vector))
    if length < 1e-9:
        return (0.0, 1.0, 0.0)
    return (vector[0] / length, vector[1] / length, vector[2] / length)


__all__ = [
    "RibbonMesh",
    "conform_to_terrain",
    "polyline_length",
    "resample_by_spacing",
    "sample_catmull_rom",
    "smooth_path",
    "terrain_hugging_ribbon",
]
