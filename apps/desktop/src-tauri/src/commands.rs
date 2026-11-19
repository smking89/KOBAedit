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
    Ok(())
}

fn open(state: &AppState) -> Result<Connection, String> {
    let connection = Connection::open(&state.db_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(|error| error.to_string())?;
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

#[tauri::command]
pub fn index_stats(state: State<'_, AppState>) -> Result<IndexStats, String> {
    let connection = open(&state)?;
    let count = |table: &str| -> Result<i64, String> {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .map_err(|error| error.to_string())
    };
    let packs = count("asset_packs")?;
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
        indexed: packs > 0,
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
        "SELECT root_path FROM asset_packs ORDER BY id LIMIT 1",
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
             ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
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
               FROM base_meshes ORDER BY item_kind, name LIMIT 5000",
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
        .arg("rust_studio_engine")
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
pub fn scan_rust_bundles(state: State<'_, AppState>, root: String) -> Result<(), String> {
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
        .arg(&progress)
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
    Err(format!(
        "no native folder picker is available; install zenity or type the path"
    ))
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
        .arg("rust_studio_engine")
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
