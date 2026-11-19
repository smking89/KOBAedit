from __future__ import annotations

import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

from rust_studio_engine.indexer import bundles as bundle_module
from rust_studio_engine.indexer.bundles import BundleIngestor, classify_asset_path, classify_object
from rust_studio_engine.indexer.db import connect, database_stats
from rust_studio_engine.indexer.indexer import prefab_name_from_path
from rust_studio_engine.indexer.unity_bundle import (
    BundleFormatError,
    ContainerEntry,
    read_bundle_info,
)
from rust_studio_engine.world.lz4_legacy import compress_block


def build_unityfs(*, compressed: bool, padded: bool) -> bytes:
    path = "CAB-test"
    data = b"DATA"
    raw_info = (
        bytes(16)
        + struct.pack(">I", 1)
        + struct.pack(">IIH", len(data), len(data), 0)
        + struct.pack(">I", 1)
        + struct.pack(">qqI", 0, len(data), 4)
        + path.encode("utf-8")
        + b"\0"
    )
    stored_info = compress_block(raw_info) if compressed else raw_info
    flags = 0x40 | (0x02 if compressed else 0) | (0x200 if padded else 0)

    prefix = (
        b"UnityFS\0"
        + struct.pack(">I", 8)
        + b"5.x.x\0"
        + b"6000.3.28x1-1\0"
    )
    body_size = len(prefix) + 8 + 4 + 4 + 4
    padding = (-body_size) % 16 if padded else 0
    total = body_size + padding + len(stored_info) + len(data)
    header = prefix + struct.pack(">q", total) + struct.pack(
        ">III", len(stored_info), len(raw_info), flags
    )
    assert len(header) == body_size
    return header + (b"\0" * padding) + stored_info + data


@pytest.mark.parametrize("compressed", [False, True])
@pytest.mark.parametrize("padded", [False, True])
def test_reads_unityfs_header_blocks_and_nodes(tmp_path, compressed, padded) -> None:
    target = tmp_path / "test.bundle"
    payload = build_unityfs(compressed=compressed, padded=padded)
    target.write_bytes(payload)

    info = read_bundle_info(target)
    assert info.file_version == 8
    assert info.unity_revision == "6000.3.28x1-1"
    assert info.compression == ("lz4" if compressed else "none")
    assert len(info.blocks) == 1
    assert info.blocks[0].uncompressed_size == 4
    assert len(info.nodes) == 1
    assert info.nodes[0].path == "CAB-test"
    assert info.nodes[0].size == 4
    assert info.file_bytes == len(payload)


def test_rejects_non_unityfs_files(tmp_path) -> None:
    target = tmp_path / "not-a-bundle.bin"
    target.write_bytes(b"PK\x03\x04not a unity bundle")
    with pytest.raises(BundleFormatError):
        read_bundle_info(target)


def test_prefab_and_container_classification() -> None:
    assert prefab_name_from_path("assets/content/items/hat.wolf.item.prefab") == "hat.wolf"
    assert prefab_name_from_path("assets/bundled/prefabs/airfield.prefab") == "airfield"
    assert classify_asset_path("assets/x/airfield.prefab") == "prefab"
    assert classify_asset_path("assets/x/ak47.fbx") == "mesh"
    assert classify_asset_path("assets/x/airfield_1/biometexture.png") == "texture"
    assert classify_asset_path("assets/x/scene.unity") == "scene"
    assert classify_object("GameObject", "assets/x/item.prefab") == "prefab"
    assert classify_object("Mesh", None) == "mesh"
    assert classify_object("MonoBehaviour", "assets/x/skin.asset") == "data"


def test_schema_tracks_bundles() -> None:
    connection = connect(":memory:")
    stats = database_stats(connection)
    assert stats["bundles"] == 0
    assert stats["bundleAssets"] == 0
    tables = {
        row["name"]
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    assert {"bundles", "bundle_assets"} <= tables
    connection.close()


class FakeObject:
    def __init__(self, object_type: str, path_id: int, name: str) -> None:
        self.type = SimpleNamespace(name=object_type)
        self.path_id = path_id
        self.assets_file = SimpleNamespace(name="CAB-test")
        self._name = name

    def peek_name(self) -> str:
        return self._name


class FakeEnvironment:
    def __init__(self, objects: list[FakeObject]) -> None:
        self.objects = objects


def test_bundle_ingest_imports_prefab_paths(tmp_path, monkeypatch) -> None:
    target = tmp_path / "content.bundle"
    target.write_bytes(build_unityfs(compressed=True, padded=True))
    environment = FakeEnvironment(
        [
            FakeObject("AssetBundle", 1, "shared/content.bundle"),
            FakeObject("GameObject", 77, "airfield"),
            FakeObject("Mesh", 88, "airfield_mesh"),
            FakeObject("Texture2D", 99, "BiomeTexture"),
        ]
    )
    monkeypatch.setattr(bundle_module, "load_bundle", lambda path: environment)
    monkeypatch.setattr(
        bundle_module,
        "read_container",
        lambda env: [ContainerEntry("assets/bundled/prefabs/airfield.prefab", 77)],
    )

    database = tmp_path / "index.db"
    with BundleIngestor(database, tmp_path / "thumbs", extract_dir=tmp_path / "extracted") as ingestor:
        report = ingestor.ingest([target], pack_name="test-pack", extract="none")

    assert not report.errors
    assert report.bundles == 1
    assert report.prefabs == 1
    assert report.assets == 3  # GameObject, Mesh, Texture2D (AssetBundle excluded)

    with connect(database) as connection:
        prefab = connection.execute("SELECT * FROM prefabs").fetchone()
        assert prefab["asset_path"] == "assets/bundled/prefabs/airfield.prefab"
        assert prefab["name"] == "airfield"
        assert prefab["category"] == "Other"
        assert prefab["prefab_id"] > 0

        bundle = connection.execute("SELECT * FROM bundles").fetchone()
        assert bundle["container_count"] == 1
        assert bundle["object_counts_json"].find("GameObject") >= 0
        assert connection.execute("SELECT COUNT(*) FROM bundle_assets").fetchone()[0] == 3

        search = connection.execute(
            "SELECT name FROM asset_search WHERE asset_search MATCH 'airfield*'"
        ).fetchall()
        assert "airfield" in [row["name"] for row in search]

        # Reindexing replaces bundle_assets rows but must keep exported paths.
        connection.execute(
            "UPDATE bundle_assets SET extracted_path = '/tmp/exported.obj' WHERE object_type = 'Mesh'"
        )

    with BundleIngestor(database, tmp_path / "thumbs", extract_dir=tmp_path / "extracted") as ingestor:
        ingestor.ingest([target], pack_name="test-pack", extract="none", force=True)

    with connect(database) as connection:
        exported = connection.execute(
            "SELECT extracted_path FROM bundle_assets WHERE object_type = 'Mesh'"
        ).fetchone()
        assert exported["extracted_path"] == "/tmp/exported.obj"
