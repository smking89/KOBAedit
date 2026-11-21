"""Unity AssetBundle ingestion for the local asset index.

The Rust client does not ship loose meshes or prefabs; it ships UnityFS
bundles. This module inventories those bundles (header, container table, object
types) and imports the real prefab asset paths they expose. Meshes and textures
can be exported on demand into ``data/extracted`` and recorded in
``bundle_assets``; exported meshes are also added to ``base_meshes`` when an
extraction pack is needed.

UnityPy is optional (``pip install -e 'engine[bundles]'``) and is imported only
when object-level access or extraction is requested.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Sequence

from .db import default_db_path, project_root
from .indexer import AssetIndexer, _load_manifest, infer_mesh_kind
from .prefab_bounds import (
    PrefabBounds,
    build_mesh_index,
    extract_game_manifest_bounds,
    extract_item_prefab_bounds_from_links,
    extract_prefab_bounds,
    read_game_manifest_paths,
)
from .unity_bundle import (
    BundleDependencyError,
    BundleExtractionError,
    BundleFormatError,
    export_mesh_object,
    export_texture_object,
    is_unity_bundle,
    load_bundle,
    peek_object_name,
    read_bundle_info,
    read_container,
)

# Standalone asset objects worth recording even when no container path points
# at them. Everything else (GameObject, MonoBehaviour, Material, ...) is kept
# only for container assets, which keeps scene bundles with millions of
# transform/behaviour nodes out of the database.
INTRINSIC_OBJECT_TYPES = {
    "Mesh",
    "Texture2D",
    "Cubemap",
    "Sprite",
    "TextAsset",
    "Shader",
}

OBJECT_KINDS = {
    "Mesh": "mesh",
    "Texture2D": "texture",
    "Cubemap": "texture",
    "Sprite": "sprite",
    "Material": "material",
    "TextAsset": "data",
    "MonoBehaviour": "data",
    "AnimationClip": "animation",
    "Shader": "shader",
    "GameObject": "prefab",
}

CONTAINER_SUFFIX_KINDS = {
    ".prefab": "prefab",
    ".fbx": "mesh",
    ".obj": "mesh",
    ".png": "texture",
    ".tga": "texture",
    ".jpg": "texture",
    ".exr": "texture",
    ".mat": "material",
    ".asset": "data",
    ".unity": "scene",
    ".json": "data",
}


@dataclass
class BundleResult:
    name: str
    unity_revision: str = ""
    compression: str = ""
    objects: int = 0
    container: int = 0
    prefabs: int = 0
    assets: int = 0
    meshes: int = 0
    textures: int = 0
    extracted_meshes: int = 0
    extracted_textures: int = 0
    skipped: bool = False
    error: str | None = None
    duration_ms: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "unityRevision": self.unity_revision,
            "compression": self.compression,
            "objects": self.objects,
            "container": self.container,
            "prefabs": self.prefabs,
            "assets": self.assets,
            "meshes": self.meshes,
            "textures": self.textures,
            "extractedMeshes": self.extracted_meshes,
            "extractedTextures": self.extracted_textures,
            "skipped": self.skipped,
            "error": self.error,
            "durationMs": self.duration_ms,
        }


@dataclass
class BundleIngestReport:
    pack: str
    root: str
    bundles: int = 0
    prefabs: int = 0
    assets: int = 0
    extracted_meshes: int = 0
    extracted_textures: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    per_bundle: list[BundleResult] = field(default_factory=list)
    duration_ms: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "pack": self.pack,
            "root": self.root,
            "bundles": self.bundles,
            "prefabs": self.prefabs,
            "assets": self.assets,
            "extractedMeshes": self.extracted_meshes,
            "extractedTextures": self.extracted_textures,
            "skipped": self.skipped,
            "errors": self.errors,
            "perBundle": [item.to_dict() for item in self.per_bundle],
            "durationMs": self.duration_ms,
        }


def classify_asset_path(path: str | None) -> str:
    """Kind for a container path (prefab, mesh, texture, scene, ...)."""
    if not path:
        return "other"
    lowered = path.lower()
    for suffix, kind in CONTAINER_SUFFIX_KINDS.items():
        if lowered.endswith(suffix):
            return kind
    return "other"


def classify_object(object_type: str, container_path: str | None) -> str:
    if object_type == "GameObject" and container_path:
        return classify_asset_path(container_path)
    return OBJECT_KINDS.get(object_type, "other")


class BundleIngestor:
    """Index UnityFS bundles and optionally export meshes/textures."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        thumbnail_dir: str | Path | None = None,
        *,
        extract_dir: str | Path | None = None,
        glb_cache_dir: str | Path | None = None,
        make_thumbnails: bool = True,
        connection: sqlite3.Connection | None = None,
        progress: Callable[..., None] | None = None,
    ) -> None:
        self.indexer = AssetIndexer(
            db_path or default_db_path(), thumbnail_dir, connection=connection
        )
        self.connection = self.indexer.connection
        self.extract_root = (
            Path(extract_dir) if extract_dir else project_root() / "data" / "extracted"
        )
        self.glb_cache_dir = (
            Path(glb_cache_dir).expanduser() if glb_cache_dir else None
        )
        self.make_thumbnails = make_thumbnails
        self.progress = progress
        self._extracted_pack_id: int | None = None
        self._linked_bounds: dict[str, PrefabBounds] = {}

    # ------------------------------------------------------------------ public
    def ingest(
        self,
        paths: Sequence[str | Path],
        *,
        pack_name: str = "rust-client",
        game_version: str = "",
        extract: str = "none",
        match: str | None = None,
        limit: int = 25,
        force: bool = False,
        manifest_path: str | Path | None = None,
        extract_bounds: bool = True,
        skin_only: bool = False,
    ) -> BundleIngestReport:
        if extract not in ("none", "meshes", "textures", "all"):
            raise ValueError("extract must be one of: none, meshes, textures, all")
        if limit < 0:
            raise ValueError("limit must be >= 0")
        try:
            import UnityPy  # noqa: F401
        except ImportError as exc:  # pragma: no cover - depends on install extras
            raise BundleDependencyError(
                "UnityPy is required to read bundle contents. Install it with:\n"
                "  pip install -e 'engine[bundles]'"
            ) from exc

        started = time.perf_counter()
        files = _expand_paths(paths)
        if not files:
            raise FileNotFoundError("no UnityFS bundles found in the given paths")
        self._linked_bounds = {}
        root = _common_root(files)
        report = BundleIngestReport(pack=pack_name, root=str(root))
        pack_id = self.indexer.register_pack(
            pack_name, root, game_version=game_version, source="local"
        )
        manifest = _load_manifest(manifest_path)

        total = len(files)
        if self.progress:
            self.progress("scanning", 0, total, f"Found {total} bundle(s)")
        for index, path in enumerate(files):
            result = BundleResult(name=path.name)
            bundle_started = time.perf_counter()
            if self.progress:
                self.progress("bundle", index, total, path.name)
            try:
                self._ingest_one(
                    path,
                    root,
                    pack_id,
                    pack_name,
                    result,
                    extract=extract,
                    match=match,
                    limit=limit,
                    force=force,
                    manifest=manifest,
                    extract_bounds=extract_bounds,
                    skin_only=skin_only,
                )
            except BundleDependencyError:
                raise
            except Exception as exc:
                result.error = f"{type(exc).__name__}: {exc}"
                report.errors.append(f"{path}: {result.error}")
            result.duration_ms = int((time.perf_counter() - bundle_started) * 1000)
            report.per_bundle.append(result)
            report.bundles += 0 if result.skipped else 1
            report.prefabs += result.prefabs
            report.assets += result.assets
            report.extracted_meshes += result.extracted_meshes
            report.extracted_textures += result.extracted_textures
            if result.skipped:
                report.skipped += 1
            if self.progress:
                self.progress("bundle", index + 1, total, f"Indexed {path.name}")

        if extract_bounds and self._linked_bounds:
            self._backfill_linked_bounds(pack_id)

        self.connection.execute(
            "UPDATE asset_packs SET last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            (pack_id,),
        )
        report.duration_ms = int((time.perf_counter() - started) * 1000)
        return report

    # ------------------------------------------------------------------ bundle
    def _ingest_one(
        self,
        path: Path,
        root: Path,
        pack_id: int,
        pack_name: str,
        result: BundleResult,
        *,
        extract: str,
        match: str | None,
        limit: int,
        force: bool,
        manifest: dict[str, dict] | None,
        extract_bounds: bool,
        skin_only: bool = False,
    ) -> None:
        stat = path.stat()
        existing = self.connection.execute(
            "SELECT * FROM bundles WHERE pack_id = ? AND path = ?",
            (pack_id, _relative(path, root)),
        ).fetchone()
        if (
            existing
            and not force
            and extract == "none"
            and int(existing["file_bytes"]) == stat.st_size
            and abs(float(existing["file_mtime"]) - stat.st_mtime) < 1.0
            and int(existing["manifest_prefab_count"]) >= 0
        ):
            result.skipped = True
            result.unity_revision = str(existing["unity_revision"])
            result.compression = str(existing["compression"])
            result.objects = int(sum(json.loads(existing["object_counts_json"]).values()))
            result.container = int(existing["container_count"])
            return

        if self.progress:
            self.progress("reading", 0, 1, path.name)
        info = read_bundle_info(path)
        env = load_bundle(path)
        if self.progress:
            self.progress("bounds", 0, 1, f"Reading {path.name}")
        container = read_container(env)
        container_by_id: dict[int, str] = {}
        for entry in container:
            if entry.path_id:
                container_by_id.setdefault(entry.path_id, entry.path)

        # Monument scenes never expose prefab containers. The GameManifest does
        # list every real prefab path, including monuments, so index those too.
        manifest_paths: dict[str, str] = {}
        try:
            manifest_paths = {
                prefab: guid
                for prefab, guid in read_game_manifest_paths(env).items()
                if prefab.lower().endswith(".prefab")
            }
        except Exception:
            manifest_paths = {}

        counts = Counter(obj.type.name for obj in env.objects)
        result.unity_revision = info.unity_revision
        result.compression = info.compression
        result.objects = sum(counts.values())
        result.container = len(container)
        result.meshes = counts.get("Mesh", 0)
        result.textures = counts.get("Texture2D", 0)

        # AABB extraction reads meshes from this bundle and can be slow for
        # large scene bundles. Do it before opening the write transaction so a
        # best-effort bounds pass never holds the database lock.
        if self.progress and extract_bounds:
            self.progress("bounds", 1, 2, f"Extracting prefab bounds from {path.name}")
        mesh_index = None
        bounds_by_path = {}
        manifest_bounds: dict[str, PrefabBounds] = {}
        if extract_bounds:
            try:
                mesh_index = build_mesh_index(env)
            except Exception:
                mesh_index = None
        if extract_bounds and any(
            entry.path.lower().endswith(".prefab") for entry in container
        ):
            try:
                bounds_by_path = extract_prefab_bounds(
                    env, container=container, mesh_index=mesh_index
                )
            except Exception as exc:  # bounds must never block indexing
                result.error = f"bounds: {type(exc).__name__}: {exc}"
        if extract_bounds and len(env.objects) <= 500_000:
            # Content carries the GameManifest and the real prefab roots. Item
            # bundles are linked to these bounds after their own rows exist.
            try:
                manifest_bounds = extract_game_manifest_bounds(
                    env, mesh_index=mesh_index
                )
                for prefab_path, bounds in manifest_bounds.items():
                    self._linked_bounds[prefab_path.casefold()] = bounds
            except Exception as exc:  # bounds must never block indexing
                result.error = f"linked bounds: {type(exc).__name__}: {exc}"

        if self.progress:
            self.progress("indexing", 0, 1, f"Writing catalogue for {path.name}")
        # Inventory and prefab import are one transaction so a failed bundle
        # never leaves a half-written catalogue behind.
        self.connection.execute("BEGIN")
        try:
            self.connection.execute(
                """
                INSERT INTO bundles (
                    pack_id, path, name, file_bytes, file_mtime,
                    unity_version, unity_revision, compression, flags,
                    block_count, node_count, container_count, object_counts_json,
                    manifest_prefab_count
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT (pack_id, path) DO UPDATE SET
                    name = excluded.name, file_bytes = excluded.file_bytes,
                    file_mtime = excluded.file_mtime,
                    unity_version = excluded.unity_version,
                    unity_revision = excluded.unity_revision,
                    compression = excluded.compression, flags = excluded.flags,
                    block_count = excluded.block_count, node_count = excluded.node_count,
                    container_count = excluded.container_count,
                    object_counts_json = excluded.object_counts_json,
                    manifest_prefab_count = excluded.manifest_prefab_count,
                    indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                """,
                (
                    pack_id,
                    _relative(path, root),
                    path.name,
                    stat.st_size,
                    stat.st_mtime,
                    info.unity_version,
                    info.unity_revision,
                    info.compression,
                    info.flags,
                    len(info.blocks),
                    len(info.nodes),
                    len(container),
                    json.dumps(dict(counts.most_common(40))),
                    len(manifest_paths),
                ),
            )
            row = self.connection.execute(
                "SELECT id FROM bundles WHERE pack_id = ? AND path = ?",
                (pack_id, _relative(path, root)),
            ).fetchone()
            bundle_id = int(row["id"])
            # A reindex must not forget the OBJ/PNG files a previous run
            # exported. Capture object identity before replacing the rows.
            preserved = {
                (str(row["source_file"]), str(row["object_type"]), int(row["path_id"])): (
                    row["extracted_path"], row["metadata_json"]
                )
                for row in self.connection.execute(
                    """
                    SELECT source_file, object_type, path_id, extracted_path, metadata_json
                      FROM bundle_assets
                     WHERE bundle_id = ? AND extracted_path IS NOT NULL
                    """,
                    (bundle_id,),
                )
            }
            self.connection.execute(
                "DELETE FROM bundle_assets WHERE bundle_id = ?", (bundle_id,)
            )

            rows: list[tuple[object, ...]] = []
            for obj in env.objects:
                object_type = obj.type.name
                if object_type == "AssetBundle":
                    continue
                path_id = int(obj.path_id)
                container_path = container_by_id.get(path_id)
                if not container_path and object_type not in INTRINSIC_OBJECT_TYPES:
                    continue
                if path_id == 0 and not container_path:
                    continue
                name = peek_object_name(obj)
                if not name and container_path:
                    name = Path(container_path).stem
                if not name:
                    name = f"{object_type}_{path_id & 0xFFFFFFFF:08x}"
                kind = classify_object(object_type, container_path)
                source_file = _object_source(obj)
                rows.append(
                    (
                        bundle_id,
                        source_file,
                        object_type,
                        path_id,
                        name,
                        kind,
                        container_path,
                        json.dumps({}),
                    )
                )
            if rows:
                self.connection.executemany(
                    """
                    INSERT OR REPLACE INTO bundle_assets (
                        bundle_id, source_file, object_type, path_id, name,
                        asset_kind, container_path, metadata_json
                    ) VALUES (?,?,?,?,?,?,?,?)
                    """,
                    rows,
                )
            for key, (extracted_path, metadata_json) in preserved.items():
                self.connection.execute(
                    """
                    UPDATE bundle_assets
                       SET extracted_path = ?, metadata_json = ?
                     WHERE bundle_id = ? AND source_file = ?
                       AND object_type = ? AND path_id = ?
                    """,
                    (extracted_path, metadata_json, bundle_id, *key),
                )
            result.assets = len(rows)

            prefab_paths = sorted(
                {entry.path for entry in container if entry.path.lower().endswith(".prefab")}
            )
            for prefab_path in prefab_paths:
                self.indexer.index_bundle_prefab(
                    pack_id, prefab_path, bundle_name=path.name
                )
                entry = (manifest or {}).get(prefab_path)
                if entry and entry.get("boundsMin") and entry.get("boundsMax"):
                    self.indexer.update_prefab_bounds(
                        pack_id,
                        prefab_path,
                        tuple(float(value) for value in entry["boundsMin"]),
                        tuple(float(value) for value in entry["boundsMax"]),
                        source="manifest",
                    )
            manifest_indexed = 0
            container_paths = set(prefab_paths)
            for prefab_path in sorted(manifest_paths):
                if prefab_path in container_paths:
                    continue
                self.indexer.index_bundle_prefab(
                    pack_id, prefab_path, bundle_name=path.name, source="game-manifest"
                )
                manifest_indexed += 1
            if bounds_by_path:
                for prefab_path, bounds in bounds_by_path.items():
                    self.indexer.update_prefab_bounds(
                        pack_id,
                        prefab_path,
                        bounds.bounds_min,
                        bounds.bounds_max,
                        source=bounds.source,
                    )
            for prefab_path in manifest_paths:
                bounds = manifest_bounds.get(prefab_path)
                if bounds is None:
                    continue
                self.indexer.update_prefab_bounds(
                    pack_id,
                    prefab_path,
                    bounds.bounds_min,
                    bounds.bounds_max,
                    source=bounds.source,
                )
            self._apply_linked_bounds(pack_id, prefab_paths)
            result.prefabs = len(prefab_paths) + manifest_indexed
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise

        if extract in ("meshes", "all"):
            if self.progress:
                self.progress("meshes", 0, max(1, limit), f"Extracting meshes from {path.name}")
            result.extracted_meshes, mesh_errors = self._extract_meshes(
                env,
                bundle_id,
                path,
                pack_name,
                container_by_id,
                match=match,
                limit=limit,
                skin_only=skin_only,
            )
            for error in mesh_errors:
                result.error = error if not result.error else f"{result.error}; {error}"
        if extract in ("textures", "all"):
            result.extracted_textures, texture_errors = self._extract_textures(
                env,
                bundle_id,
                path,
                container_by_id,
                match=match,
                limit=limit,
            )
            for error in texture_errors:
                result.error = error if not result.error else f"{result.error}; {error}"

    # ------------------------------------------------------------------- bounds
    def _apply_linked_bounds(self, pack_id: int, prefab_paths: Sequence[str]) -> int:
        """Fill item-definition rows from their real sibling/world prefab."""
        if not self._linked_bounds:
            return 0
        mapped = extract_item_prefab_bounds_from_links(
            prefab_paths, self._linked_bounds
        )
        updated = 0
        for prefab_path, bounds in mapped.items():
            if self.indexer.update_prefab_bounds(
                pack_id,
                prefab_path,
                bounds.bounds_min,
                bounds.bounds_max,
                source=f"prefab:{bounds.source}",
            ):
                updated += 1
        return updated

    def _backfill_linked_bounds(self, pack_id: int) -> int:
        """Resolve links after all bundles are indexed, regardless of file order."""
        rows = self.connection.execute(
            """
            SELECT asset_path FROM prefabs
             WHERE pack_id = ? AND lower(asset_path) LIKE '%.item.prefab'
               AND bounds_max_x <= bounds_min_x
               AND bounds_max_y <= bounds_min_y
               AND bounds_max_z <= bounds_min_z
            """,
            (pack_id,),
        ).fetchall()
        if not rows:
            return 0
        return self._apply_linked_bounds(
            pack_id, [str(row["asset_path"]) for row in rows]
        )

    # --------------------------------------------------------------- extraction
    def _extract_meshes(
        self,
        env: Any,
        bundle_id: int,
        bundle_path: Path,
        pack_name: str,
        container_by_id: dict[int, str],
        *,
        match: str | None,
        limit: int,
        skin_only: bool = False,
    ) -> tuple[int, list[str]]:
        if limit == 0:
            return 0, []
        extracted = 0
        errors: list[str] = []
        for obj, name, container in _iter_targets(env, "Mesh", container_by_id, match):
            if extracted >= limit:
                break
            if skin_only and not _is_skin_mesh(name, container):
                continue
            display = name or Path(container or "mesh").stem
            path_id = int(obj.path_id)
            destination = (
                self.extract_root
                / _slug(bundle_path.stem)
                / "meshes"
                / f"{_slug(display) or 'mesh'}-{abs(path_id) & 0xFFFFFFFF:08x}.obj"
            )
            try:
                export_mesh_object(obj, destination)
                self.connection.execute(
                    """
                    UPDATE bundle_assets
                       SET extracted_path = ?, metadata_json = ?
                     WHERE bundle_id = ? AND object_type = 'Mesh' AND path_id = ?
                    """,
                    (str(destination), json.dumps({"format": "obj"}), bundle_id, path_id),
                )
                pack_id = self._extracted_pack(pack_name)
                self.indexer.index_mesh(
                    pack_id,
                    self.extract_root,
                    destination,
                    self.make_thumbnails,
                    True,
                    display_name=display,
                    item_kind=infer_mesh_kind(container or display),
                )
                if self.glb_cache_dir is not None:
                    try:
                        from .prefab_glb import export_obj_glb

                        asset_path = _relative(destination, self.extract_root)
                        export_obj_glb(destination, asset_path, self.glb_cache_dir)
                    except (OSError, ValueError):
                                                # A missing turntable cache must not fail the mesh index.
                        pass
                extracted += 1
                if self.progress and (extracted <= 3 or extracted % 5 == 0):
                    self.progress(
                        "meshes",
                        extracted,
                        max(1, limit),
                        f"{display} ({bundle_path.name})",
                    )
            except (BundleExtractionError, OSError, ValueError) as exc:
                errors.append(f"{display}: {exc}")
        if self.progress:
            self.progress(
                "meshes", extracted, max(1, limit), f"Finished {bundle_path.name}"
            )
        return extracted, errors




    def _extract_textures(
        self,
        env: Any,
        bundle_id: int,
        bundle_path: Path,
        container_by_id: dict[int, str],
        *,
        match: str | None,
        limit: int,
    ) -> tuple[int, list[str]]:
        if limit == 0:
            return 0, []
        extracted = 0
        errors: list[str] = []
        for obj, name, container in _iter_targets(
            env, "Texture2D", container_by_id, match
        ):
            if extracted >= limit:
                break
            display = name or Path(container or "texture").stem
            path_id = int(obj.path_id)
            destination = (
                self.extract_root
                / _slug(bundle_path.stem)
                / "textures"
                / f"{_slug(Path(container).stem if container else display) or 'texture'}"
                f"-{abs(path_id) & 0xFFFFFFFF:08x}.png"
            )
            try:
                width, height = export_texture_object(obj, destination)
                self.connection.execute(
                    """
                    UPDATE bundle_assets
                       SET extracted_path = ?, metadata_json = ?
                     WHERE bundle_id = ? AND object_type = 'Texture2D' AND path_id = ?
                    """,
                    (
                        str(destination),
                        json.dumps({"width": width, "height": height}),
                        bundle_id,
                        path_id,
                    ),
                )
                extracted += 1
            except (BundleExtractionError, OSError, ValueError) as exc:
                errors.append(f"{display}: {exc}")
        return extracted, errors

    def _extracted_pack(self, pack_name: str) -> int:
        if self._extracted_pack_id is None:
            self.extract_root.mkdir(parents=True, exist_ok=True)
            self._extracted_pack_id = self.indexer.register_pack(
                f"{pack_name} extracted", self.extract_root
            )
        return self._extracted_pack_id

    # --------------------------------------------------------------- lifecycle
    def close(self) -> None:
        self.indexer.close()

    def __enter__(self) -> "BundleIngestor":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()


def _iter_targets(
    env: Any,
    object_type: str,
    container_by_id: dict[int, str],
    match: str | None,
) -> Iterator[tuple[Any, str, str | None]]:
    needle = match.lower() if match else None
    for obj in env.objects:
        if obj.type.name != object_type:
            continue
        container = container_by_id.get(int(obj.path_id))
        name = peek_object_name(obj)
        if needle:
            haystack = f"{name} {container or ''}".lower()
            if needle not in haystack:
                continue
        yield obj, name, container


SKIN_MESH_HINTS = (
    "/weapons/",
    "/attire/",
    "/clothing/",
    "/wearable/",
    "/skinviewer/models/",
)


def _is_skin_mesh(name: str, container: str | None) -> bool:
    haystack = f"{container or ''}/{name}".replace("\\", "/").lower()
    return any(hint in haystack for hint in SKIN_MESH_HINTS)


def _expand_paths(paths: Sequence[str | Path]) -> list[Path]:
    found: dict[str, Path] = {}
    for raw in paths:
        path = Path(raw).expanduser()
        if path.is_dir():
            for candidate in sorted(path.rglob("*")):
                if candidate.is_file() and is_unity_bundle(candidate):
                    found[str(candidate.resolve())] = candidate.resolve()
        elif path.is_file():
            found[str(path.resolve())] = path.resolve()
        else:
            raise FileNotFoundError(f"{path} does not exist")
    return [found[key] for key in sorted(found)]


def _common_root(files: Sequence[Path]) -> Path:
    parents = [str(path.parent) for path in files]
    try:
        return Path(os.path.commonpath(parents)).resolve()
    except ValueError:
        return files[0].parent.resolve()


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return path.name


def _object_source(obj: Any) -> str:
    assets_file = getattr(obj, "assets_file", None)
    return str(getattr(assets_file, "name", "") or "")


def _slug(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in value.lower())
    return "-".join(filter(None, cleaned.split("-")))[:80]


__all__ = [
    "BundleIngestReport",
    "BundleIngestor",
    "BundleResult",
    "classify_asset_path",
    "classify_object",
]
