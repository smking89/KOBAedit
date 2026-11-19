# Rust Studio architecture

## 1. System shape

```
+----------------------------- apps/desktop/ui (React + TypeScript) -----------------------------+
|  Wizard state machine (pure reducer)      Three.js viewports                                  |
|  - entry -> terrain -> monuments ->        - TerrainViewport: 8-channel splat shader,          |
|    paths -> loot -> validate                 biome tint, alpha holes, topology overlay,       |
|  - entry -> baseItem -> materials ->         CPU sculpt preview                               |
|    paint -> wear -> workshop               - SkinViewport: PBR item, camera-projected decals, |
|  Studio Mode at every step                   procedural wear, 4 lighting checks                |
+------------------------------------------+----------------------------------------------------+
                                           | Tauri invoke (typed in lib/ipc.ts)
+------------------------------------------v----------------------------------------------------+
| apps/desktop/src-tauri (Rust)                                                                 |
|  commands: index_stats, list_prefabs, list_base_meshes, inspect_map, save_project,            |
|            export_project, ingest_assets, sync_status                                         |
|  - rusqlite: asset index, project store, sync outbox                                          |
|  - world-codec crate: fast .map/.prefab inspection                                            |
|  - subprocess: python -m rust_studio_engine export-project / ingest_assets.py                  |
+------------------------------------------+----------------------------------------------------+
                                           | loopback CLI / optional FastAPI sidecar
+------------------------------------------v----------------------------------------------------+
| engine/rust_studio_engine (Python)                                                            |
|  world/   LZ4 legacy + protobuf codec, terrain brushes, layer validation                      |
|  spline   centripetal Catmull-Rom, resampling, terrain-conforming ribbons                      |
|  texture  channel packing, normal from height, Workshop PNG export                            |
|  indexer  walking, mesh probing (GLB/OBJ), prefab ids, thumbnails, FTS search                  |
|  sync     outbox, exponential backoff, revision comparison                                    |
|  exporter draft -> .map/.prefab or _diffuse/_normal/_specular/_emission                       |
+------------------------------------------------------------------------------------------------+
```

`db/schema.sql` is the canonical local database. `crates/world-codec` mirrors the Python codec so
the shell can inspect maps without starting Python; both implement the same container.

## 2. WorldSerialization format

Rust `.map` and `.prefab` files use one container:

```
0..4      uint32  version          (9 or 10; 10 is current)
4..12     int64   unix timestamp
12..EOF   LZ4 legacy chunked stream
             varint flags           bit 0 = payload is LZ4-compressed
             varint original_size
             varint compressed_size (only when compressed)
             <payload>
          decoded payload = protobuf WorldData
```

There is no stream magic or end marker. The decoder stops at EOF; version 9 files without a
timestamp are retried at offset 4.

```proto
message WorldData {
  uint32              size    = 1;  // terrain metres (typically 3000-6000)
  repeated MapData    maps    = 2;
  repeated PrefabData prefabs = 3;
  repeated PathData   paths   = 4;
}
message MapData    { string name = 1; bytes data = 2; }
message PrefabData { string category = 1; uint32 id = 2;
                     VectorData position = 3; VectorData rotation = 4; VectorData scale = 5; }
message VectorData { float x = 1; float y = 2; float z = 3; }
message PathData   { string name = 1; bool spline = 2; bool start = 3; bool end = 4;
                     float width = 5; float inner_padding = 6; float outer_padding = 7;
                     float inner_fade = 8; float outer_fade = 9; float random_scale = 10;
                     float mesh_offset = 11; float terrain_offset = 12;
                     int32 splat = 13; int32 topology = 14;
                     repeated VectorData nodes = 15; }
```

Terrain layers are raw little-endian buffers in `MapData`:

| Layer | Layout | Notes |
| --- | --- | --- |
| `terrain` | `uint16[(size+1)^2]` | render height |
| `height` | `uint16[(size+1)^2]` | world/decor sampling height |
| `water` | `uint16[(size+1)^2]` | 0 = dry |
| `splat` | `uint8[8][sres^2]` | eight ground weights, normalized to 255 |
| `biome` | `uint8[4..5][sres^2]` | arid / temperate / tundra / arctic |
| `topology` | `int32[sres^2]` | 32-bit mask, preserved verbatim |
| `alpha` | `uint8[sres^2]` | 0 = terrain hole |

`sres` is the next power of two at or above `size / 2` (2048 for a 4500 m map).

Coordinates follow Rust/Unity conventions: X and Z span `[-size/2, +size/2]`, Y is metres in
`[-500, +500]`; raw height `h` maps to `-500 + h / 65535 * 1000`.

Unknown `MapData` entries, including RustEdit's metadata layer, are preserved on a load/save round
trip. Editor-only data is written to `RustStudioData` and can be stripped at export.

References: Facepunch map data documentation and the RustEdit export docs.

## 3. Wizard state machine

`apps/desktop/ui/src/wizard/machine.ts` is a pure reducer with no React or I/O:

- Two branches: `world` (`entry, terrain, monuments, paths, loot, validate`) and `skin`
  (`entry, baseItem, materials, paint, wear, workshop`). Changing project kind is only allowed on
  the entry step.
- `validateDraft` derives issues per step. `wizardReducer` refuses `next` while the current step has
  a blocking error, so an invalid state cannot be exported.
- `Studio Mode` is a persisted boolean. It unlocks direct step navigation and the manual tool panels
  (sculpt/paint brushes, transform outliner, topology masks, map lock, channel packing, UV
  diagnostics). Guided steps always remain usable without it.
- `WizardProvider` persists the entire state (including placement and decal lists) to
  `localStorage` so a reload resumes on the same step. In the shell, `save_project` mirrors the
  draft into SQLite and `project.json`.

## 4. Terrain rendering and editing

The browser preview generates a 257² coarse field, uploads it as textures, and displays it through
a custom `ShaderMaterial`:

- `splatA` (channels 0-3) and `splatB` (4-7) are RGBA `DataTexture`s; a weighted palette sum gives
  ground colour. Rust's splat never exceeds eight channels, so two textures are sufficient.
- Biome weights tint the ground independently of the splat.
- The alpha map discards fragments below 0.35, producing actual terrain holes; Studio Mode can show
  them as a red mask.
- The topology layer is packed 32-bit into RGBA. The shader reads the top byte, which holds editor
  overlay bits (24 no-build, 25 monument pad, 26 foliage cleared, 27 path clear, 28 loot, 29 NPC,
  30 safe zone) and mixes an overlay colour. Game bits stay untouched.
- 25 m contour lines give scale without textures.
- Studio sculpting raycasts the terrain and applies the same kernel families as
  `engine/.../terrain.py` (raise, lower, smooth, flatten, splat, topology, alpha). Pointer strokes
  update the preview and geometry, and increment `terrain.sculptStrokes`.
- On export, Python regenerates the full-resolution layers from the seed and settings, then applies
  monument pads: `HeightField.flatten_pad` for the footprint and smooth falloff, plus topology marks
  for foliage clearing and no-build volumes.

## 5. Skin rendering and decal projection

`SkinViewport` uses ACES tone mapping, a generated room environment and four lighting presets
(day, dusk, flashlight, night). Materials are `MeshStandardMaterial` instances with two
`onBeforeCompile` injections:

1. **Projected decals.** A projector matrix is captured from the camera (or, when painting, from an
   orthographic camera aligned to the hit normal). The fragment transforms the world position into
   projector space, samples the stamp, and blends by stamp alpha, stroke opacity and a grazing-angle
   fade. Because the lookup is world-space, UV seams and island stretching cannot distort stencils.
2. **Procedural wear.** Fresnel edge wear, world-space grain, a height-based dirt band and roughness
   modulation. These are the same masks the exporter bakes into the diffuse/specular PNGs.

Layer presets (`metal`, `polymer`, `wood`, `carbon`, custom) drive base colour, metalness and
smoothness. Texture uploads are local files only. Workshop export validates 1024/2048 px and writes
`_diffuse.png` (albedo + baked stencils), `_normal.png` (tangent space), `_specular.png`
(smoothness) and `_emission.png`.

## 6. Database

`db/schema.sql` contains 25 tables plus a FTS5 index:

- **Assets:** `asset_packs`, `base_meshes`, `prefabs`, `prefab_bounds`, `source_maps`.
- **Skin inputs:** `material_presets`.
- **Projects:** `projects`, `project_wizard_state`, `project_terrain`, `project_prefabs`,
  `project_paths`, `project_skins`, `texture_exports`, `project_snapshots`.
- **Sync:** `sync_profiles`, `sync_metadata`, `sync_queue`, `sync_tombstones`.
- **Search/meta:** `asset_search` (FTS5), `app_settings`, `schema_meta`.

Terrain layers in `project_terrain` are compressed blobs. Prefab placements form a parent/child
tree for the outliner. Every project row carries `wizard_phase` and `studio_mode`, so reopening a
project restores the exact editing context.

Prefab geometry is indexed from `.prefab` containers where possible and from a metadata manifest
otherwise. `prefab_id` is `u32_le(MD5(lowercase(asset_path))[0..4])`, matching Rust's asset ids.

## 7. Offline-first sync protocol

```
save -> projects.updated_at, local_revision += 1, state = pending
     -> sync_queue(operation = push, state = queued)

worker: claim queued due rows -> inflight
        success -> done, sync_metadata.state = synced, store remote etag/revision
        failure -> queued with delay = min(3600, 5 * 2^(attempts-1)), state = error
                   after 8 attempts -> failed (manual retry)

pull: remote_revision > previous_remote + local dirty -> conflict
      remote_revision > previous_remote + local clean -> fast_forward
      otherwise -> local_wins (enqueue push)
```

Unique partial indexes prevent duplicate outstanding pushes per entity. Tombstones stop a remote
pull from resurrecting a locally deleted project. Asset packs use the same queue, so custom
monuments and mesh packs travel with the project.

## 8. Security boundaries

- Tauri window uses a restrictive CSP with IPC/asset allowances only.
- Custom commands are the only privileged surface; no arbitrary shell plugin is exposed to the UI.
- The optional FastAPI sidecar defaults to loopback, prints a per-run token, and rejects requests
  without `X-Studio-Token` when `STUDIO_SIDECAR_TOKEN` is set.
- Sync credentials live in the OS keyring; the database stores only `token_ref`.
- Export never writes the map password into the map. `mapLock` is recorded as metadata; the
  password stays in project storage.

## 9. Extension points

- `world-codec` can gain a real LZ4 block compressor; the container API does not change.
- `PrefabBounds`/`volume_kind` already models triggers, no-build, safe-zone, radiation and spawn
  volumes; the viewport can render them from the same rows.
- `project_prefabs.data_json` and `project_paths.nodes_json` are the serialization seam for
  RustEdit IO entities and loot profiles once their private schema is available.
- Spline ribbons are generated in `engine/.../spline.py` (positions, normals, UVs, indices) and can
  be uploaded directly to Three.js `BufferGeometry` for higher-fidelity road meshes.
