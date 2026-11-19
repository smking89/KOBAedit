#!/usr/bin/env python3
"""Inventory Rust UnityFS bundles and import their prefab paths.

Examples
--------
    # Index the five client bundles copied to the Desktop
    python engine/scripts/ingest_bundles.py ~/Desktop/items.preload.bundle \\
        ~/Desktop/skinnables.preload.bundle ~/Desktop/content.bundle \\
        ~/Desktop/monuments.bundle ~/Desktop/assetscenes.bundle

    # Also export a few item meshes and terrain textures
    python engine/scripts/ingest_bundles.py ~/Desktop/content.bundle \\
        ~/Desktop/monuments.bundle --extract all --match airfield --limit 8

UnityPy is required: ``pip install -e 'engine[bundles]'``. Exported files go to
``data/extracted`` unless ``--extract-dir`` is given.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rust_studio_engine.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(["ingest-bundles", *sys.argv[1:]]))
