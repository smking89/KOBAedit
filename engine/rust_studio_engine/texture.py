"""Texture channel packing and Workshop export.

Rust skins are a fixed set of square PNGs at either 1024x1024 or 2048x2048:

    <name>_diffuse.png
    <name>_normal.png
    <name>_specular.png      (smoothness in alpha for the editor preview)
    <name>_emission.png

The 3D painter works on independent channels and this module packs, validates
and writes the final files. It uses Pillow; NumPy is used when available to make
per-pixel operations (normal from height, channel merge) fast on 2048².

The ``emission`` channel is optional for the game but always exported here so a
"night/emission" lighting preview has a source of truth.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Mapping, Sequence

from PIL import Image

try:  # optional acceleration
    import numpy as _np
except Exception:  # pragma: no cover
    _np = None

SUPPORTED_RESOLUTIONS = (1024, 2048)
CHANNEL_FILES = {
    "diffuse": "_diffuse.png",
    "normal": "_normal.png",
    "specular": "_specular.png",
    "emission": "_emission.png",
}


class TextureError(ValueError):
    """Raised for unsupported resolutions or malformed channel data."""


def validate_resolution(width: int, height: int) -> None:
    if width != height:
        raise TextureError(f"skin textures must be square, got {width}x{height}")
    if width not in SUPPORTED_RESOLUTIONS:
        raise TextureError(
            f"Rust skins must be {' or '.join(map(str, SUPPORTED_RESOLUTIONS))} px, got {width}"
        )


def load_rgba(path: str | Path, resolution: int | None = None) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    if resolution and image.size != (resolution, resolution):
        image = image.resize((resolution, resolution), Image.LANCZOS)
    return image


def pack_orm(
    ao: Image.Image | None,
    roughness: Image.Image | None,
    metallic: Image.Image | None,
) -> Image.Image:
    """Pack ambient occlusion / roughness / metallic into an ORM texture."""
    base = (ao or Image.new("L", (1024, 1024), 255)).convert("L")
    size = base.size
    rough = (roughness or Image.new("L", size, 128)).convert("L")
    metal = (metallic or Image.new("L", size, 0)).convert("L")
    return Image.merge("RGB", (base, rough, metal))


def normal_map_from_height(
    height: Image.Image, strength: float = 2.0, invert_y: bool = False
) -> Image.Image:
    """Generate a tangent-space normal map from a grayscale height image."""
    gray = height.convert("L")
    width, height_px = gray.size

    if _np is not None:
        source = _np.asarray(gray, dtype=_np.float32) / 255.0
        dx = _np.zeros_like(source)
        dy = _np.zeros_like(source)
        dx[:, 1:-1] = (source[:, 2:] - source[:, :-2]) * 0.5 * strength
        dy[1:-1, :] = (source[2:, :] - source[:-2, :]) * 0.5 * strength
        nz = _np.ones_like(source)
        length = _np.sqrt(dx * dx + dy * dy + nz * nz)
        nx = -dx / length
        ny = (-dy if invert_y else dy) / length
        nz = nz / length
        rgba = _np.stack(
            [
                (nx * 0.5 + 0.5) * 255,
                (ny * 0.5 + 0.5) * 255,
                (nz * 0.5 + 0.5) * 255,
                _np.full_like(nx, 255),
            ],
            axis=-1,
        )
        return Image.fromarray(rgba.clip(0, 255).astype("uint8"), "RGBA")

    pixels = gray.load()
    out = Image.new("RGBA", (width, height_px))
    target = out.load()
    for y in range(height_px):
        y0 = max(0, y - 1)
        y1 = min(height_px - 1, y + 1)
        for x in range(width):
            x0 = max(0, x - 1)
            x1 = min(width - 1, x + 1)
            dx = (pixels[x1, y] - pixels[x0, y]) / 255.0 * strength
            dy = (pixels[x, y1] - pixels[x, y0]) / 255.0 * strength
            nz = 1.0
            length = math.sqrt(dx * dx + dy * dy + nz * nz)
            nx = -dx / length
            ny = (-dy if invert_y else dy) / length
            nz = nz / length
            target[x, y] = (
                int((nx * 0.5 + 0.5) * 255),
                int((ny * 0.5 + 0.5) * 255),
                int((nz * 0.5 + 0.5) * 255),
                255,
            )
    return out


def pack_roughness_alpha(roughness: Image.Image, smoothness_alpha: Image.Image) -> Image.Image:
    """RGB roughness + alpha smoothness, the layout the preview shader expects."""
    rgb = roughness.convert("RGB")
    alpha = smoothness_alpha.convert("L")
    rgb.putalpha(alpha)
    return rgb


def export_channels(
    name: str,
    channels: Mapping[str, Image.Image],
    output_dir: str | Path,
    resolution: int,
    *,
    also_specular_rgba: bool = False,
) -> dict[str, str]:
    """Write the four Workshop PNGs and return ``{channel: path}``."""
    validate_resolution(resolution, resolution)
    safe_name = "".join(ch for ch in name if ch.isalnum() or ch in "-_") or "skin"
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)

    written: dict[str, str] = {}
    for channel, suffix in CHANNEL_FILES.items():
        image = channels.get(channel)
        if image is None:
            if channel == "normal":
                image = Image.new("RGBA", (resolution, resolution), (128, 128, 255, 255))
            elif channel == "emission":
                image = Image.new("RGBA", (resolution, resolution), (0, 0, 0, 255))
            elif channel == "specular":
                image = Image.new("RGBA", (resolution, resolution), (32, 32, 32, 255))
            else:
                image = Image.new("RGBA", (resolution, resolution), (128, 128, 128, 255))
        if image.size != (resolution, resolution):
            image = image.resize((resolution, resolution), Image.LANCZOS)
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        path = target / f"{safe_name}{suffix}"
        image.save(path, "PNG", optimize=True)
        written[channel] = str(path)

    if also_specular_rgba and "specular" in channels:
        path = target / f"{safe_name}_specular_rgba.png"
        channels["specular"].convert("RGBA").save(path, "PNG", optimize=True)
        written["specular_rgba"] = str(path)
    return written


def inspect_png(path: str | Path) -> dict[str, object]:
    """Report resolution, mode and whether a texture is Workshop-compatible."""
    with Image.open(path) as image:
        width, height = image.size
        return {
            "path": str(path),
            "width": width,
            "height": height,
            "mode": image.mode,
            "valid": width == height and width in SUPPORTED_RESOLUTIONS,
        }


def channel_checksum(image: Image.Image) -> str:
    """Stable checksum for sync: size + FNV-1a over the raw bytes."""
    digest = 0x811C9DC5
    for byte in image.tobytes():
        digest ^= byte
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return f"{image.width}x{image.height}:{digest:08x}"


def contact_sheet(images: Sequence[Image.Image], columns: int = 2) -> Image.Image:
    """Debug/preview sheet of channels (used by the export review step)."""
    if not images:
        raise TextureError("contact_sheet needs at least one image")
    size = images[0].size[0]
    rows = math.ceil(len(images) / columns)
    sheet = Image.new("RGBA", (columns * size, rows * size), (18, 20, 23, 255))
    for index, image in enumerate(images):
        sheet.paste(image.convert("RGBA"), ((index % columns) * size, (index // columns) * size))
    return sheet


__all__ = [
    "CHANNEL_FILES",
    "SUPPORTED_RESOLUTIONS",
    "TextureError",
    "channel_checksum",
    "contact_sheet",
    "export_channels",
    "inspect_png",
    "load_rgba",
    "normal_map_from_height",
    "pack_orm",
    "pack_roughness_alpha",
    "validate_resolution",
]
