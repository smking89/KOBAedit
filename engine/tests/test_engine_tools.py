"""Tests for the sketch, GENESIS, map-check, plugin and ready-pack engines."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from koba_engine import procedural
from koba_engine.genesis import simulate
from koba_engine.plugins import build_spec, render_plugin, write_plugin
from koba_engine.server_bundle import build_bundle
from koba_engine.sketch import SKETCH_PALETTE, heights_to_png, sketch_to_heightmap
from koba_engine.validation import map_check

COLOURS = {name: colour for name, colour, _height in SKETCH_PALETTE}


def make_sketch(size: int = 96) -> Image.Image:
    image = Image.new("RGB", (size, size), COLOURS["water"])
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, size - 10, size - 10), fill=COLOURS["sand"])
    draw.rectangle((20, 20, size - 20, size - 20), fill=COLOURS["grass"])
    draw.rectangle((30, 30, size // 2, size // 2), fill=COLOURS["forest"])
    draw.rectangle((size // 2, size // 2, size - 30, size - 30), fill=COLOURS["rock"])
    draw.rectangle((size // 2 + 6, size // 2 + 6, size // 2 + 18, size // 2 + 18), fill=COLOURS["snow"])
    draw.rectangle((size // 2 - 8, 24, size // 2 - 2, size - 24), fill=COLOURS["road"])
    draw.ellipse((34, size - 44, 52, size - 26), fill=COLOURS["monument"])
    return image


def make_draft() -> dict:
    return {
        "projectId": "test",
        "name": "Test World",
        "projectKind": "map",
        "branch": "world",
        "terrain": {
            "seed": 4242,
            "preset": "islands",
            "landmass": "single-island",
            "sizeMetres": 256,
            "mountainScale": 1.0,
            "waterLevel": -8,
            "detail": 0.55,
            "biomeWeights": [0.2, 0.6, 0.15, 0.05],
        },
        "placements": [
            {
                "id": "floating",
                "name": "Launch Site",
                "assetId": "a",
                "position": {"x": 0, "y": 900, "z": 0},
                "scale": {"x": 1, "y": 1, "z": 1},
                "collisionRadius": 20,
                "collisionHeight": 15,
                "lootTier": 3,
            },
            {
                "id": "buried",
                "name": "Bunker",
                "assetId": "b",
                "position": {"x": 40, "y": -450, "z": 40},
                "scale": {"x": 1, "y": 1, "z": 1},
                "collisionRadius": 12,
                "collisionHeight": 10,
                "lootTier": 2,
            },
            {
                "id": "outside",
                "name": "Off Grid",
                "assetId": "c",
                "position": {"x": 5000, "y": 0, "z": 0},
                "scale": {"x": 1, "y": 1, "z": 1},
                "collisionRadius": 6,
                "collisionHeight": 6,
                "lootTier": 1,
            },
        ],
        "splines": [
            {"id": "s1", "name": "Road 0", "kind": "road", "width": 9, "nodes": [{"x": -80, "y": 0, "z": -80}, {"x": 0, "y": 0, "z": 0}]},
            {"id": "s2", "name": "Stub", "kind": "rail", "width": 6, "nodes": [{"x": 0, "y": 0, "z": 10}]},
        ],
        "io": {"nodes": [], "links": []},
        "loot": {"tier": 3, "crateCount": 40, "vendingMachines": 2, "lootDensity": 1.0},
    }


def test_sketch_reconstructs_ordered_heights() -> None:
    result = sketch_to_heightmap(make_sketch(), resolution=97, smooth=1.0)

    assert result.coverage["water"] > 0.01
    assert result.coverage["grass"] > 0.01
    assert result.minimum < 0 < result.maximum

    heights = np.asarray(result.heights).reshape(97, 97)
    # Water ring (4,4) < sand (15,15) < forest (40,40) < rock (60,60).
    assert heights[4, 4] < heights[15, 15] < heights[40, 40] < heights[60, 60]


def test_sketch_pad_takes_local_ground_and_png_round_trips(tmp_path: Path) -> None:
    result = sketch_to_heightmap(make_sketch(), resolution=97, smooth=0.0)
    heights = np.asarray(result.heights).reshape(97, 97)
    pad = heights[54:58, 36:40]
    surroundings = heights[44:48, 36:40]
    assert abs(float(pad.mean()) - float(surroundings.mean())) < 20.0

    target = tmp_path / "height.png"
    heights_to_png(result.heights, 97, target)
    with Image.open(target) as reopened:
        assert reopened.mode == "I;16"
        raw = np.asarray(reopened).astype(np.float64)
    metres = raw / 65535.0 * 1000.0 - 500.0
    assert float(np.abs(metres - heights).max()) < 1.0


def test_genesis_is_deterministic_and_unlocks_raise_income() -> None:
    draft = make_draft()
    first = simulate(draft, players=150, hours=72, seed=11)
    second = simulate(draft, players=150, hours=72, seed=11)

    assert first["hourlyScrap"] == second["hourlyScrap"]
    hourly = first["hourlyScrap"]
    assert hourly[-1] > hourly[0] * 2
    assert 20 <= first["summary"]["scrapPerPlayerPerHour"] <= 400
    assert simulate(draft, players=10)["players"] == 50


def test_genesis_reports_missing_loot_as_error() -> None:
    draft = make_draft()
    draft["loot"]["crateCount"] = 0
    report = simulate(draft, players=120)
    assert any(finding["code"] == "no-crates" for finding in report["findings"])
    assert report["ok"] is False


def test_map_check_flags_buried_floating_outside_and_stub_spline() -> None:
    report = map_check(make_draft())
    codes = {finding["code"] for finding in report["findings"]}

    assert {"prefab-buried", "prefab-floating", "prefab-outside-map"} <= codes
    assert "spline-insufficient-nodes" in codes
    assert report["ok"] is False
    assert report["counts"]["error"] >= 2


def test_map_check_samples_without_regenerating_layers(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("map_check must not build the exported layers")

    monkeypatch.setattr(procedural, "generate_terrain", explode)
    procedural._HEIGHT_LATTICE_CACHE.clear()

    report = map_check(make_draft())
    assert report["findings"]


def test_plugins_render_for_both_frameworks(tmp_path: Path) -> None:
    draft = make_draft()
    spec = build_spec(draft)
    oxide = render_plugin(spec, "oxide")
    carbon = render_plugin(spec, "carbon")

    assert spec.class_name.startswith("Koba")
    assert "RustPlugin" in oxide and "LoadDefaultConfig" in oxide
    assert "CarbonPlugin" in carbon and "OnServerInitialized(bool initial)" in carbon
    for source in (oxide, carbon):
        assert source.count("{") == source.count("}")
        assert "4242" in source

    written = write_plugin(draft, tmp_path, framework="oxide", spec=spec)
    assert written.exists() and written.suffix == ".cs"
    with pytest.raises(ValueError):
        render_plugin(spec, "spigot")


def test_server_bundle_contains_configs_plugin_and_manifest(tmp_path: Path) -> None:
    draft = make_draft()
    draft["loot"]["maxPlayers"] = 220
    result = build_bundle(draft, tmp_path)
    archive = Path(result["path"])

    assert archive.exists() and archive.suffix == ".zip"
    with zipfile.ZipFile(archive) as bundle:
        names = set(bundle.namelist())
        assert {
            "server.cfg",
            "manifest.json",
            "oxide/config/BetterLoot.json",
            "oxide/config/AlphaLoot.json",
        } <= names
        assert any(name.endswith(".cs") for name in names)
        assert json.loads(bundle.read("oxide/config/AlphaLoot.json"))["Global"]
        config = bundle.read("server.cfg").decode()
        assert "server.worldsize 256" in config
        assert "server.maxplayers 220" in config
