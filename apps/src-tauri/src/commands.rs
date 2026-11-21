use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use world_codec::{parse_file, WorldSummary};

use crate::tasks::{TaskManager, TaskStatus};

pub struct AppState {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub engine_dir: PathBuf,
    pub project_root: PathBuf,
    pub tasks: TaskManager,
    /// Encoded data URLs keyed by resolved path + file identity. Material slots
    /// reuse the same PNG without re-reading or base64-encoding it every time.
    pub texture_cache: std::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
    /// File-name index over the saved asset roots, so catalogue paths that went
    /// stale when the user reorganised their unpacked packs still resolve.
    pub local_paths: std::sync::Mutex<Option<LocalPathIndex>>,
}

/// Every file under the saved asset roots, keyed by lower-case file name.
///
/// The catalogue stores absolute paths, and an unpacked pack is routinely moved
/// (an export made inside `KOBAedit2/KOBAedit1/` later lives in `KOBAedit1/`).
/// The rows then point at files that no longer exist even though the same GLB is
/// on disk, and the viewport shows proxy boxes instead of real prefab geometry.
#[derive(Default)]
pub struct LocalPathIndex {
    roots: Vec<String>,
    files: std::collections::HashMap<String, Vec<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub packs: i64,
    pub base_meshes: i64,
    pub prefabs: i64,
    pub projects: i64,
    pub queued_sync: i64,
    pub indexed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds3 {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefabAssetRow {
    pub id: String,
    pub name: String,
    pub category: String,
    pub bounds: Bounds3,
    pub flatten_radius: f64,
    pub has_loot: bool,
    pub has_io: bool,
    pub has_npc: bool,
    pub thumbnail_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseMeshRow {
    pub id: String,
    pub name: String,
    pub item_kind: String,
    pub uv_channels: i64,
    pub triangles: i64,
    pub has_tangents: bool,
    pub material_slots: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseMeshPage {
    pub rows: Vec<BaseMeshRow>,
    pub total: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResponse {
    pub file: String,
    #[serde(flatten)]
    pub summary: WorldSummary,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub kind: String,
    pub path: String,
    pub bytes: u64,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaReceipt {
    pub path: String,
    pub bytes: u64,
    pub operations: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub active: bool,
    pub pending: i64,
    pub conflicts: i64,
    pub last_sync_at: Option<String>,
    pub endpoint: Option<String>,
    pub profile: Option<String>,
    pub token_saved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResult {
    pub ok: bool,
    pub conflict: bool,
    pub revision: Option<i64>,
    pub etag: Option<String>,
    pub updated_at: Option<String>,
    pub draft: Option<Value>,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResult {
    pub decision: String,
    pub revision: Option<i64>,
    pub updated_at: Option<String>,
    pub draft: Option<Value>,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResolveResult {
    pub action: String,
    pub draft: Option<Value>,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IngestSummary {
    pub meshes: i64,
    pub prefabs: i64,
    pub maps: i64,
    pub thumbnails: i64,
    pub skipped: i64,
    pub errors: Vec<String>,
}

pub fn initialize(state: &AppState) -> Result<(), String> {
    std::fs::create_dir_all(&state.data_dir).map_err(|error| error.to_string())?;
    let schema_path = state.project_root.join("db").join("schema.sql");
    let schema = std::fs::read_to_string(&schema_path)
        .map_err(|error| format!("read {}: {error}", schema_path.display()))?;
    let connection = Connection::open(&state.db_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(&schema)
        .map_err(|error| format!("apply schema: {error}"))?;
    // The local catalogue is created by the Python scanner, not db/schema.sql.
    // Add newer columns in place so an already-indexed 30k-row catalogue does
    // not need a full rescan before grouped queries can sum triangles.
    let local_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='local_assets'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if local_table > 0 {
        // Re-point catalogue rows whose recorded path was invalidated by moving
        // the unpacked packs. This runs before the first query of the session so
        // pickers and mesh loads hand out paths that exist.
        let mut roots = asset_roots_for(&connection);
        if roots.is_empty() {
            if let Ok(mut statement) = connection.prepare("SELECT DISTINCT root_path FROM local_assets") {
                if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
                    roots = rows.flatten().filter(|root| Path::new(root).is_dir()).collect();
                }
            }
        }
        if !roots.is_empty() {
            let index = build_local_path_index(&roots);
            let repair = repair_local_paths(&connection, &index);
            if repair.repaired > 0 {
                eprintln!(
                    "[index] re-pointed {} of {} stale asset paths ({} unresolved)",
                    repair.repaired, repair.checked, repair.missing
                );
            }
        }
        let has_triangles = connection
            .prepare("PRAGMA table_info(local_assets)")
            .and_then(|mut statement| {
                let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
                Ok(rows.flatten().any(|name| name == "triangles"))
            })
            .unwrap_or(false);
        if !has_triangles {
            let _ = connection.execute(
                "ALTER TABLE local_assets ADD COLUMN triangles INTEGER NOT NULL DEFAULT 0",
                [],
            );
        }
    }
    Ok(())
}

fn open(state: &AppState) -> Result<Connection, String> {
    let connection = Connection::open(&state.db_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(|error| error.to_string())?;
    // Grouped catalogue joins compare base_meshes' project-relative path with
    // local_assets.rel_path; without these indexes every picker page scans 30k
    // rows. IF NOT EXISTS keeps the first call cheap afterwards.
    let _ = connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS base_meshes_path ON base_meshes(asset_path);
         CREATE INDEX IF NOT EXISTS local_assets_rel_path ON local_assets(category, rel_path);
         CREATE INDEX IF NOT EXISTS local_assets_asset_path ON local_assets(asset_path);",
    );
    Ok(connection)
}

/// Resolve the interpreter that has the engine's dependencies.
///
/// The workspace's `.venv` is authoritative here: the system `python3` often
/// lacks UnityPy/Pillow, which is what makes extraction and monument previews
/// fail. `RUST_STUDIO_PYTHON` still wins when it is set explicitly.
pub(crate) fn python(project_root: &Path) -> PathBuf {
    if let Some(value) = std::env::var_os("RUST_STUDIO_PYTHON") {
        return PathBuf::from(value);
    }
    for candidate in [project_root.join(".venv/bin/python"), project_root.join("engine/.venv/bin/python")] {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("python3")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub struct StartupSnapshot {
    pub bundles: i64,
    pub engine: bool,
}

/// Cheap facts the splash window reports while the index is being prepared. It
/// never fails: a missing database or folder just reports zero.
pub fn startup_snapshot(state: &AppState) -> StartupSnapshot {
    let bundles = Connection::open(&state.db_path)
        .ok()
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT value FROM app_settings WHERE key = 'linked_bundle_root'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .filter(|root| Path::new(root).is_dir())
        .map(|root| {
            std::fs::read_dir(root)
                .map(|entries| {
                    entries
                        .flatten()
                        .filter(|entry| {
                            entry
                                .path()
                                .extension()
                                .is_some_and(|extension| extension == "bundle")
                        })
                        .count() as i64
                })
                .unwrap_or(0)
        })
        .unwrap_or(0);
    StartupSnapshot {
        bundles,
        engine: state.engine_dir.join("koba_engine").is_dir(),
    }
}

#[tauri::command]
pub fn index_stats(state: State<'_, AppState>) -> Result<IndexStats, String> {
    let connection = open(&state)?;
    let count = |table: &str| -> Result<i64, String> {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .map_err(|error| error.to_string())
    };
    let packs = count("asset_packs")?;
    let local_assets = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='local_assets'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    let local_count = if local_assets > 0 {
        count("local_assets").unwrap_or(0)
    } else {
        0
    };
    Ok(IndexStats {
        packs,
        base_meshes: count("base_meshes")?,
        prefabs: count("prefabs")?,
        projects: count("projects")?,
        queued_sync: connection
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE state IN ('queued','inflight')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?,
        indexed: packs > 0 || local_count > 0,
    })
}

#[tauri::command]
pub fn list_prefabs(state: State<'_, AppState>) -> Result<Vec<PrefabAssetRow>, String> {
    let connection = open(&state)?;
    prefab_rows(&connection)
}

/// One page of prefabs plus the counts a browser needs for its chips.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefabPage {
    pub rows: Vec<PrefabAssetRow>,
    pub total: i64,
    pub bounded: i64,
    pub counts: std::collections::BTreeMap<String, i64>,
}

const PREFAB_PAGE_DEFAULT: u32 = 300;
const PREFAB_PAGE_MAX: u32 = 20_000;

/// Filtered prefab page. The full catalogue is ~17.5k rows (over 5 MB of JSON),
/// so the drawer asks for one category/query page instead of the whole index.
#[tauri::command]
pub fn browse_prefabs(
    state: State<'_, AppState>,
    category: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<PrefabPage, String> {
    let connection = open(&state)?;
    browse_prefabs_query(&connection, category, query, limit, offset)
}

fn browse_prefabs_query(
    connection: &Connection,
    category: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<PrefabPage, String> {
    let limit = limit.unwrap_or(PREFAB_PAGE_DEFAULT).clamp(1, PREFAB_PAGE_MAX);
    let offset = offset.unwrap_or(0);
    let category = category.filter(|value| !value.trim().is_empty() && value != "All");
    let query = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let pattern = query.as_ref().map(|value| format!("%{value}%"));

    let where_sql = "WHERE (?1 IS NULL OR category = ?1)
                        AND (?2 IS NULL OR lower(name) LIKE ?2 OR lower(asset_path) LIKE ?2)";
    let bounds_sql = "(bounds_max_x > bounds_min_x OR bounds_max_y > bounds_min_y OR bounds_max_z > bounds_min_z)";

    let total: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM prefabs {where_sql}"),
            params![category, pattern],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let bounded: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM prefabs {where_sql} AND {bounds_sql}"),
            params![category, pattern],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let counts = {
        let mut statement = connection
            .prepare(
                "SELECT category, COUNT(*) FROM prefabs
                  WHERE (?1 IS NULL OR lower(name) LIKE ?1 OR lower(asset_path) LIKE ?1)
                  GROUP BY category",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![pattern], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut result = std::collections::BTreeMap::new();
        for row in rows {
            let (name, count) = row.map_err(|error| error.to_string())?;
            result.insert(name, count);
        }
        result
    };

    let mut statement = connection
        .prepare(&format!(
            "SELECT asset_path, name, category, bounds_min_x, bounds_min_y, bounds_min_z,
                    bounds_max_x, bounds_max_y, bounds_max_z, flatten_radius,
                    has_loot, has_io, has_npc, thumbnail_path
               FROM prefabs {where_sql}
              ORDER BY category, name LIMIT ?3 OFFSET ?4"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![category, pattern, limit, offset], prefab_row)
        .map_err(|error| error.to_string())?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(PrefabPage { rows, total, bounded, counts })
}

fn prefab_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrefabAssetRow> {
    Ok(PrefabAssetRow {
        id: row.get(0)?,
        name: row.get(1)?,
        category: row.get(2)?,
        bounds: Bounds3 {
            min: [row.get(3)?, row.get(4)?, row.get(5)?],
            max: [row.get(6)?, row.get(7)?, row.get(8)?],
        },
        flatten_radius: row.get(9)?,
        has_loot: row.get::<_, i64>(10)? != 0,
        has_io: row.get::<_, i64>(11)? != 0,
        has_npc: row.get::<_, i64>(12)? != 0,
        thumbnail_path: row.get(13)?,
    })
}

/// Bundles folder the user linked. Stored in the project database so a fresh
/// webview profile still finds it; falls back to the indexed pack root.
#[tauri::command]
pub fn linked_bundle_root(state: State<'_, AppState>) -> Result<String, String> {
    let connection = open(&state)?;
    if let Ok(stored) = connection.query_row(
        "SELECT value FROM app_settings WHERE key = 'linked_bundle_root'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if !stored.trim().is_empty() && Path::new(stored.trim()).is_dir() {
            return Ok(stored);
        }
    }
    if let Ok(root) = connection.query_row(
        "SELECT root_path FROM asset_packs
          WHERE name NOT LIKE '%demo%' AND root_path NOT LIKE '%rust-studio-demo%'
          ORDER BY id DESC LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if Path::new(&root).is_dir() {
            return Ok(root);
        }
    }
    Ok(String::new())
}

#[tauri::command]
pub fn set_linked_bundle_root(state: State<'_, AppState>, root: String) -> Result<(), String> {
    let connection = open(&state)?;
    connection
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('linked_bundle_root', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![root.trim()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn prefab_rows(connection: &Connection) -> Result<Vec<PrefabAssetRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT asset_path, name, category, bounds_min_x, bounds_min_y, bounds_min_z,
                    bounds_max_x, bounds_max_y, bounds_max_z, flatten_radius,
                    has_loot, has_io, has_npc, thumbnail_path
               FROM prefabs ORDER BY category, name LIMIT 20000",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], prefab_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_base_meshes(state: State<'_, AppState>) -> Result<Vec<BaseMeshRow>, String> {
    let connection = open(&state)?;
    base_mesh_rows(&connection)
}

/// One filtered page of base meshes. The local catalogue can hold tens of
/// thousands of GLBs, so the picker searches and pages on the Rust side.
#[tauri::command]
pub fn browse_base_meshes(
    state: State<'_, AppState>,
    query: Option<String>,
    kind: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<BaseMeshPage, String> {
    let connection = open(&state)?;
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let offset = offset.unwrap_or(0).max(0);
    let search = query.unwrap_or_default().trim().to_lowercase();
    let kind = kind.unwrap_or_else(|| "all".into());
    let pattern = format!("%{search}%");
    let total: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM base_meshes
              WHERE (?1 = '' OR lower(name) LIKE ?2 OR lower(asset_path) LIKE ?2)
                AND (?3 = 'all' OR item_kind = ?3)",
            rusqlite::params![search, pattern, kind],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT asset_path, name, item_kind, uv_channel_count, triangle_count,
                    has_tangents, metadata_json
               FROM base_meshes
              WHERE (?1 = '' OR lower(name) LIKE ?2 OR lower(asset_path) LIKE ?2)
                AND (?3 = 'all' OR item_kind = ?3)
              ORDER BY item_kind, name LIMIT ?4 OFFSET ?5",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![search, pattern, kind, limit, offset], |row| {
            let metadata: String = row.get(6)?;
            let material_slots = serde_json::from_str::<Value>(&metadata)
                .ok()
                .and_then(|value| value.get("materialSlots").cloned())
                .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
                .unwrap_or_default();
            Ok(BaseMeshRow {
                id: row.get(0)?,
                name: row.get(1)?,
                item_kind: row.get(2)?,
                uv_channels: row.get(3)?,
                triangles: row.get(4)?,
                has_tangents: row.get::<_, i64>(5)? != 0,
                material_slots,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(BaseMeshPage { rows, total })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshGroupRow {
    pub id: String,
    /// SQL grouping key (`mesh:<stem>`), stable across paged loads.
    pub group_key: String,
    pub name: String,
    pub item_kind: String,
    pub part_count: i64,
    pub triangles: i64,
    pub uv_channels: i64,
    pub has_tangents: bool,
    pub material_slots: Vec<String>,
    pub preview_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshGroupPage {
    pub rows: Vec<MeshGroupRow>,
    pub total: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPartRow {
    pub asset_path: String,
    pub name: String,
    pub part_index: i64,
    pub triangles: i64,
}

/// Grouped mesh picker: one row per explicit `group_key`, or per asset when a
/// mesh has no numbered parts. Grouping happens in SQLite so the 30k catalogue
/// never has to be shipped to the webview.
#[tauri::command]
pub fn browse_mesh_groups(
    state: State<'_, AppState>,
    query: Option<String>,
    kind: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MeshGroupPage, String> {
    let connection = open(&state)?;
    browse_mesh_groups_query(&connection, query, kind, limit, offset)
}

/// The local catalogue has no kind column, so the skins filter classifies by
/// the naming the unpacked packs use (`rifle.ak47`, `attire.burlap.shirt`,
/// `deployable.sandbag`). One fragment drives both the count and the page, so a
/// filtered page can never disagree with its total.
const MESH_KIND_SQL: &str = "CASE
        WHEN name_key LIKE '%rifle%' OR name_key LIKE '%pistol%' OR name_key LIKE '%smg%'
          OR name_key LIKE '%shotgun%' OR name_key LIKE '%lmg%' OR name_key LIKE '%bow%'
          OR name_key LIKE '%crossbow%' OR name_key LIKE '%launcher%'
          OR name_key LIKE '%flamethrower%' OR name_key LIKE '%melee%'
          OR name_key LIKE '%spear%' OR name_key LIKE '%sword%' OR name_key LIKE '%knife%'
          OR name_key LIKE '%grenade%' OR name_key LIKE '%weapon%'
          THEN 'weapon'
        WHEN name_key LIKE '%attire%' OR name_key LIKE '%shirt%' OR name_key LIKE '%pants%'
          OR name_key LIKE '%boots%' OR name_key LIKE '%gloves%' OR name_key LIKE '%helmet%'
          OR name_key LIKE '%hazmat%' OR name_key LIKE '%hoodie%' OR name_key LIKE '%jacket%'
          OR name_key LIKE '%armor%' OR name_key LIKE '%mask%'
          THEN 'attire'
        WHEN name_key LIKE '%deployable%' OR name_key LIKE '%deployed%'
          OR name_key LIKE '%sentry%' OR name_key LIKE '%turret%'
          OR name_key LIKE '%barricade%' OR name_key LIKE '%sandbag%'
          OR name_key LIKE '%generator%' OR name_key LIKE '%trap%'
          THEN 'deployable'
        ELSE 'other' END";

fn browse_mesh_groups_query(
    connection: &Connection,
    query: Option<String>,
    kind: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MeshGroupPage, String> {
    let limit = limit.unwrap_or(50).clamp(1, 100);
    let offset = offset.unwrap_or(0).max(0);
    let search = query.unwrap_or_default().trim().to_lowercase();
    let kind = kind.unwrap_or_else(|| "all".into());
    let total: i64 = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM (
                   SELECT COALESCE(NULLIF(group_key, ''), asset_path) AS group_id
                     FROM local_assets
                    WHERE category = 'mesh'
                      AND lower(name) NOT LIKE '%colbox%'
                      AND lower(asset_path) NOT LIKE '%colbox%'
                      AND (?1 = '' OR name_key LIKE '%' || lower(?1) || '%'
                                    OR lower(asset_path) LIKE '%' || lower(?1) || '%')
                    GROUP BY group_id
                   HAVING ?2 = 'all' OR MAX({MESH_KIND_SQL}) = ?2
                 )"
            ),
            params![search, kind],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT COALESCE(NULLIF(group_key, ''), asset_path) AS group_id,
                    COALESCE(MIN(NULLIF(group_key, '')), MIN(asset_path)) AS group_key,
                    MIN(COALESCE(NULLIF(group_key, ''), name)) AS group_name,
                    COUNT(*) AS part_count,
                    COALESCE(SUM(triangles), 0) AS triangles,
                    COALESCE(
                      MIN(CASE WHEN asset_path LIKE '%PrefabHierarchyObject%' THEN asset_path END),
                      MIN(asset_path)
                    ) AS preview_path,
                    MAX(CASE WHEN asset_path LIKE '%PrefabHierarchyObject%' THEN 1 ELSE 0 END) AS assembled,
                    MAX({MESH_KIND_SQL}) AS item_kind
               FROM local_assets
              WHERE category = 'mesh'
                AND lower(name) NOT LIKE '%colbox%'
                AND lower(asset_path) NOT LIKE '%colbox%'
                AND (?1 = '' OR name_key LIKE '%' || lower(?1) || '%'
                              OR lower(asset_path) LIKE '%' || lower(?1) || '%')
              GROUP BY group_id
             HAVING ?2 = 'all' OR MAX({MESH_KIND_SQL}) = ?2
              ORDER BY assembled DESC, group_key IS NULL, group_key COLLATE NOCASE, group_id
              LIMIT ?3 OFFSET ?4"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![search, kind, limit, offset], |row| {
            let group_id: String = row.get(0)?;
            let group_key: Option<String> = row.get(1)?;
            let raw_name: String = row.get(2)?;
            let part_count: i64 = row.get(3)?;
            let name = raw_name
                .strip_prefix("mesh:")
                .unwrap_or(&raw_name)
                .to_string();
            Ok(MeshGroupRow {
                id: if part_count > 1 {
                    format!("group:{group_id}")
                } else {
                    group_id
                },
                group_key: group_key.unwrap_or_default(),
                name,
                item_kind: row.get(7)?,
                part_count,
                triangles: row.get(4)?,
                uv_channels: 0,
                has_tangents: false,
                material_slots: Vec::new(),
                preview_path: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(MeshGroupPage { rows, total })
}

/// Child parts for one expanded group. Paths are absolute local GLBs so the
/// viewport can load them without another lookup. Collision boxes are indexed
/// for bounds but never offered as paint or placement parts.
#[tauri::command]
pub fn list_group_parts(
    state: State<'_, AppState>,
    group_key: String,
) -> Result<Vec<MeshPartRow>, String> {
    let connection = open(&state)?;
    let key = group_key.strip_prefix("group:").unwrap_or(&group_key);
    let mut statement = connection
        .prepare(
            "SELECT asset_path, name, COALESCE(part_index, 0), COALESCE(triangles, 0)
               FROM local_assets
              WHERE category = 'mesh' AND group_key = ?1
                AND lower(name) NOT LIKE '%colbox%'
                AND lower(asset_path) NOT LIKE '%colbox%'
              ORDER BY COALESCE(part_index, 0), name",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![key], |row| {
            Ok(MeshPartRow {
                asset_path: row.get(0)?,
                name: row.get(1)?,
                part_index: row.get(2)?,
                triangles: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if rows.is_empty() {
        // A single mesh's group id is its absolute path.
        let mut single = connection
            .prepare(
                "SELECT asset_path, name, 0, COALESCE(triangles, 0)
                   FROM local_assets
                  WHERE category='mesh' AND asset_path = ?1
                    AND lower(name) NOT LIKE '%colbox%'
                    AND lower(asset_path) NOT LIKE '%colbox%'",
            )
            .map_err(|error| error.to_string())?;
        return single
            .query_map(params![key], |row| {
                Ok(MeshPartRow {
                    asset_path: row.get(0)?,
                    name: row.get(1)?,
                    part_index: 0,
                    triangles: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string());
    }
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceableMeshPage {
    pub rows: Vec<BaseMeshRow>,
    pub total: i64,
    pub next_cursor: Option<i64>,
}

/// Cursor-paged local GLBs that can be dragged into Map or Monument.
#[tauri::command]
pub fn browse_placeable_meshes(
    state: State<'_, AppState>,
    query: Option<String>,
    cursor: Option<i64>,
    limit: Option<i64>,
) -> Result<PlaceableMeshPage, String> {
    let connection = open(&state)?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = cursor.unwrap_or(0).max(0);
    let search = query.unwrap_or_default().trim().to_lowercase();
    let pattern = format!("%{search}%");
    let total: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM local_assets
              WHERE category = 'mesh'
                AND lower(name) NOT LIKE '%colbox%'
                AND lower(asset_path) NOT LIKE '%colbox%'
                AND (?1 = '' OR name_key LIKE ?2 OR lower(asset_path) LIKE ?2)",
            params![search, pattern],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT asset_path, name, 'mesh', 0, COALESCE(triangles, 0), 0, '{}'
               FROM local_assets
              WHERE category = 'mesh'
                AND lower(name) NOT LIKE '%colbox%'
                AND lower(asset_path) NOT LIKE '%colbox%'
                AND (?1 = '' OR name_key LIKE ?2 OR lower(asset_path) LIKE ?2)
              ORDER BY (asset_path LIKE '%PrefabHierarchyObject%') DESC, name, asset_path
              LIMIT ?3 OFFSET ?4",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![search, pattern, limit, offset], |row| {
            Ok(BaseMeshRow {
                id: row.get(0)?,
                name: row.get(1)?,
                item_kind: "mesh".into(),
                uv_channels: 0,
                triangles: row.get(4)?,
                has_tangents: false,
                material_slots: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let next_cursor = (offset + limit < total).then_some(offset + limit);
    Ok(PlaceableMeshPage { rows, total, next_cursor })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAssetStatus {
    pub roots: Vec<String>,
    pub counts: std::collections::BTreeMap<String, i64>,
    /// Unpacked asset folders found on this machine, so the setup card can
    /// point at them instead of making the user walk the folder tree.
    pub candidates: Vec<String>,
}

const ASSET_MARKERS: [&str; 4] = ["Mesh", "PrefabHierarchyObject", "Sprite", "Texture2D"];

fn has_asset_markers(path: &Path) -> bool {
    ASSET_MARKERS
        .iter()
        .any(|marker| path.join(marker).is_dir())
}

/// Folders that can lead to an unpacked pack. The walk is bounded and only
/// descends into names that look like a pack, so pointing a candidate at a big
/// folder cannot turn detection into a full disk walk.
fn looks_like_pack(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "assets" || name.starts_with("kobaedit") || name == "mesh" || name == "texture2d"
}

fn contains_asset_tree(path: &Path, depth: usize) -> bool {
    if has_asset_markers(path) {
        return true;
    }
    if depth == 0 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    for entry in entries.flatten().take(32) {
        let child = entry.path();
        if !child.is_dir() || !looks_like_pack(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if contains_asset_tree(&child, depth - 1) {
            return true;
        }
    }
    false
}

/// A candidate is offered as-is: scanning is recursive and the saved root then
/// covers every nested path. Offering a narrow `.../Assets` folder from inside a
/// pack left the real meshes outside the root check, so nothing would load.
fn expand_candidate(candidate: &Path) -> Vec<PathBuf> {
    if has_asset_markers(candidate) || contains_asset_tree(candidate, 4) {
        return vec![candidate.to_path_buf()];
    }
    Vec::new()
}

/// Only folders that already hold unpacked asset folders are useful: offering
/// an empty `KOBAedit2` would send the user through the picker for nothing.
fn existing_asset_roots(candidates: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut roots = Vec::new();
    for candidate in candidates {
        for path in expand_candidate(&candidate) {
            let path = std::fs::canonicalize(&path).unwrap_or(path);
            let text = path.to_string_lossy().into_owned();
            if seen.insert(text.clone()) {
                roots.push(text);
            }
        }
    }
    roots
}

/// Locations the indexer checks by default (`default_roots` in
/// index_local_assets.py), reported only when they exist on disk.
fn asset_root_candidates_in(home: &Path) -> Vec<String> {
    let desktop = home.join("Desktop");
    let mut candidates: Vec<PathBuf> = [
        "KOBAedit",
        "KOBAedit1",
        "KOBAedit2",
        "KOBAedit3",
        "KOBAedit4",
        "KOBAeditASSETS",
        "Assets",
    ]
    .into_iter()
    .map(|folder| desktop.join(folder))
    .collect();
    candidates.extend(
        ["KOBAeditASSETS", "Assets"]
            .into_iter()
            .map(|folder| home.join(folder)),
    );
    existing_asset_roots(candidates)
}

fn asset_root_candidates() -> Vec<String> {
    match std::env::var_os("HOME").map(PathBuf::from) {
        Some(home) => asset_root_candidates_in(&home),
        None => Vec::new(),
    }
}

fn same_path(left: &str, right: &str) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    left == right
}

/// Never offer a folder that is already a saved root; the card would just
/// rescan the same catalogue again.
fn offered_candidates(candidates: Vec<String>, roots: &[String]) -> Vec<String> {
    candidates
        .into_iter()
        .filter(|candidate| !roots.iter().any(|root| same_path(root, candidate)))
        .collect()
}

/// Per-category presence for the Asset Setup panel.
#[tauri::command]
pub fn local_asset_status(state: State<'_, AppState>) -> Result<LocalAssetStatus, String> {
    let connection = open(&state)?;
    // A brand-new database has no local catalogue yet. Report an empty index
    // instead of failing the status call, so the setup card can appear.
    let catalogued: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='local_assets'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if catalogued == 0 {
        let roots = asset_roots_for(&connection);
        return Ok(LocalAssetStatus {
            candidates: offered_candidates(asset_root_candidates(), &roots),
            roots,
            counts: std::collections::BTreeMap::new(),
        });
    }
    let mut counts = std::collections::BTreeMap::new();
    let mut statement = connection
        .prepare("SELECT category, COUNT(*) FROM local_assets GROUP BY category")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (category, count) = row.map_err(|error| error.to_string())?;
        counts.insert(category, count);
    }
    let roots = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'asset_roots'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default();
    Ok(LocalAssetStatus {
        candidates: offered_candidates(asset_root_candidates(), &roots),
        roots,
        counts,
    })
}

/// Run the local catalogue scanner. Called after a folder is chosen; the
/// subprocess keeps the webview responsive while 30k+ files are hashed.
#[tauri::command]
pub async fn scan_local_assets(state: State<'_, AppState>) -> Result<String, String> {
    let project_root = state.project_root.clone();
    let engine_dir = state.engine_dir.clone();
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new(crate::commands::python(&project_root))
            .arg(engine_dir.join("scripts").join("index_local_assets.py"))
            .arg("--db")
            .arg(&db_path)
            .arg("--json")
            .current_dir(&project_root)
            .env("PYTHONPATH", &engine_dir)
            .output()
            .map_err(|error| format!("could not start asset scan: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "asset scan failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|error| format!("asset scan task failed: {error}"))?
}

#[tauri::command]
pub fn save_asset_roots(state: State<'_, AppState>, roots: Vec<String>) -> Result<(), String> {
    let connection = open(&state)?;
    connection
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('asset_roots', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![serde_json::to_string(&roots).map_err(|error| error.to_string())?],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Paths are compared after canonicalization for the security check only. The
/// persisted string is never rewritten, so Windows and Linux catalogues keep
/// their original separators and drive letters.
fn asset_roots_for(connection: &Connection) -> Vec<String> {
    connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'asset_roots'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default()
}

fn path_within_asset_roots(roots: &[String], asset_path: &str) -> bool {
    if roots.is_empty() {
        return false;
    }
    let candidate = std::fs::canonicalize(asset_path).unwrap_or_else(|_| PathBuf::from(asset_path));
    roots.iter().any(|root| {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
        candidate.starts_with(root)
    })
}

const INDEX_SKIP_DIRS: [&str; 6] = [
    "node_modules",
    "target",
    ".git",
    "__pycache__",
    ".freebuff",
    ".venv",
];

fn collect_asset_files(dir: &Path, depth: usize, files: &mut std::collections::HashMap<String, Vec<PathBuf>>) {
    if depth > 16 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if INDEX_SKIP_DIRS.iter().any(|skip| name.eq_ignore_ascii_case(skip)) {
                continue;
            }
            collect_asset_files(&entry.path(), depth + 1, files);
        } else if file_type.is_file() {
            files
                .entry(name.to_ascii_lowercase())
                .or_default()
                .push(entry.path());
        }
    }
}

/// Walk the saved roots once. An unpacked pack is tens of thousands of small
/// files, so this is a bounded directory walk rather than a database lookup.
pub fn build_local_path_index(roots: &[String]) -> LocalPathIndex {
    let mut files = std::collections::HashMap::new();
    for root in roots {
        let path = PathBuf::from(root);
        if path.is_dir() {
            collect_asset_files(&path, 0, &mut files);
        }
    }
    LocalPathIndex {
        roots: roots.to_vec(),
        files,
    }
}

fn trailing_component_matches(candidate: &Path, recorded: &Path) -> usize {
    let left: Vec<String> = candidate
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    let right: Vec<String> = recorded
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    let mut count = 0;
    while count < left.len()
        && count < right.len()
        && left[left.len() - 1 - count] == right[right.len() - 1 - count]
    {
        count += 1;
    }
    count
}

/// Re-point one recorded path at the same file under the current roots.
///
/// Several packs can ship an identically named GLB, so the candidate that keeps
/// the most trailing folders wins; a tie prefers the shorter path, which is the
/// hoisted copy rather than a leftover nested export.
fn resolve_with_index(index: &LocalPathIndex, recorded: &str) -> Option<String> {
    let recorded_path = Path::new(recorded);
    if recorded_path.is_file() {
        return Some(recorded.to_string());
    }
    let name = recorded_path.file_name()?.to_string_lossy().to_ascii_lowercase();
    let candidates = index.files.get(&name)?;
    let mut best: Option<(usize, &PathBuf)> = None;
    for candidate in candidates {
        // The index outlives a session, so a candidate can have been deleted
        // since it was built. Only hand back a file that is still there.
        if !candidate.is_file() {
            continue;
        }
        let score = trailing_component_matches(candidate, recorded_path);
        best = match best {
            None => Some((score, candidate)),
            Some((current, chosen)) => {
                if score > current
                    || (score == current && candidate.as_os_str().len() < chosen.as_os_str().len())
                {
                    Some((score, candidate))
                } else {
                    Some((current, chosen))
                }
            }
        };
    }
    best.map(|(_, path)| path.to_string_lossy().into_owned())
}

fn with_local_index<T>(
    state: &AppState,
    roots: &[String],
    use_index: impl FnOnce(&LocalPathIndex) -> T,
) -> T {
    let mut guard = match state.local_paths.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let stale = guard
        .as_ref()
        .map(|index| index.roots != roots)
        .unwrap_or(true);
    if stale {
        *guard = Some(build_local_path_index(roots));
    }
    let index = guard.as_ref().expect("index is built for these roots");
    use_index(index)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPathRepair {
    pub checked: i64,
    pub repaired: i64,
    pub missing: i64,
}

/// Rewrite catalogue rows whose file moved so every later query returns a path
/// that exists. Rows with no matching file are reported, never deleted.
///
/// Only `local_assets` is rewritten. `base_meshes.asset_path` is pack-relative
/// by design (and unique per pack), so several rows can name the same moved file;
/// rewriting them would collide, and every reader resolves the path anyway.
pub fn repair_local_paths(connection: &Connection, index: &LocalPathIndex) -> AssetPathRepair {
    let mut recorded: Vec<String> = Vec::new();
    if let Ok(mut statement) = connection.prepare("SELECT DISTINCT asset_path FROM local_assets") {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
            recorded.extend(rows.flatten());
        }
    }
    recorded.sort_unstable();
    recorded.dedup();

    // 29k rewrites against an unindexed 32k-row table scan 32k rows each. The
    // index turns the repair from minutes of CPU into one pass.
    let _ = connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS local_assets_asset_path ON local_assets(asset_path);",
    );
    let mut repair = AssetPathRepair {
        checked: 0,
        repaired: 0,
        missing: 0,
    };
    let _ = connection.execute_batch("BEGIN");
    for path in recorded {
        repair.checked += 1;
        if Path::new(&path).is_file() {
            continue;
        }
        let Some(resolved) = resolve_with_index(index, &path) else {
            repair.missing += 1;
            continue;
        };
        if resolved == path {
            continue;
        }
        let updated = connection
            .execute(
                "UPDATE local_assets SET asset_path = ?1 WHERE asset_path = ?2",
                params![resolved, path],
            )
            .unwrap_or(0);
        if updated > 0 {
            repair.repaired += 1;
        } else {
            repair.missing += 1;
        }
    }
    let _ = connection.execute_batch("COMMIT");
    repair
}

#[tauri::command]
pub fn repair_asset_paths(state: State<'_, AppState>) -> Result<AssetPathRepair, String> {
    let connection = open(&state)?;
    let roots = asset_roots_for(&connection);
    if roots.is_empty() {
        return Err("no asset folders are saved; choose an Assets folder first".into());
    }
    let repair = with_local_index(&state, &roots, |index| repair_local_paths(&connection, index));
    Ok(repair)
}

fn texture_cache_key(path: &Path) -> String {
    let metadata = std::fs::metadata(path).ok();
    let bytes = metadata.as_ref().map(|value| value.len()).unwrap_or(0);
    let modified = metadata
        .and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0);
    format!("{}|{bytes}|{modified}", path.to_string_lossy())
}

/// Read one indexed GLB. The path must still sit inside a saved asset root.
#[tauri::command]
pub fn load_local_mesh(state: State<'_, AppState>, asset_path: String) -> Result<Vec<u8>, String> {
    let connection = open(&state)?;
    let roots = asset_roots_for(&connection);
    // Resolve inside the index lock, then read the file outside it: a large GLB
    // must not block thumbnails queued behind the same catalogue index.
    let resolved = with_local_index(&state, &roots, |index| resolve_with_index(index, &asset_path));
    read_catalogued_mesh(&connection, resolved.as_deref(), &roots, &asset_path)
}

/// Load path for one catalogue mesh: verify, repair the row, read.
///
/// `resolved` is the file found for `recorded` (see `resolve_with_index`), which
/// may differ from it when the pack was reorganised. The `local_assets` row is
/// repaired so later listings and thumbnail jobs reuse the real file.
/// `base_meshes` keeps its pack-relative path, which is why both the recorded and
/// resolved value are accepted by the catalogue check.
pub fn read_catalogued_mesh(
    connection: &Connection,
    resolved: Option<&str>,
    roots: &[String],
    asset_path: &str,
) -> Result<Vec<u8>, String> {
    if roots.is_empty() {
        return Err("no asset folders are saved; choose an Assets folder first".into());
    }
    let Some(resolved) = resolved else {
        return Err("mesh file is missing from the saved asset folders".into());
    };
    let resolved = resolved.to_string();
    if resolved != asset_path {
        let _ = connection.execute(
            "UPDATE local_assets SET asset_path = ?1 WHERE asset_path = ?2",
            params![resolved, asset_path],
        );
    }
    if !path_within_asset_roots(roots, &resolved) {
        return Err("mesh path is outside the saved asset folders".into());
    }
    let local: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM local_assets WHERE asset_path IN (?1, ?2) AND category = 'mesh'",
            params![resolved, asset_path],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let base: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM base_meshes WHERE asset_path IN (?1, ?2)",
            params![resolved, asset_path],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if local == 0 && base == 0 {
        return Err("mesh is not in the local catalogue".into());
    }
    std::fs::read(&resolved).map_err(|error| format!("could not read mesh: {error}"))
}

/// Resolve one catalogue texture to a file that exists under the saved roots.
/// Kept separate from the data-URL encoding so the load path is testable.
pub fn resolve_catalogued_texture(
    connection: &Connection,
    index: &LocalPathIndex,
    roots: &[String],
    name: &str,
) -> Result<Option<String>, String> {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let stem = file
        .rsplit_once('.')
        .map(|(value, _extension)| value)
        .unwrap_or(file)
        .trim_end_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_lowercase();
    let path: Option<String> = connection
        .query_row(
            "SELECT asset_path FROM local_assets
              WHERE category IN ('texture2d','sprite')
                AND (lower(name) = ?1 OR lower(name_key) IN (?2, ?3))
              ORDER BY (lower(name) = ?1) DESC, file_bytes DESC LIMIT 1",
            params![stem, format!("{stem}.png"), format!("{stem}.jpg")],
            |row| row.get(0),
        )
        .ok();
    let Some(path) = path else { return Ok(None) };
    let Some(resolved) = resolve_with_index(index, &path) else {
        return Ok(None);
    };
    if !path_within_asset_roots(roots, &resolved) {
        return Err("texture path is outside the saved asset folders".into());
    }
    if resolved != path {
        let _ = connection.execute(
            "UPDATE local_assets SET asset_path = ?1 WHERE asset_path = ?2",
            params![resolved, path],
        );
    }
    Ok(Some(resolved))
}

/// Resolve a texture by filename/stem from the local catalogue as a data URL.
/// The encoded result is cached by path + length + mtime, because weapons often
/// repeat the same metal/rubber texture across dozens of material slots.
#[tauri::command]
pub fn local_texture(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let connection = open(&state)?;
    let roots = asset_roots_for(&connection);
    if roots.is_empty() {
        return Err("no asset folders are saved; choose an Assets folder first".into());
    }
    let Some(path) = with_local_index(&state, &roots, |index| {
        resolve_catalogued_texture(&connection, index, &roots, &name)
    })?
    else {
        return Ok(None);
    };
    let key = texture_cache_key(Path::new(&path));
    if let Ok(cache) = state.texture_cache.lock() {
        if let Some(cached) = cache.get(&key) {
            return Ok(cached.clone());
        }
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => {
            if let Ok(mut cache) = state.texture_cache.lock() {
                cache.insert(key, None);
            }
            return Ok(None);
        }
    };
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8") {
        "image/jpeg"
    } else {
        return Ok(None);
    };
    let data = format!("data:{mime};base64,{}", STANDARD.encode(bytes));
    if let Ok(mut cache) = state.texture_cache.lock() {
        if cache.len() > 512 {
            cache.clear();
        }
        cache.insert(key, Some(data.clone()));
    }
    Ok(Some(data))
}

/// Return the indexer's cached base-mesh preview without exposing filesystem
/// paths to the webview. Skin cards use it until a rendered skin preview exists.
#[tauri::command]
pub fn get_base_mesh_thumbnail(
    state: State<'_, AppState>,
    asset_path: String,
) -> Result<Option<String>, String> {
    let connection = open(&state)?;
    let stored: Option<String> = connection
        .query_row(
            "SELECT thumbnail_path FROM base_meshes WHERE asset_path = ? AND thumbnail_path IS NOT NULL LIMIT 1",
            params![asset_path],
            |row| row.get(0),
        )
        .ok();
    let Some(stored) = stored else {
        return Ok(None);
    };
    let path = PathBuf::from(&stored);
    let path = if path.is_absolute() {
        path
    } else {
        state.project_root.join(path)
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => bytes,
        _ => return Ok(None),
    };
    Ok(Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes))))
}

fn base_mesh_rows(connection: &Connection) -> Result<Vec<BaseMeshRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT asset_path, name, item_kind, uv_channel_count, triangle_count,
                    has_tangents, metadata_json
               FROM base_meshes ORDER BY item_kind, name LIMIT 200",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let metadata: String = row.get(6)?;
            let material_slots = serde_json::from_str::<Value>(&metadata)
                .ok()
                .and_then(|value| value.get("materialSlots").cloned())
                .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
                .unwrap_or_default();
            Ok(BaseMeshRow {
                id: row.get(0)?,
                name: row.get(1)?,
                item_kind: row.get(2)?,
                uv_channels: row.get(3)?,
                triangles: row.get(4)?,
                has_tangents: row.get::<_, i64>(5)? != 0,
                material_slots,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_database() -> Option<PathBuf> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("data")
            .join("rust-studio.db");
        path.exists().then_some(path)
    }

    #[test]
    fn native_asset_queries_match_indexed_catalogue() {
        let Some(path) = workspace_database() else {
            eprintln!("skipping: workspace data/rust-studio.db is not present");
            return;
        };
        let connection = Connection::open(path).expect("open workspace index");
        let prefabs = prefab_rows(&connection).expect("read prefabs");
        let meshes = base_mesh_rows(&connection).expect("read base meshes");

        assert!(!prefabs.is_empty(), "native prefab catalogue is empty");
        assert!(!meshes.is_empty(), "native base mesh catalogue is empty");
        let bounded = prefabs
            .iter()
            .filter(|row| {
                row.bounds.max[0] > row.bounds.min[0]
                    || row.bounds.max[1] > row.bounds.min[1]
                    || row.bounds.max[2] > row.bounds.min[2]
            })
            .count();
        assert!(
            bounded > 1,
            "native bounds were not populated beyond the demo prefab"
        );

        let prefab = serde_json::to_value(&prefabs[0]).expect("serialize prefab");
        assert!(prefab.get("flattenRadius").is_some());
        assert!(prefab.get("hasLoot").is_some());
        assert!(prefab["bounds"]["min"].is_array());
        let mesh = serde_json::to_value(&meshes[0]).expect("serialize mesh");
        assert!(mesh.get("materialSlots").is_some());
        assert!(mesh.get("uvChannels").is_some());

        eprintln!(
            "native assets: {} prefabs, {} meshes, {} bounded",
            prefabs.len(),
            meshes.len(),
            bounded
        );
    }

    #[test]
    fn asset_root_boundary_accepts_children_and_rejects_siblings() {
        let base = std::env::temp_dir().join(format!("koba-roots-{}", uuid::Uuid::new_v4()));
        let root = base.join("Assets");
        let child = root.join("Mesh/rifle.glb");
        let sibling = base.join("Other/rifle.glb");
        std::fs::create_dir_all(child.parent().unwrap()).unwrap();
        std::fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        std::fs::write(&child, b"glb").unwrap();
        std::fs::write(&sibling, b"glb").unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        assert!(path_within_asset_roots(&roots, &child.to_string_lossy()));
        assert!(!path_within_asset_roots(&roots, &sibling.to_string_lossy()));
        assert!(!path_within_asset_roots(&[], &child.to_string_lossy()));
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn detected_roots_cover_nested_pack_layouts() {
        let home = std::env::temp_dir().join(format!("koba-detect-{}", uuid::Uuid::new_v4()));
        // How unpacked packs actually ship: the pack tree can sit several levels
        // inside the folder the user keeps them in.
        let packs = home.join("Desktop/KOBAeditASSETS");
        std::fs::create_dir_all(packs.join("KOBAedit2/KOBAedit1/Assets/Mesh")).unwrap();
        std::fs::create_dir_all(packs.join("KOBAedit3/Assets/Texture2D")).unwrap();
        // A pack folder that keeps `Assets` one level in.
        std::fs::create_dir_all(home.join("Desktop/KOBAedit1/Assets/Sprite")).unwrap();
        // A pack that is the `Assets` folder itself, plus a decoy with no assets.
        std::fs::create_dir_all(home.join("Assets/PrefabHierarchyObject")).unwrap();
        std::fs::create_dir_all(home.join("Desktop/KOBAedit4/notes")).unwrap();

        let roots = asset_root_candidates_in(&home);
        assert_eq!(roots.len(), 3, "detected: {roots:?}");
        for expected in [
            // The parent, so every nested pack is inside the saved root.
            packs.clone(),
            home.join("Desktop/KOBAedit1"),
            home.join("Assets"),
        ] {
            let expected = std::fs::canonicalize(expected).unwrap();
            assert!(
                roots.iter().any(|root| Path::new(root) == expected),
                "missing {}",
                expected.display()
            );
        }
        assert!(!roots.iter().any(|root| root.ends_with("KOBAedit4")));
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn saved_roots_are_not_offered_again() {
        let home = std::env::temp_dir().join(format!("koba-offer-{}", uuid::Uuid::new_v4()));
        let first = home.join("one/Assets/Mesh");
        let second = home.join("two/Assets/Mesh");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let first = std::fs::canonicalize(home.join("one/Assets"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let second = std::fs::canonicalize(home.join("two/Assets"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let offered = offered_candidates(vec![first.clone(), second.clone()], &[first.clone()]);
        assert_eq!(offered, vec![second]);
        // A saved root written with a trailing slash still matches.
        let offered = offered_candidates(vec![first.clone()], &[format!("{first}/")]);
        assert!(offered.is_empty());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn grouped_meshes_skip_colbox_and_prioritize_assembled_items() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE local_assets (
                   category TEXT, name TEXT, name_key TEXT, group_key TEXT,
                   part_index INTEGER, asset_path TEXT, triangles INTEGER
                 );
                 INSERT INTO local_assets VALUES
                   ('mesh','zeta_part01','zeta_part01.glb','mesh:zeta',1,'/assets/Mesh/zeta_part01.glb',10),
                   ('mesh','zeta_part02','zeta_part02.glb','mesh:zeta',2,'/assets/Mesh/zeta_part02.glb',10),
                   ('mesh','alpha','alpha.glb','mesh:alpha',NULL,'/assets/PrefabHierarchyObject/alpha.glb',50),
                   ('mesh','zeta_part01.colbox','zeta_part01.colbox.glb','mesh:zeta_part01.colbox',NULL,'/assets/Mesh/zeta_part01.colbox.glb',2);",
            )
            .expect("fixture rows");
        let page = browse_mesh_groups_query(&connection, None, None, Some(10), None)
            .expect("grouped page");
        assert_eq!(page.total, 2, "collision boxes must not be placeable groups");
        assert_eq!(page.rows[0].name, "alpha", "assembled items sort first");
        assert_eq!(page.rows[0].triangles, 50);
        assert_eq!(page.rows[1].name, "zeta");
        assert_eq!(page.rows[1].part_count, 2);
        assert_eq!(page.rows[1].triangles, 20);
        assert!(!page.rows.iter().any(|row| row.name.contains("colbox")));
    }

    #[test]
    fn mesh_group_kind_filter_uses_prefab_naming() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE local_assets (
                   category TEXT, name TEXT, name_key TEXT, group_key TEXT,
                   part_index INTEGER, asset_path TEXT, triangles INTEGER
                 );
                 INSERT INTO local_assets VALUES
                   ('mesh','rifle.ak47','rifle.ak47.glb','mesh:rifle.ak47',NULL,'/assets/Mesh/rifle.ak47.glb',100),
                   ('mesh','attire.burlap.shirt','attire.burlap.shirt.glb','mesh:attire.burlap.shirt',NULL,'/assets/Mesh/attire.burlap.shirt.glb',80),
                   ('mesh','deployable.sandbag','deployable.sandbag.glb','mesh:deployable.sandbag',NULL,'/assets/Mesh/deployable.sandbag.glb',40),
                   ('mesh','roof.corrugated','roof.corrugated.glb','mesh:roof.corrugated',NULL,'/assets/Mesh/roof.corrugated.glb',12);",
            )
            .expect("fixture rows");

        let all = browse_mesh_groups_query(&connection, None, Some("all".into()), Some(50), None)
            .expect("all groups");
        assert_eq!(all.total, 4);

        let weapons =
            browse_mesh_groups_query(&connection, None, Some("weapon".into()), Some(50), None)
                .expect("weapon groups");
        assert_eq!(weapons.total, 1, "the chip must change the total, not just the page");
        assert_eq!(weapons.rows[0].name, "rifle.ak47");
        assert_eq!(weapons.rows[0].item_kind, "weapon");

        let attire =
            browse_mesh_groups_query(&connection, None, Some("attire".into()), Some(50), None)
                .expect("attire groups");
        assert_eq!(attire.total, 1);
        assert_eq!(attire.rows[0].name, "attire.burlap.shirt");

        let deployables =
            browse_mesh_groups_query(&connection, None, Some("deployable".into()), Some(50), None)
                .expect("deployable groups");
        assert_eq!(deployables.total, 1);
        assert_eq!(deployables.rows[0].item_kind, "deployable");

        let other = browse_mesh_groups_query(&connection, None, None, Some(50), None)
            .expect("unfiltered groups");
        let roof = other
            .rows
            .iter()
            .find(|row| row.name == "roof.corrugated")
            .expect("roof row");
        assert_eq!(roof.item_kind, "other");
    }

    #[test]
    fn workspace_kind_filter_returns_only_that_kind() {
        let Some(path) = workspace_database() else {
            eprintln!("skipping: workspace data/rust-studio.db is not present");
            return;
        };
        let connection = Connection::open(path).expect("open workspace index");
        let all = browse_mesh_groups_query(&connection, None, Some("all".into()), Some(50), None)
            .expect("all groups");
        assert!(all.total > 100, "local mesh groups are missing");
        for kind in ["weapon", "attire", "deployable"] {
            let page =
                browse_mesh_groups_query(&connection, None, Some(kind.to_string()), Some(50), None)
                    .expect("filtered groups");
            assert!(page.total > 0, "{kind} matched nothing in the real catalogue");
            assert!(
                page.total < all.total,
                "{kind} did not narrow the catalogue"
            );
            assert!(
                page.rows.iter().all(|row| row.item_kind == kind),
                "{kind} page leaked rows of another kind"
            );
        }
    }

    #[test]
    fn prefab_pages_filter_and_count_without_shipping_the_catalogue() {
        let Some(path) = workspace_database() else {
            eprintln!("skipping: workspace data/rust-studio.db is not present");
            return;
        };
        let connection = Connection::open(path).expect("open workspace index");
        let page = browse_prefabs_query(&connection, None, None, Some(200), None)
            .expect("browse prefabs");
        assert_eq!(page.rows.len(), 200);
        assert!(page.total >= page.rows.len() as i64);
        assert!(!page.counts.is_empty());

        let monuments = browse_prefabs_query(
            &connection,
            Some("Monument".to_string()),
            None,
            Some(200),
            None,
        )
        .expect("browse monuments");
        assert!(!monuments.rows.is_empty());
        assert!(monuments.rows.iter().all(|row| row.category == "Monument"));
        assert_eq!(
            monuments.counts.get("Monument").copied(),
            Some(monuments.total)
        );

        let search = browse_prefabs_query(
            &connection,
            Some("Monument".to_string()),
            Some("cave".to_string()),
            Some(200),
            None,
        )
        .expect("search monuments");
        assert!(search.rows.iter().all(|row| row.id.to_lowercase().contains("cave")));

        // Real paging: offsets walk the indexed catalogue without overlapping.
        let second_page = browse_prefabs_query(&connection, None, None, Some(200), Some(200))
            .expect("browse second page");
        assert_eq!(second_page.rows.len(), 200);
        assert_eq!(second_page.total, page.total);
        assert!(
            page.total > 400,
            "index has too few prefabs for a paging check: {}",
            page.total
        );
        let first_ids: std::collections::HashSet<String> =
            page.rows.iter().map(|row| row.id.clone()).collect();
        assert!(
            second_page
                .rows
                .iter()
                .all(|row| !first_ids.contains(&row.id)),
            "page 2 repeated rows from page 1"
        );

        // The final page is short rather than padded, and offset + rows == total.
        let last_offset = (page.total as u32 / 200) * 200;
        let last_page = browse_prefabs_query(&connection, None, None, Some(200), Some(last_offset))
            .expect("browse last page");
        assert!(!last_page.rows.is_empty());
        assert_eq!(last_offset as usize + last_page.rows.len(), page.total as usize);
        eprintln!(
            "paging: total {}, page 2 {} rows, last page {} rows at offset {}",
            page.total,
            second_page.rows.len(),
            last_page.rows.len(),
            last_offset
        );
    }
}

#[tauri::command]
pub fn inspect_map(path: String) -> Result<InspectResponse, String> {
    let document = parse_file(&path).map_err(|error| error.to_string())?;
    Ok(InspectResponse {
        file: path,
        summary: document.summary(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_recent_projects(state: State<'_, AppState>) -> Result<Vec<RecentProject>, String> {
    let connection = open(&state)?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, kind, updated_at
               FROM projects
              ORDER BY updated_at DESC
              LIMIT 12",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(RecentProject {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// Reopen the exact draft + wizard cursor written by save_project.
#[tauri::command]
pub fn load_project(state: State<'_, AppState>, project_id: String) -> Result<Value, String> {
    let connection = open(&state)?;
    let payload: String = connection
        .query_row(
            "SELECT state_json FROM project_wizard_state WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&payload).map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirectoryEntry>,
}

/// In-app folder browser used instead of the GTK dialog, which can black out
/// WebKitGTK while the native modal owns the window.
#[tauri::command]
pub fn list_directories(path: Option<String>) -> Result<DirectoryListing, String> {
    let requested = path
        .map(std::path::PathBuf::from)
        .or_else(|| {
            let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
            let desktop = home.join("Desktop");
            Some(if desktop.is_dir() { desktop } else { home })
        })
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    let current = requested
        .canonicalize()
        .unwrap_or(requested)
        .to_string_lossy()
        .into_owned();
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        entries.push(DirectoryEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
        });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    let parent = std::path::Path::new(&current)
        .parent()
        .map(|value| value.to_string_lossy().into_owned());
    Ok(DirectoryListing {
        path: current,
        parent,
        entries,
    })
}

#[tauri::command]
pub fn save_project(
    state: State<'_, AppState>,
    draft: Value,
    step_id: String,
) -> Result<String, String> {
    let project_id = uuid::Uuid::new_v4().to_string();
    let name = draft
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Untitled project")
        .to_string();
    let kind = draft
        .get("projectKind")
        .and_then(Value::as_str)
        .unwrap_or("map");
    let (kind, export_target) = match kind {
        "skin" => ("skin", "skin"),
        "monument" => ("monument", "prefab"),
        _ => ("map", "map"),
    };

    let workspace_relative = format!("projects/{project_id}");
    let workspace = state.data_dir.join(&workspace_relative);
    std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
    let saved_at = now_iso();
    let payload = json!({ "draft": draft, "stepId": step_id, "savedAt": saved_at });
    let file = workspace.join("project.json");
    std::fs::write(
        &file,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let connection = open(&state)?;
    let size = draft
        .get("terrain")
        .and_then(|terrain| terrain.get("sizeMetres"))
        .and_then(Value::as_i64);
    let seed = draft
        .get("terrain")
        .and_then(|terrain| terrain.get("seed"))
        .and_then(Value::as_i64);
    let studio_mode = draft
        .get("studioMode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let wizard_phase = match step_id.as_str() {
        "terrain" | "monuments" | "paths" | "loot" | "validate" => step_id.as_str(),
        "baseItem" => "base_item",
        "materials" => "materials",
        "paint" => "paint",
        "wear" => "wear",
        "workshop" => "workshop",
        _ => "terrain",
    };

    connection
        .execute(
            "INSERT INTO projects (
                id, name, kind, export_target, workspace_path, wizard_phase,
                studio_mode, is_dirty, map_size, map_resolution, seed, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?10,?11)
             ON CONFLICT (id) DO UPDATE SET
                name = excluded.name,
                wizard_phase = excluded.wizard_phase,
                studio_mode = excluded.studio_mode,
                is_dirty = 0,
                updated_at = excluded.updated_at",
            params![
                project_id,
                name,
                kind,
                export_target,
                workspace_relative,
                wizard_phase,
                if studio_mode { 1i64 } else { 0i64 },
                size,
                size.map(|value| value + 1),
                seed,
                saved_at
            ],
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT INTO project_wizard_state (project_id, state_json)
             VALUES (?1, ?2)
             ON CONFLICT (project_id) DO UPDATE SET state_json = excluded.state_json",
            params![project_id, payload.to_string()],
        )
        .map_err(|error| error.to_string())?;

    Ok(file.to_string_lossy().into_owned())
}

/// Run one engine subcommand that takes a wizard draft and answers JSON.
///
/// The draft is written the same way `export_project` does it, so the engine sees
/// one shape on every path. A non-zero exit is only fatal when the engine did
/// not answer: `validate-project` exits 1 precisely when it found errors.
fn run_engine_command(
    state: &AppState,
    subcommand: &str,
    extra: &[String],
    draft: &Value,
) -> Result<Value, String> {
    let scratch = state.data_dir.join("exports");
    std::fs::create_dir_all(&scratch).map_err(|error| error.to_string())?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let draft_path = scratch.join(format!(".draft-{stamp}.json"));
    std::fs::write(
        &draft_path,
        serde_json::to_vec(&json!({ "draft": draft })).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let output = Command::new(python(&state.project_root))
        .arg("-m")
        .arg("koba_engine")
        .arg(subcommand)
        .arg(&draft_path)
        .args(extra)
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir)
        .output();
    // Remove the scratch draft on every path, including a failed spawn.
    let output = match output {
        Ok(output) => {
            let _ = std::fs::remove_file(&draft_path);
            output
        }
        Err(error) => {
            let _ = std::fs::remove_file(&draft_path);
            return Err(format!(
                "could not start the engine ({error}). Install Python 3.10+ and run \
                 `pip install -e engine`."
            ));
        }
    };

    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(payload) => Ok(payload),
        Err(_) => Err(format!(
            "engine {subcommand} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchImport {
    pub path: String,
    pub resolution: u32,
    pub data_url: String,
    pub coverage: Value,
    pub minimum: f64,
    pub maximum: f64,
}

/// Rebuild a 16-bit heightmap from a colour sketch and hand the PNG back to the
/// wizard, which decodes it through the same importer as a manual heightmap.
#[tauri::command]
pub fn engine_sketch(
    state: State<'_, AppState>,
    sketch_path: String,
    resolution: u32,
    vertical_scale: f64,
    sea_level: f64,
    smooth: f64,
) -> Result<SketchImport, String> {
    let exports = state.data_dir.join("exports");
    std::fs::create_dir_all(&exports).map_err(|error| error.to_string())?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let target = exports.join(format!("sketch-{stamp}.png"));

    let output = Command::new(python(&state.project_root))
        .arg("-m")
        .arg("koba_engine")
        .arg("sketch-to-heightmap")
        .arg(&sketch_path)
        .arg("--out")
        .arg(&target)
        .arg("--resolution")
        .arg(resolution.clamp(129, 4097).to_string())
        .arg("--vertical-scale")
        .arg(vertical_scale.to_string())
        .arg("--sea-level")
        .arg(sea_level.to_string())
        .arg("--smooth")
        .arg(smooth.to_string())
        .arg("--json")
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir)
        .output()
        .map_err(|error| {
            format!(
                "could not start the engine ({error}). Install Python 3.10+ and run \
                 `pip install -e engine`."
            )
        })?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&target);
        return Err(format!(
            "sketch import failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let payload: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "unexpected engine response ({error}): {}",
            String::from_utf8_lossy(&output.stdout).trim()
        )
    })?;
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(&target);

    Ok(SketchImport {
        path: target.to_string_lossy().to_string(),
        resolution: payload["resolution"].as_u64().unwrap_or(0) as u32,
        coverage: payload.get("coverage").cloned().unwrap_or(Value::Null),
        minimum: payload["minimum"].as_f64().unwrap_or(0.0),
        maximum: payload["maximum"].as_f64().unwrap_or(0.0),
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
    })
}

/// Engine map check: floating, buried and overlapping prefabs, orphaned splines,
/// unwired IO and layer layout, measured against the exported terrain.
#[tauri::command]
pub fn engine_map_check(state: State<'_, AppState>, draft: Value) -> Result<Value, String> {
    run_engine_command(&state, "validate-project", &["--json".to_string()], &draft)
}

/// GENESIS wipe simulation.
#[tauri::command]
pub fn engine_genesis(
    state: State<'_, AppState>,
    draft: Value,
    players: u32,
    hours: u32,
) -> Result<Value, String> {
    let extra = vec![
        "--players".to_string(),
        players.clamp(50, 300).to_string(),
        "--hours".to_string(),
        hours.clamp(24, 168).to_string(),
        "--json".to_string(),
    ];
    run_engine_command(&state, "genesis-sim", &extra, &draft)
}

/// Server Ready-Pack: configs, companion plugin and the zip that holds them.
#[tauri::command]
pub fn engine_server_bundle(state: State<'_, AppState>, draft: Value) -> Result<Value, String> {
    let out = state.data_dir.join("exports").join("server-pack");
    std::fs::create_dir_all(&out).map_err(|error| error.to_string())?;
    let extra = vec![
        "--out".to_string(),
        out.to_string_lossy().to_string(),
        "--json".to_string(),
    ];
    run_engine_command(&state, "server-bundle", &extra, &draft)
}

#[tauri::command]
pub fn export_project(state: State<'_, AppState>, draft: Value) -> Result<ExportReport, String> {
    let exports = state.data_dir.join("exports");
    std::fs::create_dir_all(&exports).map_err(|error| error.to_string())?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let draft_path = exports.join(format!(".draft-{stamp}.json"));
    std::fs::write(
        &draft_path,
        serde_json::to_vec(&json!({ "draft": draft })).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let output = Command::new(python(&state.project_root))
        .arg("-m")
        .arg("koba_engine")
        .arg("export-project")
        .arg(&draft_path)
        .arg("--json")
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir)
        .output()
        .map_err(|error| {
            format!(
                "could not start the engine ({error}). Install Python 3.10+ and run \
                 `pip install -e engine`."
            )
        })?;

    let _ = std::fs::remove_file(&draft_path);
    if !output.status.success() {
        return Err(format!(
            "engine export failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    serde_json::from_slice::<ExportReport>(&output.stdout).map_err(|error| {
        format!(
            "unexpected engine response ({error}): {}",
            String::from_utf8_lossy(&output.stdout).trim()
        )
    })
}

#[tauri::command]
pub fn ingest_assets(
    state: State<'_, AppState>,
    root: String,
) -> Result<IngestSummary, String> {
    let script = state.engine_dir.join("scripts").join("ingest_assets.py");
    let output = Command::new(python(&state.project_root))
        .arg(&script)
        .arg(&root)
        .arg("--db")
        .arg(&state.db_path)
        .arg("--thumbnails")
        .arg(state.data_dir.join("thumbnails"))
        .arg("--json")
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir)
        .output()
        .map_err(|error| format!("could not start the indexer: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "indexing failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice::<IngestSummary>(&output.stdout).map_err(|error| {
        format!(
            "unexpected indexer response ({error}): {}",
            String::from_utf8_lossy(&output.stdout).trim()
        )
    })
}

/// Start a cancellable bundle scan. The UI polls `bundle_scan_status` so the
/// IPC thread never blocks for the multi-minute item-prefab extraction.
#[tauri::command]
pub fn scan_rust_bundles(
    state: State<'_, AppState>,
    root: String,
    force: Option<bool>,
) -> Result<(), String> {
    let script = state.engine_dir.join("scripts").join("ingest_bundles.py");
    let glb_cache = crate::thumbnails::cache_root()?.join("meshes");
    let progress = state.data_dir.join("sync").join("progress").join("bundles.jsonl");
    let mut command = Command::new(python(&state.project_root));
    command
        .arg(&script)
        .arg(&root)
        .arg("--db")
        .arg(&state.db_path)
        .arg("--thumbnails")
        .arg(state.data_dir.join("thumbnails"))
        .arg("--glb-cache")
        .arg(glb_cache)
        .arg("--pack-name")
        .arg("rust-client")
        .arg("--skin-meshes")
        .arg("--limit")
        .arg("80")
        .arg("--json")
        .arg("--progress")
        .arg(&progress);
    if force.unwrap_or(false) {
        // Bounds indexing: re-read bundles that were already catalogued so the
        // missing renderer AABBs are populated.
        command.arg("--force");
    }
    command
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir);
    state.tasks.start_scan(command, progress, "bundle scan")
}

#[tauri::command]
pub fn bundle_scan_status(state: State<'_, AppState>) -> TaskStatus {
    state.tasks.scan_status()
}

#[tauri::command]
pub fn cancel_bundle_scan(state: State<'_, AppState>) -> Result<(), String> {
    state.tasks.cancel_scan()
}

fn sync_project_id(delta: &Value) -> String {
    let explicit = delta
        .get("projectId")
        .or_else(|| delta.get("project"))
        .and_then(Value::as_str)
        .unwrap_or("untitled");
    explicit
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn token_path(state: &AppState) -> PathBuf {
    state.data_dir.join("sync").join("token")
}

fn active_profile(
    connection: &Connection,
) -> Result<Option<(i64, String, String)>, String> {
    Ok(connection
        .query_row(
            "SELECT id, name, endpoint FROM sync_profiles WHERE is_active = 1 LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok())
}

fn sync_state(connection: &Connection) -> Result<SyncStatus, String> {
    let Some((profile_id, name, endpoint)) = active_profile(connection)? else {
        return Ok(SyncStatus {
            active: false,
            pending: 0,
            conflicts: 0,
            last_sync_at: None,
            endpoint: None,
            profile: None,
            token_saved: false,
        });
    };
    let pending: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE profile_id = ?1 AND state IN ('queued','inflight')",
            params![profile_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let conflicts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_metadata WHERE profile_id = ?1 AND state = 'conflict'",
            params![profile_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let last_sync_at = connection
        .query_row(
            "SELECT last_sync_at FROM sync_profiles WHERE id = ?1",
            params![profile_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(SyncStatus {
        active: true,
        pending,
        conflicts,
        last_sync_at,
        endpoint: Some(endpoint),
        profile: Some(name),
        token_saved: false,
    })
}

#[tauri::command]
pub fn queue_project_delta(
    state: State<'_, AppState>,
    delta: Value,
) -> Result<DeltaReceipt, String> {
    if !delta.is_object() {
        return Err("project delta must be a JSON object".to_string());
    }
    let outbox = state.data_dir.join("sync").join("outbox");
    std::fs::create_dir_all(&outbox).map_err(|error| error.to_string())?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let path = outbox.join(format!("delta-{stamp}.json"));
    let bytes = serde_json::to_vec_pretty(&delta).map_err(|error| error.to_string())?;
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;
    let operations = delta
        .get("operations")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(0);

    let connection = open(&state)?;
    if let Some((profile_id, _, _)) = active_profile(&connection)? {
        let project_id = sync_project_id(&delta);
        connection
            .execute(
                r#"
                INSERT INTO sync_metadata (profile_id, entity_type, entity_id, local_revision, state)
                VALUES (?1, 'project', ?2, 1, 'pending')
                ON CONFLICT (profile_id, entity_type, entity_id) DO UPDATE SET
                    local_revision = sync_metadata.local_revision + 1,
                    state = 'pending', error_message = NULL
                "#,
                params![profile_id, project_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO sync_queue (
                    profile_id, entity_type, entity_id, operation, payload_path,
                    payload_hash, state, next_attempt_at
                ) VALUES (?1, 'project', ?2, 'push', ?3, '', 'queued', ?4)
                ON CONFLICT (profile_id, entity_type, entity_id, operation) DO UPDATE SET
                    payload_path = excluded.payload_path,
                    state = 'queued',
                    last_error = NULL,
                    next_attempt_at = excluded.next_attempt_at
                "#,
                params![
                    profile_id,
                    project_id,
                    path.to_string_lossy().into_owned(),
                    now_iso()
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(DeltaReceipt {
        path: path.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
        operations,
    })
}

#[tauri::command]
pub fn pick_bundle_folder() -> Result<Option<String>, String> {
    native_pick_folder("Select the Rust Bundles folder")
}

#[cfg(target_os = "windows")]
fn native_pick_folder(title: &str) -> Result<Option<String>, String> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; \
         $dialog.Description = '{title}'; \
         if ($dialog.ShowDialog() -eq 'OK') {{ Write-Output $dialog.SelectedPath }}"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| {
            format!("no native folder picker is available ({error}); type the path instead")
        })?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

#[cfg(target_os = "macos")]
fn native_pick_folder(title: &str) -> Result<Option<String>, String> {
    let script = format!(
        "POSIX path of (choose folder with prompt \"{title}\" default location (path to home folder))"
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| {
            format!("no native folder picker is available ({error}); type the path instead")
        })?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn native_pick_folder(title: &str) -> Result<Option<String>, String> {
    let zenity = Command::new("zenity")
        .arg("--file-selection")
        .arg("--directory")
        .arg(format!("--title={title}"))
        .output();
    if let Ok(output) = zenity {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok((!path.is_empty()).then_some(path));
        }
        return Ok(None);
    }
    // KDE desktops ship kdialog instead of zenity.
    let kdialog = Command::new("kdialog")
        .arg("--getexistingdirectory")
        .arg(".")
        .arg("--title")
        .arg(title)
        .output();
    if let Ok(output) = kdialog {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok((!path.is_empty()).then_some(path));
        }
        return Ok(None);
    }
    Err("no native folder picker is available; install zenity or type the path".to_string())
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let connection = open(&state)?;
    let mut status = sync_state(&connection)?;
    status.token_saved = token_path(&state).is_file();
    Ok(status)
}

#[tauri::command]
pub fn sync_configure(
    state: State<'_, AppState>,
    endpoint: String,
    token: String,
) -> Result<SyncStatus, String> {
    let endpoint = endpoint.trim().trim_end_matches('/').to_string();
    if endpoint.is_empty() {
        return Err("sync endpoint is required".to_string());
    }
    if !endpoint.starts_with("https://") && !endpoint.starts_with("http://") {
        return Err("sync endpoint must use http or https".to_string());
    }
    if let Some(rest) = endpoint.strip_prefix("http://") {
        let authority = rest.split('/').next().unwrap_or("");
        let host = authority
            .rsplit_once(':')
            .map(|(value, _)| value)
            .unwrap_or(authority);
        if !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
            return Err("plain HTTP is only allowed for localhost; use HTTPS".to_string());
        }
    }

    let secret = token.trim();
    let token_file = token_path(&state);
    if !secret.is_empty() {
        if let Some(parent) = token_file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&token_file)
            .map_err(|error| error.to_string())?;
        file.write_all(secret.as_bytes())
            .map_err(|error| error.to_string())?;
        let _ = std::fs::set_permissions(
            &token_file,
            std::fs::Permissions::from_mode(0o600),
        );
    }

    let connection = open(&state)?;
    connection
        .execute(
            r#"
            INSERT INTO sync_profiles (name, endpoint, token_ref, is_active)
            VALUES ('default', ?1, ?2, 0)
            ON CONFLICT (name) DO UPDATE SET endpoint = excluded.endpoint, token_ref = excluded.token_ref
            "#,
            params![endpoint, token_file.to_string_lossy().into_owned()],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("UPDATE sync_profiles SET is_active = 0", [])
        .map_err(|error| error.to_string())?;
    connection
        .execute("UPDATE sync_profiles SET is_active = 1 WHERE name = 'default'", [])
        .map_err(|error| error.to_string())?;
    let mut status = sync_state(&connection)?;
    status.token_saved = token_file.is_file();
    Ok(status)
}

fn run_sync_engine(state: &AppState, args: &[&str]) -> Result<Value, String> {
    let token_file = token_path(state);
    if !token_file.is_file() {
        return Err("a sync token has not been configured".to_string());
    }
    let mut command = Command::new(python(&state.project_root));
    command
        .arg("-m")
        .arg("koba_engine")
        .args(args)
        .arg("--token-file")
        .arg(&token_file)
        .arg("--json")
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir);
    let output = command
        .output()
        .map_err(|error| format!("could not start the sync client: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "sync failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice::<Value>(&output.stdout).map_err(|error| {
        format!(
            "unexpected sync response ({error}): {}",
            String::from_utf8_lossy(&output.stdout).trim()
        )
    })
}

#[tauri::command]
pub fn sync_test(state: State<'_, AppState>) -> Result<String, String> {
    let connection = open(&state)?;
    let Some((_, _, endpoint)) = active_profile(&connection)? else {
        return Err("configure a sync endpoint first".to_string());
    };
    let payload = run_sync_engine(&state, &["sync-test", "--endpoint", &endpoint])?;
    let service = payload
        .get("health")
        .and_then(|value| value.get("service"))
        .and_then(Value::as_str)
        .unwrap_or("koba-sync");
    Ok(format!("Connected to {service}"))
}

#[tauri::command]
pub fn sync_push(
    state: State<'_, AppState>,
    project_id: String,
    draft: Value,
) -> Result<SyncPushResult, String> {
    let connection = open(&state)?;
    let Some((profile_id, _, endpoint)) = active_profile(&connection)? else {
        return Err("configure a sync endpoint first".to_string());
    };
    let project = sync_project_id(&json!({ "projectId": project_id }));
    if project.is_empty() {
        return Err("project id is required".to_string());
    }
    let base_revision: i64 = connection
        .query_row(
            "SELECT COALESCE(remote_revision, 0) FROM sync_metadata WHERE profile_id = ?1 AND entity_type = 'project' AND entity_id = ?2",
            params![profile_id, project],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let payload_dir = state.data_dir.join("sync").join("payloads");
    std::fs::create_dir_all(&payload_dir).map_err(|error| error.to_string())?;
    let path = payload_dir.join(format!("{project}-{}.json", chrono::Utc::now().timestamp_millis()));
    std::fs::write(
        &path,
        serde_json::to_vec(&draft).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let base = base_revision.to_string();
    let path_text = path.to_string_lossy().into_owned();
    let result = run_sync_engine(
        &state,
        &[
            "sync-push",
            "--endpoint",
            &endpoint,
            "--project-id",
            &project,
            "--payload",
            &path_text,
            "--base-revision",
            &base,
        ],
    )?;

    if result.get("conflict").and_then(Value::as_bool).unwrap_or(false) {
        let remote = result.get("remote").cloned().unwrap_or(Value::Null);
        if let Some(payload) = remote.get("payload") {
            let incoming = state
                .data_dir
                .join("sync")
                .join("incoming")
                .join(format!("{project}.json"));
            if let Some(parent) = incoming.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(
                &incoming,
                serde_json::to_vec(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        }
        let remote_revision = remote.get("revision").and_then(Value::as_i64);
        let remote_etag = remote.get("etag").and_then(Value::as_str).map(str::to_string);
        connection
            .execute(
                r#"
                INSERT INTO sync_metadata (
                    profile_id, entity_type, entity_id, remote_revision, remote_etag,
                    state, error_message
                ) VALUES (?3, 'project', ?4, ?1, ?2, 'conflict', 'remote revision changed')
                ON CONFLICT (profile_id, entity_type, entity_id) DO UPDATE SET
                    state = 'conflict',
                    remote_revision = COALESCE(excluded.remote_revision, sync_metadata.remote_revision),
                    remote_etag = COALESCE(excluded.remote_etag, sync_metadata.remote_etag),
                    error_message = excluded.error_message
                "#,
                params![remote_revision, remote_etag, profile_id, project],
            )
            .map_err(|error| error.to_string())?;
        return Ok(SyncPushResult {
            ok: false,
            conflict: true,
            revision: remote_revision,
            etag: remote_etag,
            updated_at: remote
                .get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            draft: remote.get("payload").cloned(),
            message: "The remote project has a newer revision. Choose which copy to keep.".to_string(),
        });
    }

    let remote = result.get("remote").cloned().unwrap_or(Value::Null);
    let revision = remote.get("revision").and_then(Value::as_i64);
    let etag = remote.get("etag").and_then(Value::as_str).map(str::to_string);
    connection
        .execute(
            r#"
            INSERT INTO sync_metadata (
                profile_id, entity_type, entity_id, remote_revision, remote_etag,
                state, last_synced_at, error_message
            ) VALUES (?4, 'project', ?5, ?1, ?2, 'synced', ?3, NULL)
            ON CONFLICT (profile_id, entity_type, entity_id) DO UPDATE SET
                remote_revision = excluded.remote_revision,
                remote_etag = excluded.remote_etag,
                state = 'synced',
                last_synced_at = excluded.last_synced_at,
                error_message = NULL
            "#,
            params![revision, etag, now_iso(), profile_id, project],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE sync_queue SET state = 'done', updated_at = ?1 WHERE profile_id = ?2 AND entity_type = 'project' AND entity_id = ?3 AND state IN ('queued','inflight')",
            params![now_iso(), profile_id, project],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE sync_profiles SET last_sync_at = ?1 WHERE id = ?2",
            params![now_iso(), profile_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(SyncPushResult {
        ok: true,
        conflict: false,
        revision,
        etag,
        updated_at: remote
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        draft: None,
        message: "Pushed the current project revision.".to_string(),
    })
}

#[tauri::command]
pub fn sync_pull(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<SyncPullResult, String> {
    let connection = open(&state)?;
    let Some((profile_id, _, endpoint)) = active_profile(&connection)? else {
        return Err("configure a sync endpoint first".to_string());
    };
    let project = sync_project_id(&json!({ "projectId": project_id }));
    let incoming_dir = state.data_dir.join("sync").join("incoming");
    std::fs::create_dir_all(&incoming_dir).map_err(|error| error.to_string())?;
    let incoming = incoming_dir.join(format!("{project}.json"));
    let incoming_text = incoming.to_string_lossy().into_owned();
    let result = run_sync_engine(
        &state,
        &[
            "sync-pull",
            "--endpoint",
            &endpoint,
            "--project-id",
            &project,
            "--out",
            &incoming_text,
        ],
    )?;
    let Some(remote) = result.get("remote").filter(|value| !value.is_null()) else {
        return Ok(SyncPullResult {
            decision: "no-remote".to_string(),
            revision: None,
            updated_at: None,
            draft: None,
            message: "No remote revision exists for this project yet.".to_string(),
        });
    };
    let revision = remote.get("revision").and_then(Value::as_i64).unwrap_or(0);
    let etag = remote.get("etag").and_then(Value::as_str).unwrap_or("");
    let updated_at = remote
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let draft = std::fs::read(&incoming)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .or_else(|| remote.get("payload").cloned());

    let metadata: Option<(i64, String)> = connection
        .query_row(
            "SELECT COALESCE(remote_revision, 0), state FROM sync_metadata WHERE profile_id = ?1 AND entity_type = 'project' AND entity_id = ?2",
            params![profile_id, project],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let previous_remote = metadata.as_ref().map(|row| row.0).unwrap_or(0);
    let local_pending = metadata
        .as_ref()
        .map(|row| matches!(row.1.as_str(), "pending" | "error" | "conflict"))
        .unwrap_or(false);
    let newer_remote = revision > previous_remote;
    let conflict = newer_remote && local_pending;
    let local_wins = !newer_remote && local_pending;
    let next_state = if conflict {
        "conflict"
    } else if local_wins {
        "pending"
    } else {
        "synced"
    };
    connection
        .execute(
            r#"
            INSERT INTO sync_metadata (profile_id, entity_type, entity_id, remote_revision, remote_etag, remote_updated_at, state, last_synced_at)
            VALUES (?1, 'project', ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT (profile_id, entity_type, entity_id) DO UPDATE SET
                remote_revision = excluded.remote_revision,
                remote_etag = excluded.remote_etag,
                remote_updated_at = excluded.remote_updated_at,
                state = excluded.state,
                last_synced_at = COALESCE(excluded.last_synced_at, sync_metadata.last_synced_at)
            "#,
            params![
                profile_id,
                project,
                revision,
                etag,
                updated_at,
                next_state,
                if conflict || local_wins { None } else { Some(now_iso()) }
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(SyncPullResult {
        decision: if conflict {
            "conflict"
        } else if local_wins {
            "local-wins"
        } else {
            "fast-forward"
        }
        .to_string(),
        revision: Some(revision),
        updated_at,
        draft: if local_wins { None } else { draft },
        message: if conflict {
            "Remote and local both changed. Keep one copy or dismiss to push local.".to_string()
        } else if local_wins {
            "The remote revision is unchanged; local edits remain queued for push.".to_string()
        } else {
            "Pulled the latest remote revision.".to_string()
        },
    })
}

#[tauri::command]
pub fn sync_resolve(
    state: State<'_, AppState>,
    project_id: String,
    choice: String,
) -> Result<SyncResolveResult, String> {
    let connection = open(&state)?;
    let Some((profile_id, _, _)) = active_profile(&connection)? else {
        return Err("configure a sync endpoint first".to_string());
    };
    let project = sync_project_id(&json!({ "projectId": project_id }));
    if choice == "local" {
        connection
            .execute(
                "UPDATE sync_metadata SET state = 'pending', local_revision = local_revision + 1, error_message = NULL WHERE profile_id = ?1 AND entity_type = 'project' AND entity_id = ?2",
                params![profile_id, project],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                r#"
                INSERT INTO sync_queue (profile_id, entity_type, entity_id, operation, state, next_attempt_at)
                VALUES (?1, 'project', ?2, 'push', 'queued', ?3)
                ON CONFLICT (profile_id, entity_type, entity_id, operation) DO UPDATE SET
                    state = 'queued', last_error = NULL, next_attempt_at = excluded.next_attempt_at
                "#,
                params![profile_id, project, now_iso()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(SyncResolveResult {
            action: "push".to_string(),
            draft: None,
        });
    }
    if choice == "remote" {
        let incoming = state.data_dir.join("sync").join("incoming").join(format!("{project}.json"));
        let draft = std::fs::read(&incoming)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or_else(|| "the remote draft is no longer available; pull again".to_string())?;
        connection
            .execute(
                "UPDATE sync_metadata SET state = 'synced', last_synced_at = ?1, error_message = NULL WHERE profile_id = ?2 AND entity_type = 'project' AND entity_id = ?3",
                params![now_iso(), profile_id, project],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE sync_queue SET state = 'cancelled', updated_at = ?1 WHERE profile_id = ?2 AND entity_type = 'project' AND entity_id = ?3 AND state IN ('queued','inflight')",
                params![now_iso(), profile_id, project],
            )
            .map_err(|error| error.to_string())?;
        return Ok(SyncResolveResult {
            action: "apply".to_string(),
            draft: Some(draft),
        });
    }
    Err("conflict choice must be 'local' or 'remote'".to_string())
}

#[cfg(test)]
mod asset_path_tests {
    use super::*;

    /// The pack layout that broke the catalogue: an export created inside a pack
    /// was later hoisted next to it, leaving every recorded path one folder off.
    fn moved_pack() -> (PathBuf, PathBuf, LocalPathIndex) {
        let base = std::env::temp_dir().join(format!("koba-paths-{}", uuid::Uuid::new_v4()));
        let root = base.join("KOBAeditASSETS");
        let hoisted = root.join("KOBAedit1/Assets/PrefabHierarchyObject/peperomia_d.glb");
        std::fs::create_dir_all(hoisted.parent().unwrap()).unwrap();
        std::fs::write(&hoisted, b"glb").unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        let index = build_local_path_index(&roots);
        (base, hoisted, index)
    }

    #[test]
    fn stale_paths_repoint_to_the_moved_file() {
        let (base, hoisted, index) = moved_pack();
        let root = base.join("KOBAeditASSETS");
        let stale = root.join("KOBAedit2/KOBAedit1/Assets/PrefabHierarchyObject/peperomia_d.glb");
        assert!(!stale.exists());

        let resolved = resolve_with_index(&index, &stale.to_string_lossy()).expect("resolve stale");
        assert_eq!(Path::new(&resolved), hoisted);
        assert_eq!(
            resolve_with_index(&index, &hoisted.to_string_lossy()).as_deref(),
            Some(hoisted.to_string_lossy().as_ref())
        );
        let unknown = root.join("KOBAedit9/Assets/nope.glb");
        assert!(resolve_with_index(&index, &unknown.to_string_lossy()).is_none());
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn duplicate_names_prefer_the_deepest_matching_folder() {
        let base = std::env::temp_dir().join(format!("koba-dupes-{}", uuid::Uuid::new_v4()));
        let first = base.join("KOBAedit1/Assets/Mesh/door.glb");
        let second = base.join("KOBAedit2/Assets/Mesh/door.glb");
        for path in [&first, &second] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"glb").unwrap();
        }
        let roots = vec![base.to_string_lossy().into_owned()];
        let index = build_local_path_index(&roots);
        // The second copy is gone; the surviving one is an equally named file in
        // another pack, so only the trailing folders can tell them apart.
        std::fs::remove_dir_all(base.join("KOBAedit2/Assets/Mesh")).unwrap();
        let recorded = base.join("KOBAedit2/Assets/Mesh/door.glb");
        let resolved = resolve_with_index(&index, &recorded.to_string_lossy()).expect("resolve");
        assert_eq!(
            Path::new(&resolved).file_name(),
            Some(std::ffi::OsStr::new("door.glb"))
        );
        assert!(Path::new(&resolved).is_file());
        std::fs::remove_dir_all(base).ok();
    }

    /// End-to-end on a copy of the workspace catalogue: the repair must resolve
    /// the rows whose pack was moved, and every rewritten path must exist.
    #[test]
    fn workspace_catalogue_paths_are_repaired_on_a_copy() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("data")
            .join("rust-studio.db");
        if !source.exists() {
            eprintln!("skipping: workspace data/rust-studio.db is not present");
            return;
        }
        let copy = std::env::temp_dir().join(format!("koba-catalogue-{}.db", uuid::Uuid::new_v4()));
        std::fs::copy(&source, &copy).expect("copy catalogue");
        let connection = Connection::open(&copy).expect("open copy");

        let mut roots = asset_roots_for(&connection);
        if roots.is_empty() {
            if let Ok(mut statement) = connection.prepare("SELECT DISTINCT root_path FROM local_assets") {
                if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
                    roots = rows.flatten().filter(|root| Path::new(root).is_dir()).collect();
                }
            }
        }
        if roots.is_empty() {
            eprintln!("skipping: no saved asset roots on this machine");
            std::fs::remove_file(&copy).ok();
            return;
        }

        let index = build_local_path_index(&roots);
        let repair = repair_local_paths(&connection, &index);
        // An already-repaired catalogue is a valid state (the app repairs on
        // launch), so the count may be zero; the invariants below are the test.
        assert!(repair.checked > 0, "the catalogue is empty");

        // A row may only stay unresolved when no file of that name exists under
        // the saved roots at all (deleted exports, not moved ones).
        let mut unresolved = 0;
        let mut statement = connection
            .prepare("SELECT DISTINCT asset_path FROM local_assets")
            .unwrap();
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).unwrap();
        for path in rows.flatten() {
            if Path::new(&path).is_file() {
                continue;
            }
            unresolved += 1;
            let name = Path::new(&path)
                .file_name()
                .map(|value| value.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            assert!(
                !index.files.contains_key(&name),
                "moved file left unresolved: {path}"
            );
        }
        eprintln!(
            "repaired {} of {} paths, {unresolved} permanently gone",
            repair.repaired, repair.checked
        );
        assert_eq!(unresolved as i64, repair.missing);

        let mut broken = 0;
        let mut statement = connection
            .prepare("SELECT asset_path FROM local_assets LIMIT 500")
            .unwrap();
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).unwrap();
        for path in rows.flatten() {
            if !Path::new(&path).is_file() {
                broken += 1;
            }
        }
        assert_eq!(broken, 0, "repaired rows still point at missing files");
        eprintln!("repaired {} of {} catalogue paths", repair.repaired, repair.checked);
        std::fs::remove_file(&copy).ok();
    }

    fn mesh_database(stale: &str) -> Connection {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE local_assets (asset_path TEXT, category TEXT);
                 CREATE TABLE base_meshes (asset_path TEXT);",
            )
            .expect("fixture schema");
        connection
            .execute(
                "INSERT INTO local_assets VALUES (?1, 'mesh')",
                params![stale],
            )
            .unwrap();
        connection
    }

    #[test]
    fn load_path_reads_a_mesh_through_a_moved_pack() {
        let (base, hoisted, index) = moved_pack();
        let root = base.join("KOBAeditASSETS");
        let roots = vec![root.to_string_lossy().into_owned()];
        let stale = root.join("KOBAedit2/KOBAedit1/Assets/PrefabHierarchyObject/peperomia_d.glb");
        let connection = mesh_database(&stale.to_string_lossy());

        let recorded = stale.to_string_lossy();
        let resolved = resolve_with_index(&index, &recorded).expect("resolve the moved mesh");
        let bytes = read_catalogued_mesh(&connection, Some(&resolved), &roots, &recorded)
            .expect("load through the moved pack");
        assert_eq!(bytes, b"glb");

        // The row is repaired on the way out, so the next load costs one stat.
        let stored: String = connection
            .query_row("SELECT asset_path FROM local_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(Path::new(&stored), hoisted);
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn load_path_accepts_pack_relative_base_meshes() {
        let (base, _hoisted, index) = moved_pack();
        let roots = vec![base
            .join("KOBAeditASSETS")
            .to_string_lossy()
            .into_owned()];
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE local_assets (asset_path TEXT, category TEXT);
                 CREATE TABLE base_meshes (asset_path TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO base_meshes VALUES (?1)",
                params!["Assets/PrefabHierarchyObject/peperomia_d.glb"],
            )
            .unwrap();

        let recorded = "Assets/PrefabHierarchyObject/peperomia_d.glb";
        let resolved = resolve_with_index(&index, recorded).expect("resolve the base mesh");
        let bytes = read_catalogued_mesh(&connection, Some(&resolved), &roots, recorded)
            .expect("load a pack-relative base mesh");
        assert_eq!(bytes, b"glb");

        // An unresolvable path must fail instead of reading something else.
        let error = read_catalogued_mesh(&connection, None, &roots, recorded)
            .expect_err("a missing file cannot load");
        assert!(error.contains("missing from the saved asset folders"));
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn texture_load_path_follows_a_moved_pack() {
        let base = std::env::temp_dir().join(format!("koba-tex-{}", uuid::Uuid::new_v4()));
        let root = base.join("KOBAeditASSETS");
        let hoisted = root.join("KOBAedit3/Assets/Texture2D/metal.png");
        std::fs::create_dir_all(hoisted.parent().unwrap()).unwrap();
        std::fs::write(&hoisted, b"\x89PNG\r\n\x1a\n").unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        let index = build_local_path_index(&roots);
        let stale = root.join("KOBAedit2/KOBAedit3/Assets/Texture2D/metal.png");

        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE local_assets (
                   asset_path TEXT, category TEXT, name TEXT, name_key TEXT, file_bytes INTEGER
                 );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO local_assets VALUES (?1, 'texture2d', 'metal', 'metal.png', 8)",
                params![stale.to_string_lossy()],
            )
            .unwrap();

        let resolved = resolve_catalogued_texture(&connection, &index, &roots, "metal.png")
            .expect("texture lookup")
            .expect("texture path");
        assert_eq!(Path::new(&resolved), hoisted);
        assert!(Path::new(&resolved).is_file());
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn repair_rewrites_moved_rows_and_counts_unresolved_files() {
        let (base, hoisted, index) = moved_pack();
        let root = base.join("KOBAeditASSETS");
        let stale = root.join("KOBAedit2/KOBAedit1/Assets/PrefabHierarchyObject/peperomia_d.glb");
        let gone = root.join("KOBAedit9/Assets/nothing.glb");
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE local_assets (asset_path TEXT);
                 CREATE TABLE base_meshes (asset_path TEXT);",
            )
            .expect("fixture schema");
        connection
            .execute(
                "INSERT INTO local_assets VALUES (?1), (?2)",
                params![stale.to_string_lossy(), gone.to_string_lossy()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO base_meshes VALUES (?1)",
                params![stale.to_string_lossy()],
            )
            .unwrap();

        let repair = repair_local_paths(&connection, &index);
        assert_eq!(repair.checked, 2);
        assert_eq!(repair.repaired, 1);
        assert_eq!(repair.missing, 1);

        let repaired: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM local_assets WHERE asset_path = ?1",
                params![hoisted.to_string_lossy()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(repaired, 1, "the catalogue row must point at the real file");
        // Pack-relative base meshes keep their stored path; readers resolve it.
        let base_untouched: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM base_meshes WHERE asset_path = ?1",
                params![stale.to_string_lossy()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(base_untouched, 1);
        let still_missing: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM local_assets WHERE asset_path = ?1",
                params![gone.to_string_lossy()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_missing, 1, "an unresolved row is kept, never deleted");
        std::fs::remove_dir_all(base).ok();
    }
}
