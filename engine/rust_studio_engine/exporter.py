"""Export a wizard draft to server-ready map/prefab files or a skin channel set.

The Tauri shell writes the current wizard draft to a temporary JSON file and
invokes ``python -m rust_studio_engine export-project``; this module is the
single implementation of the export path, shared with the CLI and tests.

Draft shape matches ``apps/desktop/ui/src/wizard/types.ts`` (camelCase).
Only fields the engine needs are read; unknown fields are ignored.
"""

from __future__ import annotations

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
from .procedural import TerrainSettings, apply_to_document
from .texture import export_channels, normal_map_from_height
from .world.map_file import (
    STUDIO_META_LAYER,
    build_document,
    validate_layout,
    write_document,
)
from .world.models import PathInstance, PathNode, PrefabInstance, Vector3, WorldDocument
from .world.terrain import (
    HeightField,
    decode_i32,
    encode_i32,
    mark_topology_region,
    set_water_level,
    splat_planes,
)

SPLINE_PREFIXES = {
    "road": "Road",
    "river": "River",
    "rail": "Rail",
    "apc": "APC",
    "cargo": "Cargo",
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

    for placement in placements:
        _add_prefab(document, placement)

    if kind != "monument":
        _add_splines(document, draft.get("splines") or [])

    _apply_monument_pads(document, settings, placements)
    set_water_level(document, float(settings.water_level))

    meta = {
        "studio": "rust-studio",
        "version": 1,
        "projectName": draft.get("name"),
        "mode": draft.get("mode", "offline"),
        "seed": settings.seed,
        "preset": settings.preset,
        "loot": draft.get("loot"),
        "export": {
            "mapLock": bool((draft.get("export") or {}).get("mapLock")),
            # Never write the password itself into the exported map.
        },
    }
    document.layers[STUDIO_META_LAYER] = json.dumps(meta).encode("utf-8")

    if _strip_editor_data(draft):
        document.layers.pop(STUDIO_META_LAYER, None)

    issues = [issue for issue in validate_layout(document) if issue["severity"] == "error"]
    if issues:
        raise ExportError("; ".join(issue["message"] for issue in issues))

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


def _apply_monument_pads(
    document: WorldDocument, settings: TerrainSettings, placements: list[dict[str, Any]]
) -> None:
    if not placements:
        return
    field = HeightField.from_document(document)
    topology = decode_i32(document.layers["topology"])
    topology_resolution = int(math.sqrt(len(topology)))

    for placement in placements:
        position = placement.get("position") or {}
        x = float(position.get("x", 0.0))
        z = float(position.get("z", 0.0))
        radius = float(placement.get("flattenRadius") or 40.0)
        if placement.get("flatten", True):
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
