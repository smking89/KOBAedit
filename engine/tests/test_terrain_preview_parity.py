"""The exported heightmap must match the editor's terrain preview.

The editor draws `generateTerrainPreview` (TypeScript) and the engine exports
`generate_terrain` (Python). They are two implementations of the same noise, so
a constant drifting in one of them would export a map the user never saw — the
offshore monuments in The King's Curse are placed against the preview, so a
mismatch would put oil rigs on land.

The expected values come from the TypeScript generator:
seed 1313, preset islands, size 256 m, 257² preview grid.
"""

from __future__ import annotations

import pytest

from koba_engine.procedural import TerrainSettings, generate_terrain
from koba_engine.world.models import height_raw_to_metres
from koba_engine.world.terrain import decode_u16

# The first four picks sit on the map border, which the edge falloff now drops
# to the seabed (-43 m for the default -8 m water line) so every square map
# ends in ocean. The last two are interior samples of the unchanged island.
PICKS = [0, 1, 128, 129, 257 * 10 + 7, 257 * 200 + 250]
EDITOR_HEIGHTS = [-43.000000, -43.000000, -43.000000, -43.000000, -38.025581, -31.734886]


def test_engine_heightmap_matches_editor_preview() -> None:
    settings = TerrainSettings(seed=1313, size_metres=256, preset="islands", water_level=-8, detail=0.55)
    terrain = generate_terrain(settings)
    raw = decode_u16(terrain.layers["terrain"])

    for index, expected in zip(PICKS, EDITOR_HEIGHTS):
        actual = height_raw_to_metres(raw[index])
        # Quantised to a uint16 height, so allow a few centimetres.
        assert actual == pytest.approx(expected, abs=0.1), f"grid index {index} drifted from the editor preview"
