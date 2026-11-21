"""Seeded procedural terrain generation for the wizard's Terrain step.

The interactive preview is generated in TypeScript; this module is the
authoritative generator used when a map is exported, so a project seed always
reproduces the same terrain in the engine.

Generation is done on a coarse lattice and upsampled to the exact Rust layer
resolution with block-wise numpy. Height, mask and topology passes are
vectorised, which keeps a 4500 m map export in the low seconds and makes a
16000 m map possible at all, while still producing smooth terrain (the noise is
low-frequency by design).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field, asdict
from typing import Any

import numpy as np

from .world.models import (
    WorldDocument,
    height_metres_to_raw,
    height_metres_to_raw_array,
)
from .world.terrain import shoreline_topology_plane

# Rows per vectorised block. Keeps the float64 temporaries of a 16000 m map
# (16001 x 16001) to a few megabytes instead of gigabytes.
_ROW_BLOCK = 512

PRESETS: dict[str, dict[str, float]] = {
    "islands": {"frequency": 1.9, "mountain": 0.9, "sea": 0.42, "detail": 0.55},
    "mountains": {"frequency": 2.6, "mountain": 1.8, "sea": 0.18, "detail": 0.7},
    "valley": {"frequency": 1.3, "mountain": 0.7, "sea": 0.24, "detail": 0.4},
    "flat": {"frequency": 0.8, "mountain": 0.08, "sea": 0.0, "detail": 0.1},
    "archipelago": {"frequency": 3.4, "mountain": 0.6, "sea": 0.52, "detail": 0.6},
}

BIOME_PRESET_WEIGHTS = {
    "islands": (0.15, 0.65, 0.15, 0.05),
    "mountains": (0.05, 0.55, 0.30, 0.10),
    "valley": (0.20, 0.60, 0.10, 0.10),
    "flat": (0.20, 0.65, 0.10, 0.05),
    "archipelago": (0.25, 0.55, 0.15, 0.05),
}

# Channel order shared with the TypeScript preview (`SPLAT_INDEX`/`BIOME_INDEX`).
SPLAT_CHANNELS = {
    "dirt": 0,
    "snow": 1,
    "sand": 2,
    "rock": 3,
    "grass": 4,
    "forest": 5,
    "stones": 6,
    "gravel": 7,
}
BIOME_CHANNELS = {"arid": 0, "temperate": 1, "tundra": 2, "arctic": 3}


@dataclass
class TerrainSettings:
    seed: int = 1337
    size_metres: int = 4500
    preset: str = "islands"
    landmass: str = "single-island"
    mountain_scale: float = 1.0
    water_level: float = -8.0
    tree_density: float = 0.7
    biome_weights: tuple[float, float, float, float] = (0.15, 0.65, 0.15, 0.05)
    detail: float = 0.55
    seed_offset: int = 0
    # Flat starting floor (ocean starters, biome sandboxes, monument stage).
    # ``None`` keeps the procedural heightmap.
    floor_height: float | None = None
    floor_splat: str | None = None
    floor_biome: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["biomeWeights"] = list(self.biome_weights)
        del payload["biome_weights"]
        payload["floorHeight"] = payload.pop("floor_height")
        payload["floorSplat"] = payload.pop("floor_splat")
        payload["floorBiome"] = payload.pop("floor_biome")
        return payload

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TerrainSettings":
        weights = tuple(data.get("biomeWeights", BIOME_PRESET_WEIGHTS.get(data.get("preset", "islands"), (0.15, 0.65, 0.15, 0.05))))
        return cls(
            seed=int(data.get("seed", 1337)),
            size_metres=int(data.get("sizeMetres", data.get("size_metres", 4500))),
            preset=str(data.get("preset", "islands")),
            landmass=str(data.get("landmass", "single-island")),
            mountain_scale=float(data.get("mountainScale", data.get("mountain_scale", 1.0))),
            water_level=float(data.get("waterLevel", data.get("water_level", -8.0))),
            tree_density=float(data.get("treeDensity", data.get("tree_density", 0.7))),
            biome_weights=(float(weights[0]), float(weights[1]), float(weights[2]), float(weights[3])),
            detail=float(data.get("detail", 0.55)),
            floor_height=_optional_float(data.get("floorHeight", data.get("floor_height"))),
            floor_splat=_optional_str(data.get("floorSplat", data.get("floor_splat"))),
            floor_biome=_optional_str(data.get("floorBiome", data.get("floor_biome"))),
        )


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_str(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


@dataclass
class GeneratedTerrain:
    settings: TerrainSettings
    height_resolution: int
    splat_resolution: int
    layers: dict[str, bytes] = field(default_factory=dict)


def _hash2(x: int, y: int, seed: int) -> float:
    # Must stay bit-identical to `hash2` in the editor preview
    # (apps/studio-ui/src/lib/procedural.ts): the exported .map has to match
    # the terrain the user designed against.
    value = (x * 374761393 + y * 668265263 + seed * 1442695041) & 0xFFFFFFFF
    value = (value ^ (value >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((value ^ (value >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _smooth(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def value_noise(x: float, y: float, seed: int) -> float:
    x0, y0 = math.floor(x), math.floor(y)
    fx, fy = _smooth(x - x0), _smooth(y - y0)
    n00 = _hash2(int(x0), int(y0), seed)
    n10 = _hash2(int(x0) + 1, int(y0), seed)
    n01 = _hash2(int(x0), int(y0) + 1, seed)
    n11 = _hash2(int(x0) + 1, int(y0) + 1, seed)
    top = n00 + (n10 - n00) * fx
    bottom = n01 + (n11 - n01) * fx
    return top + (bottom - top) * fy


def fbm(x: float, y: float, seed: int, octaves: int = 5, lacunarity: float = 2.0, gain: float = 0.5) -> float:
    amplitude = 1.0
    frequency = 1.0
    total = 0.0
    norm = 0.0
    for octave in range(octaves):
        total += value_noise(x * frequency, y * frequency, seed + octave * 1013) * amplitude
        norm += amplitude
        amplitude *= gain
        frequency *= lacunarity
    return total / norm if norm else 0.0


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _landmass_mask(shape: str, u: float, v: float, radial: float, sea: float, seed: int) -> float:
    """Silhouette mask, matching `landmassMask` in the editor preview.

    ``single-island`` returns the original radial falloff so maps authored
    before silhouettes existed keep the exact heights they were built against.
    """
    if shape == "single-island":
        return max(0.0, 1.0 - radial * radial * (1.0 + sea))

    dx = (u - 0.5) * 2.0
    dy = (v - 0.5) * 2.0
    if shape == "archipelago":
        # Four seeded island lobes plus noise so the coastlines break up.
        noise = fbm(u * 3.1 + 4.2, v * 3.1 - 1.7, seed + 311, octaves=3) - 0.5
        cluster = max(
            1.0 - math.hypot(dx - 0.42, dy + 0.12) / 0.54,
            1.0 - math.hypot(dx + 0.38, dy - 0.3) / 0.5,
            1.0 - math.hypot(dx - 0.12, dy - 0.52) / 0.44,
            1.0 - math.hypot(dx + 0.1, dy + 0.55) / 0.42,
        )
        return _clamp01(cluster + noise * 0.45)
    if shape == "atoll":
        wobble = (fbm(u * 4.3 - 2.1, v * 4.3 + 6.4, seed + 733, octaves=3) - 0.5) * 0.2
        return _clamp01(1.0 - abs(math.hypot(dx, dy) - 0.62) / max(0.1, 0.26 + wobble))
    west = 1.0 - math.hypot((dx + 0.42) / 0.62, dy / 0.95) ** 2
    east = 1.0 - math.hypot((dx - 0.42) / 0.58, dy * 1.08 / 0.9) ** 2
    channel = _smooth(_clamp01((abs(dx) - 0.03) / 0.08))
    return _clamp01(max(west, east) * channel)


def _edge_ring(u: float, v: float) -> float:
    """Radial edge mask: one inside, zero on the border ring."""
    edge = max(abs(u - 0.5), abs(v - 0.5)) * 2.0
    return _smooth(_clamp01((1.0 - edge) / 0.16))


def _coarse_grid(resolution: int, max_samples: int = 257) -> int:
    """Pick a generation lattice that is a divisor-friendly size."""
    return min(resolution, max(2, max_samples))


def _generate_height(
    settings: TerrainSettings, resolution: int, coarse: int
) -> np.ndarray:
    preset = PRESETS.get(settings.preset, PRESETS["islands"])
    shape = settings.landmass or "single-island"
    frequency = preset["frequency"]
    mountain = preset["mountain"] * settings.mountain_scale
    detail = max(0.0, settings.detail if settings.detail is not None else preset["detail"])
    seed = settings.seed

    coarse_values = np.zeros((coarse, coarse), dtype=np.float64)
    for gy in range(coarse):
        for gx in range(coarse):
            u = gx / (coarse - 1)
            v = gy / (coarse - 1)
            # The silhouette mask keeps water at the map edge.
            radial = math.hypot(u - 0.5, v - 0.5) * 2.0
            land = _landmass_mask(shape, u, v, radial, preset["sea"], seed)
            base = fbm(u * frequency * 2.2, v * frequency * 2.2, seed, octaves=5)
            ridges = 1.0 - abs(fbm(u * frequency * 3.4 + 11.3, v * frequency * 3.4 - 4.7, seed + 91, octaves=4) * 2.0 - 1.0)
            height = (base - 0.5) * 240.0 * (0.6 + detail)
            height += (ridges ** 2) * 260.0 * mountain
            height *= 0.35 + land * 0.9
            height -= preset["sea"] * 120.0
            # Mask holes and the border ring are open ocean, not merely low
            # ground; untouched interior texels skip the blend so existing maps
            # keep their exact heights.
            seabed = settings.water_level - 35.0
            land_factor = 1.0 if shape == "single-island" else _smooth(land)
            border = _edge_ring(u, v)
            if land_factor < 1.0 or border < 1.0:
                height = seabed + (height - seabed) * land_factor * border
            coarse_values[gy, gx] = height

    # Bilinear upsample to the exact height resolution. The per-sample order of
    # operations is unchanged from the scalar loop it replaces, so exported
    # layers stay byte-identical; only the loop is gone.
    values = np.empty((resolution, resolution), dtype=np.float64)
    scale = (coarse - 1) / (resolution - 1)
    x = np.arange(resolution, dtype=np.float64) * scale
    x0 = np.minimum(coarse - 2, x.astype(np.int64))
    tx = x - x0
    y = np.arange(resolution, dtype=np.float64) * scale
    y0 = np.minimum(coarse - 2, y.astype(np.int64))
    ty = y - y0
    for start in range(0, resolution, _ROW_BLOCK):
        stop = min(resolution, start + _ROW_BLOCK)
        rows = y0[start:stop]
        h00 = coarse_values[rows[:, None], x0]
        h10 = coarse_values[rows[:, None], x0 + 1]
        h01 = coarse_values[rows[:, None] + 1, x0]
        h11 = coarse_values[rows[:, None] + 1, x0 + 1]
        top = h00 + (h10 - h00) * tx
        bottom = h01 + (h11 - h01) * tx
        values[start:stop] = top + (bottom - top) * ty[start:stop, None]
    return values


def _raw_heights(heights: np.ndarray) -> np.ndarray:
    """`height_metres_to_raw` over a grid, blockwise to bound temporaries."""
    flat = heights.reshape(-1)
    raw = np.empty(flat.size, dtype=np.uint16)
    step = _ROW_BLOCK * heights.shape[1]
    for start in range(0, flat.size, step):
        raw[start : start + step] = height_metres_to_raw_array(flat[start : start + step])
    return raw


def generate_terrain(settings: TerrainSettings) -> GeneratedTerrain:
    """Generate all terrain layers for a map at Rust's expected resolutions."""
    height_resolution = settings.size_metres + 1
    splat_resolution = 1
    while splat_resolution < max(1, int(settings.size_metres * 0.5)):
        splat_resolution <<= 1

    if settings.floor_height is not None:
        heights = np.full(
            (height_resolution, height_resolution),
            float(settings.floor_height),
            dtype=np.float64,
        )
    else:
        coarse = _coarse_grid(height_resolution, 257)
        heights = _generate_height(settings, height_resolution, coarse)

    raw_heights = _raw_heights(heights)

    # Water plane from settings; rivers are drawn later by the spline step.
    water_raw = height_metres_to_raw(settings.water_level) if settings.water_level > -500 else 0
    water = np.full((height_resolution, height_resolution), water_raw, dtype=np.uint16)

    # Splat / biome computed on the coarse lattice, nearest-upsampled. The mix
    # rows are indexed by the same height bands the scalar pass used.
    splat_planes = [
        np.zeros((splat_resolution, splat_resolution), dtype=np.uint8) for _ in range(8)
    ]
    biome_planes = [
        np.zeros((splat_resolution, splat_resolution), dtype=np.uint8) for _ in range(4)
    ]
    splat_mix = np.array(
        [
            (210, 20, 25, 0, 0, 0, 0, 0),
            (0, 110, 0, 30, 0, 0, 40, 0),
            (30, 20, 0, 80, 20, 0, 100, 0),
            (40, 0, 0, 0, 120, 80, 0, 15),
        ],
        dtype=np.uint8,
    )
    weights = settings.biome_weights
    total_weight = sum(weights) or 1.0
    default_biome = [int(255 * weight / total_weight) for weight in weights]
    topology_values = np.zeros((splat_resolution, splat_resolution), dtype=np.int32)

    if settings.floor_height is not None:
        splat_channel = SPLAT_CHANNELS.get(settings.floor_splat or "grass", 4)
        biome_channel = BIOME_CHANNELS.get(settings.floor_biome or "temperate", 1)
        splat_planes[splat_channel].fill(255)
        biome_planes[biome_channel].fill(255)

    # Nearest height sample for every mask texel (same mapping as the scalar
    # pass): floor(sx / splat * (height_resolution - 1)).
    sample = np.minimum(
        height_resolution - 1,
        (
            np.arange(splat_resolution, dtype=np.float64)
            / splat_resolution
            * (height_resolution - 1)
        ).astype(np.int64),
    )

    if settings.floor_height is None:
        for start in range(0, splat_resolution, _ROW_BLOCK):
            stop = min(splat_resolution, start + _ROW_BLOCK)
            block = heights[sample[start:stop, None], sample]

            # Height/slope driven ground mix: sand near water, rock up high,
            # grass/forest in the mid band, snow on peaks.
            category = np.full(block.shape, 3, dtype=np.uint8)
            category[block > 120] = 2
            category[block > 220] = 1
            category[block < settings.water_level + 4] = 0
            for channel in range(8):
                splat_planes[channel][start:stop] = splat_mix[category, channel]

            for channel in range(4):
                biome_planes[channel][start:stop] = default_biome[channel]
            biome_index = np.zeros(block.shape, dtype=np.uint8)
            biome_index[block < settings.water_level + 20] = 1
            biome_index[block > 160] = 2
            for index in range(4):
                chosen = biome_index == index
                if not chosen.any():
                    continue
                plane = biome_planes[index][start:stop]
                plane[chosen] = np.minimum(255, plane[chosen].astype(np.int16) + 40)

            # Real spawn topology: Ocean under the water line, Beach at the shore.
            topology_values[start:stop] = shoreline_topology_plane(
                block, settings.water_level
            )

    layers = {
        "terrain": raw_heights.astype("<u2", copy=False).tobytes(),
        "water": water.astype("<u2", copy=False).tobytes(),
        "splat": b"".join(plane.tobytes() for plane in splat_planes),
        "biome": b"".join(plane.tobytes() for plane in biome_planes),
        "topology": topology_values.astype("<i4", copy=False).tobytes(),
        "alpha": bytes([255]) * (splat_resolution * splat_resolution),
    }
    return GeneratedTerrain(
        settings=settings,
        height_resolution=height_resolution,
        splat_resolution=splat_resolution,
        layers=layers,
    )


_HEIGHT_LATTICE_CACHE: dict[tuple[object, ...], list[float]] = {}


def sample_heightfield(settings: TerrainSettings, resolution: int = 257) -> list[float]:
    """Height lattice in metres without building any map layer.

    ``generate_terrain`` is the exporter path: it allocates every layer at
    ``(size + 1)²``, which costs seconds and hundreds of megabytes on a 4500 m
    map. Validation only needs the coarse lattice the exported surface is
    interpolated from, so it asks for a 257² lattice and stays exact on every
    sampled lattice point.
    """

    resolution = max(2, min(int(resolution), 2049))
    if settings.floor_height is not None:
        return [float(settings.floor_height)] * (resolution * resolution)
    # Two checks on the same map (map check, then a re-run after an edit) should
    # not pay for the lattice twice. The list is shared, so callers must read it.
    key = (
        settings.seed,
        settings.seed_offset,
        settings.size_metres,
        settings.preset,
        settings.landmass,
        settings.mountain_scale,
        settings.water_level,
        settings.detail,
        settings.floor_height,
        resolution,
    )
    cached = _HEIGHT_LATTICE_CACHE.get(key)
    if cached is not None:
        return cached
    coarse = _coarse_grid(resolution, 257)
    values = _generate_height(settings, resolution, coarse).reshape(-1).tolist()
    if len(_HEIGHT_LATTICE_CACHE) >= 4:
        _HEIGHT_LATTICE_CACHE.clear()
    _HEIGHT_LATTICE_CACHE[key] = values
    return values


def apply_to_document(settings: TerrainSettings, document: WorldDocument | None = None) -> WorldDocument:
    """Generate terrain and place it into a (new or existing) document."""
    generated = generate_terrain(settings)
    document = document or WorldDocument(size=settings.size_metres)
    document.size = settings.size_metres
    for name, data in generated.layers.items():
        document.layers[name] = data
    document.layers.setdefault("height", generated.layers["terrain"])
    return document


def generate_preview_png(settings: TerrainSettings, path: str, size: int = 512) -> str:
    """Convenience preview used by the CLI and tests."""
    from .indexer.thumbnails import render_heightmap_thumbnail
    from .world.terrain import HeightField, decode_u16

    generated = generate_terrain(settings)
    values = decode_u16(generated.layers["terrain"])
    field = HeightField(values=values, resolution=generated.height_resolution, size_metres=settings.size_metres)
    render_heightmap_thumbnail(field, path, size=size)
    return path


def random_seed() -> int:
    return random.SystemRandom().randint(0, 2**31 - 1)


def terrain_footprint(size_metres: int) -> dict[str, int]:
    """Layer grid and byte counts for a square map, straight from the generator.

    ``generate_terrain`` allocates the mask grid at the next power of two at or
    above half the map size and writes three uint16 height grids plus masks at
    17 bytes per texel. The studio badge shows these numbers, so both sides read
    this one formula instead of re-deriving it.
    """
    size = max(1, int(round(size_metres)))
    samples = size + 1
    splat = 1
    while splat < max(1, int(size * 0.5)):
        splat <<= 1
    height_bytes = samples * samples * 2 * 3
    mask_bytes = splat * splat * (8 + 4 + 4 + 1)
    mib = 1024 * 1024
    half = mib // 2
    return {
        "samples": samples,
        "splatResolution": splat,
        "heightMiB": (height_bytes + half) // mib,
        "maskMiB": (mask_bytes + half) // mib,
        "totalMiB": (height_bytes + mask_bytes + half) // mib,
    }


__all__ = [
    "BIOME_PRESET_WEIGHTS",
    "GeneratedTerrain",
    "PRESETS",
    "TerrainSettings",
    "apply_to_document",
    "fbm",
    "generate_preview_png",
    "generate_terrain",
    "terrain_footprint",
    "random_seed",
    "value_noise",
]
