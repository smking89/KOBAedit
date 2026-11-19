"""SQLite asset index: meshes, prefabs, maps, thumbnails and search."""

from .db import connect, database_stats, default_db_path
from .indexer import AssetIndexer, IngestReport, prefab_id_from_path
from .mesh_probe import MeshInfo, probe

__all__ = [
    "AssetIndexer",
    "IngestReport",
    "MeshInfo",
    "connect",
    "database_stats",
    "default_db_path",
    "prefab_id_from_path",
    "probe",
]
