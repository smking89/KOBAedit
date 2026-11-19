"""Prefab AABB extraction from Unity renderer and collider hierarchies.

Unity prefabs do not store a single world-space bounds value. The useful data is
spread across MeshFilter/SkinnedMeshRenderer components, colliders, LODGroups,
their meshes and the Transform hierarchy. This module walks a prefab root and
unions transformed geometry into prefab-local bounds.

Rust item prefabs (``*.item.prefab``) are item definitions; their visual entity
lives in a separate prefab. ``extract_game_manifest_bounds`` resolves the real
prefab paths from the bundle's ``GameManifest`` and
``extract_item_prefab_bounds_from_links`` maps those bounds back to the item
rows. Missing geometry is skipped instead of writing a misleading zero box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from .unity_bundle import read_container

IDENTITY = (
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
)

COLLIDER_TYPES = {"BoxCollider", "SphereCollider", "CapsuleCollider", "MeshCollider"}


@dataclass(frozen=True, slots=True)
class PrefabBounds:
    asset_path: str
    bounds_min: tuple[float, float, float]
    bounds_max: tuple[float, float, float]
    renderers: int
    colliders: int = 0
    lod_groups: int = 0

    @property
    def source(self) -> str:
        parts: list[str] = []
        if self.renderers:
            parts.append(f"renderers:{self.renderers}")
        if self.colliders:
            parts.append(f"colliders:{self.colliders}")
        if self.lod_groups:
            parts.append(f"lod:{self.lod_groups}")
        return "+".join(parts) or "geometry"

    @property
    def volume(self) -> float:
        return max(0.0, self.bounds_max[0] - self.bounds_min[0]) * max(
            0.0, self.bounds_max[1] - self.bounds_min[1]
        ) * max(0.0, self.bounds_max[2] - self.bounds_min[2])


@dataclass
class _BoundsAccumulator:
    minimum: list[float] = field(default_factory=lambda: [math.inf, math.inf, math.inf])
    maximum: list[float] = field(default_factory=lambda: [-math.inf, -math.inf, -math.inf])

    def add_point(self, point: tuple[float, float, float]) -> None:
        for axis in range(3):
            self.minimum[axis] = min(self.minimum[axis], point[axis])
            self.maximum[axis] = max(self.maximum[axis], point[axis])

    def add_box(
        self,
        low: tuple[float, float, float],
        high: tuple[float, float, float],
        matrix: tuple[float, ...],
    ) -> None:
        for x in (low[0], high[0]):
            for y in (low[1], high[1]):
                for z in (low[2], high[2]):
                    self.add_point(_transform_point(matrix, (x, y, z)))

    def valid(self) -> bool:
        return all(math.isfinite(value) for value in (*self.minimum, *self.maximum))


@dataclass
class _Counts:
    renderers: int = 0
    colliders: int = 0
    lod_groups: int = 0


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


def _object_source_file(obj: Any) -> str:
    assets_file = getattr(obj, "assets_file", None)
    name = getattr(assets_file, "name", "") if assets_file is not None else ""
    return str(name or "")


def build_mesh_index(env: Any) -> dict[tuple[str | None, int], Any]:
    """Index meshes by source file and path id for cross-bundle PPtrs."""
    index: dict[tuple[str | None, int], Any] = {}
    for obj in getattr(env, "objects", []):
        if getattr(getattr(obj, "type", None), "name", None) != "Mesh":
            continue
        try:
            path_id = int(obj.path_id)
        except (TypeError, ValueError):
            continue
        index[(None, path_id)] = obj
        source = _object_source_file(obj).casefold()
        if source:
            index[(source, path_id)] = obj
    return index


def _pointer_cab(pointer: Any) -> str | None:
    assets_file = getattr(pointer, "assets_file", None) or getattr(pointer, "assetsfile", None)
    if assets_file is None:
        return None
    try:
        file_id = int(getattr(pointer, "m_FileID", getattr(pointer, "file_id", 0)))
    except (TypeError, ValueError):
        file_id = 0
    if file_id <= 0:
        return None
    externals = getattr(assets_file, "externals", None) or []
    if file_id > len(externals):
        return None
    external = externals[file_id - 1]
    path = getattr(external, "path", None) or getattr(external, "name", None)
    return Path(str(path)).name.casefold() if path else None


def _resolve_mesh(pointer: Any, mesh_index: Mapping[tuple[str | None, int], Any] | None) -> Any | None:
    try:
        return pointer.read()
    except Exception:
        pass
    if mesh_index is None:
        return None
    try:
        path_id = int(getattr(pointer, "m_PathID", getattr(pointer, "path_id", 0)))
    except (TypeError, ValueError):
        return None
    cab = _pointer_cab(pointer)
    if cab is not None:
        found = mesh_index.get((cab, path_id))
        if found is not None:
            return found
    return mesh_index.get((None, path_id))


def _collider_box(collider: Any) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    name = type(collider).__name__
    if getattr(collider, "m_Enabled", True) is False:
        return None

    if name == "MeshCollider":
        pointer = getattr(collider, "m_Mesh", None)
        if pointer is None:
            return None
        try:
            mesh = pointer.read()
        except Exception:
            return None
        return _mesh_bounds(mesh)

    try:
        centre = _vec(getattr(collider, "m_Center"))
    except (AttributeError, TypeError, ValueError):
        return None

    if name == "BoxCollider":
        try:
            size = _vec(collider.m_Size)
        except (AttributeError, TypeError, ValueError):
            return None
        return (
            (centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2),
            (centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2),
        )

    if name == "SphereCollider":
        radius = float(getattr(collider, "m_Radius", 0.0))
        return (
            (centre[0] - radius, centre[1] - radius, centre[2] - radius),
            (centre[0] + radius, centre[1] + radius, centre[2] + radius),
        )

    if name == "CapsuleCollider":
        radius = float(getattr(collider, "m_Radius", 0.0))
        height = float(getattr(collider, "m_Height", 0.0)) / 2
        direction = int(getattr(collider, "m_Direction", 1))
        extents = [radius, radius, radius]
        extents[direction if direction in (0, 1, 2) else 1] = max(radius, height)
        return (
            (centre[0] - extents[0], centre[1] - extents[1], centre[2] - extents[2]),
            (centre[0] + extents[0], centre[1] + extents[1], centre[2] + extents[2]),
        )
    return None


def _lod_box(lod_group: Any) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    try:
        centre = _vec(lod_group.m_LocalReferencePoint)
        size = float(lod_group.m_Size)
    except (AttributeError, TypeError, ValueError):
        return None
    if not math.isfinite(size) or size <= 0:
        return None
    half = size / 2
    return (
        (centre[0] - half, centre[1] - half, centre[2] - half),
        (centre[0] + half, centre[1] + half, centre[2] + half),
    )


def _walk(
    game_object: Any,
    parent_matrix: tuple[float, ...] | None,
    *,
    visited: set[int],
    mesh_index: Mapping[tuple[str | None, int], Any] | None,
    render_bounds: _BoundsAccumulator,
    collider_bounds: _BoundsAccumulator,
    lod_bounds: _BoundsAccumulator,
    counts: _Counts,
    apply_root_transform: bool,
) -> None:
    """Union renderer, collider and LOD geometry below ``game_object``."""
    marker = id(game_object)
    if marker in visited:
        return
    visited.add(marker)

    transform = None
    mesh_filter = None
    skinned = None
    colliders: list[Any] = []
    lod_group = None
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
        elif name in COLLIDER_TYPES:
            colliders.append(component)
        elif name == "LODGroup":
            lod_group = component

    world = IDENTITY
    if transform is not None:
        local = _local_matrix(transform)
        if parent_matrix is None:
            world = local if apply_root_transform else IDENTITY
        else:
            world = _multiply(parent_matrix, local)

    mesh_pointer = getattr(skinned, "m_Mesh", None) if skinned is not None else None
    if mesh_pointer is None and mesh_filter is not None:
        mesh_pointer = getattr(mesh_filter, "m_Mesh", None)
    if mesh_pointer is not None:
        mesh = _resolve_mesh(mesh_pointer, mesh_index)
        local = _mesh_bounds(mesh) if mesh is not None else None
        if local is not None:
            render_bounds.add_box(local[0], local[1], world)
            counts.renderers += 1

    for collider in colliders:
        local = _collider_box(collider)
        if local is not None:
            collider_bounds.add_box(local[0], local[1], world)
            counts.colliders += 1

    if lod_group is not None:
        local = _lod_box(lod_group)
        if local is not None:
            lod_bounds.add_box(local[0], local[1], world)
            counts.lod_groups += 1

    if transform is not None:
        for child_pointer in getattr(transform, "m_Children", []) or []:
            try:
                child_transform = child_pointer.read()
                child_object = child_transform.m_GameObject.read()
            except Exception:
                continue
            _walk(
                child_object,
                world,
                visited=visited,
                mesh_index=mesh_index,
                render_bounds=render_bounds,
                collider_bounds=collider_bounds,
                lod_bounds=lod_bounds,
                counts=counts,
                apply_root_transform=apply_root_transform,
            )


@dataclass(frozen=True, slots=True)
class MeshInstance:
    mesh: Any
    matrix: tuple[float, ...]
    materials: tuple[Any, ...] = ()


def collect_mesh_instances(
    root: Any,
    *,
    mesh_index: Mapping[tuple[str | None, int], Any] | None = None,
    apply_root_transform: bool = False,
) -> list[MeshInstance]:
    """Collect renderable mesh instances with their prefab-local transforms."""
    instances: list[MeshInstance] = []

    def walk(
        game_object: Any,
        parent_matrix: tuple[float, ...] | None,
        depth: int = 0,
    ) -> None:
        if depth > 96:
            return
        transform = None
        mesh_filter = None
        skinned = None
        renderer = None
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
                renderer = component
            elif name == "MeshRenderer":
                renderer = component

        world = IDENTITY
        if transform is not None:
            local = _local_matrix(transform)
            if parent_matrix is None:
                world = local if apply_root_transform else IDENTITY
            else:
                world = _multiply(parent_matrix, local)

        object_name = str(getattr(game_object, "m_Name", "") or "")
        lowered = object_name.casefold()
        skip = any(
            token in lowered
            for token in ("_lod1", "_lod2", "_lod3", "_lod4", "collision", "_col")
        )
        if not skip:
            pointer = getattr(skinned, "m_Mesh", None) if skinned is not None else None
            if pointer is None and mesh_filter is not None:
                pointer = getattr(mesh_filter, "m_Mesh", None)
            if pointer is not None:
                mesh = _resolve_mesh(pointer, mesh_index)
                if mesh is not None:
                    materials = tuple(getattr(renderer, "m_Materials", ()) or ()) if renderer else ()
                    instances.append(
                        MeshInstance(mesh=mesh, matrix=world, materials=materials)
                    )

        if transform is not None:
            for child_pointer in getattr(transform, "m_Children", []) or []:
                try:
                    child = child_pointer.read().m_GameObject.read()
                except Exception:
                    continue
                walk(child, world, depth + 1)

    walk(root, None)
    return instances


def _bounds_from_walk(
    root: Any,
    *,
    asset_path: str,
    mesh_index: Mapping[tuple[str | None, int], Any] | None = None,
    apply_root_transform: bool = True,
) -> PrefabBounds | None:
    render_bounds = _BoundsAccumulator()
    collider_bounds = _BoundsAccumulator()
    lod_bounds = _BoundsAccumulator()
    counts = _Counts()
    _walk(
        root,
        None,
        visited=set(),
        mesh_index=mesh_index,
        render_bounds=render_bounds,
        collider_bounds=collider_bounds,
        lod_bounds=lod_bounds,
        counts=counts,
        apply_root_transform=apply_root_transform,
    )

    chosen = None
    if counts.renderers and render_bounds.valid():
        chosen = render_bounds
    elif counts.colliders and collider_bounds.valid():
        chosen = collider_bounds
    elif counts.lod_groups and lod_bounds.valid():
        chosen = lod_bounds
    if chosen is None:
        return None
    if all(chosen.maximum[axis] - chosen.minimum[axis] <= 1e-6 for axis in range(3)):
        return None
    return PrefabBounds(
        asset_path=asset_path,
        bounds_min=(chosen.minimum[0], chosen.minimum[1], chosen.minimum[2]),
        bounds_max=(chosen.maximum[0], chosen.maximum[1], chosen.maximum[2]),
        renderers=counts.renderers,
        colliders=counts.colliders,
        lod_groups=counts.lod_groups,
    )


def extract_prefab_bounds(
    env: Any,
    *,
    match: str | None = None,
    container: Any = None,
    mesh_index: Mapping[tuple[str | None, int], Any] | None = None,
) -> dict[str, PrefabBounds]:
    """Return bounds for every prefab container that has readable geometry."""
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
        bounds = _bounds_from_walk(root, asset_path=entry.path, mesh_index=mesh_index)
        if bounds is not None:
            found[entry.path] = bounds
    return found


def _object_type(obj: Any) -> str | None:
    return getattr(getattr(obj, "type", None), "name", None)


def _object_name(obj: Any) -> str:
    try:
        peek = getattr(obj, "peek_name", None)
        if callable(peek):
            name = peek()
            if name:
                return str(name)
    except Exception:
        pass
    try:
        return str(getattr(obj.read(), "m_Name", "") or "")
    except Exception:
        return ""


def extract_named_bounds(
    env: Any,
    names: Iterable[str],
    *,
    mesh_index: Mapping[tuple[str | None, int], Any] | None = None,
) -> dict[str, PrefabBounds]:
    """Find GameObject roots by exact name and return their real bounds.

    Names are matched case-insensitively. If several roots share a name, the
    root with the most renderers (then colliders, then volume) wins.
    """
    wanted = {str(name).casefold(): str(name) for name in names if name}
    if not wanted:
        return {}
    best: dict[str, PrefabBounds] = {}
    for obj in getattr(env, "objects", []):
        object_type = _object_type(obj)
        if object_type is not None and object_type != "GameObject":
            continue
        name = _object_name(obj)
        key = name.casefold()
        if key not in wanted:
            continue
        try:
            root = obj.read()
        except Exception:
            continue
        # Manifest roots can be scene-placed instances. Skip the root transform
        # so bounds stay prefab-local instead of inheriting map coordinates.
        bounds = _bounds_from_walk(
            root,
            asset_path=wanted[key],
            mesh_index=mesh_index,
            apply_root_transform=False,
        )
        if bounds is None:
            continue
        current = best.get(key)
        if current is None or (
            bounds.renderers,
            bounds.colliders,
            bounds.lod_groups,
            bounds.volume,
        ) > (
            current.renderers,
            current.colliders,
            current.lod_groups,
            current.volume,
        ):
            best[key] = bounds
    return best


def read_game_manifest_paths(env: Any) -> dict[str, str]:
    """Return ``prefab path -> guid`` from the bundle's GameManifest, if any."""
    for obj in getattr(env, "objects", []):
        if _object_type(obj) != "MonoBehaviour":
            continue
        if _object_name(obj).casefold() != "manifest":
            continue
        try:
            script = obj.read().m_Script.read()
            if getattr(script, "m_ClassName", "") != "GameManifest":
                continue
            manifest = obj.read()
        except Exception:
            continue
        paths: dict[str, str] = {}
        for prop in getattr(manifest, "prefabProperties", None) or []:
            name = getattr(prop, "name", None)
            guid = getattr(prop, "guid", None)
            if name:
                paths[str(name)] = str(guid or "")
        return paths
    return {}


def extract_game_manifest_bounds(
    env: Any,
    *,
    mesh_index: Mapping[tuple[str | None, int], Any] | None = None,
) -> dict[str, PrefabBounds]:
    """Resolve bounds for every real prefab path listed in the GameManifest."""
    paths = [path for path in read_game_manifest_paths(env) if path.lower().endswith(".prefab")]
    if not paths:
        return {}
    by_name = {Path(path).stem: path for path in paths}
    found_by_name = extract_named_bounds(env, by_name, mesh_index=mesh_index)
    return {
        by_name[key]: bounds
        for key, bounds in found_by_name.items()
        if key in by_name
    }


def item_prefab_candidates(item_path: str) -> list[str]:
    """Actual prefab paths an item definition can point at, most specific first."""
    lowered = item_path.lower()
    if not lowered.endswith(".item.prefab"):
        return []
    base = item_path[: -len(".item.prefab")]
    return [
        f"{base}.prefab",
        f"{base}.entity.prefab",
        f"{base}.worldmodel.prefab",
        f"{base}_deployed.prefab",
    ]


def extract_item_prefab_bounds_from_links(
    item_paths: Iterable[str],
    bounds_by_path: Mapping[str, PrefabBounds],
) -> dict[str, PrefabBounds]:
    """Map real prefab bounds onto item-definition rows.

    Rust item prefabs are definitions without visual geometry. The actual model
    is a sibling/world prefab; use it only when the bundle manifest resolved a
    real AABB for that exact prefab path.
    """
    folded = {str(path).casefold(): bounds for path, bounds in bounds_by_path.items()}
    found: dict[str, PrefabBounds] = {}
    for item_path in item_paths:
        for candidate in item_prefab_candidates(item_path):
            bounds = folded.get(candidate.casefold())
            if bounds is None:
                continue
            found[item_path] = PrefabBounds(
                asset_path=item_path,
                bounds_min=bounds.bounds_min,
                bounds_max=bounds.bounds_max,
                renderers=bounds.renderers,
                colliders=bounds.colliders,
                lod_groups=bounds.lod_groups,
            )
            break
    return found


__all__ = [
    "MeshInstance",
    "PrefabBounds",
    "build_mesh_index",
    "collect_mesh_instances",
    "extract_game_manifest_bounds",
    "extract_item_prefab_bounds_from_links",
    "extract_named_bounds",
    "extract_prefab_bounds",
    "item_prefab_candidates",
    "read_game_manifest_paths",
]
