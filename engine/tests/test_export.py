from __future__ import annotations

from pathlib import Path

from PIL import Image

from rust_studio_engine.exporter import export_draft
from rust_studio_engine.world.map_file import read_document
from rust_studio_engine.world.models import STUDIO_META_LAYER


def base_draft(kind: str = "map") -> dict:
    return {
        "name": "Test World",
        "mode": "offline",
        "projectKind": kind,
        "terrain": {
            "seed": 4242,
            "preset": "islands",
            "sizeMetres": 128,
            "mountainScale": 1.0,
            "waterLevel": -6,
            "detail": 0.5,
            "treeDensity": 0.6,
            "biomeWeights": [0.2, 0.6, 0.15, 0.05],
        },
        "placements": [
            {
                "assetId": "assets/bundled/prefabs/autospawn/monument/airfield.prefab",
                "position": {"x": 12, "y": 0, "z": -8},
                "rotationEuler": {"x": 0, "y": 45, "z": 0},
                "scale": {"x": 1, "y": 1, "z": 1},
                "flatten": True,
                "flattenRadius": 18,
                "flattenFalloff": 8,
                "clearFoliage": True,
                "noBuildZone": True,
            }
        ],
        "splines": [
            {
                "kind": "road",
                "name": "Road 0",
                "width": 9,
                "closed": False,
                "nodes": [{"x": -40, "y": 0, "z": -40}, {"x": 0, "y": 0, "z": 0}, {"x": 40, "y": 0, "z": 40}],
            },
            {
                "kind": "river",
                "name": "River 0",
                "width": 18,
                "closed": False,
                "nodes": [{"x": -50, "y": 0, "z": 30}, {"x": 50, "y": 0, "z": 20}],
            },
        ],
        "loot": {"tier": 2},
        "skin": {},
        "export": {
            "fileName": "test_world",
            "stripEditorData": False,
            "mapLock": True,
            "mapPassword": "secret123",
            "includeEmission": True,
        },
    }


def test_export_map_writes_parseable_file_with_prefabs_paths_and_pads(tmp_path) -> None:
    result = export_draft(base_draft("map"), output_dir=tmp_path)
    assert result.kind == "map"
    path = Path(result.path)
    assert path.suffix == ".map"
    assert path.stat().st_size == result.bytes

    document = read_document(path)
    assert document.size == 128
    assert len(document.prefabs) == 1
    assert document.prefabs[0].category == "Monument"
    assert document.prefabs[0].prefab_id != 0
    assert len(document.paths) == 2
    assert [path.name for path in document.paths] == ["Road 0", "River 0"]

    layers = document.summary()["layers"]
    assert layers["terrain"] == (128 + 1) ** 2 * 2
    assert STUDIO_META_LAYER in document.layers
    assert b"secret123" not in document.layers[STUDIO_META_LAYER]


def test_export_monument_writes_prefab_only(tmp_path) -> None:
    draft = base_draft("monument")
    result = export_draft(draft, output_dir=tmp_path)
    assert result.kind == "prefab"
    document = read_document(result.path)
    assert "terrain" not in document.layers
    assert len(document.prefabs) == 1
    assert not document.paths


def test_export_skin_writes_four_channels(tmp_path) -> None:
    draft = {
        "name": "AK Skin",
        "projectKind": "skin",
        "mode": "offline",
        "skin": {
            "baseMeshId": "assets/content/weapons/ak47/ak47.glb",
            "resolution": 1024,
            "layers": [
                {
                    "id": "layer-1",
                    "preset": "metal",
                    "enabled": True,
                    "baseColor": "#3f4a52",
                    "metallic": 0.85,
                    "smoothness": 0.45,
                }
            ],
            "decals": [
                {"id": "d1", "stamp": "hazard", "color": "#d8b45a", "size": 180, "opacity": 0.8},
            ],
            "wear": {"edgeWear": 0.4, "grunge": 0.3, "dirt": 0.2, "scratches": 0.2, "emissionStrength": 1.5},
        },
        "export": {"fileName": "ak_skin", "includeEmission": True},
    }
    result = export_draft(draft, output_dir=tmp_path)
    assert result.kind == "skin"
    assert result.channels == ["diffuse", "normal", "specular", "emission"]
    for suffix in ("_diffuse.png", "_normal.png", "_specular.png", "_emission.png"):
        path = tmp_path / f"ak_skin{suffix}"
        assert path.exists(), suffix
        with Image.open(path) as image:
            assert image.size == (1024, 1024)
            assert image.mode == "RGBA"
