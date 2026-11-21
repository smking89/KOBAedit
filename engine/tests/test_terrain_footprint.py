"""The UI footprint badge must be the engine's own numbers."""

from __future__ import annotations

import json
from pathlib import Path

from koba_engine.procedural import TerrainSettings, generate_terrain, terrain_footprint

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "apps/studio-ui/tests/fixtures/terrain-footprint.json"
)


def test_fixture_matches_the_engine_rule() -> None:
    rows = json.loads(FIXTURE.read_text(encoding="utf-8"))

    assert len(rows) >= 8
    for row in rows:
        expected = dict(row)
        size = expected.pop("sizeMetres")
        assert terrain_footprint(size) == expected, f"{size} m drifted from the fixture"


def test_rule_matches_the_generated_layers() -> None:
    """The closed-form grid must equal what generate_terrain actually allocates."""

    generated = generate_terrain(
        TerrainSettings(seed=7, size_metres=1000, floor_height=0.0)
    )
    footprint = terrain_footprint(1000)

    assert footprint["samples"] == 1001
    assert generated.height_resolution == footprint["samples"]
    assert generated.splat_resolution == footprint["splatResolution"]
    # Layers are encoded: uint16 heights and eight packed splat planes.
    assert len(generated.layers["terrain"]) == footprint["samples"] ** 2 * 2
    assert len(generated.layers["splat"]) == footprint["splatResolution"] ** 2 * 8
    assert len(generated.layers["biome"]) == footprint["splatResolution"] ** 2 * 4
    assert len(generated.layers["topology"]) == footprint["splatResolution"] ** 2 * 4
    assert len(generated.layers["alpha"]) == footprint["splatResolution"] ** 2
