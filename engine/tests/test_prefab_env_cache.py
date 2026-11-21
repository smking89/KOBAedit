from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from koba_engine.indexer import prefab_glb as pg


def test_env_cache_evicts_oldest_entry_when_budget_is_exceeded(
    tmp_path: Path, monkeypatch
) -> None:
    first = tmp_path / "first.bundle"
    second = tmp_path / "second.bundle"
    first.write_bytes(b"a")
    second.write_bytes(b"b")

    loads: list[str] = []

    def fake_load(path: Path) -> SimpleNamespace:
        loads.append(Path(path).name)
        return SimpleNamespace(objects=[])

    monkeypatch.setattr(pg, "load_bundle", fake_load)
    # RSS is sampled after each insert: the first load fits, the second pushes
    # the process past the budget and evicts the bundle loaded before it.
    readings = iter([200, 200])
    monkeypatch.setattr(pg, "_process_rss_bytes", lambda: next(readings, 200))

    pg.configure_env_cache(100)
    try:
        pg._load_env(first)
        loaded = pg._load_env(second)

        assert len(pg._ENV_CACHE) == 1, "over-budget entry should evict the oldest"
        assert next(iter(pg._ENV_CACHE.values())) is loaded
    finally:
        pg.configure_env_cache(0)


def test_env_cache_returns_the_same_environment_without_reloading(
    tmp_path: Path, monkeypatch
) -> None:
    bundle = tmp_path / "bundle.bundle"
    bundle.write_bytes(b"x")
    loads: list[str] = []

    def fake_load(path: Path) -> SimpleNamespace:
        loads.append(Path(path).name)
        return SimpleNamespace(objects=[])

    monkeypatch.setattr(pg, "load_bundle", fake_load)
    monkeypatch.setattr(pg, "_process_rss_bytes", lambda: 0)

    pg.configure_env_cache(1024 * 1024)
    try:
        first = pg._load_env(bundle)
        second = pg._load_env(bundle)
        assert first is second
        assert loads == ["bundle.bundle"]
    finally:
        pg.configure_env_cache(0)


def test_disabled_cache_never_retains_environments(tmp_path: Path, monkeypatch) -> None:
    bundle = tmp_path / "bundle.bundle"
    bundle.write_bytes(b"x")
    monkeypatch.setattr(pg, "load_bundle", lambda path: SimpleNamespace(objects=[]))

    pg.configure_env_cache(0)
    pg._load_env(bundle)

    assert len(pg._ENV_CACHE) == 0
