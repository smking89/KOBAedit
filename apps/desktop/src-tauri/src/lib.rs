mod commands;

use std::path::PathBuf;

use commands::AppState;

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn data_dir() -> PathBuf {
    std::env::var("RUST_STUDIO_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root().join("data"))
}

fn engine_dir() -> PathBuf {
    std::env::var("RUST_STUDIO_ENGINE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root().join("engine"))
}

pub fn run() {
    let root = project_root();
    let data = data_dir();
    let _ = std::fs::create_dir_all(&data);

    let state = AppState {
        data_dir: data.clone(),
        db_path: data.join("rust-studio.db"),
        engine_dir: engine_dir(),
        project_root: root,
    };

    if let Err(error) = commands::initialize(&state) {
        eprintln!("database initialization failed: {error}");
    }

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::index_stats,
            commands::list_prefabs,
            commands::list_base_meshes,
            commands::inspect_map,
            commands::save_project,
            commands::export_project,
            commands::ingest_assets,
            commands::sync_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rust Studio");
}
