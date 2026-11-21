"""UnityFS AssetBundle reader and optional UnityPy extraction helpers.

Rust ships its client assets as Unity AssetBundles (``UnityFS`` containers,
Unity 6 build). The native part of this module reads the archive header and
block/directory table without any third-party package, which is enough to
inventory a bundle quickly. Object names and payload extraction use UnityPy,
installed through the optional ``bundles`` extra.

No bundle is modified: callers only read the files and write derived OBJ/PNG
files into the workspace.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

from ..world.lz4_legacy import Lz4Error, decompress_block

MAGIC = b"UnityFS\0"
MAX_BLOCKS_INFO_BYTES = 64 * 1024 * 1024

# kArchiveCompressionType
COMPRESSION_NAMES = {
    0: "none",
    1: "lzma",
    2: "lz4",
    3: "lz4hc",
}

# kArchiveBlocksAndDirectoryInfoCombined / kArchiveBlocksInfoAtTheEnd /
# kArchiveBlockInfoNeedPaddingAtStart
FLAG_COMBINED_INFO = 0x40
FLAG_INFO_AT_END = 0x80
FLAG_PAD_INFO = 0x200


class BundleFormatError(ValueError):
    """Raised when a file is not a supported UnityFS archive."""


class BundleDependencyError(RuntimeError):
    """Raised when object-level bundle access needs an uninstalled package."""


class BundleExtractionError(RuntimeError):
    """Raised when a mesh or texture cannot be exported."""


@dataclass(frozen=True, slots=True)
class BundleBlock:
    uncompressed_size: int
    compressed_size: int
    flags: int


@dataclass(frozen=True, slots=True)
class BundleNode:
    offset: int
    size: int
    flags: int
    path: str


@dataclass(frozen=True, slots=True)
class BundleInfo:
    path: Path
    file_bytes: int
    file_version: int
    unity_version: str
    unity_revision: str
    total_size: int
    flags: int
    compression: str
    info_offset: int
    blocks: tuple[BundleBlock, ...]
    nodes: tuple[BundleNode, ...]


@dataclass(frozen=True, slots=True)
class ContainerEntry:
    """One AssetBundle lookup path (what Rust writes into prefab references)."""

    path: str
    path_id: int


@dataclass(frozen=True, slots=True)
class BundleObject:
    object_type: str
    path_id: int
    name: str
    source_file: str
    container_path: str | None = None


def is_unity_bundle(path: str | Path) -> bool:
    try:
        with Path(path).open("rb") as handle:
            return handle.read(8) == MAGIC
    except OSError:
        return False


def read_bundle_info(path: str | Path) -> BundleInfo:
    """Read the UnityFS header plus its compressed block/directory table."""
    target = Path(path)
    file_bytes = target.stat().st_size
    with target.open("rb") as handle:
        if handle.read(8) != MAGIC:
            raise BundleFormatError(f"{target} is not a UnityFS bundle")
        version = _read_u32(handle)
        unity_version = _read_cstring(handle)
        revision = _read_cstring(handle)
        total_size = _read_i64(handle)
        compressed_info_size = _read_u32(handle)
        uncompressed_info_size = _read_u32(handle)
        flags = _read_u32(handle)
        header_end = handle.tell()

        if not 6 <= version <= 8:
            raise BundleFormatError(f"unsupported UnityFS version {version}")
        if compressed_info_size > MAX_BLOCKS_INFO_BYTES:
            raise BundleFormatError(
                f"blocks/directory table is {compressed_info_size} bytes (refusing to parse)"
            )

        info_offset = header_end
        if flags & FLAG_PAD_INFO:
            info_offset = (info_offset + 15) & ~15
        if flags & FLAG_INFO_AT_END:
            info_offset = max(0, total_size - compressed_info_size)
        handle.seek(info_offset)
        raw = handle.read(compressed_info_size)
        if len(raw) != compressed_info_size:
            raise BundleFormatError("truncated blocks/directory table")

    if compressed_info_size == uncompressed_info_size:
        info_data = raw
    else:
        compression = flags & 0x3F
        if compression not in (2, 3):
            raise BundleFormatError(
                f"unsupported bundle compression '{COMPRESSION_NAMES.get(compression, compression)}'"
            )
        try:
            info_data = decompress_block(raw, uncompressed_info_size)
        except Lz4Error as exc:
            raise BundleFormatError(f"invalid LZ4 blocks/directory table: {exc}") from exc
    if len(info_data) != uncompressed_info_size:
        raise BundleFormatError(
            f"blocks/directory table decoded to {len(info_data)} bytes, "
            f"expected {uncompressed_info_size}"
        )

    reader = _InfoReader(info_data)
    reader.skip(16)  # uncompressed data hash
    block_count = reader.u32()
    if block_count > 1_000_000:
        raise BundleFormatError(f"implausible block count {block_count}")
    blocks = tuple(
        BundleBlock(reader.u32(), reader.u32(), reader.u16()) for _ in range(block_count)
    )
    if not flags & FLAG_COMBINED_INFO:
        raise BundleFormatError("separate directory information is not supported")
    node_count = reader.u32()
    if node_count > 1_000_000:
        raise BundleFormatError(f"implausible node count {node_count}")
    nodes = tuple(
        BundleNode(reader.i64(), reader.i64(), reader.u32(), reader.cstring())
        for _ in range(node_count)
    )

    return BundleInfo(
        path=target,
        file_bytes=file_bytes,
        file_version=version,
        unity_version=unity_version,
        unity_revision=revision,
        total_size=total_size,
        flags=flags,
        compression=COMPRESSION_NAMES.get(flags & 0x3F, "unknown"),
        info_offset=info_offset,
        blocks=blocks,
        nodes=nodes,
    )


def load_bundle(path: str | Path) -> Any:
    """Load a bundle with UnityPy (object access only)."""
    try:
        import UnityPy  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - depends on install extras
        raise BundleDependencyError(
            "UnityPy is required for bundle object access. Install it with:\n"
            "  pip install -e 'engine[bundles]'"
        ) from exc
    return UnityPy.load(str(path))


def read_container(env: Any) -> list[ContainerEntry]:
    """Read the AssetBundle container table (asset path -> path id)."""
    bundle = next((obj for obj in env.objects if obj.type.name == "AssetBundle"), None)
    if bundle is None:
        return []
    try:
        data = bundle.read()
    except Exception as exc:  # UnityPy raises a variety of errors here
        raise BundleFormatError(f"cannot read AssetBundle table: {exc}") from exc
    entries: list[ContainerEntry] = []
    for item in getattr(data, "m_Container", None) or []:
        try:
            path, info = item
        except (TypeError, ValueError):
            continue
        try:
            path_id = int(info.asset.path_id)
        except Exception:
            path_id = 0
        entries.append(ContainerEntry(str(path), path_id))
    return entries


def peek_object_name(obj: Any) -> str:
    try:
        return str(obj.peek_name() or "")
    except Exception:
        return ""


def object_source_file(obj: Any) -> str:
    assets_file = getattr(obj, "assets_file", None)
    name = getattr(assets_file, "name", "") if assets_file is not None else ""
    return str(name or "")


def iter_bundle_objects(env: Any) -> Iterator[BundleObject]:
    """Yield every object with its type, id and name (skips the bundle object)."""
    for obj in env.objects:
        object_type = obj.type.name
        if object_type == "AssetBundle":
            continue
        yield BundleObject(
            object_type=object_type,
            path_id=int(obj.path_id),
            name=peek_object_name(obj),
            source_file=object_source_file(obj),
        )


def export_mesh_object(obj: Any, destination: str | Path) -> Path:
    """Export one Mesh object to an OBJ file using UnityPy's writer."""
    try:
        mesh = obj.read()
        text = mesh.export()
    except Exception as exc:
        raise BundleExtractionError(f"mesh export failed: {exc}") from exc
    if isinstance(text, dict):  # older UnityPy releases can return submeshes
        text = "\n".join(str(part) for part in text.values())
    if not isinstance(text, str) or not text.strip():
        raise BundleExtractionError("mesh exporter returned no geometry")
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


def export_texture_object(
    obj: Any,
    destination: str | Path,
    *,
    max_pixels: int = 16_777_216,
) -> tuple[int, int]:
    """Decode one Texture2D to PNG. Oversized textures are refused."""
    try:
        texture = obj.read()
        width = int(getattr(texture, "m_Width", 0))
        height = int(getattr(texture, "m_Height", 0))
        if width <= 0 or height <= 0:
            raise BundleExtractionError("texture has no dimensions")
        if width * height > max_pixels:
            raise BundleExtractionError(f"texture is {width}x{height} (over the pixel cap)")
        image = texture.image
    except BundleExtractionError:
        raise
    except Exception as exc:
        raise BundleExtractionError(f"texture decode failed: {exc}") from exc
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA")
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "PNG", optimize=True)
    return width, height


def bundle_nodes_matching(info: BundleInfo, suffix: str) -> Iterable[BundleNode]:
    suffix = suffix.lower()
    return (node for node in info.nodes if node.path.lower().endswith(suffix))


def _read_u32(handle: Any) -> int:
    data = handle.read(4)
    if len(data) != 4:
        raise BundleFormatError("truncated header")
    return struct.unpack(">I", data)[0]


def _read_i64(handle: Any) -> int:
    data = handle.read(8)
    if len(data) != 8:
        raise BundleFormatError("truncated header")
    return struct.unpack(">q", data)[0]


def _read_cstring(handle: Any, limit: int = 4096) -> str:
    data = bytearray()
    while len(data) < limit:
        char = handle.read(1)
        if not char:
            raise BundleFormatError("unterminated header string")
        if char == b"\0":
            return data.decode("utf-8", "replace")
        data.extend(char)
    raise BundleFormatError("header string is too long")


class _InfoReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, count: int) -> bytes:
        end = self.pos + count
        if end > len(self.data):
            raise BundleFormatError("blocks/directory table is truncated")
        chunk = self.data[self.pos : end]
        self.pos = end
        return chunk

    def skip(self, count: int) -> None:
        self.take(count)

    def u16(self) -> int:
        return struct.unpack(">H", self.take(2))[0]

    def u32(self) -> int:
        return struct.unpack(">I", self.take(4))[0]

    def i64(self) -> int:
        return struct.unpack(">q", self.take(8))[0]

    def cstring(self) -> str:
        end = self.data.find(b"\0", self.pos)
        if end < 0:
            raise BundleFormatError("unterminated directory path")
        value = self.data[self.pos : end].decode("utf-8", "replace")
        self.pos = end + 1
        return value


__all__ = [
    "BundleBlock",
    "BundleDependencyError",
    "BundleExtractionError",
    "BundleFormatError",
    "BundleInfo",
    "BundleNode",
    "BundleObject",
    "ContainerEntry",
    "export_mesh_object",
    "export_texture_object",
    "is_unity_bundle",
    "iter_bundle_objects",
    "load_bundle",
    "object_source_file",
    "peek_object_name",
    "read_bundle_info",
    "read_container",
]
