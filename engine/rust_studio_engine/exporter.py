"""Export a wizard draft to server-ready map/prefab files or a skin channel set.

The Tauri shell writes the current wizard draft to a temporary JSON file and
invokes ``python -m rust_studio_engine export-project``; this module is the
single implementation of the export path, shared with the CLI and tests.

Draft shape matches ``apps/desktop/ui/src/wizard/types.ts`` (camelCase).
Only fields the engine needs are read; unknown fields are ignored.
"""

from __future__ import annotations

import base64
import hashlib
from array import array
import json
import math
import random
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter

from .indexer.indexer import infer_prefab_category, prefab_id_from_path
from .map_lock import LOCK_LAYER, create_map_lock
from .procedural import TerrainSettings, apply_to_document
from .texture import export_channels, normal_map_from_height
from .world.map_file import (
    STUDIO_META_LAYER,
    build_document,
    expected_layer_sizes,
    validate_layout,
    write_document,
)
from .world.models import (
    PathInstance,
    PathNode,
    PrefabInstance,
    Vector3,
    WorldDocument,
    height_metres_to_raw,
    height_raw_to_metres,
)
from .world.terrain import (
    HeightField,
    EDITOR_TOPOLOGY_FLAGS,
    SPLAT_CHANNELS,
    biome_planes,
    decode_i32,
    decode_u16,
    encode_i32,
    encode_u16,
    mark_topology_region,
    paint_biome,
    paint_splat,
    set_alpha_region,
    set_water_level,
    splat_planes,
    store_biome,
    store_splat,
)

SPLINE_PREFIXES = {
    "road": "Road",
    "river": "River",
    "rail": "Rail",
    "apc": "APC",
    "cargo": "Cargo",
    "chinook": "Chinook",
    "powerline": "Powerline",
}

SKIN_LAYER_COLORS = {
    "metal": (63, 74, 82),
    "polymer": (34, 38, 43),
    "wood": (109, 74, 47),
    "carbon": (20, 22, 24),
    "custom": (140, 145, 150),
}


class ExportError(ValueError):
    """Raised when a draft cannot be exported."""


@dataclass
class ExportResult:
    kind: str
    path: str
    bytes: int
    channels: list[str] = field(default_factory=list)
    createdAt: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "path": self.path,
            "bytes": self.bytes,
            "channels": self.channels,
            "createdAt": self.createdAt,
        }


def export_draft(
    draft: dict[str, Any],
    *,
    output_dir: str | Path | None = None,
    data_root: str | Path | None = None,
) -> ExportResult:
    """Export ``draft`` and return where it landed."""
    if not isinstance(draft, dict) or "projectKind" not in draft:
        raise ExportError("draft must be an object with projectKind")

    export_settings = draft.get("export") or {}
    kind = str(draft["projectKind"])
    name = _slug(
        str(export_settings.get("fileName") or draft.get("name") or "untitled")
    )
    target_dir = Path(output_dir) if output_dir else _default_output_dir(export_settings, data_root)
    target_dir.mkdir(parents=True, exist_ok=True)

    if kind == "skin":
        return _export_skin(draft, name, target_dir)
    return _export_world(draft, name, target_dir, kind)


# ---------------------------------------------------------------------------
# World export
# ---------------------------------------------------------------------------


def _export_world(
    draft: dict[str, Any], name: str, target_dir: Path, kind: str
) -> ExportResult:
    settings = TerrainSettings.from_dict(draft.get("terrain") or {})
    document = apply_to_document(settings)
    placements = draft.get("placements") or []
    terrain = draft.get("terrain") or {}

    _apply_heightmap_import(document, terrain)
    # Native imports can change the map size; keep every later pass (pads,
    # splines, brushes) in the same world-space grid as the height layer.
    settings.size_metres = int(document.size)
    for placement in placements:
        _add_prefab(document, placement)

    if kind != "monument":
        _add_splines(document, draft.get("splines") or [])
        _apply_spline_corridors(document, settings, draft.get("splines") or [])
        _apply_cave_portals(document, settings, draft.get("splines") or [])

    _apply_monument_pads(document, settings, placements)
    _apply_mask_imports(document, terrain)
    _apply_slope_topology(document, settings, terrain)
    _apply_terrain_strokes(document, settings, terrain)
    set_water_level(document, float(settings.water_level))

    meta = {
        "studio": "rust-studio",
        "version": 1,
        "projectName": draft.get("name"),
        "mode": draft.get("mode", "offline"),
        "seed": settings.seed,
        "preset": settings.preset,
        "loot": draft.get("loot"),
        "io": draft.get("io") or {},
        "vendingOverrides": (draft.get("io") or {}).get("vendingOverrides") or [],
        "placements": [
            {
                "id": placement.get("id"),
                "assetId": placement.get("assetId"),
                "name": placement.get("name"),
                "ioWiring": placement.get("ioWiring") or "",
                "lootTier": placement.get("lootTier"),
                "lootProfile": placement.get("lootProfile") or "",
                "npcCount": placement.get("npcCount") or 0,
                "collisionRadius": placement.get("collisionRadius"),
                "collisionHeight": placement.get("collisionHeight"),
            }
            for placement in placements
        ],
        "slopeTopology": terrain.get("slopeTopology") or [],
        "splines": [
            {
                "id": spline.get("id"),
                "name": spline.get("name"),
                "kind": spline.get("kind"),
                "curve": spline.get("curve", "catmull-rom"),
                "width": spline.get("width"),
                "ceilingHeight": spline.get("ceilingHeight"),
                "roughness": spline.get("roughness"),
                "nodes": spline.get("nodes") or [],
            }
            for spline in (draft.get("splines") or [])
        ],
        "export": {
            "mapLock": bool((draft.get("export") or {}).get("mapLock")),
            # Never write the password itself into the exported map.
        },
    }
    document.layers[STUDIO_META_LAYER] = json.dumps(meta).encode("utf-8")

    lock_record: dict[str, Any] | None = None
    export_settings = draft.get("export") or {}
    if kind != "monument" and bool(export_settings.get("mapLock")):
        password = str(export_settings.get("mapPassword") or "")
        if len(password) < 6:
            raise ExportError("map lock requires a password of at least 6 characters")
        lock_record = create_map_lock(
            password,
            {
                "project": draft.get("name"),
                "file": name,
                "createdAt": _now(),
            },
        )
        document.layers[LOCK_LAYER] = json.dumps(lock_record).encode("utf-8")

    if _strip_editor_data(draft):
        document.layers.pop(STUDIO_META_LAYER, None)

    issues = [issue for issue in validate_layout(document) if issue["severity"] == "error"]
    if issues:
        raise ExportError("; ".join(issue["message"] for issue in issues))
    layer_bytes = sum(len(blob) for blob in document.layers.values())
    if layer_bytes > MAX_EXPORT_LAYER_BYTES:
        raise ExportError(
            f"export layers need {layer_bytes // (1024 * 1024)} MiB, above the "
            f"{MAX_EXPORT_LAYER_BYTES // (1024 * 1024)} MiB safety limit"
        )

    if kind == "monument":
        prefab_only = WorldDocument(
            size=document.size,
            layers={STUDIO_META_LAYER: document.layers[STUDIO_META_LAYER]}
            if STUDIO_META_LAYER in document.layers
            else {},
            prefabs=document.prefabs,
        )
        path = target_dir / f"{name}.prefab"
        write_document(path, prefab_only)
        return ExportResult(
            kind="prefab",
            path=str(path),
            bytes=path.stat().st_size,
            createdAt=_now(),
        )

    path = target_dir / f"{name}.map"
    write_document(path, document)
    if lock_record is not None:
        sidecar = {
            **lock_record,
            "map": path.name,
            "mapSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "mapBytes": path.stat().st_size,
        }
        (target_dir / f"{name}.map.lock").write_text(
            json.dumps(sidecar, indent=2), encoding="utf-8"
        )
    return ExportResult(kind="map", path=str(path), bytes=path.stat().st_size, createdAt=_now())


def _add_prefab(document: WorldDocument, placement: dict[str, Any]) -> None:
    asset_id = str(placement.get("assetId") or "")
    category = infer_prefab_category(asset_id)
    if category == "Other":
        category = "Monument" if "monument" in asset_id.lower() else "Decor"
    position = _vector(placement.get("position"), 0.0)
    rotation = _vector(placement.get("rotationEuler"), 0.0)
    scale = _vector(placement.get("scale"), 1.0)
    document.prefabs.append(
        PrefabInstance(
            category=category,
            prefab_id=prefab_id_from_path(asset_id) if asset_id else 0,
            position=position,
            rotation=rotation,
            scale=scale,
        )
    )


def _add_splines(document: WorldDocument, splines: list[dict[str, Any]]) -> None:
    counters: dict[str, int] = {}
    for spline in splines:
        nodes = spline.get("nodes") or []
        if len(nodes) < 2:
            continue
        kind = str(spline.get("kind") or "road")
        prefix = SPLINE_PREFIXES.get(kind, "Path")
        index = counters.get(prefix, 0)
        counters[prefix] = index + 1
        path = PathInstance(
            name=str(spline.get("name") or f"{prefix} {index}"),
            width=float(spline.get("width") or 6.0),
            # Rust paths have no closed flag; a loop is expressed with coincident
            # start/end nodes that the terrain pass closes.
            start=bool(spline.get("closed")),
            end=bool(spline.get("closed")),
            splat=4 if kind == "road" else 2,
            topology=0,
            nodes=[
                PathNode(
                    Vector3(
                        float(node.get("x", 0.0)),
                        float(node.get("y", 0.0)),
                        float(node.get("z", 0.0)),
                    )
                )
                for node in nodes
            ],
        )
        document.paths.append(path)


MAX_NATIVE_RESOLUTION = 4097
MAX_EXPORT_LAYER_BYTES = 512 * 1024 * 1024

# Pillow 9.1+ exposes the filters under Image.Resampling while keeping the
# module-level aliases; resolve both so older pinned Pillows still work.
_RESAMPLING = getattr(Image, "Resampling", Image)
_MASK_DOWNSAMPLE = _RESAMPLING.BOX
_MASK_UPSAMPLE = _RESAMPLING.BILINEAR


def _resize_byte_planes(
    data: bytes, channels: int, old_resolution: int, new_resolution: int
) -> bytes:
    """Nearest-neighbour resize for splat/biome/topology planes."""
    if old_resolution == new_resolution:
        return data
    out = bytearray(channels * new_resolution * new_resolution)
    for z in range(new_resolution):
        sz = min(old_resolution - 1, round(z / max(1, new_resolution - 1) * (old_resolution - 1)))
        for x in range(new_resolution):
            sx = min(old_resolution - 1, round(x / max(1, new_resolution - 1) * (old_resolution - 1)))
            source = (sz * old_resolution + sx) * channels
            target = (z * new_resolution + x) * channels
            out[target : target + channels] = data[source : source + channels]
    return bytes(out)


def _resize_document_for_size(document: WorldDocument, new_size: int) -> None:
    """Resize every terrain layer so the map format stays internally consistent."""
    old_size = int(document.size)
    if old_size == new_size:
        return
    old_height = HeightField.from_document(document)
    new_resolution = new_size + 1
    values = array("H", [0]) * (new_resolution * new_resolution)
    for z in range(new_resolution):
        sz = min(old_height.resolution - 1, round(z / max(1, new_resolution - 1) * (old_height.resolution - 1)))
        for x in range(new_resolution):
            sx = min(old_height.resolution - 1, round(x / max(1, new_resolution - 1) * (old_height.resolution - 1)))
            values[z * new_resolution + x] = old_height.values[sz * old_height.resolution + sx]
    document.size = new_size
    document.layers["terrain"] = encode_u16(values)
    document.layers["height"] = encode_u16(values)
    for name, channels in (("splat", 8), ("biome", 4), ("topology", 4), ("alpha", 1)):
        blob = document.layers.get(name)
        if not blob:
            continue
        old_resolution = int(round((len(blob) / channels) ** 0.5))
        target = expected_layer_sizes(new_size)[name][1]
        target_resolution = int(round(target ** 0.5))
        document.layers[name] = _resize_byte_planes(
            blob, channels, old_resolution, target_resolution
        )
    water = document.layers.get("water")
    if water:
        old_values = decode_u16(water)
        old_resolution = int(round(len(old_values) ** 0.5))
        resized = array("H", [0]) * (new_resolution * new_resolution)
        for z in range(new_resolution):
            sz = min(old_resolution - 1, round(z / max(1, new_resolution - 1) * (old_resolution - 1)))
            for x in range(new_resolution):
                sx = min(old_resolution - 1, round(x / max(1, new_resolution - 1) * (old_resolution - 1)))
                resized[z * new_resolution + x] = old_values[sz * old_resolution + sx]
        document.layers["water"] = encode_u16(resized)


def _apply_heightmap_import(document: WorldDocument, terrain: dict[str, Any]) -> None:
    imported = terrain.get("heightmap")
    if not isinstance(imported, dict):
        return
    try:
        resolution = int(imported.get("resolution") or 0)
        payload = base64.b64decode(str(imported.get("data") or ""))
    except (ValueError, TypeError) as exc:
        raise ExportError(f"heightmap import is corrupt: {exc}") from exc
    if resolution > MAX_NATIVE_RESOLUTION:
        raise ExportError(
            f"heightmap import is {resolution}²; native exports support at most {MAX_NATIVE_RESOLUTION}²"
        )
    values = decode_u16(payload)
    if resolution < 2 or len(values) < resolution * resolution:
        raise ExportError("heightmap import is not a square 16-bit grid")
    estimated = 2 * resolution * resolution
    if estimated > MAX_EXPORT_LAYER_BYTES:
        raise ExportError(
            f"heightmap import needs {estimated // (1024 * 1024)} MiB for one layer; "
            "split the map or use a 2049² source"
        )
    scale = float(imported.get("verticalScale") or 1.0)

    if resolution >= 1025:
        # Preserve the native grid instead of resampling it into the generated
        # 4501² layer. The map size follows the native resolution so validation
        # and the layer layout stay consistent.
        _resize_document_for_size(document, resolution - 1)
        native = array(
            "H",
            (
                height_metres_to_raw(value / 65535.0 * 1000.0 * scale)
                for value in values[: resolution * resolution]
            ),
        )
        encoded = encode_u16(native)
        document.layers["terrain"] = encoded
        document.layers["height"] = encoded
        return

    field = HeightField.from_document(document)
    for iz in range(field.resolution):
        v = iz / max(1, field.resolution - 1) * (resolution - 1)
        z0 = min(resolution - 1, int(v))
        z1 = min(resolution - 1, z0 + 1)
        tz = v - z0
        for ix in range(field.resolution):
            u = ix / max(1, field.resolution - 1) * (resolution - 1)
            x0 = min(resolution - 1, int(u))
            x1 = min(resolution - 1, x0 + 1)
            tx = u - x0
            top = values[z0 * resolution + x0] * (1 - tx) + values[z0 * resolution + x1] * tx
            bottom = values[z1 * resolution + x0] * (1 - tx) + values[z1 * resolution + x1] * tx
            raw = top * (1 - tz) + bottom * tz
            metres = raw / 65535.0 * 1000.0 * scale
            field.values[iz * field.resolution + ix] = height_metres_to_raw(metres)
    field.store(document)


def _resample_mask(data: bytes, resolution: int, target_resolution: int) -> bytes:
    """Map a native mask onto the layer grid without discarding detail.

    Exact grids are copied byte for byte. Larger sources are box-averaged over
    each target texel's footprint instead of point-sampled, so a 4097² mask
    keeps its coverage when it lands on a 2048² splat/biome/topology layer.
    Smaller sources are interpolated so they do not turn into blocky steps.
    """
    if resolution == target_resolution:
        return data[: resolution * resolution]
    source = bytes(data[: resolution * resolution])
    image = Image.frombytes("L", (resolution, resolution), source)
    resample = _MASK_DOWNSAMPLE if resolution > target_resolution else _MASK_UPSAMPLE
    return image.resize((target_resolution, target_resolution), resample).tobytes()


def _apply_mask_imports(document: WorldDocument, terrain: dict[str, Any]) -> None:
    masks = terrain.get("masks") or []
    if not masks:
        return
    splat = splat_planes(document)
    biome = biome_planes(document)
    topology = decode_i32(document.layers["topology"])
    alpha = bytearray(document.layers["alpha"])
    splat_resolution = int(round(len(splat[0]) ** 0.5))
    topology_bits = list(EDITOR_TOPOLOGY_FLAGS.values())

    for mask in masks:
        try:
            resolution = int(mask.get("resolution") or 0)
            data = base64.b64decode(str(mask.get("data") or ""))
        except (ValueError, TypeError):
            continue
        if resolution > MAX_NATIVE_RESOLUTION:
            raise ExportError(
                f"mask import is {resolution}²; native exports support at most {MAX_NATIVE_RESOLUTION}²"
            )
        if resolution < 2 or len(data) < resolution * resolution:
            continue
        kind = str(mask.get("kind") or "splat")
        channel = max(0, min(7, int(mask.get("channel") or 0)))
        target_resolution = splat_resolution if kind != "alpha" else int(round(len(alpha) ** 0.5))
        target = alpha if kind == "alpha" else None
        # Keep the imported native grid; only the final stamp uses the layer grid.
        values = _resample_mask(data, resolution, target_resolution)
        for index, value in enumerate(values):
            if value <= 0:
                continue
            if kind == "splat":
                plane = splat[channel]
                plane[index] = min(255, int(plane[index] + (255 - plane[index]) * value / 255))
            elif kind == "biome":
                for other in range(4):
                    value_other = biome[other][index]
                    biome[other][index] = (
                        min(255, int(value_other + (255 - value_other) * value / 255))
                        if other == channel
                        else int(value_other * (1 - value / 255 * 0.85))
                    )
            elif kind == "topology":
                if index < len(topology) and value > 127:
                    topology[index] = int(topology[index]) | topology_bits[min(len(topology_bits) - 1, channel)]
            elif target is not None:
                target[index] = min(target[index], 255 - value)
    if any(str(mask.get("kind")) == "splat" for mask in masks):
        from .world.terrain import normalize_splat

        normalize_splat(splat)
        store_splat(document, splat)
    if any(str(mask.get("kind")) == "biome" for mask in masks):
        store_biome(document, biome)
    if any(str(mask.get("kind")) == "topology" for mask in masks):
        document.layers["topology"] = encode_i32(topology)
    if any(str(mask.get("kind")) == "alpha" for mask in masks):
        document.layers["alpha"] = bytes(alpha)


def _apply_slope_topology(
    document: WorldDocument, settings: TerrainSettings, terrain: dict[str, Any]
) -> None:
    rules = terrain.get("slopeTopology") or []
    if not rules:
        return
    field = HeightField.from_document(document)
    topology = decode_i32(document.layers["topology"])
    topology_resolution = int(round(len(topology) ** 0.5))
    scale = (topology_resolution - 1) / max(1, field.resolution - 1)
    for z in range(1, field.resolution - 1):
        for x in range(1, field.resolution - 1):
            index = z * field.resolution + x
            left = field.values[index - 1]
            right = field.values[index + 1]
            up = field.values[index - field.resolution]
            down = field.values[index + field.resolution]
            dx = (height_raw_to_metres(right) - height_raw_to_metres(left)) / (2 * field.texel_size)
            dz = (height_raw_to_metres(down) - height_raw_to_metres(up)) / (2 * field.texel_size)
            slope = math.degrees(math.atan(math.hypot(dx, dz)))
            mask = 0
            for rule in rules:
                try:
                    minimum = float(rule.get("minSlope", 0))
                    maximum = float(rule.get("maxSlope", 90))
                except (TypeError, ValueError):
                    continue
                if minimum <= slope <= maximum:
                    for flag in rule.get("flags") or []:
                        mask |= EDITOR_TOPOLOGY_FLAGS.get(str(flag), 0)
            if mask:
                tx = min(topology_resolution - 1, int(round(x * scale)))
                tz = min(topology_resolution - 1, int(round(z * scale)))
                topology[tz * topology_resolution + tx] |= mask
    document.layers["topology"] = encode_i32(topology)


def _stroke_plan(terrain: dict[str, Any]) -> list[tuple[dict[str, Any], float]]:
    """Visible layers in replay order with their opacity.

    Projects saved before layers carry a flat `strokes` history; they replay at
    full strength exactly as they always did.
    """
    layers = terrain.get("layers") or []
    if not layers:
        return [(stroke, 1.0) for stroke in terrain.get("strokes") or []]
    plan: list[tuple[dict[str, Any], float]] = []
    for layer in layers:
        if not isinstance(layer, dict) or layer.get("visible") is False:
            continue
        try:
            opacity = float(layer.get("opacity", 1.0))
        except (TypeError, ValueError):
            opacity = 1.0
        opacity = max(0.0, min(1.0, opacity))
        if opacity <= 0.0:
            continue
        for stroke in layer.get("strokes") or []:
            if isinstance(stroke, dict):
                plan.append((stroke, opacity))
    return plan


def _apply_terrain_strokes(
    document: WorldDocument, settings: TerrainSettings, terrain: dict[str, Any]
) -> None:
    plan = _stroke_plan(terrain)
    if not plan:
        return
    field = HeightField.from_document(document)
    splat = splat_planes(document)
    biome = biome_planes(document)
    topology = decode_i32(document.layers["topology"])
    alpha = bytearray(document.layers["alpha"])
    splat_resolution = int(round(len(splat[0]) ** 0.5))
    topology_resolution = int(round(len(topology) ** 0.5))
    height_modes = {"raise", "lower", "smooth", "flatten"}

    for stroke, layer_opacity in plan:
        try:
            x = float(stroke.get("x") or 0.0)
            z = float(stroke.get("z") or 0.0)
            radius = max(0.1, float(stroke.get("radius") or 4.0))
            strength = float(stroke.get("strength") or 1.0)
            falloff = float(stroke.get("falloff") or 2.0)
            mode = str(stroke.get("mode") or "raise")
            sync = stroke.get("sync") or {}
        except (TypeError, ValueError):
            continue
        height_active = mode in height_modes or bool(sync.get("height"))
        height_mode = mode if mode in height_modes else "flatten"
        if height_active:
            target = field.average_height(x, z, radius) if height_mode == "flatten" else None
            field.apply_brush(
                x,
                z,
                radius,
                strength=strength * layer_opacity,
                mode=height_mode,
                falloff=falloff,
                target_height=target,
            )
        if mode == "splat" or sync.get("splat"):
            channel = SPLAT_CHANNELS.index(str(stroke.get("splatChannel") or "grass")) if str(stroke.get("splatChannel") or "grass") in SPLAT_CHANNELS else 4
            paint_splat(splat, splat_resolution, float(settings.size_metres), x, z, radius, channel, min(1.0, strength / 2) * layer_opacity)
        if sync.get("biome"):
            channel = ("arid", "temperate", "tundra", "arctic").index(str(stroke.get("biomeChannel") or "temperate")) if str(stroke.get("biomeChannel") or "temperate") in ("arid", "temperate", "tundra", "arctic") else 1
            paint_biome(biome, splat_resolution, float(settings.size_metres), x, z, radius, channel, 0.55 * layer_opacity)
        # Masks are boolean: a layer under half opacity leaves them untouched.
        if (mode == "topology" or sync.get("topology")) and layer_opacity >= 0.5:
            flags = [str(flag) for flag in stroke.get("topologyFlags") or [] if str(flag) in EDITOR_TOPOLOGY_FLAGS]
            clear = [str(flag) for flag in stroke.get("topologyClearFlags") or [] if str(flag) in EDITOR_TOPOLOGY_FLAGS]
            if flags:
                mark_topology_region(topology, topology_resolution, float(settings.size_metres), x, z, radius, flags)
            if clear:
                mark_topology_region(topology, topology_resolution, float(settings.size_metres), x, z, radius, clear, clear=True)
        if (mode == "alpha" or sync.get("alpha")) and layer_opacity >= 0.5:
            set_alpha_region(alpha, int(round(len(alpha) ** 0.5)), float(settings.size_metres), x, z, radius, 0)

    field.store(document)
    store_splat(document, splat)
    store_biome(document, biome)
    document.layers["topology"] = encode_i32(topology)
    document.layers["alpha"] = bytes(alpha)


def _apply_cave_portals(
    document: WorldDocument, settings: TerrainSettings, splines: list[dict[str, Any]]
) -> None:
    """Cut alpha holes where a cave path breaks the surface.

    Mirrors `applyCavePortals` in the editor preview: a tunnel is only open once
    its axis comes within a ceiling of the ground, so deep tunnels keep their
    roof and entrances line up with the rendered shell.
    """
    caves = [
        spline
        for spline in splines
        if str(spline.get("kind")) == "cave" and len(spline.get("nodes") or []) >= 2
    ]
    if not caves:
        return
    from .spline import sample_bezier, smooth_path

    field = HeightField.from_document(document)
    alpha = bytearray(document.layers["alpha"])
    resolution = int(round(len(alpha) ** 0.5))

    for cave in caves:
        nodes = cave.get("nodes") or []
        points = [
            (float(node.get("x", 0.0)), float(node.get("y", 0.0)), float(node.get("z", 0.0)))
            for node in nodes
        ]
        curve = str(cave.get("curve") or "catmull-rom")
        closed = bool(cave.get("closed"))
        sampled = (
            sample_bezier(points, closed=closed)
            if curve == "bezier"
            else smooth_path(points, spacing=8.0, closed=closed)
        )
        width = max(2.0, float(cave.get("width") or 9.0))
        ceiling = max(3.0, float(cave.get("ceilingHeight") or 7.0))
        roughness = min(1.0, max(0.0, float(cave.get("roughness") or 0.3)))
        for index, (x, y, z) in enumerate(sampled):
            if abs(x) > settings.size_metres / 2 or abs(z) > settings.size_metres / 2:
                continue
            surface = field.sample(x, z)
            # Spec trigger: roof = axisY + height / 2, cut within 0.5 m of the ground.
            if y + ceiling * 0.5 < surface - 0.5:
                continue
            wobble = max(0.6, 1 + math.sin(index * 12.9898 + len(nodes)) * 0.5 * roughness)
            radius = max(1.5, width * 0.65 * wobble)
            set_alpha_region(alpha, resolution, float(settings.size_metres), x, z, radius, 0)

    document.layers["alpha"] = bytes(alpha)


def _apply_spline_corridors(
    document: WorldDocument, settings: TerrainSettings, splines: list[dict[str, Any]]
) -> None:
    if not splines:
        return
    from .spline import smooth_path, sample_bezier

    field = HeightField.from_document(document)
    splat = splat_planes(document)
    biome = biome_planes(document)
    topology = decode_i32(document.layers["topology"])
    splat_resolution = int(round(len(splat[0]) ** 0.5))
    topology_resolution = int(round(len(topology) ** 0.5))
    splat_by_kind = {"road": "gravel", "river": "sand", "rail": "stones", "apc": "dirt", "cargo": "dirt", "chinook": "dirt", "powerline": "gravel"}

    for spline in splines:
        if not spline.get("deformTerrain", True) and not spline.get("paintSplat", True):
            continue
        nodes = spline.get("nodes") or []
        if len(nodes) < 2:
            continue
        points = [(float(node.get("x", 0.0)), 0.0, float(node.get("z", 0.0))) for node in nodes]
        curve = str(spline.get("curve") or "catmull-rom")
        closed = bool(spline.get("closed"))
        sampled = sample_bezier(points, closed=closed) if curve == "bezier" else smooth_path(points, spacing=8.0, closed=closed)
        width = max(1.0, float(spline.get("width") or 6.0))
        channel = SPLAT_CHANNELS.index(splat_by_kind.get(str(spline.get("kind")), "gravel"))
        topology_flag = str(spline.get("topologyFlag") or "")
        in_bounds = [
            point for point in sampled
            if abs(point[0]) <= settings.size_metres / 2 and abs(point[2]) <= settings.size_metres / 2
        ]
        heights = [field.sample(x, z) for x, _y, z in in_bounds]
        window = max(1, min(24, int(width / 4)))
        profile: list[float] = []
        for index in range(len(heights)):
            start, end = max(0, index - window), min(len(heights), index + window + 1)
            profile.append(sum(heights[start:end]) / max(1, end - start))
        for index, (x, _y, z) in enumerate(in_bounds):
            if spline.get("deformTerrain", True):
                field.flatten_pad(
                    x,
                    z,
                    radius=width * 0.5,
                    falloff_width=6.0,
                    target_height=profile[index],
                )
            if spline.get("paintSplat", True):
                paint_splat(splat, splat_resolution, float(settings.size_metres), x, z, width * 0.5 + 4, channel, 0.85)
                paint_biome(biome, splat_resolution, float(settings.size_metres), x, z, width * 0.5 + 4, 1, 0.2)
            if topology_flag in EDITOR_TOPOLOGY_FLAGS:
                mark_topology_region(topology, topology_resolution, float(settings.size_metres), x, z, width * 0.5 + 3, [topology_flag])

    field.store(document)
    store_splat(document, splat)
    store_biome(document, biome)
    document.layers["topology"] = encode_i32(topology)


def _apply_monument_pads(
    document: WorldDocument, settings: TerrainSettings, placements: list[dict[str, Any]]
) -> None:
    if not placements:
        return
    field = HeightField.from_document(document)
    topology = decode_i32(document.layers["topology"])
    topology_resolution = int(math.sqrt(len(topology)))
    splat = splat_planes(document)
    biome = biome_planes(document)
    splat_resolution = int(round(len(splat[0]) ** 0.5))

    for placement in placements:
        position = placement.get("position") or {}
        x = float(position.get("x", 0.0))
        z = float(position.get("z", 0.0))
        radius = float(placement.get("flattenRadius") or 40.0)
        asset = f"{placement.get('assetId', '')} {placement.get('name', '')}".lower()
        if any(word in asset for word in ("tree", "forest", "bush", "oak", "pine")):
            splat_channel, biome_channel = 5, 1
        elif any(word in asset for word in ("rock", "cliff", "stone", "ore", "boulder")):
            splat_channel, biome_channel = 6, 2
        elif any(word in asset for word in ("sand", "beach", "desert", "dune")):
            splat_channel, biome_channel = 2, 0
        elif any(word in asset for word in ("snow", "ice", "arctic")):
            splat_channel, biome_channel = 1, 3
        else:
            splat_channel, biome_channel = 7, 1
        if placement.get("flatten", True):
            paint_splat(
                splat,
                splat_resolution,
                float(settings.size_metres),
                x,
                z,
                radius * 1.15,
                splat_channel,
                0.72,
            )
            paint_biome(
                biome,
                splat_resolution,
                float(settings.size_metres),
                x,
                z,
                radius * 1.15,
                biome_channel,
                0.35,
            )
            field.flatten_pad(
                x,
                z,
                radius=radius,
                falloff_width=float(placement.get("flattenFalloff") or 18.0),
            )
        if placement.get("clearFoliage", True):
            mark_topology_region(
                topology,
                topology_resolution,
                float(settings.size_metres),
                x,
                z,
                radius * 1.15,
                ["foliage_cleared", "monument_pad"],
            )
        if placement.get("noBuildZone", True):
            mark_topology_region(
                topology,
                topology_resolution,
                float(settings.size_metres),
                x,
                z,
                radius,
                ["no_build"],
            )

    field.store(document)
    store_splat(document, splat)
    store_biome(document, biome)
    document.layers["topology"] = encode_i32(topology)


# ---------------------------------------------------------------------------
# Skin export
# ---------------------------------------------------------------------------


def _export_skin(draft: dict[str, Any], name: str, target_dir: Path) -> ExportResult:
    skin = draft.get("skin") or {}
    resolution = int(skin.get("resolution") or 2048)
    if resolution not in (1024, 2048):
        raise ExportError("skin resolution must be 1024 or 2048")
    layers = [layer for layer in skin.get("layers") or [] if layer.get("enabled", True)]
    wear = skin.get("wear") or {}

    diffuse = _skin_diffuse(layers, skin.get("decals") or [], resolution, wear)
    normal = normal_map_from_height(diffuse.convert("L"), strength=0.8)
    specular = _skin_specular(layers, resolution)
    emission_strength = float(wear.get("emissionStrength") or 0.0)
    emission = _skin_emission(emission_strength, resolution)

    written = export_channels(
        name,
        {
            "diffuse": diffuse,
            "normal": normal,
            "specular": specular,
            "emission": emission,
        },
        target_dir,
        resolution,
    )
    total_bytes = sum(Path(path).stat().st_size for path in written.values())
    primary = Path(written["diffuse"])
    return ExportResult(
        kind="skin",
        path=str(primary),
        bytes=total_bytes,
        channels=["diffuse", "normal", "specular", "emission"],
        createdAt=_now(),
    )


def _skin_diffuse(
    layers: list[dict[str, Any]],
    decals: list[dict[str, Any]],
    resolution: int,
    wear: dict[str, Any],
) -> Image.Image:
    top = layers[-1] if layers else None
    color = _hex_color(top.get("baseColor") if top else "#5a6068")
    image = Image.new("RGBA", (resolution, resolution), (*color, 255))
    draw = ImageDraw.Draw(image)

    # Subtle procedural grain so a flat layer still reads as a surface.
    rng = random.Random(19)
    step = max(2, resolution // 256)
    for _ in range(resolution * 3):
        x = rng.randrange(0, resolution, step)
        y = rng.randrange(0, resolution, step)
        delta = rng.randint(-10, 10)
        draw.point((x, y), fill=tuple(max(0, min(255, channel + delta)) for channel in color) + (255,))

    # Edge darkening approximates ambient occlusion on a wrapped surface.
    vignette = Image.new("L", (resolution, resolution), 0)
    vdraw = ImageDraw.Draw(vignette)
    inset = int(resolution * 0.08)
    vdraw.rectangle((inset, inset, resolution - inset, resolution - inset), fill=255)
    vignette = vignette.filter(ImageFilter.GaussianBlur(resolution * 0.06))
    dark = Image.new("RGBA", image.size, (0, 0, 0, 0))
    dark.putalpha(vignette.point(lambda value: int((255 - value) * 0.35)))
    image = Image.alpha_composite(image, dark)

    # Grime streaks.
    grunge = float(wear.get("grunge") or 0.0)
    if grunge > 0:
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        odraw = ImageDraw.Draw(overlay)
        for index in range(int(14 * grunge) + 1):
            x = int((index + 1) / (14 * grunge + 2) * resolution)
            width = max(1, int(resolution * 0.004))
            odraw.line(
                (x, 0, x + resolution * 0.12, resolution),
                fill=(24, 20, 16, int(60 * grunge)),
                width=width,
            )
        overlay = overlay.filter(ImageFilter.GaussianBlur(resolution * 0.01))
        image = Image.alpha_composite(image, overlay)

    # Decals are baked at deterministic anchors; the live 3D projection is
    # resolved in the viewport, but the exported diffuse needs the stamp.
    for index, decal in enumerate(decals):
        _draw_stamp(draw, decal, resolution, index)

    return image


def _draw_stamp(
    draw: ImageDraw.ImageDraw, decal: dict[str, Any], resolution: int, index: int
) -> None:
    color = _hex_color(decal.get("color") or "#d7dde5")
    size = max(8, int(float(decal.get("size") or 120) * resolution / 2048))
    cx = int(resolution * (0.32 + 0.12 * (index % 4)))
    cy = int(resolution * (0.4 + 0.08 * ((index // 4) % 3)))
    stamp = decal.get("stamp")

    if stamp == "stripe":
        draw.rectangle((cx - size, cy - size * 0.18, cx + size, cy + size * 0.18), fill=(*color, 255))
    elif stamp == "hazard":
        draw.rectangle((cx - size, cy - size * 0.4, cx + size, cy + size * 0.4), fill=(*color, 255))
        for offset in range(-size, size, max(6, size // 6)):
            draw.line(
                (cx + offset, cy + size * 0.4, cx + offset + size * 0.4, cy - size * 0.4),
                fill=(20, 20, 20, 255),
                width=max(2, size // 12),
            )
    elif stamp == "circle":
        draw.ellipse(
            (cx - size * 0.6, cy - size * 0.6, cx + size * 0.6, cy + size * 0.6),
            outline=(*color, 255),
            width=max(2, size // 8),
        )
    elif stamp == "number":
        draw.text((cx - size * 0.3, cy - size * 0.5), "07", fill=(*color, 255))
    else:
        for line in range(6):
            y = cy + (line - 3) * max(3, size // 12)
            draw.line((cx - size * 0.5, y, cx + size * 0.5, y + size * 0.04), fill=(*color, 255), width=2)


def _skin_specular(layers: list[dict[str, Any]], resolution: int) -> Image.Image:
    top = layers[-1] if layers else {}
    smoothness = float(top.get("smoothness", 0.5))
    value = int(max(0.0, min(1.0, smoothness)) * 255)
    image = Image.new("RGB", (resolution, resolution), (value, value, value))
    return image.convert("RGBA")


def _skin_emission(strength: float, resolution: int) -> Image.Image:
    if strength <= 0:
        return Image.new("RGBA", (resolution, resolution), (0, 0, 0, 255))
    value = int(min(1.0, strength) * 255)
    return Image.new("RGBA", (resolution, resolution), (120, 180, 255, value))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _strip_editor_data(draft: dict[str, Any]) -> bool:
    return bool((draft.get("export") or {}).get("stripEditorData", True))


def _vector(value: Any, default: float) -> Vector3:
    if not isinstance(value, dict):
        return Vector3(default, default, default)
    return Vector3(
        float(value.get("x", default)),
        float(value.get("y", default)),
        float(value.get("z", default)),
    )


def _hex_color(value: Any) -> tuple[int, int, int]:
    text = str(value or "#5a6068").lstrip("#")
    if len(text) == 3:
        text = "".join(channel * 2 for channel in text)
    if len(text) != 6:
        return (90, 96, 104)
    try:
        return tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return (90, 96, 104)


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")
    return cleaned[:64] or "untitled"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _default_output_dir(export_settings: dict[str, Any], data_root: str | Path | None) -> Path:
    configured = export_settings.get("outputDir") if export_settings else None
    if configured:
        return Path(str(configured))
    root = Path(data_root) if data_root else Path(__file__).resolve().parents[2]
    return root / "data" / "exports"


def load_draft(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    # The Tauri save format nests the draft; accept both shapes.
    if isinstance(data, dict) and "draft" in data and isinstance(data["draft"], dict):
        return data["draft"]
    if not isinstance(data, dict):
        raise ExportError("draft JSON must be an object")
    return data


__all__ = ["ExportError", "ExportResult", "export_draft", "load_draft"]
