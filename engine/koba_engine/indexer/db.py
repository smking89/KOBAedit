"""SQLite access for the local asset index and project store."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

SCHEMA_VERSION = 1
DEFAULT_DB_NAME = "rust-studio.db"


class DatabaseError(RuntimeError):
    """Raised when the index database cannot be opened or migrated."""


def project_root() -> Path:
    """Repository root (``<root>/engine/koba_engine/indexer/db.py``)."""
    return Path(__file__).resolve().parents[3]


def schema_path() -> Path:
    override = os.environ.get("RUST_STUDIO_SCHEMA")
    if override:
        return Path(override)
    candidates = [
        project_root() / "db" / "schema.sql",
        Path(__file__).resolve().parent / "schema.sql",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise DatabaseError("db/schema.sql not found (set RUST_STUDIO_SCHEMA)")


def default_db_path(data_root: str | Path | None = None) -> Path:
    root = Path(data_root) if data_root else project_root() / "data"
    return root / DEFAULT_DB_NAME


def connect(path: str | Path = ":memory:", *, apply_schema: bool = True) -> sqlite3.Connection:
    """Open a database with the pragmas the app relies on."""
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(path), timeout=10.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    if apply_schema:
        apply_migrations(connection)
    return connection


def apply_migrations(connection: sqlite3.Connection) -> None:
    """Apply ``db/schema.sql``; every object is idempotent."""
    path = schema_path()
    script = path.read_text(encoding="utf-8")
    try:
        connection.executescript(script)
    except sqlite3.Error as exc:
        raise DatabaseError(f"failed to apply {path}: {exc}") from exc
    _ensure_column(
        connection, "bundles", "manifest_prefab_count", "INTEGER NOT NULL DEFAULT -1"
    )
    current = connection.execute("PRAGMA user_version").fetchone()[0]
    if current < SCHEMA_VERSION:
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _ensure_column(
    connection: sqlite3.Connection, table: str, column: str, definition: str
) -> None:
    """Add a column to an existing database (``CREATE TABLE IF NOT EXISTS``
    never alters a table that is already present)."""
    columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def get_setting(connection: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = connection.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(connection: sqlite3.Connection, key: str, value: str) -> None:
    connection.execute(
        """
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        """,
        (key, str(value)),
    )


def database_stats(connection: sqlite3.Connection) -> dict[str, int]:
    def count(table: str) -> int:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

    return {
        "packs": count("asset_packs"),
        "baseMeshes": count("base_meshes"),
        "prefabs": count("prefabs"),
        "bundles": count("bundles"),
        "bundleAssets": count("bundle_assets"),
        "projects": count("projects"),
        "queuedSync": int(
            connection.execute(
                "SELECT COUNT(*) FROM sync_queue WHERE state IN ('queued','inflight')"
            ).fetchone()[0]
        ),
    }


__all__ = [
    "DEFAULT_DB_NAME",
    "DatabaseError",
    "SCHEMA_VERSION",
    "apply_migrations",
    "connect",
    "database_stats",
    "default_db_path",
    "get_setting",
    "project_root",
    "schema_path",
    "set_setting",
]
