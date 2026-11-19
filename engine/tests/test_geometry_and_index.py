from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from PIL import Image

from rust_studio_engine.indexer.db import connect
from rust_studio_engine.indexer.indexer import AssetIndexer, prefab_id_from_path
from rust_studio_engine.procedural import TerrainSettings, generate_terrain
from rust_studio_engine.spline import (
    sample_catmull_rom,
    smooth_path,
    terrain_hugging_ribbon,
)
from rust_studio_engine.sync.queue import SyncQueue
from rust_studio_engine.texture import (
    TextureError,
    export_channels,
    normal_map_from_height,
    validate_resolution,
)
from rust_studio_engine.world.map_file import build_document
from rust_studio_engine.world.models import (
    PathInstance,
    PathNode,
    PrefabInstance,
    Vector3,
    WorldDocument,
)
from rust_studio_engine.world.terrain import (
    EDITOR_TOPOLOGY_FLAGS,
    HeightField,
    decode_i32,
    encode_i32,
    encode_u16,
    mark_topology_region,
    paint_splat,
    splat_planes,
    store_splat,
)

CUBE_OBJ = """# cube
v 0 0 0
v 2 0 0
v 2 1 0
v 0 1 0
v 0 0 2
v 2 0 2
v 2 1 2
v 0 1 2
f 1 2 3
f 1 3 4
f 5 6 7
f 5 7 8
f 1 2 6
f 1 6 5
"""


def test_heightfield_brush_and_monument_flatten() -> None:
    res = 33
    size = 32
    heights = encode_u16([32000] * (res * res))
    document = WorldDocument(size=size, layers={"terrain": heights})
    field = HeightField.from_document(document)

    before = field.sample(0, 0)
    touched = field.apply_brush(0, 0, radius=8, strength=5.0, mode="raise")
    assert touched > 0
    assert field.sample(0, 0) > before + 3.0

    touched, target = field.flatten_pad(0, 0, radius=5, falloff_width=4)
    assert touched > 0
    assert field.sample(0, 0) == pytest.approx(target, abs=0.2)
    field.store(document)
    assert len(document.layers["terrain"]) == res * res * 2


def test_splat_paint_normalizes_and_topology_flags() -> None:
    res = 32
    size = 32
    document = WorldDocument(
        size=size,
        layers={
            "splat": bytes(res * res * 8),
            "topology": encode_i32([0] * (res * res)),
        },
    )
    planes = splat_planes(document)
    paint_splat(planes, res, size, x=0, z=0, radius=8, channel=3, strength=1.0)
    store_splat(document, planes)
    total = 0
    for texel in range(res * res):
        total = sum(plane[texel] for plane in planes)
        if total:
            break
    assert total == 255

    topology = decode_i32(document.layers["topology"])
    mark_topology_region(
        topology, res, size, 0, 0, 6, ["no_build", "monument_pad"]
    )
    bits = topology[(res // 2) * res + (res // 2)]
    assert bits & EDITOR_TOPOLOGY_FLAGS["no_build"]
    assert bits & EDITOR_TOPOLOGY_FLAGS["monument_pad"]


def test_spline_sampling_and_ribbon_mesh() -> None:
    controls = [(0.0, 0.0, 0.0), (30.0, 2.0, 0.0), (60.0, 0.0, 20.0), (90.0, 1.0, 30.0)]
    curve = sample_catmull_rom(controls, samples_per_segment=8)
    assert len(curve) > len(controls)
    assert curve[0] == pytest.approx(controls[0])
    spaced = smooth_path(controls, spacing=3.0)
    assert len(spaced) > 20
    mesh = terrain_hugging_ribbon(spaced, width=8.0)
    assert len(mesh.positions) == len(spaced) * 2 * 3
    assert len(mesh.normals) == len(mesh.positions)
    assert len(mesh.uvs) == len(spaced) * 2 * 2
    assert len(mesh.indices) == (len(spaced) - 1) * 6
    assert mesh.length > 60


def test_texture_validation_and_workshop_export(tmp_path) -> None:
    with pytest.raises(TextureError):
        validate_resolution(512, 512)
    with pytest.raises(TextureError):
        validate_resolution(1024, 2048)

    height = Image.linear_gradient("L").resize((64, 64))
    normal = normal_map_from_height(height, strength=2.0)
    assert normal.size == (64, 64)
    assert normal.mode == "RGBA"

    diffuse = Image.new("RGBA", (1024, 1024), (120, 40, 30, 255))
    written = export_channels("ak47", {"diffuse": diffuse}, tmp_path, 1024)
    assert set(written) == {"diffuse", "normal", "specular", "emission"}
    for path in written.values():
        with Image.open(path) as image:
            assert image.size == (1024, 1024)
    assert (tmp_path / "ak47_diffuse.png").exists()


def test_prefab_id_matches_rust_hash_rule() -> None:
    asset_path = "assets/bundled/prefabs/autospawn/monument/airfield.prefab"
    expected = int.from_bytes(hashlib.md5(asset_path.lower().encode()).digest()[:4], "little")
    assert prefab_id_from_path(asset_path) == expected
    assert prefab_id_from_path(asset_path.upper()) == expected


def test_procedural_terrain_is_deterministic() -> None:
    settings = TerrainSettings(seed=42, size_metres=64, preset="islands")
    first = generate_terrain(settings)
    second = generate_terrain(settings)
    assert first.layers == second.layers
    assert len(first.layers["terrain"]) == (64 + 1) ** 2 * 2
    assert len(first.layers["splat"]) == 32 * 32 * 8

    other = generate_terrain(TerrainSettings(seed=43, size_metres=64, preset="islands"))
    assert other.layers["terrain"] != first.layers["terrain"]


def build_pack(root: Path) -> Path:
    pack = root / "pack"
    monument_dir = pack / "prefabs" / "monuments"
    monument_dir.mkdir(parents=True)
    document = WorldDocument(
        size=64,
        prefabs=[PrefabInstance(category="Monument", prefab_id=1234, position=Vector3(1, 2, 3))],
    )
    (monument_dir / "airfield.prefab").write_bytes(build_document(document))

    mesh_dir = pack / "meshes" / "weapons"
    mesh_dir.mkdir(parents=True)
    (mesh_dir / "ak47.obj").write_text(CUBE_OBJ, encoding="utf-8")

    map_dir = pack / "maps"
    map_dir.mkdir()
    map_document = WorldDocument(
        size=64,
        layers={
            "terrain": encode_u16([32768] * (65 * 65)),
            "splat": bytes([255] * (32 * 32 * 8)),
        },
        prefabs=[PrefabInstance(category="Monument", prefab_id=1234)],
        paths=[PathInstance(name="Road 0", nodes=[PathNode(), PathNode(Vector3(10, 0, 10))])],
    )
    (map_dir / "studio-test.map").write_bytes(build_document(map_document))

    manifest = {
        "prefabs/monuments/airfield.prefab": {
            "category": "Monument",
            "boundsMin": [-40.0, 0.0, -30.0],
            "boundsMax": [40.0, 25.0, 30.0],
            "flattenRadius": 55.0,
            "colliders": [
                {"shape": "box", "center": [0, 12, 0], "extents": [40, 12, 30], "volumeKind": "collider"},
                {"shape": "box", "center": [0, 12, 0], "extents": [60, 15, 50], "volumeKind": "no_build"},
            ],
            "hasLoot": True,
        }
    }
    (pack / "prefabs.json").write_text(json.dumps(manifest), encoding="utf-8")
    return pack


def test_asset_indexer_ingest_thumbnails_and_search(tmp_path) -> None:
    pack = build_pack(tmp_path)

    database = tmp_path / "index.db"
    with AssetIndexer(database, tmp_path / "thumbs") as indexer:
        report = indexer.ingest(
            pack,
            pack_name="test-pack",
            manifest_path=pack / "prefabs.json",
            make_thumbnails=True,
        )
    assert report.meshes == 1
    assert report.prefabs == 1
    assert report.maps == 1
    assert report.thumbnails >= 2
    assert not report.errors

    with connect(database) as connection:
        mesh = connection.execute("SELECT * FROM base_meshes").fetchone()
        assert mesh["name"] == "ak47"
        assert mesh["item_kind"] == "weapon"
        assert mesh["triangle_count"] >= 6
        assert Path(mesh["thumbnail_path"]).exists()

        prefab = connection.execute("SELECT * FROM prefabs").fetchone()
        assert prefab["category"] == "Monument"
        assert prefab["flatten_radius"] == pytest.approx(55.0)
        assert prefab["bounds_max_y"] == pytest.approx(25.0)
        assert prefab["has_loot"] == 1
        bounds = connection.execute("SELECT COUNT(*) FROM prefab_bounds").fetchone()[0]
        assert bounds == 2

        source_map = connection.execute("SELECT * FROM source_maps").fetchone()
        assert source_map["size_metres"] == 64
        assert source_map["prefab_count"] == 1

        found = connection.execute(
            "SELECT name FROM asset_search WHERE asset_search MATCH 'airfield*'"
        ).fetchall()
        assert [row["name"] for row in found] == ["airfield"]


def test_sync_queue_backoff_and_conflict(tmp_path) -> None:
    connection = connect(tmp_path / "sync.db")
    queue = SyncQueue(connection)
    profile = queue.ensure_profile("studio-cloud", "https://sync.example.net")

    queue_id = queue.mark_local_change(profile, "project", "project-1", payload_path=None)
    assert queue.pending_count(profile) == 1

    claimed = queue.claim()
    assert len(claimed) == 1
    assert claimed[0]["state"] == "inflight"
    assert queue.claim() == []

    result = queue.fail(queue_id, "network unreachable")
    assert result["attempts"] == 1
    assert result["delaySeconds"] == pytest.approx(5.0)
    assert result["state"] == "queued"
    assert queue.claim() == []  # not due yet

    queue.retry(queue_id)
    claimed = queue.claim()
    assert len(claimed) == 1
    queue.complete(queue_id, remote_etag="etag-1", remote_revision=4)
    metadata = connection.execute("SELECT * FROM sync_metadata WHERE entity_id = 'project-1'").fetchone()
    assert metadata["state"] == "synced"
    assert metadata["remote_etag"] == "etag-1"
    assert metadata["remote_revision"] == 4

    queue.mark_local_change(profile, "project", "project-1")
    decision = queue.record_remote_revision(profile, "project", "project-1", remote_revision=9)
    assert decision == "conflict"
    assert queue.status(profile)["conflicts"] == 1

    clean = queue.record_remote_revision(profile, "asset_pack", "pack-new", remote_revision=1)
    assert clean == "fast_forward"


def test_schema_and_settings(tmp_path) -> None:
    from rust_studio_engine.indexer.db import get_setting, set_setting

    connection = connect(tmp_path / "settings.db")
    set_setting(connection, "theme", "dark")
    assert get_setting(connection, "theme") == "dark"
    assert get_setting(connection, "missing", "fallback") == "fallback"
