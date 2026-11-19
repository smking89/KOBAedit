from __future__ import annotations

from rust_studio_engine.procedural import (
    TerrainSettings,
    generate_terrain,
)
from rust_studio_engine.world.terrain import decode_u16


def test_floor_height_replaces_the_heightmap() -> None:
    settings = TerrainSettings(size_metres=128, floor_height=20.0, floor_splat="grass", floor_biome="temperate")
    generated = generate_terrain(settings)
    values = decode_u16(generated.layers["terrain"])
    assert len(set(values)) == 1


def test_floor_paints_one_splat_and_biome_channel() -> None:
    settings = TerrainSettings(size_metres=128, floor_height=-55.0, floor_splat="sand", floor_biome="arid")
    generated = generate_terrain(settings)
    splat = generated.layers["splat"]
    biome = generated.layers["biome"]
    texels = generated.splat_resolution * generated.splat_resolution
    sand = 2
    arid = 0
    assert all(byte == 255 for byte in splat[sand * texels : (sand + 1) * texels])
    assert all(byte == 0 for byte in splat[0:texels])
    assert all(byte == 255 for byte in biome[arid * texels : (arid + 1) * texels])


def test_round_trip_keeps_floor_settings() -> None:
    settings = TerrainSettings(size_metres=64, floor_height=24.0, floor_splat="snow", floor_biome="arctic")
    restored = TerrainSettings.from_dict(settings.to_dict())
    assert restored.floor_height == 24.0
    assert restored.floor_splat == "snow"
    assert restored.floor_biome == "arctic"


def test_flat_island_generation_has_no_floor() -> None:
    settings = TerrainSettings.from_dict({"preset": "islands", "sizeMetres": 64})
    assert settings.floor_height is None
    generated = generate_terrain(settings)
    values = decode_u16(generated.layers["terrain"])
    assert len(set(values)) > 1
