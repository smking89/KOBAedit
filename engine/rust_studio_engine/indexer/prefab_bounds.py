"""Best-effort prefab AABB extraction from Unity renderer hierarchies.

Unity prefabs do not store a single world-space bounds value. The useful data is
spread across MeshFilter/SkinnedMeshRenderer components, their meshes and the
Transform hierarchy. This module walks a prefab root and unions the transformed
mesh AABBs into prefab-local bounds.

Dependencies can be external serialized files. When a mesh is not available the
prefab is skipped instead of writing a misleading zero box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .unity_bundle import read_container

IDENTITY = (
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
)


@dataclass(frozen=True, slots=True)
class PrefabBounds:
    asset_path: str
    bounds_min: tuple[float, float, float]
    bounds_max: tuple[float, float, float]
    renderers: int


def _vec(value: Any) -> tuple[float, float, float]:
    return (float(value.x), float(value.y), float(value.z))


def _local_matrix(transform: Any) -> tuple[float, ...]:
    position = _vec(transform.m_LocalPosition)
    rotation = transform.m_LocalRotation
    scale = _vec(transform.m_LocalScale)
    x, y, z, w = (float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w))
    length = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / length, y / length, z / length, w / length

    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    return (
        (1 - 2 * (yy + zz)) * scale[0],
        (2 * (xy - wz)) * scale[0],
        (2 * (xz + wy)) * scale[0],
        position[0],
        (2 * (xy + wz)) * scale[1],
        (1 - 2 * (xx + zz)) * scale[1],
        (2 * (yz - wx)) * scale[1],
        position[1],
        (2 * (xz - wy)) * scale[2],
        (2 * (yz + wx)) * scale[2],
        (1 - 2 * (xx + yy)) * scale[2],
        position[2],
        0.0, 0.0, 0.0, 1.0,
    )


def _multiply(left: tuple[float, ...], right: tuple[float, ...]) -> tuple[float, ...]:
    return tuple(
        sum(left[row * 4 + k] * right[k * 4 + column] for k in range(4))
        for row in range(4)
        for column in range(4)
    )


def _transform_point(matrix: tuple[float, ...], point: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = point
    return (
        matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
        matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
        matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
    )


def _mesh_bounds(mesh: Any) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    aabb = getattr(mesh, "m_LocalAABB", None)
    if aabb is None:
        return None
    try:
        centre = _vec(aabb.m_Center)
        extent = _vec(aabb.m_Extent)
    except (AttributeError, TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in (*centre, *extent)):
        return None
    return (
        (centre[0] - extent[0], centre[1] - extent[1], centre[2] - extent[2]),
        (centre[0] + extent[0], centre[1] + extent[1], centre[2] + extent[2]),
    )


def _walk(
    game_object: Any,
    parent_matrix: tuple[float, ...] | None,
    *,
    visited: set[int],
    minimum: list[float],
    maximum: list[float],
) -> int:
    """Union renderer AABBs below ``game_object`` and return the renderer count."""
    marker = id(game_object)
    if marker in visited:
        return 0
    visited.add(marker)

    transform = None
    mesh_filter = None
    skinned = None
    for pair in getattr(game_object, "m_Component", []) or []:
        try:
            component = pair.component.read()
        except Exception:
            continue
        name = type(component).__name__
        if name in ("Transform", "RectTransform"):
            transform = component
        elif name == "MeshFilter":
            mesh_filter = component
        elif name == "SkinnedMeshRenderer":
            skinned = component

    world = IDENTITY
    if transform is not None:
        local = _local_matrix(transform)
        world = local if parent_matrix is None else _multiply(parent_matrix, local)

    renderers = 0
    mesh_pointer = getattr(skinned, "m_Mesh", None) if skinned is not None else None
    if mesh_pointer is None and mesh_filter is not None:
        mesh_pointer = getattr(mesh_filter, "m_Mesh", None)
    if mesh_pointer is not None:
        try:
            mesh = mesh_pointer.read()
            local = _mesh_bounds(mesh)
        except Exception:
            local = None
        if local is not None:
            low, high = local
            for x in (low[0], high[0]):
                for y in (low[1], high[1]):
                    for z in (low[2], high[2]):
                        point = _transform_point(world, (x, y, z))
                        for axis in range(3):
                            minimum[axis] = min(minimum[axis], point[axis])
                            maximum[axis] = max(maximum[axis], point[axis])
            renderers += 1

    if transform is not None:
        for child_pointer in getattr(transform, "m_Children", []) or []:
            try:
                child_transform = child_pointer.read()
                child_object = child_transform.m_GameObject.read()
            except Exception:
                continue
            renderers += _walk(
                child_object,
                world,
                visited=visited,
                minimum=minimum,
                maximum=maximum,
            )
    return renderers


def extract_prefab_bounds(
    env: Any,
    *,
    match: str | None = None,
    container: Any = None,
) -> dict[str, PrefabBounds]:
    """Return bounds for every prefab container that has readable renderers."""
    needle = match.lower() if match else None
    found: dict[str, PrefabBounds] = {}

    entries = [
        entry
        for entry in (container if container is not None else read_container(env))
        if entry.path.lower().endswith(".prefab")
        and (not needle or needle in entry.path.lower())
    ]
    wanted = {int(entry.path_id) for entry in entries}
    objects = {
        int(obj.path_id): obj for obj in env.objects if int(obj.path_id) in wanted
    }

    for entry in entries:
        root_object = objects.get(int(entry.path_id))
        if root_object is None:
            continue
        try:
            root = root_object.read()
        except Exception:
            continue

        minimum = [math.inf, math.inf, math.inf]
        maximum = [-math.inf, -math.inf, -math.inf]
        renderers = _walk(
            root,
            None,
            visited=set(),
            minimum=minimum,
            maximum=maximum,
        )
        if renderers == 0 or not all(math.isfinite(value) for value in (*minimum, *maximum)):
            continue
        if all(maximum[axis] - minimum[axis] <= 1e-6 for axis in range(3)):
            continue
        found[entry.path] = PrefabBounds(
            asset_path=entry.path,
            bounds_min=(minimum[0], minimum[1], minimum[2]),
            bounds_max=(maximum[0], maximum[1], maximum[2]),
            renderers=renderers,
        )
    return found


__all__ = ["PrefabBounds", "extract_prefab_bounds"]
