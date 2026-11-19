"""Seeded procedural terrain generation for the wizard's Terrain step.

The interactive preview is generated in TypeScript; this module is the
authoritative generator used when a map is exported, so a project seed always
reproduces the same terrain in the engine.

Generation is done on a coarse lattice and upsampled to the exact Rust layer
resolution, which keeps a 4500 m map export in the seconds range in pure Python
while still producing smooth terrain (the noise is low-frequency by design).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field, asdict
from typing import Any

from .world.models import WorldDocument, height_metres_to_raw
from .world.terrain import encode_i32, encode_u16

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


@dataclass
class TerrainSettings:
    seed: int = 1337
    size_metres: int = 4500
    preset: str = "islands"
    mountain_scale: float = 1.0
    water_level: float = -8.0
    tree_density: float = 0.7
    biome_weights: tuple[float, float, float, float] = (0.15, 0.65, 0.15, 0.05)
    detail: float = 0.55
    seed_offset: int = 0

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["biomeWeights"] = list(self.biome_weights)
        del payload["biome_weights"]
        return payload

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TerrainSettings":
        weights = tuple(data.get("biomeWeights", BIOME_PRESET_WEIGHTS.get(data.get("preset", "islands"), (0.15, 0.65, 0.15, 0.05))))
        return cls(
            seed=int(data.get("seed", 1337)),
            size_metres=int(data.get("sizeMetres", data.get("size_metres", 4500))),
            preset=str(data.get("preset", "islands")),
            mountain_scale=float(data.get("mountainScale", data.get("mountain_scale", 1.0))),
            water_level=float(data.get("waterLevel", data.get("water_level", -8.0))),
            tree_density=float(data.get("treeDensity", data.get("tree_density", 0.7))),
            biome_weights=(float(weights[0]), float(weights[1]), float(weights[2]), float(weights[3])),
            detail=float(data.get("detail", 0.55)),
        )


@dataclass
class GeneratedTerrain:
    settings: TerrainSettings
    height_resolution: int
    splat_resolution: int
    layers: dict[str, bytes] = field(default_factory=dict)


def _hash2(x: int, y: int, seed: int) -> float:
    value = (x * 374761393 + y * 668265263 + seed * 1442695040888963407) & 0xFFFFFFFF
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


def _coarse_grid(resolution: int, max_samples: int = 257) -> int:
    """Pick a generation lattice that is a divisor-friendly size."""
    return min(resolution, max(2, max_samples))


def _generate_height(
    settings: TerrainSettings, resolution: int, coarse: int
) -> list[float]:
    preset = PRESETS.get(settings.preset, PRESETS["islands"])
    frequency = preset["frequency"]
    mountain = preset["mountain"] * settings.mountain_scale
    detail = max(0.0, settings.detail if settings.detail is not None else preset["detail"])
    seed = settings.seed

    coarse_values = [[0.0] * coarse for _ in range(coarse)]
    for gy in range(coarse):
        for gx in range(coarse):
            u = gx / (coarse - 1)
            v = gy / (coarse - 1)
            # Radial island falloff keeps water at the map edge.
            radial = math.hypot(u - 0.5, v - 0.5) * 2.0
            island = max(0.0, 1.0 - radial * radial * (1.0 + preset["sea"]))
            base = fbm(u * frequency * 2.2, v * frequency * 2.2, seed, octaves=5)
            ridges = 1.0 - abs(fbm(u * frequency * 3.4 + 11.3, v * frequency * 3.4 - 4.7, seed + 91, octaves=4) * 2.0 - 1.0)
            height = (base - 0.5) * 240.0 * (0.6 + detail)
            height += (ridges ** 2) * 260.0 * mountain
            height *= 0.35 + island * 0.9
            height -= preset["sea"] * 120.0
            coarse_values[gy][gx] = height

    # Bilinear upsample to the exact height resolution.
    values: list[float] = [0.0] * (resolution * resolution)
    scale = (coarse - 1) / (resolution - 1)
    for y in range(resolution):
        fy = y * scale
        y0 = min(coarse - 2, int(fy))
        ty = fy - y0
        for x in range(resolution):
            fx = x * scale
            x0 = min(coarse - 2, int(fx))
            tx = fx - x0
            h00 = coarse_values[y0][x0]
            h10 = coarse_values[y0][x0 + 1]
            h01 = coarse_values[y0 + 1][x0]
            h11 = coarse_values[y0 + 1][x0 + 1]
            top = h00 + (h10 - h00) * tx
            bottom = h01 + (h11 - h01) * tx
            values[y * resolution + x] = top + (bottom - top) * ty
    return values


def generate_terrain(settings: TerrainSettings) -> GeneratedTerrain:
    """Generate all terrain layers for a map at Rust's expected resolutions."""
    height_resolution = settings.size_metres + 1
    splat_resolution = 1
    while splat_resolution < max(1, int(settings.size_metres * 0.5)):
        splat_resolution <<= 1

    coarse = _coarse_grid(height_resolution, 257)
    heights = _generate_height(settings, height_resolution, coarse)

    raw_heights = [height_metres_to_raw(value) for value in heights]

    # Water plane from settings; rivers are drawn later by the spline step.
    water_raw = height_metres_to_raw(settings.water_level) if settings.water_level > -500 else 0
    water = [water_raw] * (height_resolution * height_resolution)

    # Splat / biome computed on the coarse lattice, nearest-upsampled.
    splat_planes = [bytearray(splat_resolution * splat_resolution) for _ in range(8)]
    biome_planes = [bytearray(splat_resolution * splat_resolution) for _ in range(4)]
    weights = settings.biome_weights
    total_weight = sum(weights) or 1.0

    for sy in range(splat_resolution):
        hy = min(height_resolution - 1, int(sy / splat_resolution * (height_resolution - 1)))
        for sx in range(splat_resolution):
            hx = min(height_resolution - 1, int(sx / splat_resolution * (height_resolution - 1)))
            height = heights[hy * height_resolution + hx]

            # Height/slope driven ground mix: sand near water, rock up high,
            # grass/forest in the mid band, snow on peaks.
            if height < settings.water_level + 4:
                mix = (210, 20, 25, 0, 0, 0, 0, 0)
            elif height > 220:
                mix = (0, 110, 0, 30, 0, 0, 40, 0)
            elif height > 120:
                mix = (30, 20, 0, 80, 20, 0, 100, 0)
            else:
                mix = (40, 0, 0, 0, 120, 80, 0, 15)
            index = sy * splat_resolution + sx
            for channel in range(8):
                splat_planes[channel][index] = mix[channel]

            biome_index = 0
            if height > 160:
                biome_index = 2
            elif height < settings.water_level + 20:
                biome_index = 1
            for channel in range(4):
                biome_planes[channel][index] = int(255 * weights[channel] / total_weight)
            biome_planes[biome_index][index] = min(255, biome_planes[biome_index][index] + 40)

    layers = {
        "terrain": encode_u16(raw_heights),
        "water": encode_u16(water),
        "splat": b"".join(bytes(plane) for plane in splat_planes),
        "biome": b"".join(bytes(plane) for plane in biome_planes),
        "topology": encode_i32([0] * (splat_resolution * splat_resolution)),
        "alpha": bytes([255]) * (splat_resolution * splat_resolution),
    }
    return GeneratedTerrain(
        settings=settings,
        height_resolution=height_resolution,
        splat_resolution=splat_resolution,
        layers=layers,
    )


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


__all__ = [
    "BIOME_PRESET_WEIGHTS",
    "GeneratedTerrain",
    "PRESETS",
    "TerrainSettings",
    "apply_to_document",
    "fbm",
    "generate_preview_png",
    "generate_terrain",
    "random_seed",
    "value_noise",
]
