"""Export real prefab geometry to a compact GLB for local thumbnails/viewport.

Unity bundles contain meshes but no ready-made GLB. This module walks a prefab
(or the real sibling prefab behind an item definition), combines renderer mesh
geometry with its transform, and writes a single-material GLB. When the first
renderer exposes a readable albedo Texture2D, a downscaled PNG is embedded in
the GLB so the viewport can show real surfaces. Nothing is downloaded and no
game assets are stored in the repository; generated files live in the user's
cache.
"""

from __future__ import annotations

import io
import json
import math
import os
import struct
import weakref
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable

from PIL import Image

from .prefab_bounds import (
    collect_mesh_instances,
    item_prefab_candidates,
    read_container,
)
from .unity_bundle import load_bundle

MAX_TRIANGLES = 300_000

# Loaded bundles are expensive to parse (10-40 s for the shipped scenes), so a
# long-lived worker may retain the most recent one. The desktop shell only uses
# this from its extraction daemon; one-shot CLI runs keep the cache disabled.
_ENV_CACHE: "OrderedDict[tuple[str, float, int], Any]" = OrderedDict()
# Cached environments are bounded by measured resident memory, not by file size:
# a 1 GB bundle needs roughly 1.8 GB of RSS, and four of them reach 3.4 GB.
_ENV_CACHE_BUDGET = 0


def cache_stats() -> dict[str, int]:
    """Resident cache size, for the worker's log and response payload."""
    return {
        "entries": len(_ENV_CACHE),
        "rssBytes": _process_rss_bytes(),
        "budgetBytes": _ENV_CACHE_BUDGET,
    }


def _process_rss_bytes() -> int:
    try:
        with open("/proc/self/statm", "rb") as handle:
            pages = int(handle.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return 0


def _forget_env(env: Any) -> None:
    """Drop the name index too: it holds objects, which would keep the
    environment alive even after the cache let go of it."""
    _NAME_INDEX.pop(id(env), None)


def _release_memory() -> None:
    """Return freed arenas to the OS; otherwise RSS stays at its high-water
    mark and the budget below would only ever be exceeded."""
    import ctypes
    import gc

    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass


def configure_env_cache(limit_bytes: int) -> None:
    global _ENV_CACHE_BUDGET
    _ENV_CACHE_BUDGET = max(0, int(limit_bytes))
    if not _ENV_CACHE_BUDGET:
        for env in _ENV_CACHE.values():
            _forget_env(env)
        _ENV_CACHE.clear()


def _trim_cache(protected: tuple[str, float, int] | None = None) -> None:
    """Evict least-recently-used bundles until measured RSS fits the budget.

    Measured RSS is the only authority: a per-load delta understates what a
    bundle actually keeps resident once its objects are touched. The bundle that
    was just loaded is never evicted, because the caller is about to use it.
    """
    while len(_ENV_CACHE) > 1 and _process_rss_bytes() > _ENV_CACHE_BUDGET:
        key = next(iter(_ENV_CACHE))
        if key == protected:
            return
        _forget_env(_ENV_CACHE.pop(key))
        _release_memory()


def _load_env(path: Path) -> Any:
    if not _ENV_CACHE_BUDGET:
        return load_bundle(path)
    stat = path.stat()
    key = (str(path.resolve()), stat.st_mtime, stat.st_size)
    cached = _ENV_CACHE.get(key)
    if cached is not None:
        _ENV_CACHE.move_to_end(key)
        return cached
    env = load_bundle(path)
    _ENV_CACHE[key] = env
    _trim_cache(protected=key)
    return env
MAX_TEXTURE_EDGE = 512
ALBEDO_NAMES = ("_MainTex", "_BaseMap", "_Albedo", "_BaseColorTexture", "_MainTexture")


def prefab_hash(value: str) -> str:
    """Stable 64-bit FNV-1a hash used for cache file names."""
    result = 0xCBF29CE484222325
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{result:016x}"


def _transform(
    matrix: tuple[float, ...], point: tuple[float, float, float]
) -> tuple[float, float, float]:
    x, y, z = point
    return (
        matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
        matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
        matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
    )


Corner = tuple[int, int]


def _parse_obj(text: str) -> tuple[
    list[tuple[float, float, float]],
    list[tuple[float, float]],
    list[tuple[Corner, Corner, Corner]],
]:
    """Return OBJ positions, UVs and triangle corners ``(vertex, uv)``."""
    positions: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    triangles: list[tuple[Corner, Corner, Corner]] = []
    for line in text.splitlines():
        if line.startswith("v "):
            parts = line.split()
            if len(parts) >= 4:
                try:
                    positions.append((float(parts[1]), float(parts[2]), float(parts[3])))
                except ValueError:
                    continue
        elif line.startswith("vt "):
            parts = line.split()
            if len(parts) >= 3:
                try:
                    uvs.append((float(parts[1]), float(parts[2])))
                except ValueError:
                    continue
        elif line.startswith("f "):
            corners: list[Corner] = []
            for corner in line.split()[1:]:
                fields = corner.split("/")
                try:
                    vertex = int(fields[0]) - 1
                    uv = int(fields[1]) - 1 if len(fields) > 1 and fields[1] else -1
                except (ValueError, IndexError):
                    corners = []
                    break
                if 0 <= vertex < len(positions) and (uv < 0 or uv < len(uvs)):
                    corners.append((vertex, uv))
                else:
                    corners = []
                    break
            if len(corners) < 3:
                continue
            for index in range(1, len(corners) - 1):
                triangles.append((corners[0], corners[index], corners[index + 1]))
    return positions, uvs, triangles


def _object_type(obj: Any) -> str | None:
    return getattr(getattr(obj, "type", None), "name", None)


def _object_name(obj: Any) -> str:
    try:
        return str(obj.peek_name() or "")
    except Exception:
        try:
            return str(getattr(obj.read(), "m_Name", "") or "")
        except Exception:
            return ""


def _find_container_root(env: Any, prefab_path: str) -> Any | None:
    wanted = prefab_path.casefold()
    entry = next(
        (item for item in read_container(env) if item.path.casefold() == wanted),
        None,
    )
    if entry is None:
        return None
    for obj in env.objects:
        if int(obj.path_id) == int(entry.path_id):
            try:
                return obj.read()
            except Exception:
                return None
    return None


class _StandaloneMesh:
    """Adapter that lets the GLB writer consume a bare Mesh asset."""

    def __init__(self, mesh: Any) -> None:
        self.mesh = mesh
        self.matrix = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0)
        candidates = getattr(mesh, "m_Materials", None)
        self.materials = candidates if isinstance(candidates, (list, tuple)) else ()


class _ObjMesh:
    """Minimal Mesh facade for an already-exported OBJ file."""

    def __init__(self, text: str) -> None:
        self.text = text

    def export(self) -> str:
        return self.text


def export_obj_glb(obj_path: str | Path, asset_path: str, cache_dir: str | Path) -> dict[str, object]:
    """Cache an OBJ as a GLB under the same key the UI uses for its asset path.

    Bundle extraction writes OBJ files because that is UnityPy's native export.
    The asset drawer needs GLB for its turntable, so this adapter runs the same
    writer with an identity transform and no material links.
    """
    source = Path(obj_path).expanduser()
    text = source.read_text(encoding="utf-8", errors="replace")
    if "\nf " not in f"\n{text}" and " f " not in f" {text}":
        raise ValueError(f"OBJ has no faces: {source}")
    digest = prefab_hash(asset_path)
    target = Path(cache_dir).expanduser() / f"{digest}.glb"
    vertices, triangles, meshes = _write_glb(target, _StandaloneMesh(_ObjMesh(text)))
    return {
        "assetPath": asset_path,
        "prefabHash": digest,
        "glbPath": str(target),
        "bytes": target.stat().st_size,
        "vertices": vertices,
        "triangles": triangles,
        "meshes": meshes,
    }


def _find_standalone_mesh(env: Any, asset_path: str) -> Any | None:
    wanted = asset_path.casefold()
    entry = next(
        (item for item in read_container(env) if item.path.casefold() == wanted),
        None,
    )
    if entry is None:
        return None
    for obj in env.objects:
        if int(obj.path_id) != int(entry.path_id):
            continue
        if _object_type(obj) != "Mesh":
            return None
        try:
            return _StandaloneMesh(obj.read())
        except Exception:
            return None
    return None


_NAME_INDEX: "dict[int, tuple[Any, dict[str, list[Any]]]]" = {}


def _env_name_index(env: Any) -> dict[str, list[Any]]:
    """GameObject name -> objects, built once per loaded bundle.

    A scene bundle holds over a million objects; walking it for every prefab
    would dominate extraction time. The worker keeps a few of these indexes
    next to its cached environments.
    """
    key = id(env)
    cached = _NAME_INDEX.get(key)
    # Keep only a weak reference to the environment: a recycled id must never
    # hand back another bundle's name index, and holding four 1.4M-object
    # environments alive would be far more expensive than rebuilding one.
    if cached is not None and cached[0]() is env:
        return cached[1]
    index: dict[str, list[Any]] = {}
    for obj in env.objects:
        object_type = _object_type(obj)
        if object_type is not None and object_type != "GameObject":
            continue
        name = _object_name(obj).casefold()
        if name:
            index.setdefault(name, []).append(obj)
    try:
        reference = weakref.ref(env)
    except TypeError:
        reference = lambda: env  # type: ignore[assignment]
    _NAME_INDEX[key] = (reference, index)
    while len(_NAME_INDEX) > 4:
        _NAME_INDEX.pop(next(iter(_NAME_INDEX)))
    return index


def _find_named_root(env: Any, names: Iterable[str]) -> Any | None:
    wanted = {str(name).casefold() for name in names if name}
    index = _env_name_index(env)
    best: tuple[int, Any] | None = None
    for name in wanted:
        for obj in index.get(name, ()):
            try:
                root = obj.read()
            except Exception:
                continue
            count = len(collect_mesh_instances(root))
            if best is None or count > best[0]:
                best = (count, root)
    return best[1] if best and best[0] else None


def _bundle_files(root: Path, bundle: str | Path | None = None) -> list[Path]:
    if bundle is not None:
        target = Path(bundle).expanduser()
        if not target.is_absolute():
            target = root / target
        return [target] if target.is_file() else []
    return sorted(root.glob("*.bundle"), key=lambda path: path.stat().st_size)


def _root_for_path(
    bundle_root: Path,
    prefab_path: str,
    progress: Any = None,
    bundle: str | Path | None = None,
) -> tuple[Any, Any] | None:
    files = _bundle_files(bundle_root, bundle)
    for index, path in enumerate(files):
        if progress:
            progress(
                "scanning-bundles",
                index,
                len(files),
                f"Scanning {path.name} for {Path(prefab_path).stem}",
            )
        # Skip the 3 GB scene bundles during a folder-wide search; an explicit
        # ``bundle`` request is allowed to load one on demand.
        if bundle is None and path.stat().st_size > 1_300_000_000:
            continue
        try:
            env = _load_env(path)
        except Exception:
            continue
        root = _find_container_root(env, prefab_path)
        if root is not None and collect_mesh_instances(root):
            return root, env
        standalone = _find_standalone_mesh(env, prefab_path)
        if standalone is not None:
            return standalone, env
        # Item definitions point at sibling prefabs; monument/scene prefabs use
        # their own stem. Both are resolved by GameObject name.
        names = {Path(prefab_path).stem}
        if prefab_path.lower().endswith(".item.prefab"):
            names.update(Path(candidate).stem for candidate in item_prefab_candidates(prefab_path))
        named = _find_named_root(env, names)
        if named is not None:
            return named, env
    return None


def _append_geometry(
    positions: list[float],
    normals: list[float],
    uvs: list[float],
    indices: list[int],
    source: list[tuple[float, float, float]],
    texcoords: list[tuple[float, float]],
    triangles: list[tuple[Corner, Corner, Corner]],
    matrix: tuple[float, ...],
) -> int:
    added = 0
    for corners in triangles:
        points = [
            _transform(matrix, source[vertex])
            for vertex, _uv in corners
        ]
        ab = tuple(points[1][axis] - points[0][axis] for axis in range(3))
        ac = tuple(points[2][axis] - points[0][axis] for axis in range(3))
        nx = ab[1] * ac[2] - ab[2] * ac[1]
        ny = ab[2] * ac[0] - ab[0] * ac[2]
        nz = ab[0] * ac[1] - ab[1] * ac[0]
        length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        normal = (nx / length, ny / length, nz / length)
        for (vertex, uv_index), point in zip(corners, points):
            indices.append(len(indices))
            positions.extend(point)
            normals.extend(normal)
            uv = texcoords[uv_index] if 0 <= uv_index < len(texcoords) else (0.0, 0.0)
            uvs.extend(uv)
        added += 1
    return added


def _material_texture_png(instance: Any) -> bytes | None:
    """Read the first readable albedo Texture2D from an instance's materials."""
    for material_pointer in getattr(instance, "materials", ()) or ():
        try:
            material = material_pointer.read()
        except Exception:
            continue
        saved = getattr(material, "m_SavedProperties", None)
        envs = getattr(saved, "m_TexEnvs", None) or []
        items = envs.items() if hasattr(envs, "items") else envs
        try:
            pairs = list(items)
        except TypeError:
            continue
        for item in pairs:
            try:
                name, value = item
            except (TypeError, ValueError):
                continue
            if str(name) not in ALBEDO_NAMES:
                continue
            pointer = getattr(value, "m_Texture", None)
            if pointer is None:
                try:
                    pointer = value[1]
                except (TypeError, IndexError):
                    pointer = None
            if pointer is None:
                continue
            try:
                texture = pointer.read()
                image = texture.image
            except Exception:
                continue
            if image is None:
                continue
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA")
            if max(image.size) > MAX_TEXTURE_EDGE:
                image = image.copy()
                image.thumbnail((MAX_TEXTURE_EDGE, MAX_TEXTURE_EDGE), Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, "PNG", optimize=True)
            return buffer.getvalue()
    return None


_NON_ALBEDO_TOKENS = (
    "icon",
    "normal",
    "normals",
    "mask",
    "specular",
    "metallic",
    "roughness",
    "translucency",
    "emission",
    "height",
    "biome",
    "water",
    "topology",
    "alpha",
    "cursor",
    "loading",
    "cloud",
    "foam",
    "terrain",
)


def _fallback_texture_png(env: Any, asset_path: str) -> bytes | None:
    """Pick a plausible albedo when the prefab's material lives in another CAB.

    Rust ships many materials as external references. The bundle still contains
    the Texture2D assets, so score readable textures against the prefab name and
    reject normal/mask/icon maps. This is a fallback, never a substitute for an
    explicitly linked ``_MainTex``.
    """
    stop = {
        "assets",
        "prefabs",
        "bundled",
        "autospawn",
        "item",
        "prefab",
        "worldmodel",
        "entity",
        "deployed",
        "toptier",
    }
    tokens = [
        token
        for token in Path(asset_path).stem.casefold().replace("-", "_").replace(".", "_").split("_")
        if len(token) > 2 and token not in stop
    ]
    if not tokens:
        return None
    best: tuple[int, int, Any] | None = None
    for obj in getattr(env, "objects", []):
        if _object_type(obj) != "Texture2D":
            continue
        name = _object_name(obj)
        lowered = name.casefold()
        if not name or any(token in lowered for token in _NON_ALBEDO_TOKENS):
            continue
        score = sum(1 for token in tokens if token in lowered)
        if not score:
            continue
        bonus = 1 if any(suffix in lowered for suffix in ("_bc", "_albedo", "_diffuse", "_maintex")) else 0
        candidate = (score, bonus, obj)
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    if best is None:
        return None
    try:
        texture = best[2].read()
        image = texture.image
    except Exception:
        return None
    if image is None or not _looks_like_albedo(image):
        return None
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA")
    if max(image.size) > MAX_TEXTURE_EDGE:
        image = image.copy()
        image.thumbnail((MAX_TEXTURE_EDGE, MAX_TEXTURE_EDGE), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()


def _looks_like_albedo(image: Image.Image) -> bool:
    """Reject UI icons and masks that share a name with a model texture."""
    rgb = image.convert("RGB")
    sample = rgb.copy()
    sample.thumbnail((32, 32))
    colors = sample.getcolors(4096) or []
    if len(colors) < 6:
        return False
    # A flat black/white silhouette is an icon or mask, not a surface map.
    chromatic = 0
    for _count, (red, green, blue) in colors:
        if max(red, green, blue) - min(red, green, blue) > 10:
            chromatic += 1
    return chromatic >= max(2, len(colors) // 12)


def _write_glb(
    path: Path,
    root: Any,
    fallback_texture: bytes | None = None,
    fallback_loader: Any = None,
) -> tuple[int, int, int]:
    positions: list[float] = []
    normals: list[float] = []
    uvs: list[float] = []
    indices: list[int] = []
    triangles = 0
    meshes = 0
    texture_png: bytes | None = None
    seen: set[tuple[int, tuple[float, ...]]] = set()
    instances = [root] if isinstance(root, _StandaloneMesh) else collect_mesh_instances(root)
    for instance in instances:
        key = (id(instance.mesh), instance.matrix)
        if key in seen:
            continue
        seen.add(key)
        if texture_png is None:
            texture_png = _material_texture_png(instance)
        try:
            text = instance.mesh.export()
        except Exception:
            continue
        if not isinstance(text, str) or not text.strip():
            continue
        source, texcoords, mesh_triangles = _parse_obj(text)
        if not mesh_triangles:
            continue
        if triangles + len(mesh_triangles) > MAX_TRIANGLES:
            break
        triangles += _append_geometry(
            positions,
            normals,
            uvs,
            indices,
            source,
            texcoords,
            mesh_triangles,
            instance.matrix,
        )
        meshes += 1
    if not indices:
        raise ValueError("prefab has no readable mesh geometry")
    if texture_png is None:
        texture_png = fallback_texture if fallback_texture is not None else (
            fallback_loader() if callable(fallback_loader) else None
        )

    positions_bytes = struct.pack(f"<{len(positions)}f", *positions)
    normals_bytes = struct.pack(f"<{len(normals)}f", *normals)
    uv_bytes = struct.pack(f"<{len(uvs)}f", *uvs)
    index_bytes = struct.pack(f"<{len(indices)}I", *indices)
    while len(positions_bytes) % 4:
        positions_bytes += b"\0"
    while len(normals_bytes) % 4:
        normals_bytes += b"\0"
    while len(uv_bytes) % 4:
        uv_bytes += b"\0"
    while len(index_bytes) % 4:
        index_bytes += b"\0"

    bin_parts = [positions_bytes, normals_bytes, uv_bytes, index_bytes]
    offset = sum(len(part) for part in bin_parts)
    image_padding = b""
    if texture_png is not None:
        if offset % 4:
            image_padding = b"\0" * (4 - offset % 4)
            bin_parts.append(image_padding)
            offset += len(image_padding)
        image_offset = offset
        bin_parts.append(texture_png)
        texture_padding = (4 - len(texture_png) % 4) % 4
        if texture_padding:
            bin_parts.append(b"\0" * texture_padding)
    else:
        image_offset = 0
    bin_data = b"".join(bin_parts)
    vertex_count = len(positions) // 3
    uv_count = len(uvs) // 2

    material: dict[str, Any] = {
        "name": "KOBA extracted",
        "pbrMetallicRoughness": {
            "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
            "metallicFactor": 0.12,
            "roughnessFactor": 0.72,
        },
        "doubleSided": True,
    }
    if texture_png is not None:
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}

    document: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "KOBA Studios local extractor"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": path.stem}],
        "meshes": [
            {
                "name": path.stem,
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": 0,
                            "NORMAL": 1,
                            "TEXCOORD_0": 2,
                        },
                        "indices": 3,
                        "material": 0,
                        "mode": 4,
                    }
                ],
            }
        ],
        "materials": [material],
        "buffers": [{"byteLength": len(bin_data)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(positions_bytes), "target": 34962},
            {
                "buffer": 0,
                "byteOffset": len(positions_bytes),
                "byteLength": len(normals_bytes),
                "target": 34962,
            },
            {
                "buffer": 0,
                "byteOffset": len(positions_bytes) + len(normals_bytes),
                "byteLength": len(uv_bytes),
                "target": 34962,
            },
            {
                "buffer": 0,
                "byteOffset": len(positions_bytes) + len(normals_bytes) + len(uv_bytes),
                "byteLength": len(index_bytes),
                "target": 34963,
            },
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": vertex_count,
                "type": "VEC3",
                "min": [min(positions[0::3]), min(positions[1::3]), min(positions[2::3])],
                "max": [max(positions[0::3]), max(positions[1::3]), max(positions[2::3])],
            },
            {
                "bufferView": 1,
                "componentType": 5126,
                "count": vertex_count,
                "type": "VEC3",
            },
            {
                "bufferView": 2,
                "componentType": 5126,
                "count": uv_count,
                "type": "VEC2",
            },
            {
                "bufferView": 3,
                "componentType": 5125,
                "count": len(indices),
                "type": "SCALAR",
            },
        ],
    }
    if texture_png is not None:
        document["bufferViews"].append(
            {
                "buffer": 0,
                "byteOffset": image_offset,
                "byteLength": len(texture_png),
            }
        )
        document["images"] = [{"bufferView": 4, "mimeType": "image/png"}]
        document["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        document["textures"] = [{"sampler": 0, "source": 0}]

    json_bytes = json.dumps(document, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("wb") as handle:
        handle.write(struct.pack("<III", 0x46546C67, 2, total))
        handle.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        handle.write(json_bytes)
        handle.write(struct.pack("<II", len(bin_data), 0x004E4942))
        handle.write(bin_data)
    os.replace(temporary, path)
    return vertex_count, triangles, meshes


def export_prefab_glb(
    prefab_path: str,
    bundle_root: str | Path,
    cache_dir: str | Path,
    progress: Any = None,
    bundle: str | Path | None = None,
) -> dict[str, object]:
    root = Path(bundle_root).expanduser()
    if not root.is_dir():
        raise FileNotFoundError(f"bundle folder does not exist: {root}")
    digest = prefab_hash(prefab_path)
    target = Path(cache_dir).expanduser() / f"{digest}.glb"
    if progress:
        progress("scanning-bundles", 0, 0, f"Looking for {prefab_path}")
    loaded = _root_for_path(root, prefab_path, progress, bundle=bundle)
    if loaded is None:
        raise ValueError(f"no readable prefab geometry for {prefab_path}")
    prefab_root, env = loaded
    if progress:
        progress("writing-glb", 0, 1, f"Writing {target.name}")
    vertices, triangles, meshes = _write_glb(
        target,
        prefab_root,
        fallback_loader=lambda: _fallback_texture_png(env, prefab_path),
    )
    return {
        "prefabPath": prefab_path,
        "prefabHash": digest,
        "glbPath": str(target),
        "bytes": target.stat().st_size,
        "vertices": vertices,
        "triangles": triangles,
        "meshes": meshes,
        "error": None,
    }


__all__ = ["export_obj_glb", "export_prefab_glb", "prefab_hash"]
