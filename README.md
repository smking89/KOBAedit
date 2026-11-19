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

Every `.prefab` listed by the bundle's `GameManifest` is imported as well (marked `source: game-manifest`). That is how monument scenes get catalogue rows even though `monuments.bundle` only ships splat textures and their assembly lives in the world map: `content.bundle` alone lists ~17.5k prefab paths, 84 of them monuments. A bundle is remembered as manifest-scanned (even when it has no manifest), so the second scan only re-reads headers.

Monument cards show a real preview without any scene geometry. `monuments.bundle` ships a terrain height map per monument (`assets/scenes/prefabs/<group>/<scene>/heighttexture.png`); the engine renders it as shaded relief into the app's thumbnail cache, keyed by the same prefab hash the drawer asks for:

```bash
.venv/bin/python -m rust_studio_engine monument-previews \
  --bundle-root ~/Desktop --cache-dir ~/.cache/koba-edit/thumbs
```

The drawer's **Monument previews** button (and every bundle scan) runs the same pass. Scenes without a shipped height mask — ocean rigs, the missile silo, underwater labs — keep the category placeholder; 75 of the 84 indexed monuments have one.

The New Project screen's **Link & scan** action persists the selected `Bundles` folder and runs the same inventory locally. It also extracts up to 80 weapon/attire skin meshes per bundle and builds their base-mesh thumbnails, so the Assets → Skin bases tab is populated and previewed automatically.

Prefab bounds are extracted automatically by walking each prefab's renderer hierarchy and unioning its transformed mesh AABBs, with collider and LODGroup fallbacks when a prefab has no readable renderer meshes. Item definitions (`*.item.prefab`) have no geometry of their own: the bundle's `GameManifest` is used to resolve their real sibling/entity/world prefabs, and those prefab-local bounds are linked back to the item row. Prefabs with no shipped geometry, or meshes in an unshipped external CAB, keep zero bounds instead of a fake box; a `--manifest` can still supply them. Pass `--no-bounds` to skip the walk on large scene bundles.

Export selected payloads on demand (OBJ meshes and PNG textures):

```bash
# One prefab as a cached GLB, through the resident extraction worker
.venv/bin/python -m rust_studio_engine export-prefab-glb \
  --prefab assets/prefabs/weapons/ak47u/ak47u.item.prefab \
  --bundle-root ~/Desktop --cache-dir ~/.cache/koba-edit/meshes \
  --daemon-socket ~/.cache/koba-edit/extract.sock

# Four AK LOD meshes; exported OBJs are added to base_meshes with thumbnails
.venv/bin/python engine/scripts/ingest_bundles.py ~/Desktop/content.bundle \
  --db data/rust-studio.db --pack-name rust-client \
  --extract meshes --match ak47 --limit 4

# Extract weapon/attire skin bases and build their thumbnails for the app
.venv/bin/python engine/scripts/ingest_bundles.py ~/Desktop/content.bundle \
  --db data/rust-studio.db --pack-name rust-client \
  --skin-meshes --limit 80

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
- Pulls compare remote revisions before writing. A dirty local revision plus a newer remote revision marks the entity `conflict`; the Export step shows **Keep local and push** / **Accept remote** instead of silently overwriting. Revisions are compared deterministically; there is no hidden field-level merge.
- Sync tokens are not stored in SQLite or project JSON. `sync_configure` writes the token to `data/sync/token` with mode `0600`; `sync_profiles.token_ref` records that path, and the shell passes it to the HTTP client by file.
- The adapter speaks the documented generic **`koba-sync/1`** contract. It is intentionally not tied to a hosted account; point it at any server implementing these endpoints:

  ```text
  GET  {endpoint}/v1/health
  POST {endpoint}/v1/projects/{projectId}/push
  GET  {endpoint}/v1/projects/{projectId}
  ```

  Push bodies carry `format`, `projectId`, `baseRevision`, `force`, `payload` and `payloadHash`. A stale base revision returns HTTP 409 with a `remote` envelope; pull returns the same revision envelope plus `payload`. HTTP is accepted only for loopback addresses; use HTTPS for any other host. The Python CLI exposes the same operations as `sync-test`, `sync-push` and `sync-pull`.
- `queue_project_delta` writes the local outbox file and, when a profile is active, updates `sync_metadata` and `sync_queue`. Push sends the current full draft and marks queued work done; pull stores the remote draft under `data/sync/incoming/` for conflict resolution.
- The optional FastAPI sidecar binds loopback only and authenticates with a per-run token from `STUDIO_SIDECAR_TOKEN`.

## Terrain, cache and native jobs

- Heightmap and mask imports keep native 2049² / 4097² grids. Files above 4097² are rejected rather than silently downsampled. A native heightmap sets the exported map size to `resolution - 1` metres so layer sizes validate; the UI shows the layer's memory footprint and the exporter enforces a 512 MiB layer budget. Masks whose grid already matches the target layer are copied byte for byte; when the native grid is larger, the exporter box-averages it onto the splat/biome/topology grid instead of point-sampling, so 4097² coverage is not lost to aliasing.
- Bundle scans and prefab GLB extraction run as cancellable background jobs. Python writes JSON-lines progress to `data/sync/progress/`; the shell polls it and the UI shows the current stage with a Cancel button. Killing a job leaves SQLite to roll back its open transaction.
- `~/.cache/koba-edit/{meshes,thumbs}` can be inspected and pruned from the New Project screen. Pruning removes the oldest `.glb`/`.png`/`.obj` files first and preserves unrelated files. The chosen limit is saved in `data/cache-settings.json` and enforced after GLB/thumbnail writes and completed scan/extraction jobs, so it survives restarts. The default is 512 MiB; `KOBA_CACHE_LIMIT_MB` supplies the initial value until a limit is saved.
- **Browse...** in the Local index panel opens the native Zenity folder picker; the manual path field remains available for headless sessions.

## Deliberate scope boundaries

This repository is a working scaffold and vertical slice, not a finished RustEdit replacement:

- Terrain, water, splat, biome, topology and alpha layers round-trip byte-exactly, including unknown layers.
- Prefab bounds are best-effort derived from renderer, collider and LODGroup geometry. Item definitions are linked to their real prefab bounds through the bundle manifest; geometry missing from the shipped bundles still requires an index manifest.
- Game-specific IO entity, vending profile and card-reader wiring are serialized into the RustEdit data layer; unknown layers are preserved opaquely and no synthetic vanilla entities are injected.
- The Rust writer stores valid LZ4 *legacy* chunks uncompressed; files are larger than game output until block compression is enabled.
- Base-mesh thumbnails from the indexer are Pillow previews. Prefab, monument and skin cards render cached GLBs through a WebGL thumbnail queue (with a deterministic CPU fallback); map lock uses PBKDF2-HMAC-SHA256 and writes a `.map.lock` sidecar.
- Skin PBR export writes deterministic diffuse/normal/specular/emission sets from the layer stack; brush strokes are previewed in the viewport and stencils are baked into the diffuse channel.

See `docs/ARCHITECTURE.md` for the format details and extension points.
