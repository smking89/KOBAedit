from __future__ import annotations

from types import SimpleNamespace

from rust_studio_engine.indexer.prefab_bounds import extract_prefab_bounds
from rust_studio_engine.indexer.unity_bundle import ContainerEntry


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


def test_ignores_prefabs_without_renderers() -> None:
    root = GameObject([Transform()])
    environment = Environment([ObjectReader(root)])
    container = [ContainerEntry("assets/prefabs/empty.prefab", 1)]

    assert extract_prefab_bounds(environment, container=container) == {}
