from __future__ import annotations

from PIL import Image

from koba_engine.indexer.monument_previews import _key, _match_scene, shade_height_map


def test_shade_height_map_renders_relief_not_a_flat_sheet() -> None:
    image = Image.new("L", (48, 48))
    for x in range(48):
        for y in range(48):
            image.putpixel((x, y), (x * 5 + y * 3) % 256)

    shaded = shade_height_map(image)

    assert shaded.mode == "RGB"
    assert shaded.size == image.size
    colors = {shaded.getpixel((x, 24)) for x in range(48)}
    assert len(colors) > 8


def test_scene_matching_handles_rust_spellings_and_suffixes() -> None:
    folders = {
        _key("airfield_1"): ("assets/scenes/prefabs/airfield/airfield_1", ""),
        _key("bandid_town"): ("assets/scenes/prefabs/bandid_town", ""),
        _key("lighthouseterrain"): ("assets/scenes/prefabs/lighthouse", ""),
        _key("nuclearmissilesilo"): ("assets/scenes/prefabs/silo", ""),
    }

    assert (
        _match_scene(
            "assets/bundled/prefabs/autospawn/monument/large/airfield_1.prefab", folders
        )
        == _key("airfield_1")
    )
    assert (
        _match_scene(
            "assets/bundled/prefabs/autospawn/monument/medium/bandit_town.prefab", folders
        )
        == _key("bandid_town")
    )
    assert (
        _match_scene(
            "assets/bundled/prefabs/autospawn/monument/small/lighthouse.prefab", folders
        )
        == _key("lighthouseterrain")
    )
    assert (
        _match_scene(
            "assets/bundled/prefabs/autospawn/monument/x/nuclear-missile-silo-hatch-open-start.prefab",
            folders,
        )
        == _key("nuclearmissilesilo")
    )
    assert (
        _match_scene(
            "assets/bundled/prefabs/autospawn/monument/oilrig/oilrig_1.prefab", folders
        )
        is None
    )
