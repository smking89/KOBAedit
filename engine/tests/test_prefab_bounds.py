from __future__ import annotations

from types import SimpleNamespace

from koba_engine.indexer.prefab_bounds import (
    PrefabBounds,
    extract_item_prefab_bounds_from_links,
    extract_prefab_bounds,
    item_prefab_candidates,
)
from koba_engine.indexer.unity_bundle import ContainerEntry


class Vec:
    def __init__(self, x: float, y: float, z: float) -> None:
        self.x, self.y, self.z = x, y, z


class Quat:
    def __init__(self) -> None:
        self.x = self.y = self.z = 0.0
        self.w = 1.0


class Pointer:
    def __init__(self, value: object) -> None:
        self.value = value

    def read(self) -> object:
        return self.value


class ComponentPair:
    def __init__(self, component: object) -> None:
        self.component = Pointer(component)


class Transform:
    def __init__(self, position=(0.0, 0.0, 0.0), children=(), game_object=None) -> None:
        self.m_LocalPosition = Vec(*position)
        self.m_LocalRotation = Quat()
        self.m_LocalScale = Vec(1.0, 1.0, 1.0)
        self.m_Children = [Pointer(child) for child in children]
        self.m_GameObject = Pointer(game_object) if game_object is not None else None


class Mesh:
    def __init__(self) -> None:
        self.m_LocalAABB = SimpleNamespace(
            m_Center=Vec(0.0, 0.0, 0.0),
            m_Extent=Vec(1.0, 1.0, 1.0),
        )


class MeshFilter:
    def __init__(self) -> None:
        self.m_Mesh = Pointer(Mesh())


class BoxCollider:
    def __init__(self) -> None:
        self.m_Center = Vec(0.0, 0.0, 0.0)
        self.m_Size = Vec(2.0, 4.0, 6.0)


class MeshCollider:
    def __init__(self) -> None:
        self.m_Mesh = Pointer(Mesh())


class GameObject:
    def __init__(self, components) -> None:
        self.m_Component = [ComponentPair(component) for component in components]

    def read(self) -> "GameObject":
        return self


class ObjectReader:
    def __init__(self, value: object) -> None:
        self.path_id = 1
        self.value = value

    def read(self) -> object:
        return self.value


class Environment:
    def __init__(self, objects) -> None:
        self.objects = objects


def test_extracts_transformed_renderer_bounds() -> None:
    child_transform = Transform(position=(10.0, 2.0, 0.0))
    child = GameObject([child_transform, MeshFilter()])
    child_transform.m_GameObject = Pointer(child)
    root = GameObject([Transform(position=(1.0, 0.0, 0.0), children=[child_transform])])
    environment = Environment([ObjectReader(root)])
    container = [ContainerEntry("assets/prefabs/test.prefab", 1)]

    bounds = extract_prefab_bounds(environment, container=container)["assets/prefabs/test.prefab"]

    assert bounds.renderers == 1
    assert bounds.bounds_min == (10.0, 1.0, -1.0)
    assert bounds.bounds_max == (12.0, 3.0, 1.0)


def test_ignores_prefabs_without_geometry() -> None:
    root = GameObject([Transform()])
    environment = Environment([ObjectReader(root)])
    container = [ContainerEntry("assets/prefabs/empty.prefab", 1)]

    assert extract_prefab_bounds(environment, container=container) == {}


def test_falls_back_to_collider_bounds() -> None:
    root = GameObject([Transform(), BoxCollider()])
    environment = Environment([ObjectReader(root)])
    container = [ContainerEntry("assets/prefabs/collider-only.prefab", 1)]

    bounds = extract_prefab_bounds(environment, container=container)[
        "assets/prefabs/collider-only.prefab"
    ]

    assert bounds.renderers == 0
    assert bounds.colliders == 1
    assert bounds.source == "colliders:1"
    assert bounds.bounds_min == (-1.0, -2.0, -3.0)
    assert bounds.bounds_max == (1.0, 2.0, 3.0)


def test_falls_back_to_mesh_collider_bounds() -> None:
    root = GameObject([Transform(), MeshCollider()])
    environment = Environment([ObjectReader(root)])
    container = [ContainerEntry("assets/prefabs/mesh-collider.prefab", 1)]

    bounds = extract_prefab_bounds(environment, container=container)[
        "assets/prefabs/mesh-collider.prefab"
    ]

    assert bounds.colliders == 1
    assert bounds.bounds_min == (-1.0, -1.0, -1.0)
    assert bounds.bounds_max == (1.0, 1.0, 1.0)


def test_maps_item_definition_to_real_prefab_bounds() -> None:
    item_path = "assets/prefabs/building/door/door.metal.item.prefab"
    real = PrefabBounds(
        asset_path="assets/prefabs/building/door/door.metal.prefab",
        bounds_min=(-0.5, 0.0, -1.5),
        bounds_max=(0.5, 2.0, 1.5),
        renderers=4,
    )

    assert item_prefab_candidates(item_path)[0] == real.asset_path
    linked = extract_item_prefab_bounds_from_links(
        [item_path], {real.asset_path: real}
    )[item_path]
    assert linked.asset_path == item_path
    assert linked.bounds_min == real.bounds_min
    assert linked.bounds_max == real.bounds_max
    assert linked.renderers == 4
