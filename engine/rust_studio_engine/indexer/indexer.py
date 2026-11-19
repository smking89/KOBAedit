"""Batch asset ingestion into the SQLite index.

Scans a Rust install, a Workshop folder or a custom asset pack and records:

* base meshes (``.glb`` / ``.gltf`` / ``.obj``) with bounds and thumbnails,
* prefabs (``.prefab`` + optional JSON manifest) with category and bounds,
* maps (``.map``) for the project browser.

Prefab ids are computed the way Rust computes them:
``uint32_le(MD5(asset_path.lower())[0:4])``.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from ..world.map_file import parse_document
from ..world.models import PrefabInstance
from . import thumbnails
from .db import connect, default_db_path, project_root
from .mesh_probe import MeshInfo, MeshProbeError, probe

MESH_SUFFIXES = (".glb", ".gltf", ".obj")
PREFAB_SUFFIXES = (".prefab",)
MAP_SUFFIXES = (".map",)

CATEGORY_HINTS = (
    ("/monument/", "Monument"),
    ("/monuments/", "Monument"),
    ("/dungeon/", "Monument"),
    ("/decor/", "Decor"),
    ("/building/", "Building"),
    ("/structures/", "Building"),
    ("/vehicle/", "Vehicle"),
    ("/vehicles/", "Vehicle"),
    ("/entity/", "Entity"),
    ("/entities/", "Entity"),
    ("/terrain/", "Terrain"),
)

MESH_KIND_HINTS = (
    ("weapon", "weapon"),
    ("weapons", "weapon"),
    ("attire", "attire"),
    ("clothing", "attire"),
    ("deployable", "deployable"),
    ("deployables", "deployable"),
)


@dataclass
class IngestReport:
    pack: str
    root: str
    meshes: int = 0
    prefabs: int = 0
    maps: int = 0
    thumbnails: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    duration_ms: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "pack": self.pack,
            "root": self.root,
            "meshes": self.meshes,
            "prefabs": self.prefabs,
            "maps": self.maps,
            "thumbnails": self.thumbnails,
            "skipped": self.skipped,
            "errors": self.errors,
            "durationMs": self.duration_ms,
        }


def prefab_id_from_path(asset_path: str) -> int:
    """Rust prefab id: first 4 bytes of MD5(lowercased path), little-endian."""
    digest = hashlib.md5(asset_path.lower().encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "little")


def infer_prefab_category(asset_path: str) -> str:
    normalized = asset_path.replace("\\", "/").lower()
    for needle, category in CATEGORY_HINTS:
        if needle in normalized:
            return category
    return "Other"


def infer_mesh_kind(asset_path: str) -> str:
    normalized = asset_path.replace("\\", "/").lower()
    for needle, kind in MESH_KIND_HINTS:
        if needle in normalized:
            return kind
    return "deployable"


def prefab_name_from_path(asset_path: str) -> str:
    """Human name for a bundled prefab path (``hat.wolf.item.prefab``)."""
    name = Path(asset_path).name
    lower = name.lower()
    for suffix in (".item.prefab", ".prefab"):
        if lower.endswith(suffix):
            return name[: -len(suffix)]
    return name


class AssetIndexer:
    def __init__(
        self,
        db_path: str | Path | None = None,
        thumbnail_dir: str | Path | None = None,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        self.db_path = Path(db_path) if db_path else default_db_path()
        self.connection = connection or connect(self.db_path)
        self.thumbnail_dir = (
            Path(thumbnail_dir)
            if thumbnail_dir
            else project_root() / "data" / "thumbnails"
        )
        self.thumbnail_dir.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------------- packs
    def register_pack(
        self,
        name: str,
        root: str | Path,
        *,
        game_version: str = "",
        source: str = "local",
    ) -> int:
        self.connection.execute(
            """
            INSERT INTO asset_packs (name, root_path, game_version, source)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET
                root_path = excluded.root_path,
                game_version = excluded.game_version,
                source = excluded.source
            """,
            (name, str(Path(root).resolve()), game_version, source),
        )
        row = self.connection.execute(
            "SELECT id FROM asset_packs WHERE name = ?", (name,)
        ).fetchone()
        return int(row["id"])

    # -------------------------------------------------------------- scanning
    @staticmethod
    def discover(root: str | Path) -> dict[str, list[Path]]:
        base = Path(root)
        found: dict[str, list[Path]] = {"meshes": [], "prefabs": [], "maps": []}
        if not base.exists():
            return found
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix in MESH_SUFFIXES:
                found["meshes"].append(path)
            elif suffix in PREFAB_SUFFIXES:
                found["prefabs"].append(path)
            elif suffix in MAP_SUFFIXES:
                found["maps"].append(path)
        return found

    # ----------------------------------------------------------------- ingest
    def ingest(
        self,
        root: str | Path,
        *,
        pack_name: str | None = None,
        game_version: str = "",
        source: str = "local",
        make_thumbnails: bool = True,
        force: bool = False,
        manifest_path: str | Path | None = None,
    ) -> IngestReport:
        started = time.perf_counter()
        root_path = Path(root).resolve()
        report = IngestReport(pack=pack_name or root_path.name, root=str(root_path))
        pack_id = self.register_pack(report.pack, root_path, game_version=game_version, source=source)
        manifest = _load_manifest(manifest_path)

        discovered = self.discover(root_path)
        for mesh_path in discovered["meshes"]:
            try:
                changed = self.index_mesh(pack_id, root_path, mesh_path, make_thumbnails, force)
                report.meshes += 1
                if changed and make_thumbnails:
                    report.thumbnails += 1
                if not changed:
                    report.skipped += 1
            except (OSError, MeshProbeError) as exc:
                report.errors.append(f"{mesh_path}: {exc}")

        for prefab_path in discovered["prefabs"]:
            try:
                changed = self.index_prefab(pack_id, root_path, prefab_path, manifest, make_thumbnails, force)
                report.prefabs += 1
                if changed and make_thumbnails:
                    report.thumbnails += 1
                if not changed:
                    report.skipped += 1
            except (OSError, ValueError) as exc:
                report.errors.append(f"{prefab_path}: {exc}")

        for map_path in discovered["maps"]:
            try:
                self.index_map(pack_id, root_path, map_path, make_thumbnails, force)
                report.maps += 1
            except (OSError, ValueError) as exc:
                report.errors.append(f"{map_path}: {exc}")

        self.connection.execute(
            "UPDATE asset_packs SET last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            (pack_id,),
        )
        report.duration_ms = int((time.perf_counter() - started) * 1000)
        return report

    # ------------------------------------------------------------------ meshes
    def index_mesh(
        self,
        pack_id: int,
        root: Path,
        mesh_path: Path,
        make_thumbnails: bool,
        force: bool,
        *,
        display_name: str | None = None,
        item_kind: str | None = None,
    ) -> bool:
        asset_path = _relative(mesh_path, root)
        digest = _sha256(mesh_path)
        existing = self.connection.execute(
            "SELECT file_hash, thumbnail_path FROM base_meshes WHERE pack_id = ? AND asset_path = ?",
            (pack_id, asset_path),
        ).fetchone()
        if existing and existing["file_hash"] == digest and not force:
            return False

        info = probe(mesh_path)
        thumbnail = existing["thumbnail_path"] if existing else None
        if make_thumbnails and (force or not thumbnail):
            preview = thumbnails.render_mesh_thumbnail(
                mesh_path, self.thumbnail_dir / f"mesh-{_slug(asset_path)}.png"
            )
            thumbnail = str(preview)

        self.connection.execute(
            """
            INSERT INTO base_meshes (
                pack_id, asset_path, name, item_kind, mesh_format, file_hash, file_bytes,
                triangle_count, vertex_count, uv_channel_count, has_tangents,
                bounds_min_x, bounds_min_y, bounds_min_z,
                bounds_max_x, bounds_max_y, bounds_max_z,
                thumbnail_path, metadata_json
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (pack_id, asset_path) DO UPDATE SET
                name = excluded.name, item_kind = excluded.item_kind,
                file_hash = excluded.file_hash, file_bytes = excluded.file_bytes,
                triangle_count = excluded.triangle_count, vertex_count = excluded.vertex_count,
                uv_channel_count = excluded.uv_channel_count, has_tangents = excluded.has_tangents,
                bounds_min_x = excluded.bounds_min_x, bounds_min_y = excluded.bounds_min_y,
                bounds_min_z = excluded.bounds_min_z, bounds_max_x = excluded.bounds_max_x,
                bounds_max_y = excluded.bounds_max_y, bounds_max_z = excluded.bounds_max_z,
                thumbnail_path = excluded.thumbnail_path, metadata_json = excluded.metadata_json,
                indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            """,
            (
                pack_id,
                asset_path,
                display_name or mesh_path.stem,
                item_kind or infer_mesh_kind(asset_path),
                mesh_path.suffix.lower().lstrip("."),
                digest,
                mesh_path.stat().st_size,
                info.triangle_count,
                info.vertex_count,
                info.uv_channels,
                int(info.has_tangents),
                info.bounds_min[0],
                info.bounds_min[1],
                info.bounds_min[2],
                info.bounds_max[0],
                info.bounds_max[1],
                info.bounds_max[2],
                thumbnail,
                json.dumps({"materialSlots": info.material_slots, "boundsSize": list(info.size)}),
            ),
        )
        self._index_search("mesh", asset_path, display_name or mesh_path.stem, asset_path)
        return True

    # ----------------------------------------------------------------- prefabs
    def index_prefab(
        self,
        pack_id: int,
        root: Path,
        prefab_path: Path,
        manifest: dict[str, dict] | None,
        make_thumbnails: bool,
        force: bool,
    ) -> bool:
        asset_path = _relative(prefab_path, root)
        digest = _sha256(prefab_path)
        existing = self.connection.execute(
            "SELECT file_hash, thumbnail_path FROM prefabs WHERE pack_id = ? AND asset_path = ?",
            (pack_id, asset_path),
        ).fetchone()
        if existing and existing["file_hash"] == digest and not force:
            return False

        entry = (manifest or {}).get(asset_path, {})
        bounds_min = entry.get("boundsMin", [0.0, 0.0, 0.0])
        bounds_max = entry.get("boundsMax", [0.0, 0.0, 0.0])
        category = entry.get("category") or infer_prefab_category(asset_path)
        colliders = entry.get("colliders", [])

        try:
            document = parse_document(prefab_path.read_bytes())
            instance_prefabs: list[PrefabInstance] = document.prefabs
        except ValueError:
            # A .prefab that is not a WorldSerialization container can still be
            # indexed from the manifest; geometry simply stays unknown.
            instance_prefabs = []

        thumbnail = existing["thumbnail_path"] if existing else None
        if make_thumbnails and (force or not thumbnail):
            preview = thumbnails.render_prefab_thumbnail(
                prefab_path.stem,
                bounds_min,
                bounds_max,
                self.thumbnail_dir / f"prefab-{_slug(asset_path)}.png",
            )
            thumbnail = str(preview)

        self.connection.execute(
            """
            INSERT INTO prefabs (
                pack_id, asset_path, name, category, prefab_id, file_hash,
                bounds_min_x, bounds_min_y, bounds_min_z,
                bounds_max_x, bounds_max_y, bounds_max_z,
                flatten_radius, flatten_depth, modifiers_json,
                has_loot, has_io, has_npc, thumbnail_path
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (pack_id, asset_path) DO UPDATE SET
                name = excluded.name, category = excluded.category,
                prefab_id = excluded.prefab_id, file_hash = excluded.file_hash,
                bounds_min_x = excluded.bounds_min_x, bounds_min_y = excluded.bounds_min_y,
                bounds_min_z = excluded.bounds_min_z, bounds_max_x = excluded.bounds_max_x,
                bounds_max_y = excluded.bounds_max_y, bounds_max_z = excluded.bounds_max_z,
                flatten_radius = excluded.flatten_radius, flatten_depth = excluded.flatten_depth,
                modifiers_json = excluded.modifiers_json, has_loot = excluded.has_loot,
                has_io = excluded.has_io, has_npc = excluded.has_npc,
                thumbnail_path = excluded.thumbnail_path,
                indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            """,
            (
                pack_id,
                asset_path,
                prefab_path.stem,
                category,
                prefab_id_from_path(asset_path),
                digest,
                float(bounds_min[0]),
                float(bounds_min[1]),
                float(bounds_min[2]),
                float(bounds_max[0]),
                float(bounds_max[1]),
                float(bounds_max[2]),
                float(entry.get("flattenRadius", 0.0)),
                float(entry.get("flattenDepth", 0.0)),
                json.dumps(
                    {
                        "source": "prefab-file" if instance_prefabs else "manifest",
                        "colliderCount": len(colliders),
                        "instanceRecords": len(instance_prefabs),
                    }
                ),
                int(bool(entry.get("hasLoot"))),
                int(bool(entry.get("hasIO"))),
                int(bool(entry.get("hasNpc"))),
                thumbnail,
            ),
        )

        row = self.connection.execute(
            "SELECT id FROM prefabs WHERE pack_id = ? AND asset_path = ?", (pack_id, asset_path)
        ).fetchone()
        prefab_row_id = int(row["id"])
        for index, collider in enumerate(colliders):
            center = collider.get("center", [0.0, 0.0, 0.0])
            extents = collider.get("extents", [0.0, 0.0, 0.0])
            self.connection.execute(
                """
                INSERT INTO prefab_bounds (
                    prefab_row_id, collider_index, shape, center_x, center_y, center_z,
                    extents_x, extents_y, extents_z, is_trigger, volume_kind
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT (prefab_row_id, collider_index) DO UPDATE SET
                    shape = excluded.shape, center_x = excluded.center_x,
                    center_y = excluded.center_y, center_z = excluded.center_z,
                    extents_x = excluded.extents_x, extents_y = excluded.extents_y,
                    extents_z = excluded.extents_z, is_trigger = excluded.is_trigger,
                    volume_kind = excluded.volume_kind
                """,
                (
                    prefab_row_id,
                    index,
                    collider.get("shape", "box"),
                    float(center[0]),
                    float(center[1]),
                    float(center[2]),
                    float(extents[0]),
                    float(extents[1]),
                    float(extents[2]),
                    int(bool(collider.get("isTrigger"))),
                    collider.get("volumeKind", "collider"),
                ),
            )

        self._index_search("prefab", asset_path, prefab_path.stem, asset_path)
        return True

    def update_prefab_bounds(
        self,
        pack_id: int,
        asset_path: str,
        bounds_min: tuple[float, float, float],
        bounds_max: tuple[float, float, float],
        *,
        source: str,
        force: bool = False,
    ) -> bool:
        """Fill prefab bounds without clobbering manifest data by default."""
        row = self.connection.execute(
            "SELECT id, bounds_min_x, bounds_min_y, bounds_min_z, bounds_max_x, bounds_max_y, bounds_max_z, modifiers_json FROM prefabs WHERE pack_id = ? AND asset_path = ?",
            (pack_id, asset_path),
        ).fetchone()
        if row is None:
            return False
        populated = any(
            abs(float(row[key])) > 1e-6
            for key in (
                "bounds_min_x", "bounds_min_y", "bounds_min_z",
                "bounds_max_x", "bounds_max_y", "bounds_max_z",
            )
        )
        if populated and not force:
            return False
        try:
            metadata = json.loads(row["modifiers_json"] or "{}")
        except json.JSONDecodeError:
            metadata = {}
        metadata["boundsSource"] = source
        self.connection.execute(
            """
            UPDATE prefabs
               SET bounds_min_x = ?, bounds_min_y = ?, bounds_min_z = ?,
                   bounds_max_x = ?, bounds_max_y = ?, bounds_max_z = ?,
                   modifiers_json = ?,
                   indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?
            """,
            (
                float(bounds_min[0]), float(bounds_min[1]), float(bounds_min[2]),
                float(bounds_max[0]), float(bounds_max[1]), float(bounds_max[2]),
                json.dumps(metadata), int(row["id"]),
            ),
        )
        return True

    def index_bundle_prefab(
        self, pack_id: int, asset_path: str, *, bundle_name: str
    ) -> bool:
        """Record a prefab path exposed by an AssetBundle container table.

        Unity bundles do not carry the game's serialized prefab modifiers, so
        geometry, flags and thumbnails stay unknown here. The identity (path,
        name, Rust prefab id) is what map editing and export need.
        """
        name = prefab_name_from_path(asset_path)
        lowered = asset_path.lower()
        category = infer_prefab_category(asset_path)
        if category == "Other" and lowered.endswith(".item.prefab"):
            category = "Entity"

        existing = self.connection.execute(
            "SELECT id FROM prefabs WHERE pack_id = ? AND asset_path = ?",
            (pack_id, asset_path),
        ).fetchone()
        if existing:
            # Preserve bounds, flatten settings and thumbnails that a manifest
            # or a previous extraction may already have filled in.
            self.connection.execute(
                """
                UPDATE prefabs
                   SET name = ?, category = ?, prefab_id = ?, modifiers_json = ?,
                       indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE id = ?
                """,
                (
                    name,
                    category,
                    prefab_id_from_path(asset_path),
                    json.dumps({"source": "unity-bundle", "bundle": bundle_name}),
                    existing["id"],
                ),
            )
        else:
            self.connection.execute(
                """
                INSERT INTO prefabs (
                    pack_id, asset_path, name, category, prefab_id, modifiers_json
                ) VALUES (?,?,?,?,?,?)
                """,
                (
                    pack_id,
                    asset_path,
                    name,
                    category,
                    prefab_id_from_path(asset_path),
                    json.dumps({"source": "unity-bundle", "bundle": bundle_name}),
                ),
            )
        self._index_search("prefab", asset_path, name, asset_path)
        return True

    # -------------------------------------------------------------------- maps
    def index_map(
        self, pack_id: int, root: Path, map_path: Path, make_thumbnails: bool, force: bool
    ) -> bool:
        asset_path = _relative(map_path, root)
        digest = _sha256(map_path)
        existing = self.connection.execute(
            "SELECT file_hash, thumbnail_path FROM source_maps WHERE pack_id = ? AND asset_path = ?",
            (pack_id, asset_path),
        ).fetchone()
        if existing and existing["file_hash"] == digest and not force:
            return False

        document = parse_document(map_path.read_bytes())
        summary = document.summary()
        thumbnail = existing["thumbnail_path"] if existing else None
        if make_thumbnails and (force or not thumbnail):
            thumbnail = str(
                thumbnails.render_map_thumbnail(
                    document, self.thumbnail_dir / f"map-{_slug(asset_path)}.png"
                )
            )

        self.connection.execute(
            """
            INSERT INTO source_maps (
                pack_id, asset_path, name, size_metres, height_resolution,
                prefab_count, path_count, version, file_hash, file_bytes, thumbnail_path
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (pack_id, asset_path) DO UPDATE SET
                name = excluded.name, size_metres = excluded.size_metres,
                height_resolution = excluded.height_resolution,
                prefab_count = excluded.prefab_count, path_count = excluded.path_count,
                version = excluded.version, file_hash = excluded.file_hash,
                file_bytes = excluded.file_bytes, thumbnail_path = excluded.thumbnail_path,
                indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            """,
            (
                pack_id,
                asset_path,
                map_path.stem,
                int(document.size),
                summary.get("heightResolution"),
                len(document.prefabs),
                len(document.paths),
                document.version,
                digest,
                map_path.stat().st_size,
                thumbnail,
            ),
        )
        self._index_search(
            "map",
            asset_path,
            map_path.stem,
            f"{document.size}m {len(document.prefabs)} prefabs {len(document.paths)} paths",
        )
        return True

    # ------------------------------------------------------------------ search
    def _index_search(self, entity_type: str, entity_id: str, name: str, asset_path: str) -> None:
        self.connection.execute(
            "DELETE FROM asset_search WHERE entity_type = ? AND entity_id = ?",
            (entity_type, entity_id),
        )
        self.connection.execute(
            "INSERT INTO asset_search (entity_type, entity_id, name, asset_path) VALUES (?,?,?,?)",
            (entity_type, entity_id, name, asset_path),
        )

    def search(self, query: str, limit: int = 50) -> Sequence[sqlite3.Row]:
        return self.connection.execute(
            """
            SELECT entity_type, entity_id, name, asset_path
              FROM asset_search
             WHERE asset_search MATCH ?
             ORDER BY rank LIMIT ?
            """,
            (f"{query}*", limit),
        ).fetchall()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "AssetIndexer":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()


def _load_manifest(path: str | Path | None) -> dict[str, dict] | None:
    if not path:
        return None
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "prefabs" in data:
        data = data["prefabs"]
    if isinstance(data, list):
        return {entry["assetPath"]: entry for entry in data if "assetPath" in entry}
    if isinstance(data, dict):
        return data
    raise ValueError("prefab manifest must be a list or an object")


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _slug(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in value.lower())
    return "-".join(filter(None, cleaned.split("-")))[:80]


__all__ = [
    "AssetIndexer",
    "IngestReport",
    "infer_mesh_kind",
    "infer_prefab_category",
    "prefab_id_from_path",
    "prefab_name_from_path",
]
