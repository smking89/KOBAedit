"""Terrain layer access and sculpting.

All coordinates are world metres with the origin at the centre of the map
(Unity convention used by Rust): X and Z span ``[-size/2, +size/2]`` and Y is
height in metres.

Height/layer arrays are little-endian raw buffers inside
:class:`~.models.WorldDocument`; :class:`HeightField` wraps them with sampling
and brush operations and converts back to bytes without changing the layout.
"""

from __future__ import annotations

import math
import sys
from array import array
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

from .models import (
    WorldDocument,
    height_metres_to_raw,
    height_raw_to_metres,
)

RAW_PER_METRE = 65535.0 / 1000.0  # Rust terrain: 1000 m of Y over uint16

BRUSH_MODES = ("raise", "lower", "smooth", "flatten", "erode", "noise")

# Bit flags written into the 32-bit topology layer for editor-only overlays.
# The low bits are reserved by the game and are preserved untouched; the top
# eight bits are ours, so a server loading the map ignores them.
EDITOR_TOPOLOGY_FLAGS = {
    "no_build": 1 << 24,
    "monument_pad": 1 << 25,
    "foliage_cleared": 1 << 26,
    "path_clear": 1 << 27,
    "loot_zone": 1 << 28,
    "npc_zone": 1 << 29,
    "safe_zone": 1 << 30,
}

# Real game topology bits, from Facepunch's Rust.World `TerrainTopology.Enum`.
# The wizard stamps Ocean below the water line and Beach across the shore band.
RUST_TOPOLOGY_FLAGS = {
    "beachside": 1 << 3,
    "beach": 1 << 4,
    "ocean": 1 << 7,
}

# Half-width of the shore band that carries the Beach flag, in metres.
BEACH_BAND_METRES = 2.5


def shoreline_topology(height: float, water_level: float) -> int:
    """Ocean under the water line, Beach across the shoreline band."""
    bits = 0
    if height < water_level:
        bits |= RUST_TOPOLOGY_FLAGS["ocean"]
    if abs(height - water_level) <= BEACH_BAND_METRES:
        bits |= RUST_TOPOLOGY_FLAGS["beach"]
    return bits


def shoreline_topology_plane(heights: np.ndarray, water_level: float) -> np.ndarray:
    """Vectorised `shoreline_topology` for a whole height lattice."""
    bits = np.zeros(heights.shape, dtype=np.int32)
    bits[heights < water_level] = RUST_TOPOLOGY_FLAGS["ocean"]
    bits[np.abs(heights - water_level) <= BEACH_BAND_METRES] |= RUST_TOPOLOGY_FLAGS[
        "beach"
    ]
    return bits


SPLAT_CHANNELS = ("dirt", "snow", "sand", "rock", "grass", "forest", "stones", "gravel")
BIOME_CHANNELS = ("arid", "temperate", "tundra", "arctic")


class TerrainError(ValueError):
    """Raised when terrain data is missing or inconsistent."""


# ---------------------------------------------------------------------------
# Raw decoding helpers
# ---------------------------------------------------------------------------


def decode_u16(blob: bytes) -> array:
    values = array("H")
    values.frombytes(blob[: len(blob) - (len(blob) % 2)])
    if sys.byteorder == "big":
        values.byteswap()
    return values


def decode_i32(blob: bytes) -> array:
    values = array("i")
    values.frombytes(blob[: len(blob) - (len(blob) % 4)])
    if values.itemsize != 4:
        raise TerrainError("platform int is not 32-bit")
    if sys.byteorder == "big":
        values.byteswap()
    return values


def encode_u16(values: Sequence[int]) -> bytes:
    if isinstance(values, np.ndarray):
        return np.clip(values, 0, 65535).astype("<u2", copy=False).tobytes()
    if isinstance(values, array) and values.typecode == "H":
        # Already a uint16 buffer: a 16000 m height layer is 256M samples, so
        # the element-by-element path below is not an option.
        buf = array("H", values)
        if sys.byteorder == "big":
            buf.byteswap()
        return buf.tobytes()
    buf = array("H", (max(0, min(65535, int(v))) for v in values))
    if sys.byteorder == "big":
        buf.byteswap()
    return buf.tobytes()


def encode_i32(values: Sequence[int]) -> bytes:
    if isinstance(values, np.ndarray):
        return values.astype("<i4", copy=False).tobytes()
    if isinstance(values, array) and values.typecode == "i":
        buf = array("i", values)
        if sys.byteorder == "big":
            buf.byteswap()
        return buf.tobytes()
    buf = array("i", (int(v) for v in values))
    if sys.byteorder == "big":
        buf.byteswap()
    return buf.tobytes()


def square_resolution(blob: bytes, channels: int) -> int:
    texels = len(blob) // channels
    root = int(round(math.sqrt(texels)))
    if root * root != texels:
        raise TerrainError(
            f"layer of {len(blob)} bytes is not a square {channels}-channel map"
        )
    return root


def required_layer(document: WorldDocument, name: str) -> bytes:
    blob = document.layers.get(name)
    if blob is None:
        raise TerrainError(f"map has no '{name}' layer")
    return blob


def splat_planes(document: WorldDocument) -> list[bytearray]:
    """Return the eight ground-weight planes as mutable byte arrays."""
    blob = required_layer(document, "splat")
    resolution = square_resolution(blob, 8)
    plane_size = resolution * resolution
    if len(blob) < plane_size * 8:
        raise TerrainError("splat layer is truncated")
    return [
        bytearray(blob[index * plane_size : (index + 1) * plane_size])
        for index in range(8)
    ]


def biome_planes(document: WorldDocument) -> list[bytearray]:
    blob = required_layer(document, "biome")
    resolution = square_resolution(blob, 4)
    plane_size = resolution * resolution
    return [
        bytearray(blob[index * plane_size : (index + 1) * plane_size])
        for index in range(4)
    ]


def topology_texels(document: WorldDocument) -> array:
    return decode_i32(required_layer(document, "topology"))


def alpha_texels(document: WorldDocument) -> bytearray:
    return bytearray(required_layer(document, "alpha"))


def store_splat(document: WorldDocument, planes: Sequence[bytes]) -> None:
    if len(planes) != 8:
        raise TerrainError("splat requires 8 planes")
    document.layers["splat"] = b"".join(bytes(plane) for plane in planes)


def store_biome(document: WorldDocument, planes: Sequence[bytes]) -> None:
    document.layers["biome"] = b"".join(bytes(plane) for plane in planes)


# ---------------------------------------------------------------------------
# Height field
# ---------------------------------------------------------------------------


@dataclass
class HeightField:
    """Mutable terrain heights with world-space sampling and brushes."""

    values: array
    resolution: int
    size_metres: float

    @classmethod
    def from_document(cls, document: WorldDocument, layer: str = "terrain") -> "HeightField":
        blob = required_layer(document, layer)
        values = decode_u16(blob)
        resolution = int(round(math.sqrt(len(values))))
        if resolution * resolution != len(values):
            raise TerrainError("height layer is not square")
        return cls(values=values, resolution=resolution, size_metres=float(document.size))

    @property
    def texel_size(self) -> float:
        return self.size_metres / max(1, self.resolution - 1)

    def to_bytes(self) -> bytes:
        return encode_u16(self.values)

    def height_metres(self, index: int) -> float:
        return height_raw_to_metres(self.values[index])

    def grid_coords(self, x: float, z: float) -> tuple[float, float]:
        """World metres -> fractional grid coordinates."""
        scale = (self.resolution - 1) / self.size_metres
        return (x + self.size_metres / 2) * scale, (z + self.size_metres / 2) * scale

    def sample(self, x: float, z: float) -> float:
        """Bilinearly sampled height in metres."""
        gx, gz = self.grid_coords(x, z)
        gx = min(max(gx, 0.0), self.resolution - 1.001)
        gz = min(max(gz, 0.0), self.resolution - 1.001)
        x0, z0 = int(gx), int(gz)
        fx, fz = gx - x0, gz - z0
        i = z0 * self.resolution + x0
        h00 = self.values[i]
        h10 = self.values[i + 1]
        h01 = self.values[i + self.resolution]
        h11 = self.values[i + self.resolution + 1]
        top = h00 + (h10 - h00) * fx
        bottom = h01 + (h11 - h01) * fx
        return height_raw_to_metres(top + (bottom - top) * fz)

    def average_height(self, x: float, z: float, radius: float) -> float:
        gx, gz = self.grid_coords(x, z)
        centre_x, centre_z = int(gx), int(gz)
        radius_texels = max(1, int(radius / self.texel_size))
        total = 0.0
        count = 0
        for iz in range(centre_z - radius_texels, centre_z + radius_texels + 1):
            if iz < 0 or iz >= self.resolution:
                continue
            row = iz * self.resolution
            for ix in range(centre_x - radius_texels, centre_x + radius_texels + 1):
                if ix < 0 or ix >= self.resolution:
                    continue
                total += height_raw_to_metres(self.values[row + ix])
                count += 1
        return total / count if count else 0.0

    def apply_brush(
        self,
        x: float,
        z: float,
        radius: float,
        strength: float = 1.0,
        mode: str = "raise",
        falloff: float = 2.0,
        target_height: float | None = None,
        noise_seed: int = 0,
    ) -> int:
        """Apply one brush stroke; returns the number of touched texels.

        ``strength`` is in metres for raise/lower/flatten, and a 0..1 blend for
        smooth and erode. ``falloff`` 1 = linear cone, 2 = smooth dome, 3 = tight
        centre.
        """
        if mode not in BRUSH_MODES:
            raise TerrainError(f"unknown brush mode '{mode}'")
        if radius <= 0:
            return 0

        gx, gz = self.grid_coords(x, z)
        centre_x, centre_z = int(gx), int(gz)
        radius_texels = int(math.ceil(radius / self.texel_size))
        touched = 0
        for iz in range(centre_z - radius_texels, centre_z + radius_texels + 1):
            if iz < 0 or iz >= self.resolution:
                continue
            for ix in range(centre_x - radius_texels, centre_x + radius_texels + 1):
                if ix < 0 or ix >= self.resolution:
                    continue
                texel_x = (ix - (self.resolution - 1) / 2) * self.texel_size
                texel_z = (iz - (self.resolution - 1) / 2) * self.texel_size
                distance = math.hypot(texel_x - x, texel_z - z)
                if distance > radius:
                    continue
                weight = (1.0 - distance / radius) ** falloff
                index = iz * self.resolution + ix
                current = height_raw_to_metres(self.values[index])

                if mode == "raise":
                    updated = current + strength * weight
                elif mode == "lower":
                    updated = current - strength * weight
                elif mode == "flatten":
                    target = target_height if target_height is not None else current
                    updated = current + (target - current) * min(1.0, weight * strength)
                elif mode == "smooth":
                    local = self.average_height(texel_x, texel_z, self.texel_size * 2)
                    updated = current + (local - current) * min(1.0, weight * strength)
                elif mode == "erode":
                    # Thermal erosion: material leaves the texel towards its
                    # lowest 4-neighbour. Held over a ridge this cuts gullies
                    # instead of merely averaging the surface like smooth.
                    lowest = current
                    if ix > 0:
                        lowest = min(lowest, height_raw_to_metres(self.values[index - 1]))
                    if ix < self.resolution - 1:
                        lowest = min(lowest, height_raw_to_metres(self.values[index + 1]))
                    if iz > 0:
                        lowest = min(lowest, height_raw_to_metres(self.values[index - self.resolution]))
                    if iz < self.resolution - 1:
                        lowest = min(
                            lowest, height_raw_to_metres(self.values[index + self.resolution])
                        )
                    updated = current - (current - lowest) * min(1.0, weight * strength * 0.2)
                else:  # noise
                    updated = current + _hash_noise(ix, iz, noise_seed) * strength * weight

                self.values[index] = height_metres_to_raw(updated)
                touched += 1
        return touched

    def flatten_pad(
        self,
        x: float,
        z: float,
        radius: float,
        falloff_width: float = 12.0,
        target_height: float | None = None,
        blend: float = 1.0,
    ) -> tuple[int, float]:
        """Flatten a monument footprint with a smooth edge falloff.

        Returns ``(touched_texels, target_height)``. The inner ``radius`` is
        fully flat; heights blend back to the original terrain over
        ``falloff_width`` metres.
        """
        if target_height is None:
            target_height = self.average_height(x, z, radius)
        outer = radius + max(0.0, falloff_width)
        gx, gz = self.grid_coords(x, z)
        centre_x, centre_z = int(gx), int(gz)
        radius_texels = int(math.ceil(outer / self.texel_size))
        touched = 0
        for iz in range(centre_z - radius_texels, centre_z + radius_texels + 1):
            if iz < 0 or iz >= self.resolution:
                continue
            for ix in range(centre_x - radius_texels, centre_x + radius_texels + 1):
                if ix < 0 or ix >= self.resolution:
                    continue
                texel_x = (ix - (self.resolution - 1) / 2) * self.texel_size
                texel_z = (iz - (self.resolution - 1) / 2) * self.texel_size
                distance = math.hypot(texel_x - x, texel_z - z)
                if distance > outer:
                    continue
                if distance <= radius:
                    weight = 1.0
                else:
                    t = (distance - radius) / max(1e-6, falloff_width)
                    weight = 1.0 - (t * t * (3 - 2 * t))  # smoothstep out
                index = iz * self.resolution + ix
                current = height_raw_to_metres(self.values[index])
                updated = current + (target_height - current) * weight * blend
                self.values[index] = height_metres_to_raw(updated)
                touched += 1
        return touched, target_height

    def store(self, document: WorldDocument, layer: str = "terrain") -> None:
        document.layers[layer] = self.to_bytes()


# ---------------------------------------------------------------------------
# Splat / biome / topology / alpha painting
# ---------------------------------------------------------------------------


def _hash_noise(ix: int, iz: int, seed: int) -> float:
    value = (ix * 374761393 + iz * 668265263 + seed * 1442695040888963407) & 0xFFFFFFFF
    value = (value ^ (value >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((value ^ (value >> 16)) / 0xFFFFFFFF) - 0.5


def world_to_texel(x: float, z: float, resolution: int, size_metres: float) -> tuple[int, int]:
    scale = (resolution - 1) / size_metres
    return (
        int(round((x + size_metres / 2) * scale)),
        int(round((z + size_metres / 2) * scale)),
    )


def paint_splat(
    planes: list[bytearray],
    resolution: int,
    size_metres: float,
    x: float,
    z: float,
    radius: float,
    channel: int,
    strength: float = 1.0,
    falloff: float = 1.0,
) -> int:
    """Paint one splat channel and renormalize each touched texel to 255."""
    if not 0 <= channel < 8:
        raise TerrainError("splat channel must be 0..7")
    centre_x, centre_z = world_to_texel(x, z, resolution, size_metres)
    texel_size = size_metres / max(1, resolution - 1)
    radius_texels = int(math.ceil(radius / texel_size))
    touched = 0
    for iz in range(centre_z - radius_texels, centre_z + radius_texels + 1):
        if iz < 0 or iz >= resolution:
            continue
        for ix in range(centre_x - radius_texels, centre_x + radius_texels + 1):
            if ix < 0 or ix >= resolution:
                continue
            texel_x = (ix - (resolution - 1) / 2) * texel_size
            texel_z = (iz - (resolution - 1) / 2) * texel_size
            distance = math.hypot(texel_x - x, texel_z - z)
            if distance > radius:
                continue
            weight = (1.0 - distance / radius) ** falloff * strength
            index = iz * resolution + ix
            current = planes[channel][index]
            planes[channel][index] = min(255, int(current + (255 - current) * weight))
            _normalize_texel(planes, index)
            touched += 1
    return touched


def normalize_splat(planes: Sequence[bytearray]) -> None:
    """Renormalize every texel so the eight channels sum to 255."""
    arrays = [np.frombuffer(plane, dtype=np.uint8) for plane in planes]
    totals = np.zeros(arrays[0].size, dtype=np.int32)
    for plane in arrays:
        totals += plane
    empty = totals == 0
    arrays[0][empty] = 255
    active = (totals != 0) & (totals != 255)
    if not active.any():
        return
    active_totals = totals[active]
    for plane in arrays:
        values = plane[active].astype(np.int32) * 255 // active_totals
        plane[active] = np.minimum(255, values).astype(np.uint8)


def _normalize_texel(planes: Sequence[bytearray], index: int) -> None:
    total = sum(plane[index] for plane in planes)
    if total == 0:
        planes[0][index] = 255
        return
    if total == 255:
        return
    for plane in planes:
        plane[index] = min(255, (plane[index] * 255) // total)


def paint_biome(
    planes: list[bytearray],
    resolution: int,
    size_metres: float,
    x: float,
    z: float,
    radius: float,
    channel: int,
    strength: float = 1.0,
) -> int:
    """Blend one biome plane inside a radial mask (4 climax channels)."""
    if not 0 <= channel < len(planes):
        raise TerrainError("biome channel out of range")
    centre_x, centre_z = world_to_texel(x, z, resolution, size_metres)
    texel_size = size_metres / max(1, resolution - 1)
    radius_texels = int(math.ceil(radius / texel_size))
    touched = 0
    for iz in range(centre_z - radius_texels, centre_z + radius_texels + 1):
        if iz < 0 or iz >= resolution:
            continue
        for ix in range(centre_x - radius_texels, centre_x + radius_texels + 1):
            if ix < 0 or ix >= resolution:
                continue
            distance = math.hypot(
                (ix - (resolution - 1) / 2) * texel_size - x,
                (iz - (resolution - 1) / 2) * texel_size - z,
            )
            if distance > radius:
                continue
            weight = (1.0 - distance / radius) * strength
            index = iz * resolution + ix
            for other in range(len(planes)):
                value = planes[other][index]
                if other == channel:
                    planes[other][index] = min(255, int(value + (255 - value) * weight))
                else:
                    planes[other][index] = int(value * (1.0 - weight * 0.85))
            touched += 1
    return touched


def mark_topology_region(
    texels: array,
    resolution: int,
    size_metres: float,
    x: float,
    z: float,
    radius: float,
    flags: Iterable[str],
    clear: bool = False,
) -> int:
    """Set or clear editor overlay flags in a circular region."""
    mask = 0
    for name in flags:
        if name not in EDITOR_TOPOLOGY_FLAGS:
            raise TerrainError(f"unknown topology flag '{name}'")
        mask |= EDITOR_TOPOLOGY_FLAGS[name]
    if not mask:
        return 0

    centre_x, centre_z = world_to_texel(x, z, resolution, size_metres)
    texel_size = size_metres / max(1, resolution - 1)
    radius_texels = int(math.ceil(radius / texel_size))
    touched = 0
    for iz in range(centre_z - radius_texels, centre_z + radius_texels + 1):
        if iz < 0 or iz >= resolution:
            continue
        for ix in range(centre_x - radius_texels, centre_x + radius_texels + 1):
            if ix < 0 or ix >= resolution:
                continue
            distance = math.hypot(
                (ix - (resolution - 1) / 2) * texel_size - x,
                (iz - (resolution - 1) / 2) * texel_size - z,
            )
            if distance > radius:
                continue
            index = iz * resolution + ix
            value = int(texels[index])
            texels[index] = (value & ~mask) if clear else (value | mask)
            touched += 1
    return touched


def set_alpha_region(
    alpha: bytearray,
    resolution: int,
    size_metres: float,
    x: float,
    z: float,
    radius: float,
    value: int = 0,
) -> int:
    """Punch or restore terrain holes (0 hides terrain, 255 shows it)."""
    centre_x, centre_z = world_to_texel(x, z, resolution, size_metres)
    texel_size = size_metres / max(1, resolution - 1)
    radius_texels = int(math.ceil(radius / texel_size))
    touched = 0
    for iz in range(centre_z - radius_texels, centre_z + radius_texels + 1):
        if iz < 0 or iz >= resolution:
            continue
        for ix in range(centre_x - radius_texels, centre_x + radius_texels + 1):
            if ix < 0 or ix >= resolution:
                continue
            distance = math.hypot(
                (ix - (resolution - 1) / 2) * texel_size - x,
                (iz - (resolution - 1) / 2) * texel_size - z,
            )
            if distance <= radius:
                alpha[iz * resolution + ix] = max(0, min(255, value))
                touched += 1
    return touched


def set_water_level(document: WorldDocument, metres: float) -> None:
    """Fill the water layer with a flat sea level (0 = no water)."""
    height = required_layer(document, "terrain")
    resolution = square_resolution(height, 2)
    raw = 0 if metres <= -500 else height_metres_to_raw(metres)
    # A 16000 m world has 256M water texels; a Python list of those would need
    # gigabytes. One replicated uint16 buffer is the whole layer.
    document.layers["water"] = np.full(
        resolution * resolution, raw, dtype="<u2"
    ).tobytes()


def sculpt_heightmap(
    document: WorldDocument,
    mode: str,
    x: float,
    z: float,
    radius: float,
    strength: float,
    falloff: float = 2.0,
) -> dict[str, float | int]:
    """Convenience wrapper used by the Tauri command layer."""
    field = HeightField.from_document(document)
    touched = field.apply_brush(x, z, radius, strength, mode, falloff)
    field.store(document)
    return {
        "touched": touched,
        "brushMode": mode,
        "resolution": field.resolution,
    }


__all__ = [
    "BIOME_CHANNELS",
    "BRUSH_MODES",
    "EDITOR_TOPOLOGY_FLAGS",
    "HeightField",
    "SPLAT_CHANNELS",
    "TerrainError",
    "alpha_texels",
    "biome_planes",
    "decode_i32",
    "decode_u16",
    "encode_i32",
    "encode_u16",
    "mark_topology_region",
    "normalize_splat",
    "paint_biome",
    "paint_splat",
    "sculpt_heightmap",
    "set_alpha_region",
    "set_water_level",
    "splat_planes",
    "square_resolution",
    "store_biome",
    "store_splat",
    "topology_texels",
]
