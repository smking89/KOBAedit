"""Data model for Rust WorldSerialization documents.

A ``.map`` and a ``.prefab`` share one container: a version/timestamp header
followed by an LZ4 legacy stream containing protobuf ``WorldData``.

``WorldData`` (as used by the live game, serialization version 9/10)::

    message WorldData {
      uint32                  size    = 1;   // terrain size, metres
      repeated MapData        maps    = 2;   // terrain + RustEdit extras
      repeated PrefabData     prefabs = 3;
      repeated PathData       paths   = 4;
    }
    message MapData    { string name = 1; bytes data = 2; }
    message PrefabData { string category = 1; uint32 id = 2;
                         VectorData position = 3, rotation = 4, scale = 5; }
    message VectorData { float x = 1; float y = 2; float z = 3; }
    message PathData   { string name = 1; bool spline = 2; bool start = 3;
                         bool end = 4; float width = 5; float inner_padding = 6;
                         float outer_padding = 7; float inner_fade = 8;
                         float outer_fade = 9; float random_scale = 10;
                         float mesh_offset = 11; float terrain_offset = 12;
                         int32 splat = 13; int32 topology = 14;
                         repeated VectorData nodes = 15; }

Terrain layers live in ``maps`` as raw little-endian arrays:

=================  =========================  ===============================
name               layout                     notes
=================  =========================  ===============================
terrain            uint16[res*res]            render height, res = size+1
height             uint16[res*res]            world/decor sampling height
water              uint16[res*res]            0 = no water
splat              uint8[8][sres*sres]        ground weights, sum to 255
biome              uint8[4..5][sres*sres]     arid/temperate/tundra/arctic
topology           int32[sres*sres]           bitmask (opaque, preserved)
alpha              uint8[sres*sres]           0 = terrain hole
=================  =========================  ===============================

``sres`` is ``NextPowerOfTwo(size * 0.5)``, normally 2048 for a 4500 m map.
Unknown layers (``RustEditData``, custom editor payloads) are preserved verbatim,
so a load/save round trip never destroys third-party data.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Layers we understand. Others are still round-tripped untouched.
KNOWN_LAYERS = ("terrain", "height", "water", "splat", "biome", "topology", "alpha")
# Extra layers written by this editor (never required by the game itself).
STUDIO_META_LAYER = "RustStudioData"

CURRENT_VERSION = 10
SUPPORTED_VERSIONS = (9, 10)

# Height scale used by Rust's terrain: Y spans -500..+500 metres.
TERRAIN_HEIGHT_MIN = -500.0
TERRAIN_HEIGHT_MAX = 500.0
TERRAIN_HEIGHT_SPAN = TERRAIN_HEIGHT_MAX - TERRAIN_HEIGHT_MIN


@dataclass(slots=True)
class Vector3:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.x, self.y, self.z)

    @classmethod
    def from_iterable(cls, values: Any) -> "Vector3":
        x, y, z = values
        return cls(float(x), float(y), float(z))

    def to_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "z": self.z}


@dataclass(slots=True)
class PrefabInstance:
    category: str = ""
    prefab_id: int = 0
    position: Vector3 = field(default_factory=Vector3)
    rotation: Vector3 = field(default_factory=Vector3)
    scale: Vector3 = field(default_factory=lambda: Vector3(1.0, 1.0, 1.0))

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "prefabId": self.prefab_id,
            "position": self.position.to_dict(),
            "rotation": self.rotation.to_dict(),
            "scale": self.scale.to_dict(),
        }


@dataclass(slots=True)
class PathNode:
    point: Vector3 = field(default_factory=Vector3)
    normal: Vector3 = field(default_factory=Vector3)
    angle: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "point": self.point.to_dict(),
            "normal": self.normal.to_dict(),
            "angle": self.angle,
        }


@dataclass(slots=True)
class PathInstance:
    name: str = ""
    spline: bool = True
    start: bool = False
    end: bool = False
    width: float = 6.0
    inner_padding: float = 0.0
    outer_padding: float = 10.0
    inner_fade: float = 1.0
    outer_fade: float = 10.0
    random_scale: float = 1.0
    mesh_offset: float = 0.0
    terrain_offset: float = 0.0
    splat: int = 0
    topology: int = 0
    nodes: list[PathNode] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "spline": self.spline,
            "start": self.start,
            "end": self.end,
            "width": self.width,
            "innerPadding": self.inner_padding,
            "outerPadding": self.outer_padding,
            "innerFade": self.inner_fade,
            "outerFade": self.outer_fade,
            "randomScale": self.random_scale,
            "meshOffset": self.mesh_offset,
            "terrainOffset": self.terrain_offset,
            "splat": self.splat,
            "topology": self.topology,
            "nodes": [node.to_dict() for node in self.nodes],
        }


@dataclass(slots=True)
class WorldDocument:
    """A parsed ``.map`` or ``.prefab`` file."""

    version: int = CURRENT_VERSION
    timestamp: int = 0
    size: int = 4500
    layers: dict[str, bytes] = field(default_factory=dict)
    prefabs: list[PrefabInstance] = field(default_factory=list)
    paths: list[PathInstance] = field(default_factory=list)

    # ---- introspection -------------------------------------------------
    @property
    def is_prefab(self) -> bool:
        return not self.layers

    def layer(self, name: str) -> bytes | None:
        return self.layers.get(name)

    def existing_layers(self) -> list[str]:
        return [name for name in KNOWN_LAYERS if name in self.layers]

    def height(self) -> bytes | None:
        return self.layers.get("terrain") or self.layers.get("height")

    def splat(self) -> bytes | None:
        return self.layers.get("splat")

    def summary(self) -> dict[str, Any]:
        """Compact, JSON-safe descriptor used by the Tauri shell and UI."""
        height = self.height()
        splat = self.layers.get("splat")
        return {
            "version": self.version,
            "timestamp": self.timestamp,
            "size": self.size,
            "kind": "prefab" if self.is_prefab else "map",
            "layerCount": len(self.layers),
            "layers": {name: len(data) for name, data in self.layers.items()},
            "prefabCount": len(self.prefabs),
            "pathCount": len(self.paths),
            "heightResolution": _resolution(height, 2) if height else None,
            "splatResolution": _resolution(splat, 8) if splat else None,
            "pathNames": [path.name for path in self.paths[:64]],
            "prefabCategories": sorted({pf.category for pf in self.prefabs if pf.category}),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "timestamp": self.timestamp,
            "size": self.size,
            "layers": sorted(self.layers),
            "prefabs": [prefab.to_dict() for prefab in self.prefabs],
            "paths": [path.to_dict() for path in self.paths],
        }


def _resolution(blob: bytes | None, channels: int) -> int | None:
    if not blob:
        return None
    texels = len(blob) / channels
    root = int(texels**0.5)
    return root if root * root == texels else None


def height_raw_to_metres(raw: int) -> float:
    """Convert a serialized uint16 height to world-space metres."""
    return TERRAIN_HEIGHT_MIN + (raw / 65535.0) * TERRAIN_HEIGHT_SPAN


def height_metres_to_raw(metres: float) -> int:
    ratio = (metres - TERRAIN_HEIGHT_MIN) / TERRAIN_HEIGHT_SPAN
    return max(0, min(65535, int(round(ratio * 65535))))


__all__ = [
    "CURRENT_VERSION",
    "KNOWN_LAYERS",
    "PathInstance",
    "PathNode",
    "PrefabInstance",
    "STUDIO_META_LAYER",
    "SUPPORTED_VERSIONS",
    "TERRAIN_HEIGHT_MAX",
    "TERRAIN_HEIGHT_MIN",
    "TERRAIN_HEIGHT_SPAN",
    "Vector3",
    "WorldDocument",
    "height_metres_to_raw",
    "height_raw_to_metres",
]
