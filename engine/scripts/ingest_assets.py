#!/usr/bin/env python3
"""Batch-ingest local Rust base meshes, prefabs and maps.

Scans a folder (a Rust install, a Workshop download, or your own asset pack) and
writes metadata, collider bounds, prefab ids and 512 px thumbnails into the local
SQLite index. Offline only: no network calls.

Examples
--------
    # Index an entire Rust client install (first run can take a while)
    python engine/scripts/ingest_assets.py ~/.steam/steam/steamapps/common/Rust \\
        --pack-name rust-client --game-version 2026-11-05

    # Index only your own monument prefabs, with a metadata manifest
    python engine/scripts/ingest_assets.py ./my-monuments \\
        --pack-name custom-monuments --manifest ./my-monuments/prefabs.json

    # Re-index everything and regenerate thumbnails
    python engine/scripts/ingest_assets.py ./my-monuments --force

The script writes to ``data/rust-studio.db`` by default; override with ``--db``.
Thumbnails go to ``data/thumbnails`` unless ``--thumbnails`` is given.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running directly from a checkout without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from koba_engine.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(["ingest", *sys.argv[1:]]))
