"""Read/write Rust ``.map`` and ``.prefab`` files.

Container layout (serialization version 10)::

    0..4      uint32  version (9 or 10)
    4..12     int64   unix timestamp (seconds)
    12..EOF   LZ4 legacy chunked stream -> protobuf WorldData

Version 9 files written before the timestamp was introduced exist in the wild,
so :func:`parse_document` retries at offset 4 when the header+stream fails to
decode. The parsed form is :class:`~.models.WorldDocument`; saving always writes
version 10 with a fresh timestamp unless one is supplied.
"""

from __future__ import annotations

import math
import struct
import time
from pathlib import Path
from typing import Any

from .lz4_legacy import Lz4Error, compress_stream, decompress_stream
from .models import (
    CURRENT_VERSION,
    STUDIO_META_LAYER,
    SUPPORTED_VERSIONS,
    PathInstance,
    PathNode,
    PrefabInstance,
    Vector3,
    WorldDocument,
)
from .protobuf import (
    FIXED32,
    LENGTH_DELIMITED,
    MessageWriter,
    ProtobufError,
    iter_fields,
)

HEADER_SIZE = 12


class MapFormatError(ValueError):
    """Raised when a file is not a readable WorldSerialization document."""


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def parse_document(raw: bytes) -> WorldDocument:
    """Parse raw ``.map`` / ``.prefab`` bytes into a :class:`WorldDocument`."""
    if len(raw) < HEADER_SIZE:
        raise MapFormatError("file is shorter than the 12-byte header")

    version = struct.unpack_from("<I", raw, 0)[0]
    if version not in SUPPORTED_VERSIONS:
        raise MapFormatError(
            f"unsupported WorldSerialization version {version} "
            f"(supported: {', '.join(map(str, SUPPORTED_VERSIONS))})"
        )

    timestamp = struct.unpack_from("<q", raw, 4)[0]
    payload = _decompress_with_fallback(raw)
    document = _parse_world_data(payload)
    document.version = version
    document.timestamp = timestamp
    return document


def _decompress_with_fallback(raw: bytes) -> bytes:
    problems: list[str] = []
    for offset in (HEADER_SIZE, 4):
        if offset >= len(raw):
            continue
        try:
            payload = decompress_stream(raw[offset:])
        except (Lz4Error, IndexError) as exc:
            problems.append(f"offset {offset}: {exc}")
            continue
        if payload:
            return payload
        problems.append(f"offset {offset}: empty payload")
    raise MapFormatError("could not decompress map payload (" + "; ".join(problems) + ")")


def _parse_world_data(payload: bytes) -> WorldDocument:
    document = WorldDocument()
    try:
        for field, wire, value in iter_fields(payload):
            if field == 1 and wire == 0:
                document.size = int(value)
            elif field == 2 and wire == LENGTH_DELIMITED:
                name, data = _parse_map_data(value)
                if name:
                    document.layers[name] = data
            elif field == 3 and wire == LENGTH_DELIMITED:
                document.prefabs.append(_parse_prefab(value))
            elif field == 4 and wire == LENGTH_DELIMITED:
                document.paths.append(_parse_path(value))
    except (ProtobufError, struct.error) as exc:
        raise MapFormatError(f"malformed WorldData protobuf: {exc}") from exc

    if document.size <= 0:
        raise MapFormatError("WorldData has no terrain size")
    return document


def _parse_map_data(buf: bytes) -> tuple[str, bytes]:
    name = ""
    data = b""
    for field, wire, value in iter_fields(buf):
        if field == 1 and wire == LENGTH_DELIMITED:
            name = bytes(value).decode("utf-8", errors="replace")
        elif field == 2 and wire == LENGTH_DELIMITED:
            data = bytes(value)
    return name, data


def _parse_vector(buf: bytes) -> Vector3:
    vector = Vector3()
    for field, wire, value in iter_fields(buf):
        if wire != FIXED32:
            continue
        if field == 1:
            vector.x = float(value)
        elif field == 2:
            vector.y = float(value)
        elif field == 3:
            vector.z = float(value)
    return vector


def _parse_prefab(buf: bytes) -> PrefabInstance:
    prefab = PrefabInstance()
    for field, wire, value in iter_fields(buf):
        if field == 1 and wire == LENGTH_DELIMITED:
            prefab.category = bytes(value).decode("utf-8", errors="replace")
        elif field == 2 and wire == 0:
            prefab.prefab_id = int(value)
        elif field == 3 and wire == LENGTH_DELIMITED:
            prefab.position = _parse_vector(bytes(value))
        elif field == 4 and wire == LENGTH_DELIMITED:
            prefab.rotation = _parse_vector(bytes(value))
        elif field == 5 and wire == LENGTH_DELIMITED:
            prefab.scale = _parse_vector(bytes(value))
    return prefab


def _parse_path(buf: bytes) -> PathInstance:
    path = PathInstance()
    for field, wire, value in iter_fields(buf):
        if wire == FIXED32:
            if field == 5:
                path.width = float(value)
            elif field == 6:
                path.inner_padding = float(value)
            elif field == 7:
                path.outer_padding = float(value)
            elif field == 8:
                path.inner_fade = float(value)
            elif field == 9:
                path.outer_fade = float(value)
            elif field == 10:
                path.random_scale = float(value)
            elif field == 11:
                path.mesh_offset = float(value)
            elif field == 12:
                path.terrain_offset = float(value)
            continue
        if wire == 0:
            if field == 2:
                path.spline = bool(value)
            elif field == 3:
                path.start = bool(value)
            elif field == 4:
                path.end = bool(value)
            elif field == 13:
                path.splat = int(value)
            elif field == 14:
                path.topology = int(value)
            continue
        if wire == LENGTH_DELIMITED:
            if field == 1:
                path.name = bytes(value).decode("utf-8", errors="replace")
            elif field == 15:
                point = _parse_vector(bytes(value))
                path.nodes.append(PathNode(point=point))
    return path


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def build_document(document: WorldDocument) -> bytes:
    """Serialize a document to ``.map`` / ``.prefab`` bytes."""
    payload = _build_world_data(document)
    timestamp = document.timestamp or int(time.time())
    header = struct.pack("<Iq", CURRENT_VERSION, timestamp)
    return header + compress_stream(payload)


def _build_world_data(document: WorldDocument) -> bytes:
    writer = MessageWriter()
    writer.varint(1, max(1, int(document.size)))

    for name, data in document.layers.items():
        if not data:
            continue
        layer = MessageWriter().string(1, name).bytes_field(2, data)
        writer.message(2, layer)

    for prefab in document.prefabs:
        message = (
            MessageWriter()
            .string(1, prefab.category)
            .varint(2, int(prefab.prefab_id) & 0xFFFFFFFF)
            .message(3, _vector(prefab.position))
            .message(4, _vector(prefab.rotation))
            .message(5, _vector(prefab.scale))
        )
        writer.message(3, message)

    for path in document.paths:
        message = (
            MessageWriter()
            .string(1, path.name)
            .boolean(2, path.spline)
            .boolean(3, path.start)
            .boolean(4, path.end)
            .float32(5, path.width)
            .float32(6, path.inner_padding)
            .float32(7, path.outer_padding)
            .float32(8, path.inner_fade)
            .float32(9, path.outer_fade)
            .float32(10, path.random_scale)
            .float32(11, path.mesh_offset)
            .float32(12, path.terrain_offset)
            .varint(13, path.splat)
            .varint(14, path.topology)
        )
        for node in path.nodes:
            message.message(15, _vector(node.point))
        writer.message(4, message)

    return writer.finish()


def _vector(value: Vector3) -> MessageWriter:
    return (
        MessageWriter()
        .float32(1, value.x)
        .float32(2, value.y)
        .float32(3, value.z)
    )


# ---------------------------------------------------------------------------
# Path-based helpers
# ---------------------------------------------------------------------------


def read_document(path: str | Path) -> WorldDocument:
    return parse_document(Path(path).read_bytes())


def write_document(path: str | Path, document: WorldDocument) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(build_document(document))


def inspect_file(path: str | Path) -> dict[str, Any]:
    """Return a JSON-safe summary without keeping the (large) layers in memory."""
    document = read_document(path)
    summary = document.summary()
    summary["file"] = str(path)
    summary["byteSize"] = Path(path).stat().st_size
    summary["waterLevel"] = _water_level(document)
    return summary


def _water_level(document: WorldDocument) -> float:
    blob = document.layers.get("water")
    if not blob:
        return 0.0
    samples = struct.unpack_from(f"<{min(len(blob) // 2, 4096)}H", blob, 0)
    wet = [value for value in samples if value > 0]
    if not wet:
        return 0.0
    from .models import height_raw_to_metres

    return height_raw_to_metres(sum(wet) // len(wet))


# ---------------------------------------------------------------------------
# Geometry helpers shared with the editor
# ---------------------------------------------------------------------------


def expected_layer_sizes(size_metres: int) -> dict[str, tuple[int, int]]:
    """Return ``{layer: (bytes_per_texel, texels)}`` for a map of this size."""
    height_res = size_metres + 1
    splat_res = 1
    while splat_res < max(1, int(size_metres * 0.5)):
        splat_res <<= 1
    return {
        "terrain": (2, height_res * height_res),
        "height": (2, height_res * height_res),
        "water": (2, height_res * height_res),
        "splat": (8, splat_res * splat_res),
        "biome": (4, splat_res * splat_res),
        "topology": (4, splat_res * splat_res),
        "alpha": (1, splat_res * splat_res),
    }


def validate_layout(document: WorldDocument) -> list[dict[str, Any]]:
    """Check that terrain layer sizes match the declared map size."""
    issues: list[dict[str, Any]] = []
    expected = expected_layer_sizes(int(document.size))
    for name, (channels, texels) in expected.items():
        data = document.layers.get(name)
        if data is None:
            if name in ("terrain", "splat"):
                issues.append(
                    {
                        "severity": "error",
                        "layer": name,
                        "message": f"required layer '{name}' is missing",
                    }
                )
            continue
        expected_bytes = channels * texels
        # biome can legitimately carry a 5th plane in newer builds
        tolerance = texels if name == "biome" else 0
        if len(data) not in (expected_bytes, expected_bytes + tolerance):
            issues.append(
                {
                    "severity": "warning",
                    "layer": name,
                    "message": (
                        f"layer '{name}' is {len(data)} bytes, expected {expected_bytes}"
                    ),
                }
            )
    return issues


def studio_meta_layer(document: WorldDocument) -> str | None:
    """Return the editor metadata layer as text, if this map has one."""
    blob = document.layers.get(STUDIO_META_LAYER)
    if not blob:
        return None
    return blob.decode("utf-8", errors="replace")


def strip_studio_meta(document: WorldDocument) -> None:
    """Drop editor-only metadata before a server export."""
    document.layers.pop(STUDIO_META_LAYER, None)


def split_prefab_document(document: WorldDocument) -> WorldDocument:
    """Turn a one-prefab ``.prefab`` document into an empty-terrain document.

    Rust prefab files keep the same container but only carry prefab records and
    (optionally) the prefab's own serialized metadata layer.
    """
    return WorldDocument(
        version=document.version,
        timestamp=document.timestamp,
        size=document.size,
        layers={name: data for name, data in document.layers.items() if name != "terrain"},
        prefabs=list(document.prefabs),
        paths=list(document.paths),
    )


def splat_resolution(size_metres: int) -> int:
    """Splat/biome/topology resolution for a terrain size (power of two)."""
    target = max(1, int(size_metres * 0.5))
    return 1 << math.ceil(math.log2(target)) if target > 1 else 1


__all__ = [
    "HEADER_SIZE",
    "MapFormatError",
    "build_document",
    "expected_layer_sizes",
    "inspect_file",
    "parse_document",
    "read_document",
    "split_prefab_document",
    "splat_resolution",
    "studio_meta_layer",
    "strip_studio_meta",
    "validate_layout",
    "write_document",
]
