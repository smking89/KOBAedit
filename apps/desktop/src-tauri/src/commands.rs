use std::path::PathBuf;
use std::process::Command;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use world_codec::{parse_file, WorldSummary};

pub struct AppState {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub engine_dir: PathBuf,
    pub project_root: PathBuf,
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
pub struct SyncStatus {
    pub active: bool,
    pub pending: i64,
    pub conflicts: i64,
    pub last_sync_at: Option<String>,
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

fn python() -> String {
    std::env::var("RUST_STUDIO_PYTHON").unwrap_or_else(|_| "python3".to_string())
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

fn prefab_rows(connection: &Connection) -> Result<Vec<PrefabAssetRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT asset_path, name, category, bounds_min_x, bounds_min_y, bounds_min_z,
                    bounds_max_x, bounds_max_y, bounds_max_z, flatten_radius,
                    has_loot, has_io, has_npc, thumbnail_path
               FROM prefabs ORDER BY category, name LIMIT 5000",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
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
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_base_meshes(state: State<'_, AppState>) -> Result<Vec<BaseMeshRow>, String> {
    let connection = open(&state)?;
    base_mesh_rows(&connection)
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
        assert!(bounded > 0, "native bounds were not populated");

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

    let output = Command::new(python())
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
    let output = Command::new(python())
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

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let connection = open(&state)?;
    let profile: Option<(i64, Option<String>)> = connection
        .query_row(
            "SELECT id, last_sync_at FROM sync_profiles WHERE is_active = 1 LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    let Some((profile_id, last_sync_at)) = profile else {
        return Ok(SyncStatus {
            active: false,
            pending: 0,
            conflicts: 0,
            last_sync_at: None,
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

    Ok(SyncStatus {
        active: true,
        pending,
        conflicts,
        last_sync_at,
    })
}
