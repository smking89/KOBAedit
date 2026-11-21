mod commands;
mod snapshots;
mod tasks;
mod thumbnails;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use commands::AppState;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Set once the main window has shown. Startup work and the watchdog both check
/// it so the handover happens exactly once.
static MAIN_READY: AtomicBool = AtomicBool::new(false);

/// A frontend that never reports ready must not leave the user stuck on splash.
const MAIN_READY_TIMEOUT_SECS: u64 = 15;

/// The workspace usually mounts faster than a single hero crossfade, which would
/// reduce the splash to a flash. Hold it long enough to read the status line and
/// see the wordmark at rest before handing over.
const MIN_SPLASH_MS: u128 = 2400;

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Latest stage pushed at the splash. The shell starts indexing in `setup`, so
/// its first events can be emitted before the splash window has loaded and
/// registered a listener; `splash_state` lets a late window pull the current
/// stage instead of sitting at zero.
static SPLASH_PERCENT: AtomicU8 = AtomicU8::new(0);

/// A URL that launched the app before the workspace could subscribe.
/// `take_pending_deep_link` hands it over exactly once when the UI mounts.
static PENDING_DEEP_LINK: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();
/// Set when the workspace first asks for a parked URL. Until then every link is
/// parked instead of being emitted into a webview that has no listener yet.
static DEEP_LINK_READY: AtomicBool = AtomicBool::new(false);

fn pending_deep_link() -> &'static std::sync::Mutex<Option<String>> {
    PENDING_DEEP_LINK.get_or_init(|| std::sync::Mutex::new(None))
}

fn remember_deep_link(url: String) {
    if let Ok(mut slot) = pending_deep_link().lock() {
        *slot = Some(url);
    }
}

#[tauri::command]
fn take_pending_deep_link() -> Option<String> {
    DEEP_LINK_READY.store(true, Ordering::SeqCst);
    pending_deep_link().lock().ok().and_then(|mut slot| slot.take())
}
static SPLASH_MESSAGE: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();

fn splash_message() -> &'static std::sync::Mutex<String> {
    SPLASH_MESSAGE.get_or_init(|| std::sync::Mutex::new(String::new()))
}

/// Source checkout this binary was compiled from. Only debug builds (tauri dev)
/// trust it: a release build must never load code or data from a path baked in
/// at compile time, so installed apps always use their bundled resources.
fn dev_checkout() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)?;
    (root.join("engine").join("koba_engine").is_dir() && root.join("db").join("schema.sql").is_file())
        .then_some(root)
}

/// Windows resource paths can carry a `\\?\` prefix that Python and SQLite
/// do not always accept as a working directory or import path.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    }
}

/// Where the engine, schema and scripts live: the checkout in development,
/// the bundled resources in an installed app.
fn project_root(app: &tauri::App) -> PathBuf {
    if let Some(root) = dev_checkout() {
        return root;
    }
    app.path()
        .resource_dir()
        .map(plain_path)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Writable app data: `./data` in a checkout, the per-user app data folder
/// when installed (the install directory is read-only).
fn data_dir(app: &tauri::App) -> PathBuf {
    if let Ok(value) = std::env::var("RUST_STUDIO_DATA") {
        return PathBuf::from(value);
    }
    if let Some(root) = dev_checkout() {
        return root.join("data");
    }
    app.path()
        .app_data_dir()
        .map(plain_path)
        .unwrap_or_else(|_| PathBuf::from("data"))
}

fn engine_dir(root: &std::path::Path) -> PathBuf {
    std::env::var("RUST_STUDIO_ENGINE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("engine"))
}

fn splash_progress(app: &tauri::AppHandle, percent: u8, message: &str, advance_hero: bool) {
    SPLASH_PERCENT.store(percent.min(100), Ordering::SeqCst);
    if let Ok(mut slot) = splash_message().lock() {
        slot.clear();
        slot.push_str(message);
    }
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.emit(
            "splash://progress",
            serde_json::json!({
                "percent": percent,
                "message": message,
                "advanceHero": advance_hero,
            }),
        );
    }
}

/// Close the splash window and show the workspace. Idempotent: a late watchdog
/// or a second `app_ready` call is a no-op.
fn reveal_main(app: &tauri::AppHandle) {
    if MAIN_READY.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
}

/// The stage the shell has already reached, for a splash window that loaded
/// after those events were emitted.
#[tauri::command]
fn splash_state() -> serde_json::Value {
    let message = splash_message()
        .lock()
        .map(|slot| slot.clone())
        .unwrap_or_default();
    serde_json::json!({
        "percent": SPLASH_PERCENT.load(Ordering::SeqCst),
        "message": message,
    })
}

/// Map the splash window once its first frame is painted.
///
/// The window is created hidden so nobody sees the webview's unpainted frame,
/// and Rust maps it rather than the page so this works regardless of which IPC
/// window capabilities the splash webview was granted.
#[tauri::command]
fn splash_present(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.show();
        let _ = splash.set_focus();
    }
}

#[tauri::command]
fn app_ready(app: tauri::AppHandle) {
    let elapsed = STARTED.get().map(|start| start.elapsed().as_millis()).unwrap_or(u128::MAX);
    let remaining = MIN_SPLASH_MS.saturating_sub(elapsed);
    if remaining == 0 {
        reveal_main(&app);
        return;
    }
    // A fast mount still waits out the minimum; `reveal_main` is idempotent, so
    // a watchdog that fires in the meantime simply wins.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(remaining as u64));
        reveal_main(&app);
    });
}

/// Runs off the UI thread: the splash window is already painting and listens for
/// `splash://progress` while the index and caches are prepared.
fn startup(app: tauri::AppHandle) {
    let _ = STARTED.set(std::time::Instant::now());
    // Safety net: if the page never asks to be shown (slow asset, script error),
    // map the splash anyway rather than leaving the launch windowless.
    let splash_guard = app.clone();
    std::thread::spawn(move || {
        // The page presents itself as soon as its first hero is painted (~0.5 s);
        // this only catches a page that never gets there.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Some(splash) = splash_guard.get_webview_window("splashscreen") {
            let _ = splash.show();
        }
    });
    std::thread::spawn(move || {
        splash_progress(&app, 6, "Starting KOBA Studios", false);
        let state = app.state::<AppState>();

        if let Err(error) = commands::initialize(&state) {
            eprintln!("database initialization failed: {error}");
        }
        splash_progress(&app, 34, "Indexing local assets", true);

        let snapshot = commands::startup_snapshot(&state);
        splash_progress(
            &app,
            58,
            &format!("Checking Rust bundle cache ({} bundles)", snapshot.bundles),
            true,
        );
        splash_progress(
            &app,
            78,
            if snapshot.engine {
                "Starting KOBA engine"
            } else {
                "Engine sidecar not found"
            },
            true,
        );
        splash_progress(&app, 92, "Preparing 3D viewport", true);

        let watcher = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(MAIN_READY_TIMEOUT_SECS));
            if !MAIN_READY.load(Ordering::SeqCst) {
                eprintln!("[splash] main window never reported ready; revealing it anyway");
                reveal_main(&watcher);
            }
        });
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // State is built here because the install paths need the app handle.
            let root = project_root(app);
            let data = data_dir(app);
            let _ = std::fs::create_dir_all(&data);
            app.manage(commands::AppState {
                data_dir: data.clone(),
                db_path: data.join("rust-studio.db"),
                engine_dir: engine_dir(&root),
                project_root: root,
                tasks: tasks::TaskManager::default(),
                texture_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
                local_paths: std::sync::Mutex::new(None),
            });
            // Register kobastudios:// for this user. Bundled Linux packages also
            // ship the .desktop MimeType, but dev builds need this call.
            #[cfg(any(windows, target_os = "linux"))]
            if let Err(error) = app.deep_link().register_all() {
                eprintln!("deep-link registration failed: {error}");
            }
            // Warm starts arrive as an event the UI already listens for. A
            // cold start has no listener yet, so keep the URL parked until the
            // workspace asks for it; do not race the webview with a timer.
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if DEEP_LINK_READY.load(Ordering::SeqCst) {
                        let _ = deep_link_handle.emit("koba://deep-link", url.to_string());
                    } else {
                        // Park it; the workspace pulls it once its listener is up.
                        remember_deep_link(url.to_string());
                    }
                }
            });
            if let Some(url) = std::env::args().find(|arg| arg.starts_with("kobastudios://")) {
                remember_deep_link(url);
            }
            // The window is only usable once the shell reports it ready, so the
            // index/cache work happens behind the already-visible splash.
            startup(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            splash_state,
            splash_present,
            take_pending_deep_link,
            commands::index_stats,
            commands::list_prefabs,
            commands::browse_prefabs,
            commands::linked_bundle_root,
            commands::set_linked_bundle_root,
            commands::list_base_meshes,
            commands::browse_base_meshes,
            commands::browse_mesh_groups,
            commands::list_group_parts,
            commands::browse_placeable_meshes,
            commands::local_asset_status,
            commands::save_asset_roots,
            commands::scan_local_assets,
            commands::load_local_mesh,
            commands::local_texture,
            commands::repair_asset_paths,
            commands::get_base_mesh_thumbnail,
            commands::inspect_map,
            commands::save_project,
            commands::list_recent_projects,
            commands::load_project,
            commands::list_directories,
            commands::export_project,
            commands::engine_sketch,
            commands::engine_map_check,
            commands::engine_genesis,
            commands::engine_server_bundle,
            commands::ingest_assets,
            commands::scan_rust_bundles,
            commands::bundle_scan_status,
            commands::cancel_bundle_scan,
            commands::pick_bundle_folder,
            commands::queue_project_delta,
            commands::sync_status,
            commands::sync_configure,
            commands::sync_test,
            commands::sync_push,
            commands::sync_pull,
            commands::sync_resolve,
            thumbnails::save_prefab_thumbnail,
            thumbnails::get_thumbnail_path,
            thumbnails::get_thumbnail_data,
            thumbnails::load_cached_mesh_bytes,
            thumbnails::find_rust_install,
            thumbnails::extract_prefab_glb,
            thumbnails::render_monument_previews,
            thumbnails::prefab_extraction_status,
            thumbnails::cancel_prefab_extraction,
            thumbnails::cache_stats,
            thumbnails::prune_cache,
            thumbnails::enforce_cache_limit,
            snapshots::save_snapshot,
            snapshots::list_snapshots,
            snapshots::load_snapshot,
            snapshots::delete_snapshot,
        ])
        .build(tauri::generate_context!())
        .expect("error while building KOBA Studios")
        .run(|handle, event| {
            // Scans are child processes. If the window closes first they keep
            // indexing with no UI left to cancel them, so stop them on exit.
            if matches!(event, tauri::RunEvent::Exit) {
                let state = handle.state::<AppState>();
                let scan = state.tasks.cancel_scan();
                let prefab = state.tasks.cancel_prefab();
                eprintln!("[exit] cancelled engine tasks: scan={scan:?} prefab={prefab:?}");
            }
        });
}
