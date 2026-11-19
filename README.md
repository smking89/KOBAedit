# Rust Studio

Linux-first desktop workspace for **Rust map and monument editing** and **Rust PC item skin creation**. It is offline-first: every project saves to local SQLite and disk, and optional sync queues changes until a connection is available.

The UI is a guided, dual-branch wizard with a Studio Mode that progressively discloses manual tools at every step. No emoji, no cloud dependency, no runtime network asset fetching.

```
Guided wizard (React)  ->  Tauri commands (Rust)  ->  SQLite index + project store
        |                        |
   Three.js viewport      Python geometry/binary engine
   terrain + skin          .map/.prefab codec, brushes, splines, textures
```

## What is in this repository

| Path | Purpose |
| --- | --- |
| `apps/desktop/ui` | React + TypeScript wizard, Three.js viewports, GLSL terrain and skin shaders |
| `apps/desktop/src-tauri` | Tauri v2 shell, IPC commands, AppImage/deb packaging config |
| `crates/world-codec` | Native Rust WorldSerialization (`.map` / `.prefab`) reader/writer |
| `engine/rust_studio_engine` | Python codec, terrain/brush math, spline extrusion, textures, SQLite indexer, sync outbox, exporter |
| `engine/scripts/ingest_assets.py` | Batch ingestion for loose meshes, prefabs and maps |
| `engine/scripts/ingest_bundles.py` | UnityFS bundle inventory, prefab import and mesh/texture export |
| `db/schema.sql` | Complete local index, project and sync schema |
| `docs/ARCHITECTURE.md` | Binary format, rendering pipeline, sync state machine, layout |

## Prerequisites

- Linux with a WebGL2-capable browser or GPU
- Node.js 20+
- Python 3.10+ with Pillow (`pip install -e engine`)
- Rust stable (for Tauri, plus `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, and `patchelf` for bundling)

## Run the UI (browser preview, no Rust build)

```bash
npm install
npm run dev
```

The browser build uses a local mock bridge, so the whole wizard, terrain shader, decal projection and export flow can be reviewed without compiling Tauri. The header shows a `Preview data` badge while the bridge is mocked.

## Run the desktop shell

```bash
npm run tauri:dev     # dev shell, Vite dev server, native filesystem + SQLite
npm run tauri:build   # AppImage and .deb under apps/desktop/src-tauri/target/release/bundle
```

The shell resolves the repository root from its manifest path for development. Override with `RUST_STUDIO_DATA`, `RUST_STUDIO_ENGINE` and `RUST_STUDIO_PYTHON` when packaging or running from elsewhere.

## Index local Rust assets

The app is usable with the built-in demo catalogue, but real prefab bounds, colliders and thumbnails come from the index:

```bash
python3 -m venv .venv --system-site-packages
.venv/bin/pip install -e 'engine[dev]'

.venv/bin/python engine/scripts/ingest_assets.py /path/to/Rust \
  --pack-name rust-client --game-version 2026-11-05 \
  --db data/rust-studio.db --thumbnails data/thumbnails
```

Optional prefab manifest (bounds, colliders, IO flags, flatten radius). Values here take precedence over extracted bounds:

```json
{
  "prefabs/monuments/airfield.prefab": {
    "category": "Monument",
    "boundsMin": [-180, -20, -140],
    "boundsMax": [180, 60, 140],
    "flattenRadius": 200,
    "colliders": [
      { "shape": "box", "center": [0, 20, 0], "extents": [180, 40, 140], "volumeKind": "no_build" }
    ],
    "hasLoot": true,
    "hasIO": true
  }
}
```

```bash
.venv/bin/python engine/scripts/ingest_assets.py ./my-monuments \
  --manifest ./my-monuments/prefabs.json --pack-name custom-monuments
```

Prefab ids follow Rust's rule: `u32_le(MD5(lowercase(asset_path))[0..4])`.

### Unity AssetBundles

The Rust client ships `content.bundle`, `items.preload.bundle`, `skinnables.preload.bundle`, `monuments.bundle` and `assetscenes.bundle` as UnityFS archives rather than loose assets. Inventory them directly:

```bash
.venv/bin/pip install -e 'engine[bundles]'   # UnityPy, only needed for object access

.venv/bin/python engine/scripts/ingest_bundles.py ~/Desktop/*.bundle \
  --db data/rust-studio.db --pack-name rust-client --game-version 6000.3.28x1-1
```

This reads the header and block/directory table natively, imports every `.prefab` container path as a real prefab (asset path, display name and Rust prefab id), and records meshes, textures, sprites and container-linked objects. Incidental scene objects are not materialized, so a 1.4M-object scene bundle adds only its standalone assets.

Prefab bounds are extracted automatically by walking each prefab's renderer hierarchy and unioning its transformed mesh AABBs. Bundles whose meshes live in another bundle have no readable mesh here, so those prefabs keep zero bounds until a `--manifest` supplies them. Pass `--no-bounds` to skip the walk on large scene bundles.

Export selected payloads on demand (OBJ meshes and PNG textures):

```bash
# Four AK LOD meshes; exported OBJs are added to base_meshes with thumbnails
.venv/bin/python engine/scripts/ingest_bundles.py ~/Desktop/content.bundle \
  --db data/rust-studio.db --pack-name rust-client \
  --extract meshes --match ak47 --limit 4

# Airfield height/splat/topology textures
.venv/bin/python engine/scripts/ingest_bundles.py ~/Desktop/monuments.bundle \
  --db data/rust-studio.db --pack-name rust-client \
  --extract textures --match airfield --limit 3
```

Exports go to `data/extracted/<bundle>/` unless `--extract-dir` is set. `--limit` caps exports per bundle and kind; `--match` filters on object name or container path. Bundle files are never modified or copied.

## Inspect and export from the CLI

```bash
.venv/bin/python -m rust_studio_engine inspect-map world.map --json
.venv/bin/python -m rust_studio_engine export-project draft.json --out data/exports --json
.venv/bin/python -m rust_studio_engine db-stats --db data/rust-studio.db
.venv/bin/python -m rust_studio_engine generate-terrain --seed 1337 --preset islands --out terrain.png
```

`draft.json` is the wizard state (or `{ "draft": ... }` as saved by the shell). The exporter emits a server-ready `.map`, a `.prefab` for monument projects, or the four Workshop PNGs for skins.

## Verify

```bash
npm run typecheck
npm run build
cd engine && ../.venv/bin/python -m pytest -q
```

The Python suite covers the LZ4 legacy stream, protobuf round trips, terrain brushes, spline extrusion, texture packing, SQLite ingestion with thumbnails, exporter output and sync backoff/conflict handling.

## Offline and online behavior

- A banner is never required: projects autosave to `localStorage` in the browser build and to `data/projects/<id>/project.json` plus SQLite in the shell.
- `Online sync` only changes *when* uploads happen. Each save bumps a local revision and enqueues a push in `sync_queue`; failures back off exponentially instead of blocking edits.
- Pulls compare remote revisions before writing. A dirty local revision plus a newer remote revision marks the entity `conflict`; the UI surfaces the count instead of silently overwriting.
- Sync tokens are not stored in SQLite. `sync_profiles.token_ref` points at the OS keyring entry read by the shell.
- The optional FastAPI sidecar binds loopback only and authenticates with a per-run token from `STUDIO_SIDECAR_TOKEN`.

## Deliberate scope boundaries

This repository is a working scaffold and vertical slice, not a finished RustEdit replacement:

- Terrain, water, splat, biome, topology and alpha layers round-trip byte-exactly, including unknown layers.
- Prefab bounds are best-effort derived from renderer hierarchies when meshes are available in the same bundle; collider volumes still require an index manifest.
- Game-specific IO entity / vending profile serialization for RustEdit's private metadata is represented as project data (`data_json`, `io_wiring`) and preserved as opaque layers, not reverse-engineered.
- The Rust writer stores valid LZ4 *legacy* chunks uncompressed; files are larger than game output until block compression is enabled.
- Thumbnails are CPU rasterized (Pillow) approximations, not GPU renders.
- Skin PBR export writes deterministic diffuse/normal/specular/emission sets from the layer stack; brush strokes are previewed in the viewport and stencils are baked into the diffuse channel.

See `docs/ARCHITECTURE.md` for the format details and extension points.
