"""Colour-sketch to Rust heightmap reconstruction.

A sketch is a flat image where colour means land cover, not brightness: blue is
water, sand the shore, green the woods, grey rock, white snow, dark grey roads
and crimson the flat pads where monuments land. This module turns that into a
16-bit Rust height grid:

1. every pixel is classified into the nearest palette entry (nearest colour in
   RGB, so anti-aliased edges stay stable);
2. each class gets its base elevation, plus deterministic fractal detail;
3. roads and monument pads take the surrounding ground height instead of a class
   value, and pads are flattened so a prefab can sit on them;
4. three box-blur passes approximate a Gaussian, which is what removes the
   stair-stepping a painted sketch would otherwise export with.

The result feeds ``exporter._apply_heightmap_import`` unchanged: a 16-bit PNG at
the target resolution, with sea level at 0 m and 1000 m of vertical range.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

# (class, RGB, base elevation in metres). Order matters only for readability.
SKETCH_PALETTE: tuple[tuple[str, tuple[int, int, int], float], ...] = (
    ("water", (46, 111, 184), -20.0),
    ("sand", (232, 217, 160), 2.0),
    ("grass", (79, 158, 63), 14.0),
    ("forest", (47, 107, 42), 28.0),
    ("rock", (122, 122, 114), 95.0),
    ("snow", (242, 245, 247), 210.0),
    ("road", (74, 74, 74), 0.0),
    ("monument", (239, 28, 28), 0.0),
)

PALETTE_BY_NAME = {name: (colour, height) for name, colour, height in SKETCH_PALETTE}
SPECIAL_CLASSES = ("road", "monument")
LAND_CLASSES = ("sand", "grass", "forest", "rock", "snow")

# Pads are flattened over this many texels at 1025²; scaled by resolution.
PAD_RADIUS_TEXELS = 8.0
ROAD_FILL_RADIUS = 6.0

TERRAIN_MIN = -500.0
TERRAIN_MAX = 500.0


class SketchError(ValueError):
    """Raised when a sketch cannot be turned into a heightmap."""


@dataclass
class SketchResult:
    resolution: int
    heights: list[float]
    coverage: dict[str, float] = field(default_factory=dict)
    minimum: float = 0.0
    maximum: float = 0.0
    mean: float = 0.0
    land_share: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "resolution": self.resolution,
            "coverage": {name: round(value, 4) for name, value in self.coverage.items()},
            "minimum": round(self.minimum, 2),
            "maximum": round(self.maximum, 2),
            "mean": round(self.mean, 2),
            "landShare": round(self.land_share, 4),
        }


def _box_blur(field: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return field
    window = 2 * radius + 1
    padded = np.pad(field, ((0, 0), (radius, radius)), mode="edge")
    cumulative = np.cumsum(padded, axis=1, dtype=np.float64)
    cumulative = np.pad(cumulative, ((0, 0), (1, 0)))
    field = (cumulative[:, window:] - cumulative[:, :-window]) / window
    padded = np.pad(field, ((radius, radius), (0, 0)), mode="edge")
    cumulative = np.cumsum(padded, axis=0, dtype=np.float64)
    cumulative = np.pad(cumulative, ((1, 0), (0, 0)))
    return (cumulative[window:, :] - cumulative[:-window, :]) / window


def _gaussian(field: np.ndarray, sigma: float) -> np.ndarray:
    """Three box passes: close enough to a Gaussian and O(pixels)."""

    if sigma <= 0.15:
        return field
    radius = max(1, int(round(sigma * 0.85)))
    for _ in range(3):
        field = _box_blur(field, radius)
    return field


def _detail(resolution: int, seed: int, octaves: int = 4) -> np.ndarray:
    """Deterministic fractal noise in -1..1, used to break up flat classes."""

    rng = np.random.default_rng(seed)
    noise = np.zeros((resolution, resolution), dtype=np.float64)
    amplitude = 1.0
    total = 0.0
    cells = 8
    for _ in range(octaves):
        lattice = rng.uniform(-1.0, 1.0, size=(cells + 1, cells + 1))
        # Bilinear upsample of the lattice to the full grid.
        coords = np.linspace(0, cells, resolution, endpoint=False)
        x0 = coords.astype(int)
        tx = coords - x0
        x1 = np.minimum(x0 + 1, cells)
        rows = np.linspace(0, cells, resolution, endpoint=False)
        z0 = rows.astype(int)
        tz = rows - z0
        z1 = np.minimum(z0 + 1, cells)
        a = lattice[np.ix_(z0, x0)]
        b = lattice[np.ix_(z0, x1)]
        c = lattice[np.ix_(z1, x0)]
        d = lattice[np.ix_(z1, x1)]
        tx = tx[None, :]
        tz = tz[:, None]
        blend = (
            a * (1 - tx) * (1 - tz)
            + b * tx * (1 - tz)
            + c * (1 - tx) * tz
            + d * tx * tz
        )
        noise += blend * amplitude
        total += amplitude
        amplitude *= 0.5
        cells *= 2
    return noise / max(total, 1e-6)


def classify(image: Image.Image, resolution: int) -> np.ndarray:
    """Return a class-index grid at ``resolution``² (nearest-neighbour sampled)."""

    rgb = image.convert("RGB").resize((resolution, resolution), Image.NEAREST)
    pixels = np.asarray(rgb, dtype=np.int32)
    # One palette colour at a time: the broadcast form materialises
    # (res, res, 8, 3) floats, which is 200 MB at 1025².
    best = np.full((resolution, resolution), np.iinfo(np.int32).max, dtype=np.int32)
    classes = np.zeros((resolution, resolution), dtype=np.int16)
    for index, (_name, colour, _height) in enumerate(SKETCH_PALETTE):
        dr = pixels[:, :, 0] - int(colour[0])
        dg = pixels[:, :, 1] - int(colour[1])
        db = pixels[:, :, 2] - int(colour[2])
        distance = dr * dr + dg * dg + db * db
        closer = distance < best
        best = np.where(closer, distance, best)
        classes = np.where(closer, index, classes).astype(np.int16)
    return classes


def sketch_to_heightmap(
    image: Image.Image,
    *,
    resolution: int = 1025,
    vertical_scale: float = 1.0,
    sea_level: float = 0.0,
    smooth: float = 2.0,
    seed: int = 1337,
) -> SketchResult:
    """Classify ``image`` and return heights in metres (row-major, z-major)."""

    if resolution < 2:
        raise SketchError("resolution must be at least 2")
    if vertical_scale <= 0:
        raise SketchError("vertical scale must be positive")

    classes = classify(image, resolution)
    names = [name for name, _colour, _height in SKETCH_PALETTE]
    heights_by_class = np.array([height for _name, _colour, height in SKETCH_PALETTE])

    coverage: dict[str, float] = {}
    total = float(classes.size)
    for index, name in enumerate(names):
        coverage[name] = float((classes == index).sum()) / total

    if not any(coverage.get(name, 0.0) > 0.0 for name in LAND_CLASSES):
        raise SketchError("sketch has no land: paint sand, grass, forest, rock or snow")

    base = heights_by_class[classes]
    detail = _detail(resolution, seed)
    # Rock and snow carry more relief than grass; water stays flat.
    relief = np.select(
        [
            np.isin(classes, [names.index("rock"), names.index("snow")]),
            classes == names.index("forest"),
            np.isin(classes, [names.index("road"), names.index("monument")]),
        ],
        [26.0, 8.0, 0.0],
        default=4.0,
    )
    heights = base + detail * relief

    special = np.isin(classes, [names.index(name) for name in SPECIAL_CLASSES])
    if special.any():
        # Roads and pads inherit the ground they sit on, not their own colour.
        mask = (~special).astype(np.float64)
        filled = _box_blur(heights * mask, int(ROAD_FILL_RADIUS))
        weight = _box_blur(mask, int(ROAD_FILL_RADIUS))
        ground = np.where(weight > 0.05, filled / np.maximum(weight, 1e-6), 0.0)
        heights = np.where(special, ground, heights)

        pads = classes == names.index("monument")
        if pads.any():
            radius = max(2, int(round(PAD_RADIUS_TEXELS * resolution / 1025.0)))
            smoothed = _gaussian(heights, radius * 0.6)
            # Only the pad itself is levelled; the skirt keeps its relief.
            heights = np.where(pads, smoothed, heights)

    heights = _gaussian(heights, max(0.0, float(smooth)))
    heights = heights + float(sea_level)
    heights = np.clip(heights, TERRAIN_MIN, TERRAIN_MAX) * float(vertical_scale)
    heights = np.clip(heights, TERRAIN_MIN, TERRAIN_MAX)

    land = ~np.isin(classes, [names.index("water")])
    return SketchResult(
        resolution=resolution,
        heights=heights.ravel().tolist(),
        coverage=coverage,
        minimum=float(heights.min()),
        maximum=float(heights.max()),
        mean=float(heights.mean()),
        land_share=float(land.mean()),
    )


def heights_to_png(heights: list[float], resolution: int, path: str | Path) -> Path:
    """Write the 16-bit height PNG the importer expects (0 = -500 m, 65535 = +500 m)."""

    values = np.asarray(heights, dtype=np.float64)
    if values.size != resolution * resolution:
        raise SketchError("height grid is not square")
    raw = np.clip((values - TERRAIN_MIN) / (TERRAIN_MAX - TERRAIN_MIN) * 65535.0, 0, 65535)
    image = Image.frombytes(
        "I;16", (resolution, resolution), raw.astype("<u2").tobytes()
    )
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target)
    return target


def sketch_to_png(
    source: str | Path,
    target: str | Path,
    *,
    resolution: int = 1025,
    vertical_scale: float = 1.0,
    sea_level: float = 0.0,
    smooth: float = 2.0,
    seed: int = 1337,
) -> SketchResult:
    """Convenience wrapper: read a sketch image, write a heightmap PNG."""

    path = Path(source)
    if not path.exists():
        raise SketchError(f"sketch not found: {path}")
    with Image.open(path) as image:
        result = sketch_to_heightmap(
            image,
            resolution=resolution,
            vertical_scale=vertical_scale,
            sea_level=sea_level,
            smooth=smooth,
            seed=seed,
        )
    heights_to_png(result.heights, resolution, target)
    return result
