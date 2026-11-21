-- Rust Studio local index and project store
-- SQLite 3.35+ (JSON1 + FTS5). Applied by engine/koba_engine/indexer/db.py
-- (PRAGMA user_version is managed by the migrations in that module; this file is
-- the canonical v1 shape and is safe to re-apply because every object is IF NOT EXISTS).

PRAGMA foreign_keys = ON;

----------------------------------------------------------------------------
-- 0. Indexer / sync bookkeeping
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

-- One row per Rust install (or custom asset pack) that was scanned.
CREATE TABLE IF NOT EXISTS asset_packs (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,          -- "rust-client", "custom-monuments"
    root_path       TEXT NOT NULL,                 -- absolute path on disk
    game_version    TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT 'local'
                    CHECK (source IN ('local', 'workshop', 'synced')),
    last_indexed_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

----------------------------------------------------------------------------
-- 1. Base meshes (skin pipeline input: .glb / .obj + UV layout)
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS base_meshes (
    id              INTEGER PRIMARY KEY,
    pack_id         INTEGER NOT NULL REFERENCES asset_packs(id) ON DELETE CASCADE,
    asset_path      TEXT NOT NULL,                 -- path relative to pack root
    name            TEXT NOT NULL,
    item_kind       TEXT NOT NULL DEFAULT 'deployable'
                    CHECK (item_kind IN ('weapon', 'attire', 'deployable', 'misc')),
    mesh_format     TEXT NOT NULL
                    CHECK (mesh_format IN ('glb', 'gltf', 'obj', 'fbx')),
    file_hash       TEXT NOT NULL,                 -- sha256 of the source file
    file_bytes      INTEGER NOT NULL DEFAULT 0,
    triangle_count  INTEGER NOT NULL DEFAULT 0,
    vertex_count    INTEGER NOT NULL DEFAULT 0,
    uv_channel_count INTEGER NOT NULL DEFAULT 1,
    has_tangents    INTEGER NOT NULL DEFAULT 0 CHECK (has_tangents IN (0, 1)),
    -- Local-space AABB, used for framing the viewport and thumbnail camera.
    bounds_min_x    REAL NOT NULL DEFAULT 0,
    bounds_min_y    REAL NOT NULL DEFAULT 0,
    bounds_min_z    REAL NOT NULL DEFAULT 0,
    bounds_max_x    REAL NOT NULL DEFAULT 0,
    bounds_max_y    REAL NOT NULL DEFAULT 0,
    bounds_max_z    REAL NOT NULL DEFAULT 0,
    thumbnail_path  TEXT,                          -- workspace-relative PNG path
    metadata_json   TEXT NOT NULL DEFAULT '{}',    -- material slots, skeleton, rust item ids
    indexed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (pack_id, asset_path)
);

CREATE INDEX IF NOT EXISTS idx_base_meshes_kind ON base_meshes (item_kind, name);
CREATE INDEX IF NOT EXISTS idx_base_meshes_hash ON base_meshes (file_hash);

----------------------------------------------------------------------------
-- 2. Rust prefabs (map pipeline input: monuments, decor, deployables)
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS prefabs (
    id                  INTEGER PRIMARY KEY,
    pack_id             INTEGER NOT NULL REFERENCES asset_packs(id) ON DELETE CASCADE,
    asset_path          TEXT NOT NULL,             -- "assets/bundled/prefabs/autospawn/..."
    name                TEXT NOT NULL,
    category            TEXT NOT NULL               -- Monument, Decor, Building, Vehicle, ...
                        CHECK (category IN ('Monument', 'Decor', 'Building', 'Vehicle',
                                            'Entity', 'Terrain', 'Path', 'Other')),
    -- Rust prefab ids are uint32(MD5(lowercase(asset_path))[0..4]); kept signed
    -- because the game serializes them as int32.
    prefab_id           INTEGER,
    file_hash           TEXT NOT NULL DEFAULT '',
    -- Union AABB of every collider (world units, prefab-local space).
    bounds_min_x        REAL NOT NULL DEFAULT 0,
    bounds_min_y        REAL NOT NULL DEFAULT 0,
    bounds_min_z        REAL NOT NULL DEFAULT 0,
    bounds_max_x        REAL NOT NULL DEFAULT 0,
    bounds_max_y        REAL NOT NULL DEFAULT 0,
    bounds_max_z        REAL NOT NULL DEFAULT 0,
    -- Footprint used by the monument step for automatic terrain flattening.
    flatten_radius      REAL NOT NULL DEFAULT 0,
    flatten_depth       REAL NOT NULL DEFAULT 0,
    -- Serialized Rust prefab modifiers / entity data (JSON, opaque to the index).
    modifiers_json      TEXT NOT NULL DEFAULT '{}',
    has_loot            INTEGER NOT NULL DEFAULT 0 CHECK (has_loot IN (0, 1)),
    has_io              INTEGER NOT NULL DEFAULT 0 CHECK (has_io IN (0, 1)),
    has_npc             INTEGER NOT NULL DEFAULT 0 CHECK (has_npc IN (0, 1)),
    thumbnail_path      TEXT,
    indexed_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (pack_id, asset_path)
);

CREATE INDEX IF NOT EXISTS idx_prefabs_category ON prefabs (category, name);
CREATE INDEX IF NOT EXISTS idx_prefabs_game_id ON prefabs (prefab_id);

-- A prefab can own many colliders, triggers and no-build volumes.
CREATE TABLE IF NOT EXISTS prefab_bounds (
    id              INTEGER PRIMARY KEY,
    prefab_row_id   INTEGER NOT NULL REFERENCES prefabs(id) ON DELETE CASCADE,
    collider_index  INTEGER NOT NULL,
    shape           TEXT NOT NULL DEFAULT 'box'
                    CHECK (shape IN ('box', 'sphere', 'capsule', 'mesh', 'terrain')),
    center_x        REAL NOT NULL DEFAULT 0,
    center_y        REAL NOT NULL DEFAULT 0,
    center_z        REAL NOT NULL DEFAULT 0,
    extents_x       REAL NOT NULL DEFAULT 0,
    extents_y       REAL NOT NULL DEFAULT 0,
    extents_z       REAL NOT NULL DEFAULT 0,
    is_trigger      INTEGER NOT NULL DEFAULT 0 CHECK (is_trigger IN (0, 1)),
    -- Building privilege / no-build / safe-zone style volumes are marked here so
    -- the validation step can render them without re-parsing prefab data.
    volume_kind     TEXT NOT NULL DEFAULT 'collider'
                    CHECK (volume_kind IN ('collider', 'trigger', 'no_build',
                                           'safe_zone', 'radiation', 'spawn')),
    UNIQUE (prefab_row_id, collider_index)
);

-- Source .map files found on disk, browsable when starting a project.
CREATE TABLE IF NOT EXISTS source_maps (
    id               INTEGER PRIMARY KEY,
    pack_id          INTEGER NOT NULL REFERENCES asset_packs(id) ON DELETE CASCADE,
    asset_path       TEXT NOT NULL,
    name             TEXT NOT NULL,
    size_metres      INTEGER,
    height_resolution INTEGER,
    prefab_count     INTEGER NOT NULL DEFAULT 0,
    path_count       INTEGER NOT NULL DEFAULT 0,
    version          INTEGER,
    file_hash        TEXT NOT NULL,
    file_bytes       INTEGER NOT NULL DEFAULT 0,
    thumbnail_path   TEXT,
    indexed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (pack_id, asset_path)
);

CREATE INDEX IF NOT EXISTS idx_source_maps_size ON source_maps (size_metres, name);

----------------------------------------------------------------------------
-- 2b. Unity AssetBundles found inside a Rust install
----------------------------------------------------------------------------

-- One row per UnityFS archive. The bundle itself is never copied: only its
-- header, container paths and object inventory are recorded.
CREATE TABLE IF NOT EXISTS bundles (
    id                  INTEGER PRIMARY KEY,
    pack_id             INTEGER NOT NULL REFERENCES asset_packs(id) ON DELETE CASCADE,
    path                TEXT NOT NULL,             -- relative to asset_packs.root_path
    name                TEXT NOT NULL,             -- file name, e.g. content.bundle
    file_bytes          INTEGER NOT NULL DEFAULT 0,
    file_mtime          REAL NOT NULL DEFAULT 0,
    unity_version       TEXT NOT NULL DEFAULT '',
    unity_revision      TEXT NOT NULL DEFAULT '',
    compression         TEXT NOT NULL DEFAULT 'unknown',
    flags               INTEGER NOT NULL DEFAULT 0,
    block_count         INTEGER NOT NULL DEFAULT 0,
    node_count          INTEGER NOT NULL DEFAULT 0,
    container_count     INTEGER NOT NULL DEFAULT 0,
    object_counts_json  TEXT NOT NULL DEFAULT '{}',
    -- Prefab paths imported from the GameManifest. -1 means the bundle has not
    -- been inspected for one yet, so the cache cannot skip it.
    manifest_prefab_count INTEGER NOT NULL DEFAULT -1,
    indexed_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (pack_id, path)
);

-- Individual objects inside a bundle (Mesh, Texture2D, GameObject, ...).
-- ``container_path`` is the AssetBundle lookup path when the build exposes
-- one; those are the paths Rust serializes into .map files.
CREATE TABLE IF NOT EXISTS bundle_assets (
    id              INTEGER PRIMARY KEY,
    bundle_id       INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    source_file     TEXT NOT NULL DEFAULT '',      -- serialized file / CAB name
    object_type     TEXT NOT NULL,                 -- Unity class name
    path_id         INTEGER NOT NULL,              -- int64 serialized path id
    name            TEXT NOT NULL,
    asset_kind      TEXT NOT NULL DEFAULT 'other', -- mesh, texture, prefab, ...
    container_path  TEXT,
    extracted_path  TEXT,                          -- PNG/OBJ written by the importer
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    indexed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (bundle_id, source_file, object_type, path_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_assets_kind ON bundle_assets (asset_kind, name);
CREATE INDEX IF NOT EXISTS idx_bundle_assets_container ON bundle_assets (container_path);

----------------------------------------------------------------------------
-- 3. Material presets used by the skin pipeline
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS material_presets (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    family      TEXT NOT NULL
                CHECK (family IN ('metal', 'polymer', 'wood', 'carbon', 'fabric', 'custom')),
    params_json TEXT NOT NULL DEFAULT '{}',   -- PBR + procedural layer stack defaults
    is_builtin  INTEGER NOT NULL DEFAULT 1 CHECK (is_builtin IN (0, 1))
);

----------------------------------------------------------------------------
-- 4. Projects (unified map / monument / skin saves) and sync metadata
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
    id                      TEXT PRIMARY KEY,          -- UUID v4, also the folder name
    name                    TEXT NOT NULL,
    kind                    TEXT NOT NULL
                            CHECK (kind IN ('map', 'monument', 'skin')),
    -- Terrains are maps, monuments are prefabs, skins are texture sets.
    export_target           TEXT NOT NULL
                            CHECK (export_target IN ('map', 'prefab', 'skin')),
    base_mesh_id            INTEGER REFERENCES base_meshes(id) ON DELETE SET NULL,
    schema_version          INTEGER NOT NULL DEFAULT 1,
    workspace_path          TEXT NOT NULL,             -- relative to the data root
    -- Authoritative wizard cursor, so a project reopens on the same step.
    wizard_phase            TEXT NOT NULL DEFAULT 'terrain'
                            CHECK (wizard_phase IN ('terrain', 'monuments', 'paths',
                                                    'loot', 'validate', 'base_item',
                                                    'materials', 'paint', 'wear',
                                                    'workshop', 'export')),
    wizard_step_index       INTEGER NOT NULL DEFAULT 0,
    studio_mode             INTEGER NOT NULL DEFAULT 0 CHECK (studio_mode IN (0, 1)),
    is_dirty                INTEGER NOT NULL DEFAULT 1 CHECK (is_dirty IN (0, 1)),
    thumbnail_path          TEXT,
    map_size                INTEGER,                   -- metres, map/monument only
    map_resolution          INTEGER,                   -- heightmap res (e.g. 4097)
    seed                    INTEGER,                   -- procedural terrain seed
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_exported_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_kind ON projects (kind, updated_at DESC);

-- Persisted wizard state machine snapshot (single source for resume).
CREATE TABLE IF NOT EXISTS project_wizard_state (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    state_json  TEXT NOT NULL,                 -- serialized wizard context
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Compressed terrain layers, straight from / into WorldSerialization.
CREATE TABLE IF NOT EXISTS project_terrain (
    project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    size_metres     REAL NOT NULL DEFAULT 4500,
    height_res      INTEGER NOT NULL DEFAULT 4097,
    splat_res       INTEGER NOT NULL DEFAULT 2048,
    water_level     REAL NOT NULL DEFAULT 0,
    -- zlib-compressed little-endian arrays (height: uint16, splat: u8*8, etc).
    height_blob     BLOB,
    water_blob      BLOB,
    splat_blob      BLOB,
    biome_blob      BLOB,
    topology_blob   BLOB,                      -- uint32 bitmask per texel
    alpha_blob      BLOB,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Placement records for map/monument projects (outliner + validation input).
CREATE TABLE IF NOT EXISTS project_prefabs (
    id              INTEGER PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prefab_row_id   INTEGER REFERENCES prefabs(id) ON DELETE SET NULL,
    parent_id       INTEGER REFERENCES project_prefabs(id) ON DELETE CASCADE,
    display_name    TEXT NOT NULL,
    position_x      REAL NOT NULL DEFAULT 0,
    position_y      REAL NOT NULL DEFAULT 0,
    position_z      REAL NOT NULL DEFAULT 0,
    rotation_x      REAL NOT NULL DEFAULT 0,
    rotation_y      REAL NOT NULL DEFAULT 0,
    rotation_z      REAL NOT NULL DEFAULT 0,
    rotation_w      REAL NOT NULL DEFAULT 1,
    scale_x         REAL NOT NULL DEFAULT 1,
    scale_y         REAL NOT NULL DEFAULT 1,
    scale_z         REAL NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    -- Per-instance settings: loot profiles, IO wiring, NPC, vending, card puzzle.
    data_json       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_project_prefabs_project ON project_prefabs (project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_project_prefabs_parent ON project_prefabs (parent_id);

-- Roads / rivers / rails / APC / cargo splines.
CREATE TABLE IF NOT EXISTS project_paths (
    id              INTEGER PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL
                    CHECK (kind IN ('road', 'river', 'rail', 'apc', 'cargo',
                                    'powerline', 'custom')),
    name            TEXT NOT NULL,
    width           REAL NOT NULL DEFAULT 6,
    splat_index     INTEGER NOT NULL DEFAULT 0,
    topology_mask   INTEGER NOT NULL DEFAULT 0,
    closed          INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
    nodes_json      TEXT NOT NULL DEFAULT '[]'   -- [{x,y,z,normal,angle}]
);

CREATE INDEX IF NOT EXISTS idx_project_paths_project ON project_paths (project_id, kind);

-- Skin-specific project data: resolution, layer stack, wear and light checks.
CREATE TABLE IF NOT EXISTS project_skins (
    project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    resolution      INTEGER NOT NULL DEFAULT 2048
                    CHECK (resolution IN (1024, 2048)),
    layer_stack_json TEXT NOT NULL DEFAULT '[]',   -- smart materials + decals order
    wear_json       TEXT NOT NULL DEFAULT '{}',
    lighting_json   TEXT NOT NULL DEFAULT '{}'     -- enabled preview environments
);

CREATE TABLE IF NOT EXISTS texture_exports (
    id              INTEGER PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL
                    CHECK (channel IN ('diffuse', 'normal', 'specular', 'emission', 'mask')),
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    file_path       TEXT NOT NULL,
    checksum        TEXT NOT NULL DEFAULT '',
    exported_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, channel)
);

-- Named local snapshots (undo history checkpoints the user made explicit).
CREATE TABLE IF NOT EXISTS project_snapshots (
    id          INTEGER PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    state_json  TEXT NOT NULL,
    byte_size   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

----------------------------------------------------------------------------
-- 5. Offline / online sync
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_profiles (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    endpoint        TEXT NOT NULL,                 -- https://sync.example.net
    account_ref     TEXT NOT NULL DEFAULT '',      -- opaque remote account id
    -- Tokens are NOT stored here: token_ref points into the OS keyring.
    token_ref       TEXT NOT NULL DEFAULT 'keyring:rust-studio/sync',
    is_active       INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    last_sync_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per synced entity (project or asset pack). Drives conflict resolution.
CREATE TABLE IF NOT EXISTS sync_metadata (
    id                  INTEGER PRIMARY KEY,
    profile_id          INTEGER NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
    entity_type         TEXT NOT NULL
                        CHECK (entity_type IN ('project', 'asset_pack', 'asset')),
    entity_id           TEXT NOT NULL,             -- projects.id or asset_packs.id as text
    remote_id           TEXT,
    remote_etag         TEXT,
    remote_updated_at   TEXT,
    local_revision      INTEGER NOT NULL DEFAULT 0,
    remote_revision     INTEGER,
    last_synced_at      TEXT,
    state               TEXT NOT NULL DEFAULT 'local_only'
                        CHECK (state IN ('local_only', 'pending', 'syncing',
                                         'synced', 'conflict', 'error')),
    error_message       TEXT,
    UNIQUE (profile_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_metadata_state ON sync_metadata (profile_id, state);

-- Durable outbox. The worker drains this when connectivity returns; failures
-- back off via next_attempt_at instead of being dropped.
CREATE TABLE IF NOT EXISTS sync_queue (
    id              INTEGER PRIMARY KEY,
    profile_id      INTEGER NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL
                    CHECK (entity_type IN ('project', 'asset_pack', 'asset')),
    entity_id       TEXT NOT NULL,
    operation       TEXT NOT NULL
                    CHECK (operation IN ('push', 'pull', 'delete')),
    payload_path    TEXT,                          -- local bundle path to upload
    payload_hash    TEXT NOT NULL DEFAULT '',
    state           TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued', 'inflight', 'done', 'failed', 'cancelled')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_ready ON sync_queue (profile_id, state, next_attempt_at);
-- At most one outstanding push per entity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_queue_single_push
    ON sync_queue (profile_id, entity_type, entity_id, operation)
    WHERE state IN ('queued', 'inflight');

-- Applied remote deletions so a pull cannot resurrect a project the user deleted.
CREATE TABLE IF NOT EXISTS sync_tombstones (
    id          INTEGER PRIMARY KEY,
    profile_id  INTEGER NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'asset_pack', 'asset')),
    entity_id   TEXT NOT NULL,
    deleted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (profile_id, entity_type, entity_id)
);

----------------------------------------------------------------------------
-- 6. Settings and search
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS asset_search USING fts5(
    entity_type UNINDEXED,
    entity_id UNINDEXED,
    name,
    asset_path,
    tokenize = 'unicode61'
);

----------------------------------------------------------------------------
-- 7. Triggers
----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_projects_touch_updated
AFTER UPDATE OF name, wizard_phase, wizard_step_index, studio_mode, is_dirty ON projects
BEGIN
    UPDATE projects
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_wizard_touch
AFTER UPDATE ON project_wizard_state
BEGIN
    UPDATE project_wizard_state
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE project_id = NEW.project_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_queue_touch
AFTER UPDATE ON sync_queue
BEGIN
    UPDATE sync_queue
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_remove_search
AFTER DELETE ON projects
BEGIN
    DELETE FROM asset_search
     WHERE entity_type = 'project' AND entity_id = OLD.id;
END;

----------------------------------------------------------------------------
-- 8. Built-in material presets
----------------------------------------------------------------------------

INSERT OR IGNORE INTO material_presets (name, family, params_json) VALUES
    ('Bare Metal',      'metal',   '{"metallic":0.95,"smoothness":0.55,"baseColor":"#8c9196","scratches":0.35}'),
    ('Painted Metal',   'metal',   '{"metallic":0.85,"smoothness":0.45,"baseColor":"#3f4a52","scratches":0.5}'),
    ('Polymer Matte',   'polymer', '{"metallic":0.0,"smoothness":0.22,"baseColor":"#22262b","scratches":0.2}'),
    ('Wood Laminate',   'wood',    '{"metallic":0.0,"smoothness":0.3,"baseColor":"#6d4a2f","grain":0.6}'),
    ('Carbon Fiber',    'carbon',  '{"metallic":0.1,"smoothness":0.65,"baseColor":"#141618","weave":0.8}'),
    ('Canvas Fabric',   'fabric',  '{"metallic":0.0,"smoothness":0.12,"baseColor":"#4b5240","weave":0.4}');
