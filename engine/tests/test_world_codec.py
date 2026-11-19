from __future__ import annotations

import os
import struct

import pytest

from rust_studio_engine.world.lz4_legacy import (
    Lz4Error,
    compress_block,
    compress_stream,
    decompress_block,
    decompress_stream,
)
from rust_studio_engine.world.map_file import (
    MapFormatError,
    build_document,
    expected_layer_sizes,
    parse_document,
    read_document,
    validate_layout,
    write_document,
)
from rust_studio_engine.world.models import (
    PathInstance,
    PathNode,
    PrefabInstance,
    Vector3,
    WorldDocument,
)
from rust_studio_engine.world.terrain import encode_i32, encode_u16


def make_document(size: int = 64) -> WorldDocument:
    height_res = size + 1
    splat_res = 32
    document = WorldDocument(size=size, timestamp=1_760_000_000)
    document.layers["terrain"] = encode_u16(
        (index * 37) % 65536 for index in range(height_res * height_res)
    )
    document.layers["height"] = document.layers["terrain"]
    document.layers["water"] = encode_u16([31000] * (height_res * height_res))
    document.layers["splat"] = bytes(
        (index * 7) % 256 for index in range(splat_res * splat_res * 8)
    )
    document.layers["biome"] = bytes(
        (index * 3) % 256 for index in range(splat_res * splat_res * 4)
    )
    document.layers["topology"] = encode_i32([0] * (splat_res * splat_res))
    document.layers["alpha"] = bytes([255] * (splat_res * splat_res))

    document.prefabs = [
        PrefabInstance(
            category="Monument",
            prefab_id=0xDEADBEEF,
            position=Vector3(10.5, 12.25, -40.75),
            rotation=Vector3(0.0, 90.0, 0.0),
            scale=Vector3(1.0, 2.0, 1.0),
        ),
        PrefabInstance(category="Decor", prefab_id=7),
    ]
    document.paths = [
        PathInstance(
            name="Road 0",
            width=9.5,
            splat=4,
            topology=16,
            nodes=[
                PathNode(Vector3(-100.0, 5.0, -100.0)),
                PathNode(Vector3(0.0, 6.5, 0.0)),
                PathNode(Vector3(100.0, 8.0, 100.0)),
            ],
        ),
        PathInstance(name="River 0", width=22.0, nodes=[PathNode(), PathNode(Vector3(1, 2, 3))]),
    ]
    document.layers["RustEditData"] = b"<RustEdit/>"
    return document


def test_lz4_block_roundtrip_random_and_repetitive() -> None:
    for payload in (os.urandom(4096), b"abcd" * 20_000, b"", b"x"):
        packed = compress_block(payload)
        assert decompress_block(packed, len(payload)) == payload


def test_lz4_stream_roundtrip_multiple_chunks() -> None:
    payload = os.urandom(5000) + b"terrain" * 40_000
    stream = compress_stream(payload, chunk_size=4096)
    assert decompress_stream(stream) == payload


def test_lz4_rejects_corrupt_block() -> None:
    with pytest.raises(Lz4Error):
        decompress_block(b"\xff\xff\xff\xff\xff\xff\xff\xff", 1024)


def test_map_roundtrip_preserves_layers_prefabs_paths() -> None:
    original = make_document()
    raw = build_document(original)
    assert raw[:4] == struct.pack("<I", 10)
    assert struct.unpack_from("<q", raw, 4)[0] == 1_760_000_000

    restored = parse_document(raw)
    assert restored.size == original.size
    assert restored.version == 10
    assert restored.layers == original.layers
    assert len(restored.prefabs) == 2
    monument = restored.prefabs[0]
    assert monument.category == "Monument"
    assert monument.prefab_id == 0xDEADBEEF
    assert monument.position.x == pytest.approx(10.5)
    assert monument.position.z == pytest.approx(-40.75)
    assert monument.rotation.y == pytest.approx(90.0)
    assert monument.scale.y == pytest.approx(2.0)

    assert [path.name for path in restored.paths] == ["Road 0", "River 0"]
    road = restored.paths[0]
    assert road.width == pytest.approx(9.5)
    assert road.splat == 4
    assert road.topology == 16
    assert len(road.nodes) == 3
    assert road.nodes[2].point.y == pytest.approx(8.0)


def test_map_file_helpers_and_validation(tmp_path) -> None:
    document = make_document()
    target = tmp_path / "world.map"
    write_document(target, document)
    restored = read_document(target)
    assert restored.size == 64

    issues = validate_layout(restored)
    assert [issue for issue in issues if issue["severity"] == "error"] == []
    expected = expected_layer_sizes(64)
    assert expected["terrain"] == (2, 65 * 65)
    assert expected["splat"] == (8, 32 * 32)

    small = WorldDocument(size=64, layers={"terrain": b"\x00\x00" * 4})
    issues = validate_layout(small)
    assert any(issue["layer"] == "splat" and issue["severity"] == "error" for issue in issues)
    assert any(issue["layer"] == "terrain" and issue["severity"] == "warning" for issue in issues)


def test_prefab_only_document_roundtrip() -> None:
    document = WorldDocument(size=4500, prefabs=[PrefabInstance(category="Monument", prefab_id=99)])
    restored = parse_document(build_document(document))
    assert restored.is_prefab
    assert restored.prefabs[0].prefab_id == 99


def test_rejects_bad_header_and_version() -> None:
    with pytest.raises(MapFormatError):
        parse_document(b"\x01\x02")
    raw = struct.pack("<Iq", 11, 0) + b"junk"
    with pytest.raises(MapFormatError):
        parse_document(raw)
