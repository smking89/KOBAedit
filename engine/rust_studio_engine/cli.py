"""Command-line entry points.

    rust-studio-engine ingest <pack-root> --db data/rust-studio.db
    rust-studio-engine inspect-map world.map --json
    rust-studio-engine generate-terrain --seed 1337 --preset islands --out terrain.png
    rust-studio-engine db-stats --db data/rust-studio.db
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .indexer.db import connect, database_stats, default_db_path
from .indexer.indexer import AssetIndexer
from .world.map_file import MapFormatError, inspect_file


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rust-studio-engine",
        description="Offline engine tools for Rust Studio (maps, prefabs, textures, index).",
    )
    parser.add_argument("--version", action="version", version=f"rust-studio-engine {__version__}")
    subcommands = parser.add_subparsers(dest="command", required=True)

    ingest = subcommands.add_parser("ingest", help="Index loose meshes, prefabs and maps in a folder")
    ingest.add_argument("root", type=Path, help="Folder to scan recursively")
    ingest.add_argument("--db", type=Path, default=None, help="SQLite index path")
    ingest.add_argument("--thumbnails", type=Path, default=None, help="Thumbnail output folder")
    ingest.add_argument("--pack-name", default=None, help="Display name for this asset pack")
    ingest.add_argument("--game-version", default="", help="Rust build string recorded in the index")
    ingest.add_argument(
        "--source", choices=("local", "workshop", "synced"), default="local", help="Pack origin"
    )
    ingest.add_argument("--manifest", type=Path, default=None, help="Prefab metadata JSON")
    ingest.add_argument("--no-thumbnails", action="store_true", help="Skip PNG generation")
    ingest.add_argument("--force", action="store_true", help="Re-index unchanged files")
    ingest.add_argument("--json", action="store_true", help="Machine-readable report")

    bundles = subcommands.add_parser(
        "ingest-bundles",
        help="Inventory UnityFS bundles and import their prefab paths (needs UnityPy)",
    )
    bundles.add_argument("paths", nargs="+", type=Path, help="Bundle files or folders to scan")
    bundles.add_argument("--db", type=Path, default=None, help="SQLite index path")
    bundles.add_argument("--thumbnails", type=Path, default=None, help="Thumbnail output folder")
    bundles.add_argument("--extract-dir", type=Path, default=None, help="Exported OBJ/PNG root")
    bundles.add_argument("--pack-name", default="rust-client", help="Display name for this pack")
    bundles.add_argument("--game-version", default="", help="Rust build string recorded in the index")
    bundles.add_argument(
        "--extract",
        choices=("none", "meshes", "textures", "all"),
        default="none",
        help="Also export matching meshes/textures",
    )
    bundles.add_argument("--match", default=None, help="Only extract names/paths containing this text")
    bundles.add_argument("--limit", type=int, default=25, help="Maximum exports per bundle and kind")
    bundles.add_argument("--force", action="store_true", help="Re-read unchanged bundles")
    bundles.add_argument("--manifest", type=Path, default=None, help="Prefab metadata JSON for bounds/flatten settings")
    bundles.add_argument("--no-bounds", action="store_true", help="Skip renderer AABB extraction")
    bundles.add_argument("--json", action="store_true", help="Machine-readable report")

    inspect = subcommands.add_parser("inspect-map", help="Print a .map/.prefab summary")
    inspect.add_argument("file", type=Path)
    inspect.add_argument("--json", action="store_true")

    generate = subcommands.add_parser("generate-terrain", help="Render a seeded terrain preview PNG")
    generate.add_argument("--seed", type=int, default=1337)
    generate.add_argument("--size", type=int, default=4500)
    generate.add_argument("--preset", default="islands", choices=("islands", "mountains", "valley", "flat", "archipelago"))
    generate.add_argument("--mountain-scale", type=float, default=1.0)
    generate.add_argument("--water-level", type=float, default=-8.0)
    generate.add_argument("--out", type=Path, default=Path("terrain-preview.png"))
    generate.add_argument("--resolution", type=int, default=512, help="Output PNG size")

    stats = subcommands.add_parser("db-stats", help="Print index statistics")
    stats.add_argument("--db", type=Path, default=None)
    stats.add_argument("--json", action="store_true")

    export = subcommands.add_parser(
        "export-project", help="Export a saved wizard draft to .map/.prefab or skin PNGs"
    )
    export.add_argument("draft", type=Path, help="Draft JSON written by the Tauri shell")
    export.add_argument("--out", type=Path, default=None, help="Output folder")
    export.add_argument("--json", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "ingest":
        database = args.db or default_db_path()
        with AssetIndexer(database, args.thumbnails) as indexer:
            if not args.root.exists():
                print(f"error: {args.root} does not exist", file=sys.stderr)
                return 2
            report = indexer.ingest(
                args.root,
                pack_name=args.pack_name,
                game_version=args.game_version,
                source=args.source,
                make_thumbnails=not args.no_thumbnails,
                force=args.force,
                manifest_path=args.manifest,
            )
        payload = report.to_dict()
        payload["database"] = str(database)
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(f"pack: {report.pack}  root: {report.root}")
            print(
                f"meshes: {report.meshes}  prefabs: {report.prefabs}  maps: {report.maps}  "
                f"thumbnails: {report.thumbnails}  skipped: {report.skipped}  "
                f"time: {report.duration_ms} ms"
            )
            print(f"index: {database}")
            for error in report.errors:
                print(f"warning: {error}", file=sys.stderr)
        return 1 if report.errors and not report.meshes and not report.prefabs else 0

    if args.command == "ingest-bundles":
        from .indexer.bundles import BundleIngestor
        from .indexer.unity_bundle import BundleDependencyError

        database = args.db or default_db_path()
        try:
            with BundleIngestor(
                database, args.thumbnails, extract_dir=args.extract_dir
            ) as ingestor:
                report = ingestor.ingest(
                    args.paths,
                    pack_name=args.pack_name,
                    game_version=args.game_version,
                    extract=args.extract,
                    match=args.match,
                    limit=args.limit,
                    force=args.force,
                    manifest_path=args.manifest,
                    extract_bounds=not args.no_bounds,
                )
        except (BundleDependencyError, FileNotFoundError, ValueError, OSError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

        payload = report.to_dict()
        payload["database"] = str(database)
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(f"pack: {report.pack}  root: {report.root}")
            print(
                f"bundles: {report.bundles}  prefabPaths: {report.prefabs}  "
                f"bundleAssets: {report.assets}  meshExports: {report.extracted_meshes}  "
                f"textureExports: {report.extracted_textures}  skipped: {report.skipped}  "
                f"time: {report.duration_ms} ms"
            )
            for item in report.per_bundle:
                if item.skipped:
                    print(f"  {item.name}: unchanged")
                elif not item.error or item.objects:
                    print(
                        f"  {item.name}: {item.objects} objects, {item.container} container paths, "
                        f"{item.prefabs} prefabs, {item.assets} assets indexed"
                    )
                if item.error:
                    print(f"warning: {item.name}: {item.error}", file=sys.stderr)
            print(f"index: {database}")
            for error in report.errors:
                print(f"warning: {error}", file=sys.stderr)
        return 1 if report.errors and report.bundles == 0 else 0

    if args.command == "inspect-map":
        try:
            summary = inspect_file(args.file)
        except (MapFormatError, OSError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print(f"{summary['file']}  version {summary['version']}  {summary['size']} m")
            print(
                f"height {summary['heightResolution']}  splat {summary['splatResolution']}  "
                f"prefabs {summary['prefabCount']}  paths {summary['pathCount']}"
            )
            print(f"layers: {', '.join(f'{name} ({size} B)' for name, size in summary['layers'].items())}")
            if summary["pathNames"]:
                print(f"paths: {', '.join(summary['pathNames'][:12])}")
        return 0

    if args.command == "generate-terrain":
        from .procedural import TerrainSettings, generate_preview_png

        settings = TerrainSettings(
            seed=args.seed,
            size_metres=args.size,
            preset=args.preset,
            mountain_scale=args.mountain_scale,
            water_level=args.water_level,
        )
        target = generate_preview_png(settings, str(args.out), size=args.resolution)
        print(f"wrote {target} ({args.preset}, seed {args.seed}, {args.size} m)")
        return 0

    if args.command == "export-project":
        from .exporter import ExportError, export_draft, load_draft

        try:
            draft = load_draft(args.draft)
            result = export_draft(draft, output_dir=args.out)
        except (ExportError, OSError, ValueError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        payload = result.to_dict()
        if args.json:
            print(json.dumps(payload))
        else:
            print(f"{payload['kind']}: {payload['path']} ({payload['bytes']} bytes)")
        return 0

    if args.command == "db-stats":
        database = args.db or default_db_path()
        with connect(database) as connection:
            stats = {"database": str(database), **database_stats(connection)}
        if args.json:
            print(json.dumps(stats, indent=2))
        else:
            for key, value in stats.items():
                print(f"{key}: {value}")
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
