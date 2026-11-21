"""WorldSerialization codec, terrain math and map/monument document model."""

from .lz4_legacy import (
    Lz4Error,
    compress_block,
    compress_stream,
    decompress_block,
    decompress_stream,
)
from .map_file import (
    MapFormatError,
    build_document,
    inspect_file,
    parse_document,
    read_document,
    validate_layout,
    write_document,
)
from .models import (
    CURRENT_VERSION,
    KNOWN_LAYERS,
    PathInstance,
    PathNode,
    PrefabInstance,
    Vector3,
    WorldDocument,
    height_metres_to_raw,
    height_raw_to_metres,
)

__all__ = [
    "CURRENT_VERSION",
    "KNOWN_LAYERS",
    "Lz4Error",
    "MapFormatError",
    "PathInstance",
    "PathNode",
    "PrefabInstance",
    "Vector3",
    "WorldDocument",
    "build_document",
    "compress_block",
    "compress_stream",
    "decompress_block",
    "decompress_stream",
    "height_metres_to_raw",
    "height_raw_to_metres",
    "inspect_file",
    "parse_document",
    "read_document",
    "validate_layout",
    "write_document",
]
