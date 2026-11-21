use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::tasks::TaskStatus;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

pub fn cache_root() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KOBA_CACHE_DIR") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(path).join("koba-edit"));
    }
    Ok(home_dir()?.join(".cache").join("koba-edit"))
}

fn safe_key(value: &str) -> Result<String, String> {
    let key = value.trim();
    if key.is_empty()
        || key.len() > 160
        || !key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        || key.contains("..")
    {
        return Err("cache key must be a plain file name".to_string());
    }
    Ok(key.to_string())
}

fn thumbnail_path(key: &str) -> Result<PathBuf, String> {
    Ok(cache_root()?.join("thumbs").join(format!("{}.png", safe_key(key)?)))
}

fn project_thumbnail_path(data_dir: &Path, key: &str) -> Result<PathBuf, String> {
    Ok(data_dir
        .join("thumbnails")
        .join(format!("{}.png", safe_key(key)?)))
}

fn mesh_path(key: &str) -> Result<PathBuf, String> {
    Ok(cache_root()?.join("meshes").join(format!("{}.glb", safe_key(key)?)))
}

struct ThumbnailWrite {
    path: PathBuf,
    bytes: Vec<u8>,
    data_dir: PathBuf,
}

/// Three bounded writers share PNG encoding I/O. Rendering stays on the
/// webview thread (it owns the GL context), but disk writes and pruning do not
/// block the next card.
fn thumbnail_writers() -> &'static SyncSender<ThumbnailWrite> {
    static WRITERS: OnceLock<SyncSender<ThumbnailWrite>> = OnceLock::new();
    WRITERS.get_or_init(|| {
        let (sender, receiver) = sync_channel::<ThumbnailWrite>(32);
        let receiver = std::sync::Arc::new(std::sync::Mutex::new(receiver));
        for _ in 0..3 {
            let receiver = receiver.clone();
            std::thread::spawn(move || loop {
                let job = {
                    let guard = match receiver.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    match guard.recv() {
                        Ok(job) => job,
                        Err(_) => return,
                    }
                };
                let _ = write_atomic(&job.path, &job.bytes);
                // Pruning walks both cache buckets; doing it per PNG made bulk
                // card generation quadratic in the number of files. Prune every
                // Nth write instead; `enforce_cache_limit` still covers exact
                // limits on demand.
                if writes_until_prune() {
                    let _ = prune_to(read_cache_limit(&job.data_dir));
                }
            });
        }
        sender
    })
}

fn newer_than(png: &Path, source: &Path) -> bool {
    let png_time = std::fs::metadata(png).and_then(|meta| meta.modified()).ok();
    let source_time = std::fs::metadata(source).and_then(|meta| meta.modified()).ok();
    match (png_time, source_time) {
        (Some(png_time), Some(source_time)) => png_time >= source_time,
        _ => true,
    }
}

/// Writers run in parallel and two cards can resolve to the same key, so every
/// write gets its own temporary name. A shared `<key>.tmp` let one worker
/// rename another worker's half-written PNG into place.
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const WRITES_PER_PRUNE: u64 = 32;
static WRITES_SINCE_PRUNE: AtomicU64 = AtomicU64::new(0);

fn should_prune(sequence: u64) -> bool {
    sequence % WRITES_PER_PRUNE == 0
}

/// True on every Nth completed write. Workers share the counter, so the number
/// of prunes per batch stays bounded no matter how many threads run.
fn writes_until_prune() -> bool {
    should_prune(WRITES_SINCE_PRUNE.fetch_add(1, Ordering::Relaxed))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "cache path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("thumbnail");
    let temporary = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(error) = std::fs::write(&temporary, bytes) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    // Windows cannot rename over an existing PNG; a concurrent rewrite of the
    // same hash has to replace it explicitly.
    let renamed = std::fs::rename(&temporary, path).or_else(|_| {
        std::fs::remove_file(path).and_then(|_| std::fs::rename(&temporary, path))
    });
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    renamed.map_err(|error| format!("could not write {}: {error}", path.display()))
}

#[tauri::command]
pub fn save_prefab_thumbnail(
    state: State<'_, AppState>,
    prefab_hash: String,
    png_base64: String,
) -> Result<String, String> {
    let payload = png_base64
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(&png_base64);
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|error| format!("invalid PNG base64: {error}"))?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("thumbnail payload is not a PNG".to_string());
    }
    let path = project_thumbnail_path(&state.data_dir, &prefab_hash)?;
    let job = ThumbnailWrite {
        path: path.clone(),
        bytes,
        data_dir: state.data_dir.clone(),
    };
    thumbnail_writers()
        .try_send(job)
        .map_err(|error| format!("thumbnail queue is full: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_thumbnail_path(prefab_hash: String) -> Result<Option<String>, String> {
    let path = thumbnail_path(&prefab_hash)?;
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn get_thumbnail_data(
    state: State<'_, AppState>,
    prefab_hash: String,
    source_path: Option<String>,
) -> Result<Option<String>, String> {
    let fresh = project_thumbnail_path(&state.data_dir, &prefab_hash)?;
    // Read legacy cache entries too, so upgrading does not blank the drawer.
    let path = if fresh.is_file() {
        fresh
    } else {
        thumbnail_path(&prefab_hash)?
    };
    if !path.is_file() {
        return Ok(None);
    }
    // A cached PNG older than the GLB is stale: let the frontend regenerate it.
    if let Some(source) = source_path.filter(|value| !value.trim().is_empty()) {
        if !newer_than(&path, Path::new(source.trim())) {
            return Ok(None);
        }
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes)
    )))
}

#[tauri::command]
pub fn load_cached_mesh_bytes(prefab_hash: String) -> Result<Vec<u8>, String> {
    let path = mesh_path(&prefab_hash)?;
    std::fs::read(&path).map_err(|error| {
        format!(
            "no cached GLB for {} ({}): {error}",
            prefab_hash,
            path.display()
        )
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustInstall {
    pub root: String,
    pub bundles: Vec<String>,
    pub source: String,
    pub found: bool,
}

/// Default Steam Rust `Bundles` folders for the OS KOBA Studios is running on.
/// The manual picker (`pick_bundle_folder`) and `RUST_BUNDLES_DIR` remain the
/// fallback for custom libraries, the web build and iPadOS.
fn steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let programs = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let programs_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
        for base in [programs, programs_x86].into_iter().flatten() {
            roots.push(
                base.join("Steam")
                    .join("steamapps")
                    .join("common")
                    .join("Rust")
                    .join("Bundles"),
            );
            roots.push(
                base.join("SteamLibrary")
                    .join("steamapps")
                    .join("common")
                    .join("Rust")
                    .join("Bundles"),
            );
        }
        for drive in ["C:\\", "D:\\", "E:\\"] {
            roots.push(Path::new(drive).join("SteamLibrary").join("steamapps").join("common").join("Rust").join("Bundles"));
            roots.push(Path::new(drive).join("Program Files (x86)").join("Steam").join("steamapps").join("common").join("Rust").join("Bundles"));
        }
    }

    if let Ok(home) = home_dir() {
        roots.extend([
            home.join(".steam/steam/steamapps/common/Rust/Bundles"),
            home.join(".local/share/Steam/steamapps/common/Rust/Bundles"),
            home.join(
                ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Rust/Bundles",
            ),
            // macOS and the iPadOS sandbox (the picker still handles real bundles).
            home.join("Library/Application Support/Steam/steamapps/common/Rust/Bundles"),
        ]);
    }
    roots
}

fn read_bundles(root: &Path, source: &str) -> RustInstall {
    let mut bundles = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("bundle") {
                bundles.push(path.to_string_lossy().into_owned());
            }
        }
    }
    bundles.sort();
    RustInstall {
        root: root.to_string_lossy().into_owned(),
        found: !bundles.is_empty(),
        bundles,
        source: source.to_string(),
    }
}

#[tauri::command]
pub fn find_rust_install(root: Option<String>) -> Result<RustInstall, String> {
    if let Some(value) = root.filter(|value| !value.trim().is_empty()) {
        return Ok(read_bundles(Path::new(&value), "selected"));
    }
    if let Some(value) = std::env::var_os("RUST_BUNDLES_DIR") {
        let found = read_bundles(Path::new(&value), "environment");
        if found.found {
            return Ok(found);
        }
    }
    for candidate in steam_roots() {
        let found = read_bundles(&candidate, "steam");
        if found.found {
            return Ok(found);
        }
    }
    Ok(RustInstall {
        root: String::new(),
        bundles: Vec::new(),
        source: "not-found".to_string(),
        found: false,
    })
}



fn python(project_root: &Path) -> PathBuf {
    crate::commands::python(project_root)
}

#[tauri::command]
pub fn extract_prefab_glb(
    state: State<'_, AppState>,
    prefab_path: String,
    bundle_root: Option<String>,
) -> Result<(), String> {
    let root = bundle_root
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            find_rust_install(None)
                .ok()
                .filter(|install| install.found)
                .map(|install| PathBuf::from(install.root))
        })
        .ok_or_else(|| "Rust Bundles folder is not linked".to_string())?;
    let cache = cache_root()?;
    let progress = state
        .data_dir
        .join("sync")
        .join("progress")
        .join("prefab.jsonl");
    let mut command = Command::new(python(&state.project_root));
    command
        .arg("-m")
        .arg("koba_engine")
        .arg("export-prefab-glb")
        .arg("--prefab")
        .arg(&prefab_path)
        .arg("--bundle-root")
        .arg(&root)
        .arg("--cache-dir")
        .arg(cache.join("meshes"))
        .arg("--json")
        .arg("--progress")
        .arg(&progress)
        // The engine keeps one bundle resident across extractions; the CLI
        // process above is only a thin client for the drawer's task plumbing.
        .arg("--daemon-socket")
        .arg(cache.join("extract.sock"))
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir);
    state
        .tasks
        .start_prefab(command, progress, &format!("GLB extraction: {prefab_path}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonumentPreviewReport {
    pub monuments: u64,
    pub rendered: u64,
    pub missing: u64,
}

/// Render each monument's shipped terrain height map into the thumbnail cache.
/// The drawer looks thumbnails up by prefab hash, so the PNGs appear without a
/// database change. Runs in the engine because it needs the bundle textures.
#[tauri::command]
pub async fn render_monument_previews(
    state: State<'_, AppState>,
    bundle_root: String,
) -> Result<MonumentPreviewReport, String> {
    let thumbs = cache_root()?.join("thumbs");
    std::fs::create_dir_all(&thumbs).map_err(|error| error.to_string())?;
    let output = Command::new(python(&state.project_root))
        .arg("-m")
        .arg("koba_engine")
        .arg("monument-previews")
        .arg("--bundle-root")
        .arg(&bundle_root)
        .arg("--cache-dir")
        .arg(&thumbs)
        .arg("--json")
        .current_dir(&state.project_root)
        .env("PYTHONPATH", &state.engine_dir)
        .output()
        .map_err(|error| format!("could not start the engine: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(message.trim().lines().last().unwrap_or("monument previews failed").to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("unexpected engine response: {error}"))?;
    Ok(MonumentPreviewReport {
        monuments: value.get("monuments").and_then(|v| v.as_u64()).unwrap_or(0),
        rendered: value.get("rendered").and_then(|v| v.as_u64()).unwrap_or(0),
        missing: value.get("missing").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

#[tauri::command]
pub fn prefab_extraction_status(state: State<'_, AppState>) -> TaskStatus {
    state.tasks.prefab_status()
}

#[tauri::command]
pub fn cancel_prefab_extraction(state: State<'_, AppState>) -> Result<(), String> {
    state.tasks.cancel_prefab()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBucket {
    pub files: u64,
    pub bytes: u64,
}

const DEFAULT_CACHE_LIMIT_MB: u64 = 512;
const MIN_CACHE_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CACHE_LIMIT_BYTES: u64 = 64 * 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheSettings {
    limit_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub root: String,
    pub meshes: CacheBucket,
    pub thumbs: CacheBucket,
    pub total_bytes: u64,
    pub limit_bytes: u64,
}

fn cache_settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cache-settings.json")
}

/// Saved limit wins; `KOBA_CACHE_LIMIT_MB` is the default until the user saves one.
pub fn read_cache_limit(data_dir: &Path) -> u64 {
    if let Ok(text) = std::fs::read_to_string(cache_settings_path(data_dir)) {
        if let Ok(settings) = serde_json::from_str::<CacheSettings>(&text) {
            if settings.limit_bytes > 0 {
                return settings.limit_bytes.clamp(MIN_CACHE_LIMIT_BYTES, MAX_CACHE_LIMIT_BYTES);
            }
        }
    }
    let megabytes = std::env::var("KOBA_CACHE_LIMIT_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_CACHE_LIMIT_MB);
    megabytes
        .saturating_mul(1024 * 1024)
        .clamp(MIN_CACHE_LIMIT_BYTES, MAX_CACHE_LIMIT_BYTES)
}

fn write_cache_limit(data_dir: &Path, limit_bytes: u64) -> Result<u64, String> {
    let limit = limit_bytes.clamp(MIN_CACHE_LIMIT_BYTES, MAX_CACHE_LIMIT_BYTES);
    std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let payload = serde_json::to_vec_pretty(&CacheSettings { limit_bytes: limit })
        .map_err(|error| error.to_string())?;
    let path = cache_settings_path(data_dir);
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, payload).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(limit)
}

fn bucket_stats(path: &Path) -> CacheBucket {
    let mut files = 0u64;
    let mut bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    files += 1;
                    bytes += metadata.len();
                }
            }
        }
    }
    CacheBucket { files, bytes }
}

fn stats_for(root: &Path, limit_bytes: u64) -> CacheStats {
    let meshes = bucket_stats(&root.join("meshes"));
    let thumbs = bucket_stats(&root.join("thumbs"));
    CacheStats {
        root: root.to_string_lossy().into_owned(),
        total_bytes: meshes.bytes + thumbs.bytes,
        limit_bytes,
        meshes,
        thumbs,
    }
}

#[tauri::command]
pub fn cache_stats(state: State<'_, AppState>) -> Result<CacheStats, String> {
    let root = cache_root()?;
    Ok(stats_for(&root, read_cache_limit(&state.data_dir)))
}

fn prune_bucket(path: &Path, remove_bytes: &mut u64) -> Result<u64, String> {
    let mut entries: Vec<(std::time::SystemTime, PathBuf, u64)> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(path) {
        for entry in read_dir.flatten() {
            let entry_path = entry.path();
            let Ok(metadata) = entry.metadata() else { continue };
            if !metadata.is_file() {
                continue;
            }
            let extension = entry_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(extension.as_str(), "glb" | "png" | "obj") {
                continue;
            }
            let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
            entries.push((modified, entry_path, metadata.len()));
        }
    }
    entries.sort_by_key(|entry| entry.0);
    let mut removed = 0u64;
    for (_, entry_path, bytes) in entries {
        if *remove_bytes == 0 {
            break;
        }
        std::fs::remove_file(&entry_path).map_err(|error| {
            format!("could not remove {}: {error}", entry_path.display())
        })?;
        *remove_bytes = remove_bytes.saturating_sub(bytes);
        removed += 1;
    }
    Ok(removed)
}

fn prune_to(limit_bytes: u64) -> Result<CacheStats, String> {
    let limit = limit_bytes.clamp(MIN_CACHE_LIMIT_BYTES, MAX_CACHE_LIMIT_BYTES);
    let root = cache_root()?;
    let meshes_path = root.join("meshes");
    let thumbs_path = root.join("thumbs");
    let meshes = bucket_stats(&meshes_path);
    let thumbs = bucket_stats(&thumbs_path);
    let total = meshes.bytes + thumbs.bytes;
    if total > limit {
        // Keep the two caches proportional to their current size so a large
        // mesh cache cannot evict every thumbnail (or the reverse).
        let mesh_keep = ((limit as u128 * meshes.bytes as u128 / total as u128) as u64)
            .min(meshes.bytes);
        let thumb_keep = limit.saturating_sub(mesh_keep).min(thumbs.bytes);
        let mut mesh_remove = meshes.bytes.saturating_sub(mesh_keep);
        let mut thumb_remove = thumbs.bytes.saturating_sub(thumb_keep);
        prune_bucket(&meshes_path, &mut mesh_remove)?;
        prune_bucket(&thumbs_path, &mut thumb_remove)?;
    }
    Ok(stats_for(&root, limit))
}

#[tauri::command]
pub fn prune_cache(
    state: State<'_, AppState>,
    limit_bytes: u64,
) -> Result<CacheStats, String> {
    let limit = write_cache_limit(&state.data_dir, limit_bytes)?;
    prune_to(limit)
}

#[tauri::command]
pub fn enforce_cache_limit(state: State<'_, AppState>) -> Result<CacheStats, String> {
    prune_to(read_cache_limit(&state.data_dir))
}

#[cfg(test)]
mod tests {
    use super::{
        prune_bucket, read_cache_limit, safe_key, write_cache_limit, MIN_CACHE_LIMIT_BYTES,
    };

    #[test]
    fn cache_prune_removes_old_cache_files_only() {
        let root = std::env::temp_dir().join(format!(
            "koba-cache-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.glb"), vec![0u8; 10]).unwrap();
        std::fs::write(root.join("b.png"), vec![0u8; 10]).unwrap();
        std::fs::write(root.join("keep.txt"), b"not cache").unwrap();
        let mut remove = 20u64;
        let removed = prune_bucket(&root, &mut remove).unwrap();
        assert_eq!(removed, 2);
        assert!(root.join("keep.txt").is_file());
        assert!(!root.join("a.glb").is_file());
        assert!(!root.join("b.png").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_limit_is_saved_and_clamped() {
        let dir = std::env::temp_dir().join(format!(
            "koba-cache-limit-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let saved = write_cache_limit(&dir, 96 * 1024 * 1024).unwrap();
        assert_eq!(saved, 96 * 1024 * 1024);
        assert_eq!(read_cache_limit(&dir), 96 * 1024 * 1024);
        let text = std::fs::read_to_string(dir.join("cache-settings.json")).unwrap();
        assert!(text.contains("\"limitBytes\""));
        assert_eq!(write_cache_limit(&dir, 1).unwrap(), MIN_CACHE_LIMIT_BYTES);
        assert_eq!(read_cache_limit(&dir), MIN_CACHE_LIMIT_BYTES);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cache_pruning_runs_once_per_write_batch_window() {
        let prunes = (0..96).filter(|sequence| super::should_prune(*sequence)).count();
        assert_eq!(prunes, 3);
    }

    #[test]
    fn concurrent_thumbnail_writes_leave_one_complete_png() {
        let root = std::env::temp_dir().join(format!(
            "koba-thumb-race-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("same.png");
        let mut workers = Vec::new();
        for index in 0..8u8 {
            let path = path.clone();
            workers.push(std::thread::spawn(move || {
                super::write_atomic(&path, &vec![index; 4096])
            }));
        }
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 4096);
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_keys_cannot_escape_the_cache_directory() {
        assert!(safe_key("abc123").is_ok());
        assert!(safe_key("monument_1234").is_ok());
        assert!(safe_key("../secret").is_err());
        assert!(safe_key("a/b").is_err());
        assert!(safe_key("").is_err());
    }
}
