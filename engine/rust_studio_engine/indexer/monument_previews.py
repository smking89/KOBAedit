"""Render real monument previews from the shipped terrain height maps.

Monument scene meshes are not part of the shipped bundles: Rust assembles a
monument at runtime from world-map data. What *is* shipped for every monument is
its terrain masks in ``monuments.bundle`` (``heighttexture.png`` and friends
under ``assets/scenes/prefabs/<group>/<scene>/``). This module turns those height
maps into shaded relief thumbnails, so a monument card can show the real shape
of its terrain instead of an identical stand-in box.

The PNGs are written straight into the desktop app's thumbnail cache, keyed by
the same prefab hash the UI asks for, so no database column or UI change is
needed for them to appear.
"""

from __future__ import annotations

import math
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Sequence

from PIL import Image

from .prefab_bounds import read_container
from .prefab_glb import prefab_hash
from .unity_bundle import load_bundle

MAX_EDGE = 288
MIN_MATCH_RATIO = 0.86
HEIGHT_TEXTURE = "heighttexture.png"

# Light from the north-west, 45 degrees above the horizon; the standard
# cartographic shading direction used for relief maps.
_LIGHT = (-0.5, -0.5, 0.7071)


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _terrain_folders(container: Iterable[Any]) -> dict[str, tuple[str, str]]:
    """Map normalized scene name -> (folder path, container path of height map)."""
    folders: dict[str, tuple[str, str]] = {}
    for entry in container:
        path = str(entry.path)
        if not path.lower().endswith("/" + HEIGHT_TEXTURE):
            continue
        folder = path.rsplit("/", 1)[0]
        scene = folder.rsplit("/", 1)[-1]
        folders[_key(scene)] = (folder, path)
    return folders


def _match_scene(prefab_path: str, folders: dict[str, tuple[str, str]]) -> str | None:
    stem = Path(prefab_path).stem
    key = _key(stem)
    if key in folders:
        return key
    # Scene folders add suffixes ("lighthouseterrain", "nuclearmissilesilo") while
    # prefab stems add variants ("radtown_small_3"). Accept a clear prefix match
    # before falling back to fuzzy spelling correction.
    for candidate in folders:
        shorter, longer = sorted((key, candidate), key=len)
        if len(shorter) >= 6 and longer.startswith(shorter):
            return candidate
    # Rust's data has its own spelling quirks ("bandid_town" vs "bandit_town"),
    # so fall back to the closest scene name and reject weak matches.
    from difflib import SequenceMatcher

    best: tuple[float, str] | None = None
    for candidate in folders:
        ratio = SequenceMatcher(None, key, candidate).ratio()
        if best is None or ratio > best[0]:
            best = (ratio, candidate)
    if best and best[0] >= MIN_MATCH_RATIO:
        return best[1]
    return None


def _height_image(texture: Any) -> Image.Image | None:
    try:
        image = texture.image
    except Exception:
        return None
    if image is None:
        return None
    image = image.convert("L")
    if max(image.size) > MAX_EDGE:
        image = image.copy()
        image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
    return image


def shade_height_map(image: Image.Image) -> Image.Image:
    """Turn a grayscale height map into a shaded-relief RGB image."""
    width, height = image.size
    if width < 3 or height < 3:
        return image.convert("RGB")
    pixels = list(image.getdata())
    # The shipped masks use a narrow band of heights, so stretch to the 2-98th
    # percentile; otherwise every monument renders as a flat green sheet.
    ordered = sorted(pixels)
    low = ordered[max(0, int(len(ordered) * 0.02))]
    high = ordered[min(len(ordered) - 1, int(len(ordered) * 0.98))]
    if high - low < 8:
        low, high = ordered[0], ordered[-1]
    span = max(1, high - low)
    heights = [min(1.0, max(0.0, (value - low) / span)) for value in pixels]

    out = Image.new("RGB", (width, height))
    target = out.load()
    # Gradients are taken over normalized heights, so the relief reads on small
    # thumbnails as well as on the full 288 px preview.
    relief = 3.0
    light_x, light_y, light_z = _LIGHT
    for y in range(height):
        row = y * width
        up = (y - 1) * width if y > 0 else row
        down = (y + 1) * width if y + 1 < height else row
        for x in range(width):
            left = x - 1 if x > 0 else x
            right = x + 1 if x + 1 < width else x
            dx = (heights[row + right] - heights[row + left]) * relief
            dy = (heights[down + x] - heights[up + x]) * relief
            length = math.sqrt(dx * dx + dy * dy + 1.0)
            lambert = (-dx * light_x - dy * light_y + light_z) / length
            shade = 0.45 + 0.55 * max(0.0, min(1.0, lambert))
            value = heights[row + x]
            # Muted terrain ramp: green lowland -> grass -> sand -> rock -> snow.
            if value < 0.45:
                blend = value / 0.45
                base = (58 + 68 * blend, 92 + 54 * blend, 62 + 34 * blend)
            elif value < 0.75:
                blend = (value - 0.45) / 0.3
                base = (126 + 30 * blend, 146 + 16 * blend, 96 + 26 * blend)
            elif value < 0.9:
                blend = (value - 0.75) / 0.15
                base = (156 + 24 * blend, 162 + 20 * blend, 122 + 22 * blend)
            else:
                blend = (value - 0.9) / 0.1
                base = (180 + 50 * blend, 182 + 50 * blend, 144 + 66 * blend)
            target[x, y] = tuple(int(min(255, channel * shade)) for channel in base)
    return out


def render_monument_previews(
    bundle_path: str | Path,
    prefab_paths: Sequence[str],
    thumbnail_dir: str | Path,
    *,
    force: bool = False,
) -> dict[str, str]:
    """Write a shaded terrain preview per monument prefab.

    Returns a mapping of prefab asset path -> written PNG path. Prefabs without a
    shipped height map (or without a confident scene match) are simply absent.
    """
    target_dir = Path(thumbnail_dir).expanduser()
    target_dir.mkdir(parents=True, exist_ok=True)
    env = load_bundle(Path(bundle_path).expanduser())
    container = read_container(env)
    folders = _terrain_folders(container)
    by_container = {str(entry.path): entry for entry in container}
    by_path_id = {int(obj.path_id): obj for obj in env.objects}

    written: dict[str, str] = {}
    for prefab_path in prefab_paths:
        scene = _match_scene(prefab_path, folders)
        if scene is None:
            continue
        _folder, height_container = folders[scene]
        entry = by_container.get(height_container)
        if entry is None:
            continue
        obj = by_path_id.get(int(entry.path_id))
        if obj is None:
            continue
        try:
            image = _height_image(obj.read())
        except Exception:
            continue
        if image is None:
            continue
        target = target_dir / f"{prefab_hash(prefab_path)}.png"
        if target.is_file() and not force:
            written[prefab_path] = str(target)
            continue
        shade_height_map(image).save(target, "PNG", optimize=True)
        written[prefab_path] = str(target)
    return written


def monument_paths(connection: sqlite3.Connection) -> list[str]:
    rows = connection.execute(
        "SELECT asset_path FROM prefabs WHERE category = 'Monument' ORDER BY asset_path"
    ).fetchall()
    return [str(row[0]) for row in rows]


def find_monuments_bundle(root: str | Path) -> Path | None:
    folder = Path(root).expanduser()
    preferred = folder / "monuments.bundle"
    if preferred.is_file():
        return preferred
    for candidate in sorted(folder.glob("*.bundle")):
        if "monument" in candidate.name.lower():
            return candidate
    return None
