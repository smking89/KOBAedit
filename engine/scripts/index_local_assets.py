#!/usr/bin/env python3
"""Index unpacked asset folders into one searchable local catalogue.

Scans every .glb plus Texture2D, Sprite, Shader and AudioClip file, stores the
full disk path in ``local_assets`` inside rust-studio.db, and keeps duplicate
filenames as one row whose ``sources_json`` lists every folder that has it.
Files are never copied into the project or the app bundle.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
import time
from pathlib import Path

CATEGORY_DIRS = {
    "texture2d": "Texture2D",
    "sprite": "Sprite",
    "shader": "Shader",
    "audioclip": "AudioClip",
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS local_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    group_key TEXT NOT NULL,
    part_index INTEGER,
    ext TEXT NOT NULL,
    asset_path TEXT NOT NULL,
    root_path TEXT NOT NULL,
    pack TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    file_bytes INTEGER NOT NULL,
    content_hash TEXT,
    sources_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    indexed_at TEXT NOT NULL,
    UNIQUE (category, name_key)
);
CREATE INDEX IF NOT EXISTS local_assets_group ON local_assets (category, group_key);
CREATE INDEX IF NOT EXISTS local_assets_name ON local_assets (name_key);
CREATE VIRTUAL TABLE IF NOT EXISTS local_assets_fts USING fts5(
    name, pack, category, content='local_assets', content_rowid='id'
);
"""


def default_roots() -> list[Path]:
    desktop = Path.home() / "Desktop"
    roots = [desktop / "KOBAedit"] + [desktop / f"KOBAedit{i}" for i in range(1, 5)]
    roots.append(Path.home() / ".steam/steam/steamapps/common/Rust")
    program_files = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    roots.append(Path(program_files) / "Steam/steamapps/common/Rust")
    return roots


def custom_roots(db: Path) -> list[Path]:
    if not db.exists():
        return []
    try:
        connection = sqlite3.connect(db)
        row = connection.execute(
            "SELECT value FROM app_settings WHERE key = 'asset_roots'"
        ).fetchone()
        connection.close()
        if row:
            return [Path(item) for item in json.loads(row[0]) if item]
    except (sqlite3.Error, ValueError, TypeError):
        pass
    return []


def classify(path: Path) -> str | None:
    parts = {part.lower() for part in path.parts}
    if path.suffix.lower() == ".glb":
        return "mesh"
    for key, folder in CATEGORY_DIRS.items():
        if folder.lower() in parts:
            return key
    return None


def glb_metadata(path: Path) -> dict:
    try:
        with path.open("rb") as handle:
            header = handle.read(20)
            if len(header) < 20 or header[:4] != b"glTF":
                return {}
            length, kind = struct.unpack("<II", header[12:20])
            if kind != 0x4E4F534A:
                return {}
            payload = json.loads(handle.read(length))
        return {
            "meshes": len(payload.get("meshes", [])),
            "materials": len(payload.get("materials", [])),
            "images": len(payload.get("images", [])),
            "animations": len(payload.get("animations", [])),
            "nodes": len(payload.get("nodes", [])),
        }
    except (OSError, ValueError, struct.error):
        return {}


def file_hash(path: Path) -> str | None:
    try:
        digest = hashlib.sha1()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def part_info(stem: str) -> tuple[str, int | None]:
    # Only explicit "part" / "piece" numbering is a multi-part mesh. A bare
    # trailing number is usually a variant (crate1, door2), not one model.
    match = re.match(r"^(.*?)[._-](?:part|piece)[._-]?(\d{1,3})$", stem, re.IGNORECASE)
    if match and match.group(2):
        base = re.sub(r"[._-]+$", "", match.group(1))
        if base:
            return base.lower(), int(match.group(2))
    return stem.lower(), None


def scan(root: Path, rows: dict, totals: dict) -> None:
    pack = root.name
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        category = classify(path)
        if not category:
            continue
        totals[category] = totals.get(category, 0) + 1
        stem = path.stem
        name_key = path.name.lower()
        group_key, part_index = part_info(stem)
        key = (category, name_key)
        row = rows.get(key)
        if row is None:
            metadata = glb_metadata(path) if category == "mesh" else {}
            row = {
                "category": category,
                "name": stem,
                "name_key": name_key,
                "group_key": f"{category}:{group_key}",
                "part_index": part_index,
                "ext": path.suffix.lower(),
                "asset_path": str(path),
                "root_path": str(root),
                "pack": pack,
                "rel_path": str(path.relative_to(root)),
                "file_bytes": path.stat().st_size,
                "content_hash": file_hash(path) if category == "mesh" else None,
                "sources": [],
                "metadata": metadata,
            }
            rows[key] = row
        row["sources"].append({"pack": pack, "path": str(path)})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="*", type=Path)
    parser.add_argument("--db", type=Path, default=Path("data/rust-studio.db"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    roots = args.roots or (custom_roots(args.db) + default_roots())
    roots = [root.expanduser().resolve() for root in roots if root.expanduser().is_dir()]

    started = time.perf_counter()
    rows: dict[tuple[str, str], dict] = {}
    totals: dict[str, int] = {}
    for root in dict.fromkeys(roots):
        scan(root, rows, totals)

    args.db.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(args.db)
    connection.executescript(SCHEMA)
    indexed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for row in rows.values():
        connection.execute(
            """INSERT INTO local_assets
               (category,name,name_key,group_key,part_index,ext,asset_path,root_path,
                pack,rel_path,file_bytes,content_hash,sources_json,metadata_json,indexed_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(category,name_key) DO UPDATE SET
                 name=excluded.name, group_key=excluded.group_key,
                 part_index=excluded.part_index, asset_path=excluded.asset_path,
                 root_path=excluded.root_path, pack=excluded.pack,
                 rel_path=excluded.rel_path, file_bytes=excluded.file_bytes,
                 content_hash=excluded.content_hash, sources_json=excluded.sources_json,
                 metadata_json=excluded.metadata_json, indexed_at=excluded.indexed_at""",
            (
                row["category"], row["name"], row["name_key"], row["group_key"],
                row["part_index"], row["ext"], row["asset_path"], row["root_path"],
                row["pack"], row["rel_path"], row["file_bytes"], row["content_hash"],
                json.dumps(row["sources"]), json.dumps(row["metadata"]), indexed_at,
            ),
        )
    connection.commit()
    sequence = connection.execute("SELECT MAX(id) FROM local_assets").fetchone()[0] or 0
    connection.execute("INSERT INTO local_assets_fts(local_assets_fts) VALUES ('rebuild')")
    connection.commit()
    stored = connection.execute("SELECT COUNT(*) FROM local_assets").fetchone()[0]
    connection.close()

    report = {
        "roots": [str(root) for root in dict.fromkeys(roots)],
        "scanned": totals,
        "unique": stored,
        "duplicatesCollapsed": sum(totals.values()) - stored,
        "durationMs": round((time.perf_counter() - started) * 1000),
        "database": str(args.db),
        "sequence": sequence,
    }
    print(json.dumps(report, indent=2) if args.json else report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
