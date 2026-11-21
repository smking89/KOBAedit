"""Mesh metadata extraction for the asset index.

Reads only what the index and thumbnailer need, without a geometry library:

* ``.glb``  - JSON chunk + binary buffer, accessor min/max, indices, UV sets
* ``.gltf`` - JSON accessors (external buffers are not read here)
* ``.obj``  - vertex and face declarations

Node transforms in glTF are intentionally ignored: Rust base meshes are authored
at unit scale with identity transforms, and the index stores local-space bounds.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from pathlib import Path

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

COMPONENT_FLOAT = 5126
COMPONENT_UINT16 = 5123
COMPONENT_UINT32 = 5125


class MeshProbeError(ValueError):
    """Raised when a mesh file cannot be read."""


@dataclass(slots=True)
class MeshInfo:
    bounds_min: tuple[float, float, float] = (0.0, 0.0, 0.0)
    bounds_max: tuple[float, float, float] = (0.0, 0.0, 0.0)
    vertex_count: int = 0
    triangle_count: int = 0
    uv_channels: int = 1
    has_tangents: bool = False
    material_slots: list[str] = field(default_factory=list)
    positions: list[tuple[float, float, float]] = field(default_factory=list)
    triangles: list[tuple[int, int, int]] = field(default_factory=list)

    @property
    def size(self) -> tuple[float, float, float]:
        return tuple(self.bounds_max[i] - self.bounds_min[i] for i in range(3))  # type: ignore[return-value]

    def to_dict(self) -> dict[str, object]:
        return {
            "boundsMin": list(self.bounds_min),
            "boundsMax": list(self.bounds_max),
            "vertexCount": self.vertex_count,
            "triangleCount": self.triangle_count,
            "uvChannels": self.uv_channels,
            "hasTangents": self.has_tangents,
            "materialSlots": self.material_slots,
        }


def probe(path: str | Path, *, with_geometry: bool = False) -> MeshInfo:
    target = Path(path)
    suffix = target.suffix.lower()
    data = target.read_bytes()
    if suffix == ".glb":
        info = _probe_glb(data, with_geometry)
    elif suffix == ".gltf":
        info = _probe_gltf(json.loads(data.decode("utf-8")), with_geometry)
    elif suffix == ".obj":
        info = _probe_obj(data.decode("utf-8", errors="replace"), with_geometry)
    else:
        raise MeshProbeError(f"unsupported mesh format '{suffix}'")
    info.uv_channels = max(1, info.uv_channels)
    return info


def _probe_glb(data: bytes, with_geometry: bool) -> MeshInfo:
    if len(data) < 12:
        raise MeshProbeError("GLB is shorter than its header")
    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2:
        raise MeshProbeError("not a glTF 2.0 binary")
    if total > len(data):
        raise MeshProbeError("GLB length header exceeds file size")

    pos = 12
    document: dict | None = None
    binary = b""
    while pos + 8 <= len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, pos)
        pos += 8
        chunk = data[pos : pos + chunk_len]
        pos += chunk_len
        if chunk_type == CHUNK_JSON:
            document = json.loads(chunk.decode("utf-8").rstrip("\x00 "))
        elif chunk_type == CHUNK_BIN:
            binary = chunk
    if document is None:
        raise MeshProbeError("GLB has no JSON chunk")
    return _probe_gltf(document, with_geometry, binary)


def _probe_gltf(document: dict, with_geometry: bool, binary: bytes = b"") -> MeshInfo:
    info = MeshInfo()
    accessors = document.get("accessors", [])
    materials = document.get("materials", [])
    bounds_min = [float("inf")] * 3
    bounds_max = [float("-inf")] * 3
    uv_sets = 0
    index_count = 0
    vertex_count = 0

    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            attributes = primitive.get("attributes", {})
            uv_sets = max(
                uv_sets,
                1 + max(
                    (int(key.replace("TEXCOORD_", "")) for key in attributes if key.startswith("TEXCOORD_")),
                    default=-1,
                ),
            )
            info.has_tangents = info.has_tangents or "TANGENT" in attributes
            position_index = attributes.get("POSITION")
            if position_index is not None and position_index < len(accessors):
                accessor = accessors[position_index]
                vertex_count += int(accessor.get("count", 0))
                if "min" in accessor and "max" in accessor:
                    for axis in range(3):
                        bounds_min[axis] = min(bounds_min[axis], float(accessor["min"][axis]))
                        bounds_max[axis] = max(bounds_max[axis], float(accessor["max"][axis]))
                if with_geometry and binary:
                    info.positions.extend(_read_vec3_accessor(accessor, document, binary))
            indices = primitive.get("indices")
            if indices is not None and indices < len(accessors):
                index_count += int(accessors[indices].get("count", 0))
            material = primitive.get("material")
            if material is not None and material < len(materials):
                name = materials[material].get("name", f"material_{material}")
                if name not in info.material_slots:
                    info.material_slots.append(name)

    if bounds_min[0] != float("inf"):
        info.bounds_min = tuple(bounds_min)  # type: ignore[assignment]
        info.bounds_max = tuple(bounds_max)  # type: ignore[assignment]
    info.vertex_count = vertex_count
    info.triangle_count = index_count // 3
    info.uv_channels = uv_sets

    if with_geometry and not info.positions and info.vertex_count:
        # No embedded normals/positions readable: synthesise an AABB so the
        # isometric thumbnail still communicates scale.
        info.positions = _box_positions(info.bounds_min, info.bounds_max)
        info.triangles = _box_triangles()
    elif with_geometry and info.positions:
        info.triangles = _triangulate_sequential(len(info.positions))
        info.vertex_count = len(info.positions)
    return info


def _read_vec3_accessor(accessor: dict, document: dict, binary: bytes) -> list[tuple[float, float, float]]:
    if accessor.get("componentType") != COMPONENT_FLOAT or accessor.get("type") != "VEC3":
        return []
    view_index = accessor.get("bufferView")
    if view_index is None:
        return []
    views = document.get("bufferViews", [])
    if view_index >= len(views):
        return []
    view = views[view_index]
    buffer_index = view.get("buffer", 0)
    if buffer_index != 0:
        return []  # external/secondary buffers are not loaded
    stride = view.get("byteStride") or 12
    start = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    count = int(accessor.get("count", 0))
    available = max(0, (len(binary) - start) // stride)
    count = min(count, available, 200_000)
    out: list[tuple[float, float, float]] = []
    for index in range(count):
        offset = start + index * stride
        out.append(struct.unpack_from("<fff", binary, offset))
    return out


def _triangulate_sequential(count: int) -> list[tuple[int, int, int]]:
    """Fallback when indices are unavailable: fan groups of three."""
    return [(i, i + 1, i + 2) for i in range(0, count - 2, 3)]


def _box_positions(
    minimum: tuple[float, float, float], maximum: tuple[float, float, float]
) -> list[tuple[float, float, float]]:
    x0, y0, z0 = minimum
    x1, y1, z1 = maximum
    return [
        (x0, y0, z0),
        (x1, y0, z0),
        (x1, y0, z1),
        (x0, y0, z1),
        (x0, y1, z0),
        (x1, y1, z0),
        (x1, y1, z1),
        (x0, y1, z1),
    ]


def _box_triangles() -> list[tuple[int, int, int]]:
    return [
        (0, 1, 2), (0, 2, 3),  # bottom
        (4, 6, 5), (4, 7, 6),  # top
        (0, 4, 5), (0, 5, 1),  # front
        (1, 5, 6), (1, 6, 2),  # right
        (2, 6, 7), (2, 7, 3),  # back
        (3, 7, 4), (3, 4, 0),  # left
    ]


def _probe_obj(text: str, with_geometry: bool) -> MeshInfo:
    info = MeshInfo()
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    has_uv = False
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v" and len(parts) >= 4:
            vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif parts[0] == "vt":
            has_uv = True
        elif parts[0] == "f" and len(parts) >= 4:
            face: list[int] = []
            for token in parts[1:]:
                raw = token.split("/")[0]
                if raw:
                    index = int(raw)
                    face.append(index - 1 if index > 0 else len(vertices) + index)
            for offset in range(1, len(face) - 1):
                triangles.append((face[0], face[offset], face[offset + 1]))

    if vertices:
        xs, ys, zs = zip(*vertices)
        info.bounds_min = (min(xs), min(ys), min(zs))
        info.bounds_max = (max(xs), max(ys), max(zs))
    info.vertex_count = len(vertices)
    info.triangle_count = len(triangles)
    info.uv_channels = 1 if has_uv else 1
    if with_geometry:
        info.positions = vertices
        info.triangles = triangles
    return info


__all__ = ["MeshInfo", "MeshProbeError", "probe"]
