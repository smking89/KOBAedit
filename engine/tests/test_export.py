from __future__ import annotations

from pathlib import Path

from PIL import Image

import base64

import pytest

from koba_engine.exporter import ExportError, export_draft, stretch_grid_onto_map
from koba_engine.world.map_file import read_document, validate_layout
from koba_engine.world.terrain import HeightField, encode_u16
from koba_engine.map_lock import LOCK_LAYER, unlock_map_lock
from koba_engine.world.models import STUDIO_META_LAYER, height_raw_to_metres
from koba_engine.world.terrain import decode_u16


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


def test_native_heightmap_keeps_1025_grid_and_map_size(tmp_path) -> None:
    draft = base_draft("map")
    resolution = 1025
    # 1025² is the native grid of a 1024 m map, so the map follows the grid.
    draft["terrain"]["sizeMetres"] = resolution - 1
    heights = [((x * 7 + z * 3) % 65535) for z in range(resolution) for x in range(resolution)]
    draft["terrain"]["heightmap"] = {
        "name": "native.raw",
        "resolution": resolution,
        "encoding": "raw16",
        "data": base64.b64encode(encode_u16(heights)).decode("ascii"),
        "minHeight": 0,
        "maxHeight": 1000,
        "verticalScale": 1,
    }
    draft["placements"] = []
    draft["splines"] = []
    draft["export"]["mapLock"] = False
    result = export_draft(draft, output_dir=tmp_path)
    document = read_document(result.path)
    assert document.size == resolution - 1
    assert len(document.layers["terrain"]) == resolution * resolution * 2
    assert document.summary()["heightResolution"] == resolution
    assert not [issue for issue in validate_layout(document) if issue["severity"] == "error"]


# Preview heights for the fixture below, produced by the editor's own
# buildTerrainPreview at 257² on a 4500 m draft (sampleGrid is bilinear). The
# last pick sits above Rust's +500 m ceiling, so both sides store the clipped 500.
COARSE_PREVIEW_PICKS = [
    (0, 0, 0.0),
    (64, 32, 37.8729),
    (128, 128, 242.4201),
    (200, 96, 364.1108),
    (256, 256, 500.0),
    (37, 211, 339.498),
]


def coarse_fixture(resolution: int) -> list[int]:
    """Smooth (quadratic) so upsampling error stays far below the tolerance,
    yet integer-exact in both Python and the TypeScript preview."""
    return [((x * x + z * z) // 33) for z in range(resolution) for x in range(resolution)]


def sample_bilinear(raw: list[int], resolution: int, u: float, v: float) -> float:
    """Same interpolation the editor uses (terrainImport.sampleGrid)."""
    gx = max(0.0, min(resolution - 1.0, u * (resolution - 1)))
    gz = max(0.0, min(resolution - 1.0, v * (resolution - 1)))
    x0 = int(gx)
    z0 = int(gz)
    x1 = min(resolution - 1, x0 + 1)
    z1 = min(resolution - 1, z0 + 1)
    tx = gx - x0
    tz = gz - z0
    top = raw[z0 * resolution + x0] * (1 - tx) + raw[z0 * resolution + x1] * tx
    bottom = raw[z1 * resolution + x0] * (1 - tx) + raw[z1 * resolution + x1] * tx
    return top * (1 - tz) + bottom * tz


def test_stretch_grid_onto_map_interpolates_and_clips() -> None:
    """The exporter resample is plain bilinear on the source grid.

    Raw values are elevation in the 0-1000 m import convention: 0, 500, 250 and
    750 m here, so the last corner must be clipped at the layer ceiling exactly
    as the preview clips it. This is the fast half of the old full-map test; one
    end-to-end case still checks the export path itself.
    """
    grid = [0, 32768, 16384, 49152]
    stretched = stretch_grid_onto_map(grid, 2, 3)
    metres = [height_raw_to_metres(value) for value in stretched]

    assert len(stretched) == 9
    assert metres[0] == pytest.approx(0, abs=0.02)
    assert metres[1] == pytest.approx(250, abs=0.02)  # edge midpoint
    assert metres[2] == pytest.approx(500, abs=0.02)
    assert metres[4] == pytest.approx(375, abs=0.02)  # centre = mean of corners
    assert metres[6] == pytest.approx(250, abs=0.02)
    assert metres[8] == pytest.approx(500, abs=0.02)  # 750 m clipped to the ceiling

    scaled = [height_raw_to_metres(value) for value in stretch_grid_onto_map(grid, 2, 3, 2.0)]
    assert max(scaled) == pytest.approx(500, abs=0.02)
    assert scaled[0] == pytest.approx(0, abs=0.02)


def test_png_labelled_import_exports_identically_to_raw(tmp_path) -> None:
    """A PNG-sourced heightmap takes the same export path as a RAW one.

    The editor normalises both imports to the same uint16 payload and keeps
    ``encoding`` only as provenance, so a PNG-labelled draft must export
    byte-identical terrain. The map is 1050 m - just above the 1024 m coarse
    threshold - to keep this fast; the pinned preview picks are normalised, so
    they do not depend on the map size.
    """
    resolution = 1025
    payload = base64.b64encode(encode_u16(coarse_fixture(resolution))).decode("ascii")
    documents = {}
    for encoding in ("raw16", "png16"):
        draft = base_draft("map")
        draft["terrain"]["sizeMetres"] = 1050
        draft["terrain"]["heightmap"] = {
            "name": f"fixture.{encoding}",
            "resolution": resolution,
            "encoding": encoding,
            "data": payload,
            "minHeight": 0,
            "maxHeight": 1000,
            "verticalScale": 1,
        }
        draft["placements"] = []
        draft["splines"] = []
        draft["export"]["mapLock"] = False
        draft["export"]["fileName"] = f"parity-{encoding}"
        documents[encoding] = read_document(export_draft(draft, output_dir=tmp_path).path)

    png, raw = documents["png16"], documents["raw16"]
    assert png.size == raw.size == 1050
    assert png.layers["terrain"] == raw.layers["terrain"]
    assert png.layers["height"] == raw.layers["height"]

    values = decode_u16(png.layers["terrain"])
    for x, z, expected in COARSE_PREVIEW_PICKS:
        sampled = sample_bilinear(values, png.size + 1, x / 256, z / 256)
        assert height_raw_to_metres(round(sampled)) == pytest.approx(expected, abs=0.05), (
            f"PNG-sourced export drifted from the preview at preview index ({x}, {z})"
        )


def test_coarse_import_exports_the_preview_the_user_saw(tmp_path) -> None:
    """A 1025² grid on a 2250 m map must export exactly what the preview draws.

    The picks are preview-index fractions, so the target grid only has to be
    large enough to exercise normalisation and smaller than the map size; 2250 m
    keeps the export to a quarter of the work of the old 4500 m fixture.
    """
    resolution = 1025
    draft = base_draft("map")
    draft["terrain"]["sizeMetres"] = 2250
    draft["terrain"]["heightmap"] = {
        "name": "fixture.raw",
        "resolution": resolution,
        "encoding": "raw16",
        "data": base64.b64encode(encode_u16(coarse_fixture(resolution))).decode("ascii"),
        "minHeight": 0,
        "maxHeight": 1000,
        "verticalScale": 1,
    }
    draft["placements"] = []
    draft["splines"] = []
    draft["export"]["mapLock"] = False

    document = read_document(export_draft(draft, output_dir=tmp_path).path)
    assert document.size == 2250
    exported = decode_u16(document.layers["terrain"])
    exported_resolution = document.size + 1
    assert len(exported) == exported_resolution * exported_resolution

    for x, z, expected in COARSE_PREVIEW_PICKS:
        raw = sample_bilinear(exported, exported_resolution, x / 256, z / 256)
        # uint16 quantisation of a 1000 m layer is ~1.5 cm, so 5 cm is generous.
        assert height_raw_to_metres(round(raw)) == pytest.approx(expected, abs=0.05), (
            f"export drifted from the preview at preview index ({x}, {z})"
        )


def test_native_import_rejects_grids_above_limit() -> None:
    draft = base_draft("map")
    draft["terrain"]["heightmap"] = {
        "resolution": 4098,
        "data": "",
        "verticalScale": 1,
    }
    with pytest.raises(ExportError, match="at most 4097"):
        export_draft(draft, output_dir=Path("/tmp"))
    draft["terrain"].pop("heightmap")
    draft["terrain"]["masks"] = [{"kind": "splat", "channel": 0, "resolution": 4098, "data": ""}]
    with pytest.raises(ExportError, match="at most 4097"):
        export_draft(draft, output_dir=Path("/tmp"))


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
    import json

    lock = json.loads(document.layers[LOCK_LAYER])
    assert unlock_map_lock(lock, "secret123")["project"] == "Test World"
    assert (tmp_path / "test_world.map.lock").exists()
    assert "secret123" not in (tmp_path / "test_world.map.lock").read_text()


def _cave_draft(y: float) -> dict:
    draft = base_draft("map")
    draft["placements"] = []
    draft["splines"] = [
        {
            "id": "cave-0",
            "name": "Cave 0",
            "kind": "cave",
            "width": 9,
            "ceilingHeight": 7,
            "roughness": 0.2,
            "curve": "catmull-rom",
            "deformTerrain": False,
            "paintSplat": False,
            "topologyFlag": None,
            "nodes": [
                {"x": -50, "y": y, "z": 0},
                {"x": 50, "y": y, "z": 0},
            ],
        }
    ]
    return draft


def test_cave_spline_cuts_alpha_portals_at_the_surface(tmp_path) -> None:
    result = export_draft(_cave_draft(500), output_dir=tmp_path)
    document = read_document(result.path)
    alpha = document.layers["alpha"]
    assert len(alpha) == 64 * 64
    # A tunnel far above the terrain opens the ceiling over its whole run.
    assert alpha.count(0) > 200
    assert alpha.count(255) > 2000


def test_deep_cave_keeps_its_ceiling(tmp_path) -> None:
    result = export_draft(_cave_draft(-900), output_dir=tmp_path)
    document = read_document(result.path)
    assert document.layers["alpha"].count(0) == 0


def _raise_stroke(strength: float) -> dict:
    return {
        "id": "stroke-raise",
        "x": 0,
        "z": 0,
        "mode": "raise",
        "radius": 20,
        "strength": strength,
        "falloff": 2,
        "splatChannel": "grass",
        "biomeChannel": "temperate",
        "topologyFlags": [],
        "topologyClearFlags": [],
        "sync": {},
    }


def _flatten_stroke() -> dict:
    stroke = _raise_stroke(1.0)
    stroke["id"] = "stroke-flatten"
    stroke["mode"] = "flatten"
    stroke["radius"] = 34
    return stroke


def _layer_draft(layers: list[dict] | None = None, strokes: list[dict] | None = None) -> dict:
    draft = base_draft("map")
    draft["placements"] = []
    draft["splines"] = []
    if layers is not None:
        draft["terrain"]["layers"] = layers
    if strokes is not None:
        draft["terrain"]["strokes"] = strokes
    return draft


def _layer(
    stroke: dict, *, opacity: float = 1.0, visible: bool = True, layer_id: str = "l1"
) -> dict:
    return {
        "id": layer_id,
        "name": "Sculpt 1",
        "kind": "sculpt",
        "visible": visible,
        "opacity": opacity,
        "strokes": [stroke],
    }


def _centre_height(path: Path) -> float:
    return HeightField.from_document(read_document(path)).sample(0, 0)


def test_layers_replay_visibility_opacity_and_legacy_equivalence(tmp_path) -> None:
    base = _centre_height(export_draft(_layer_draft(strokes=[]), output_dir=tmp_path).path)
    legacy = _centre_height(
        export_draft(_layer_draft(strokes=[_raise_stroke(6.0)]), output_dir=tmp_path).path
    )
    full = _centre_height(
        export_draft(_layer_draft(layers=[_layer(_raise_stroke(6.0))]), output_dir=tmp_path).path
    )
    half = _centre_height(
        export_draft(
            _layer_draft(layers=[_layer(_raise_stroke(6.0), opacity=0.5)]), output_dir=tmp_path
        ).path
    )
    hidden = _centre_height(
        export_draft(
            _layer_draft(layers=[_layer(_raise_stroke(6.0), visible=False)]), output_dir=tmp_path
        ).path
    )

    # A single visible full-strength layer exports what the old flat history did.
    assert abs((full - base) - (legacy - base)) < 0.1
    assert full - base > 3
    assert abs((half - base) - (full - base) / 2) < 0.5
    assert abs(hidden - base) < 0.1


def test_layer_order_drives_replay_order(tmp_path) -> None:
    raise_then_flatten = _layer_draft(
        layers=[
            _layer(_raise_stroke(8.0), layer_id="l1"),
            _layer(_flatten_stroke(), layer_id="l2"),
        ]
    )
    flatten_then_raise = _layer_draft(
        layers=[
            _layer(_flatten_stroke(), layer_id="l1"),
            _layer(_raise_stroke(8.0), layer_id="l2"),
        ]
    )
    first = _centre_height(export_draft(raise_then_flatten, output_dir=tmp_path).path)
    second = _centre_height(export_draft(flatten_then_raise, output_dir=tmp_path).path)
    # Flattening after a raise erases it; flattening first keeps the raise on top.
    assert second - first > 3


def test_native_mask_resampling_keeps_detail() -> None:
    from koba_engine.exporter import _resample_mask

    checker = bytes(255 if (x + z) % 2 else 0 for z in range(8) for x in range(8))
    # An exact grid is passed through untouched, byte for byte.
    assert _resample_mask(checker, 8, 8) == checker
    # Point sampling every other texel would return pure 0/255. Box averaging
    # keeps the 50% coverage of the native mask on the smaller layer grid.
    averaged = _resample_mask(checker, 8, 4)
    assert len(averaged) == 16
    assert all(120 <= value <= 136 for value in averaged)


def test_native_mask_is_resampled_onto_the_layer_grid(tmp_path) -> None:
    from koba_engine.world.terrain import EDITOR_TOPOLOGY_FLAGS, decode_i32

    draft = base_draft("map")
    draft["placements"] = []
    draft["splines"] = []
    resolution = 128
    # Left half marked, right half clear: the 2:1 downsample must keep the
    # boundary and drive the topology bit from the layer grid, not native rows.
    data = bytes(
        255 if x < resolution // 2 else 0
        for z in range(resolution)
        for x in range(resolution)
    )
    draft["terrain"]["masks"] = [
        {
            "kind": "topology",
            "channel": 7,
            "resolution": resolution,
            "data": base64.b64encode(data).decode("ascii"),
        }
    ]
    result = export_draft(draft, output_dir=tmp_path)
    document = read_document(result.path)
    topology = decode_i32(document.layers["topology"])
    bit = EDITOR_TOPOLOGY_FLAGS["safe_zone"]
    size = 64
    assert len(topology) == size * size
    assert all(topology[z * size + x] & bit for z in range(size) for x in range(32))
    assert not any(topology[z * size + x] & bit for z in range(size) for x in range(32, size))


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
