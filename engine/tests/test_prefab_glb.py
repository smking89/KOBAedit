import json
import struct

from PIL import Image

from rust_studio_engine.indexer import prefab_glb


class FakeMesh:
    def export(self) -> str:
        return "\n".join(
            [
                "v 0 0 0",
                "v 1 0 0",
                "v 0 1 0",
                "vt 0 0",
                "vt 1 0",
                "vt 0 1",
                "f 1/1 2/2 3/3",
            ]
        )


class FakeInstance:
    mesh = FakeMesh()
    matrix = (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
    materials = ()


def read_glb(path):
    raw = path.read_bytes()
    magic, version, _length = struct.unpack_from("<III", raw, 0)
    assert magic == 0x46546C67 and version == 2
    json_length, json_type = struct.unpack_from("<II", raw, 12)
    assert json_type == 0x4E4F534A
    document = json.loads(raw[20 : 20 + json_length].decode("utf-8"))
    binary_start = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<II", raw, binary_start)
    assert binary_type == 0x004E4942
    return document, raw[binary_start + 8 : binary_start + 8 + binary_length]


def test_glb_accessors_and_texture_links_stay_inside_the_binary_chunk(tmp_path, monkeypatch):
    monkeypatch.setattr(prefab_glb, "collect_mesh_instances", lambda _root: [FakeInstance()])
    target = tmp_path / "mesh.glb"
    vertices, triangles, meshes = prefab_glb._write_glb(target, object())
    assert (vertices, triangles, meshes) == (3, 1, 1)

    document, binary = read_glb(target)
    assert document["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] == 2
    assert document["meshes"][0]["primitives"][0]["indices"] == 3
    for view in document["bufferViews"]:
        assert view["buffer"] == 0
        assert view["byteOffset"] + view["byteLength"] <= len(binary)
    for accessor in document["accessors"]:
        assert accessor["bufferView"] < len(document["bufferViews"])
    assert document["buffers"][0]["byteLength"] == len(binary)


def test_glb_embeds_first_readable_albedo_texture(tmp_path, monkeypatch):
    class Pointer:
        def __init__(self, value):
            self.value = value

        def read(self):
            return self.value

    class SavedProperties:
        m_TexEnvs = [
            (
                "_MainTex",
                type(
                    "TexEnv",
                    (),
                    {
                        "m_Texture": Pointer(
                            type("Texture", (), {"image": Image.new("RGB", (4, 4), (180, 20, 10))})()
                        )
                    },
                )(),
            )
        ]

    material = type("Material", (), {"m_SavedProperties": SavedProperties()})()
    instance = FakeInstance()
    instance.materials = (Pointer(material),)
    monkeypatch.setattr(prefab_glb, "collect_mesh_instances", lambda _root: [instance])
    target = tmp_path / "textured.glb"
    prefab_glb._write_glb(target, object())
    document, _binary = read_glb(target)
    assert document["images"][0]["mimeType"] == "image/png"
    assert document["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 0


def test_albedo_filter_rejects_silhouette_icons():
    icon = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for x in range(16, 48):
        for y in range(8, 56):
            icon.putpixel((x, y), (255, 255, 255, 255))
    assert not prefab_glb._looks_like_albedo(icon)

    surface = Image.new("RGB", (64, 64))
    for y in range(64):
        for x in range(64):
            surface.putpixel((x, y), ((x * 3) % 256, (y * 5) % 256, ((x + y) * 2) % 256))
    assert prefab_glb._looks_like_albedo(surface)


def test_fallback_texture_matches_prefab_tokens_and_skips_non_albedo(monkeypatch):
    class TextureObject:
        type = type("Type", (), {"name": "Texture2D"})()

        def __init__(self, name, image):
            self.name = name
            self.image = image

        def peek_name(self):
            return self.name

        def read(self):
            return type("Texture", (), {"image": self.image})()

    surface = Image.new("RGB", (32, 32))
    for y in range(32):
        for x in range(32):
            surface.putpixel((x, y), ((x * 7) % 256, (y * 11) % 256, ((x + y) * 3) % 256))
    env = type(
        "Env",
        (),
        {
            "objects": [
                TextureObject("wall.doorway.door", Image.new("RGB", (32, 32), (0, 0, 0))),
                TextureObject("door_toptier_bc", surface),
                TextureObject("door_toptier_normals", surface),
            ]
        },
    )()
    png = prefab_glb._fallback_texture_png(env, "assets/prefabs/building/door/door.toptier.item.prefab")
    assert png is not None and png.startswith(b"\x89PNG")


def test_export_obj_glb_uses_the_asset_path_cache_key(tmp_path):
    source = tmp_path / "weapon.obj"
    source.write_text("\n".join(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]), encoding="utf-8")
    result = prefab_glb.export_obj_glb(source, "content/meshes/weapon.obj", tmp_path / "cache")
    assert result["prefabHash"] == prefab_glb.prefab_hash("content/meshes/weapon.obj")
    document, _binary = read_glb(tmp_path / "cache" / f"{result['prefabHash']}.glb")
    assert document["meshes"][0]["primitives"][0]["mode"] == 4
