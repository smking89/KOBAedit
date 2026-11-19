import type { ExportReport, PrefabAsset, WizardDraft } from "../wizard/types";
import { DEMO_BASE_MESHES, DEMO_PREFABS, type BaseMeshAsset } from "./demoAssets";
import { prettifyPrefabName } from "./prefabName";

/**
 * Bridge to the Rust shell. In a browser (vite dev without Tauri) every call
 * resolves against a local mock so the full wizard remains usable; the UI marks
 * the session as demo data. No network request is ever made from here.
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

const MOCK_DELAY = 90;
const wait = (ms = MOCK_DELAY) => new Promise((resolve) => window.setTimeout(resolve, ms));

export interface MapSummary {
  file: string;
  version: number;
  size: number;
  heightResolution: number | null;
  splatResolution: number | null;
  prefabCount: number;
  pathCount: number;
  waterLevel: number;
  layers: Record<string, number>;
}

export interface IndexStats {
  packs: number;
  baseMeshes: number;
  prefabs: number;
  projects: number;
  queuedSync: number;
  indexed: boolean;
}

export async function indexStats(): Promise<IndexStats> {
  if (!isTauri()) {
    await wait();
    return { packs: 0, baseMeshes: 0, prefabs: 0, projects: 0, queuedSync: 0, indexed: false };
  }
  return invokeCommand<IndexStats>("index_stats");
}

export async function listPrefabs(): Promise<PrefabAsset[]> {
  if (!isTauri()) {
    await wait();
    return DEMO_PREFABS;
  }
  const rows = await invokeCommand<PrefabAsset[]>("list_prefabs");
  // The index stores Unity file stems; show readable names to the user while
  // keeping `id` as the asset path used for extraction and export.
  return (rows.length ? rows : DEMO_PREFABS).map((row) => ({
    ...row,
    name: prettifyPrefabName(row.name || row.id),
  }));
}

export interface PrefabPage {
  rows: PrefabAsset[];
  total: number;
  bounded: number;
  counts: Record<string, number>;
}

/**
 * One filtered page of the prefab catalogue. The index holds ~17.5k prefabs
 * (over 5 MB as JSON), so the drawer asks for a page instead of everything.
 */
export async function browsePrefabs(
  options: { category?: string; query?: string; limit?: number; offset?: number } = {},
): Promise<PrefabPage> {
  if (!isTauri()) {
    await wait();
    const needle = (options.query ?? "").trim().toLowerCase();
    const offset = options.offset ?? 0;
    const rows = DEMO_PREFABS.filter(
      (prefab) =>
        (!options.category || prefab.category === options.category) &&
        (!needle || `${prefab.name} ${prefab.id}`.toLowerCase().includes(needle)),
    ).slice(offset, offset + (options.limit ?? DEMO_PREFABS.length));
    const counts: Record<string, number> = {};
    for (const prefab of rows) counts[prefab.category] = (counts[prefab.category] ?? 0) + 1;
    return { rows, total: rows.length, bounded: rows.length, counts };
  }
  const page = await invokeCommand<PrefabPage>("browse_prefabs", {
    category: options.category ?? null,
    query: options.query?.trim() || null,
    limit: options.limit ?? null,
    offset: options.offset ?? null,
  });
  return {
    ...page,
    rows: page.rows.map((row) => ({ ...row, name: prettifyPrefabName(row.name || row.id) })),
  };
}

export interface MonumentPreviewReport {
  monuments: number;
  rendered: number;
  missing: number;
}

/** Render real monument terrain previews from the linked bundles. */
export async function renderMonumentPreviews(bundleRoot: string): Promise<MonumentPreviewReport> {
  if (!isTauri()) return { monuments: 0, rendered: 0, missing: 0 };
  return invokeCommand<MonumentPreviewReport>("render_monument_previews", { bundleRoot });
}

export async function listBaseMeshes(): Promise<BaseMeshAsset[]> {
  if (!isTauri()) {
    await wait();
    return DEMO_BASE_MESHES;
  }
  const rows = await invokeCommand<BaseMeshAsset[]>("list_base_meshes");
  return rows.length ? rows : DEMO_BASE_MESHES;
}

export async function getBaseMeshThumbnail(assetPath: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invokeCommand<string | null>("get_base_mesh_thumbnail", { assetPath });
  } catch {
    return null;
  }
}

export async function inspectMap(path: string): Promise<MapSummary> {
  if (!isTauri()) {
    await wait();
    return {
      file: path || "demo.map",
      version: 10,
      size: 4500,
      heightResolution: 2049,
      splatResolution: 2048,
      prefabCount: 1240,
      pathCount: 96,
      waterLevel: -8,
      layers: { terrain: 16_781_312, splat: 33_554_432, topology: 16_777_216 },
    };
  }
  return invokeCommand<MapSummary>("inspect_map", { path });
}

export async function saveProject(draft: WizardDraft, stepId: string): Promise<string> {
  if (!isTauri()) {
    await wait(40);
    window.localStorage.setItem("rust-studio:last-project", JSON.stringify({ draft, stepId, savedAt: new Date().toISOString() }));
    return "localStorage://rust-studio:last-project";
  }
  return invokeCommand<string>("save_project", { draft, stepId });
}

export async function exportProject(draft: WizardDraft): Promise<ExportReport> {
  const kind = draft.projectKind === "skin" ? "skin" : draft.projectKind === "monument" ? "prefab" : "map";
  if (!isTauri()) {
    await wait(420);
    const report: ExportReport = {
      kind,
      path: `data/exports/${draft.export.fileName || "untitled"}.${kind === "skin" ? "zip" : kind}`,
      bytes: kind === "skin" ? 4 * 2048 * 2048 * 4 : 48 * 1024 * 1024,
      channels: kind === "skin" ? ["diffuse", "normal", "specular", "emission"] : undefined,
      createdAt: new Date().toISOString(),
    };
    window.localStorage.setItem("rust-studio:last-export", JSON.stringify(report));
    return report;
  }
  return invokeCommand<ExportReport>("export_project", { draft });
}

export interface SyncStatus {
  active: boolean;
  pending: number;
  conflicts: number;
  lastSyncAt: string | null;
  endpoint: string | null;
  profile: string | null;
  tokenSaved: boolean;
}

export interface SyncPushResult {
  ok: boolean;
  conflict: boolean;
  revision: number | null;
  etag: string | null;
  updatedAt: string | null;
  draft: WizardDraft | null;
  message: string;
}

export interface SyncPullResult {
  decision: "fast-forward" | "local-wins" | "conflict" | "no-remote";
  revision: number | null;
  updatedAt: string | null;
  draft: WizardDraft | null;
  message: string;
}

export interface SyncResolveResult {
  action: "push" | "apply";
  draft: WizardDraft | null;
}

export async function syncStatus(): Promise<SyncStatus> {
  if (!isTauri()) {
    await wait(30);
    const last = window.localStorage.getItem("rust-studio:last-sync");
    return {
      active: false,
      pending: 0,
      conflicts: 0,
      lastSyncAt: last,
      endpoint: null,
      profile: null,
      tokenSaved: false,
    };
  }
  return invokeCommand<SyncStatus>("sync_status");
}

export async function syncConfigure(endpoint: string, token: string): Promise<SyncStatus> {
  if (!isTauri()) throw new Error("Sync profiles need the desktop shell.");
  return invokeCommand<SyncStatus>("sync_configure", { endpoint, token });
}

export async function syncTest(): Promise<string> {
  if (!isTauri()) throw new Error("Sync testing needs the desktop shell.");
  return invokeCommand<string>("sync_test");
}

export async function syncPush(projectId: string, draft: WizardDraft): Promise<SyncPushResult> {
  if (!isTauri()) throw new Error("Sync needs the desktop shell.");
  return invokeCommand<SyncPushResult>("sync_push", { projectId, draft });
}

export async function syncPull(projectId: string): Promise<SyncPullResult> {
  if (!isTauri()) throw new Error("Sync needs the desktop shell.");
  return invokeCommand<SyncPullResult>("sync_pull", { projectId });
}

export async function syncResolve(projectId: string, choice: "local" | "remote"): Promise<SyncResolveResult> {
  if (!isTauri()) throw new Error("Sync needs the desktop shell.");
  return invokeCommand<SyncResolveResult>("sync_resolve", { projectId, choice });
}

export interface TaskProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

export interface TaskStatus {
  running: boolean;
  cancelled: boolean;
  label: string;
  progress: TaskProgress[];
  result: unknown;
  error: string | null;
}

async function waitForTask(
  status: () => Promise<TaskStatus>,
  onProgress?: (last: TaskProgress | null, status: TaskStatus) => void,
): Promise<unknown> {
  for (;;) {
    const current = await status();
    onProgress?.(current.progress.at(-1) ?? null, current);
    if (!current.running) {
      if (current.error) throw new Error(current.error);
      return current.result;
    }
    await wait(450);
  }
}

export async function cancelBundleScan(): Promise<void> {
  if (!isTauri()) return;
  await invokeCommand("cancel_bundle_scan");
}

export async function cancelPrefabExtraction(): Promise<void> {
  if (!isTauri()) return;
  await invokeCommand("cancel_prefab_extraction");
}

export async function ingestAssets(root: string): Promise<{ meshes: number; prefabs: number; maps: number; errors: string[] }> {
  if (!isTauri()) {
    await wait(600);
    return { meshes: DEMO_BASE_MESHES.length, prefabs: DEMO_PREFABS.length, maps: 1, errors: [] };
  }
  return invokeCommand<{ meshes: number; prefabs: number; maps: number; errors: string[] }>(
    "ingest_assets",
    { root },
  );
}

export interface BundleScanSummary {
  bundles: number;
  prefabs: number;
  assets: number;
  extractedMeshes: number;
  extractedTextures: number;
  skipped: number;
  errors: string[];
}

export async function scanRustBundles(
  root: string,
  onProgress?: (last: TaskProgress | null, status: TaskStatus) => void,
): Promise<BundleScanSummary> {
  if (!isTauri()) {
    await wait(300);
    return {
      bundles: 0,
      prefabs: DEMO_PREFABS.length,
      assets: 0,
      extractedMeshes: 0,
      extractedTextures: 0,
      skipped: 0,
      errors: ["Bundle scanning needs the desktop shell."],
    };
  }
  await invokeCommand("scan_rust_bundles", { root });
  const result = await waitForTask(
    () => invokeCommand<TaskStatus>("bundle_scan_status"),
    onProgress,
  );
  void enforceCacheLimit();
  return result as BundleScanSummary;
}

export async function getThumbnailData(hash: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invokeCommand<string | null>("get_thumbnail_data", { prefabHash: hash });
}

export async function loadCachedMeshBytes(hash: string): Promise<Uint8Array | null> {
  if (!isTauri()) return null;
  try {
    const bytes = await invokeCommand<number[]>("load_cached_mesh_bytes", {
      prefabHash: hash,
    });
    return Uint8Array.from(bytes);
  } catch {
    return null;
  }
}

/** Remember the folder used for geometry extraction and scans. */
let knownBundleRoot = "";

export function setLinkedBundleRoot(root: string): void {
  if (typeof window === "undefined") return;
  knownBundleRoot = root;
  try {
    if (root) window.localStorage.setItem("koba.bundles.root", root);
    else window.localStorage.removeItem("koba.bundles.root");
  } catch {
    /* storage can be unavailable in hardened webviews */
  }
  if (isTauri()) {
    // Persist in the project database as well: localStorage is per webview
    // profile and does not survive a fresh shell profile.
    void invokeCommand("set_linked_bundle_root", { root }).catch(() => undefined);
  }
}

/** Bundle folder the user linked in Setup; empty means let the shell auto-detect. */
export function linkedBundleRoot(): string {
  if (typeof window === "undefined") return "";
  try {
    return knownBundleRoot || window.localStorage.getItem("koba.bundles.root") || "";
  } catch {
    return knownBundleRoot;
  }
}

/**
 * The linked Bundles folder, preferring the copy stored in the project database.
 * Falls back to the index pack root, so a fresh shell profile still knows where
 * the bundles are.
 */
export async function loadLinkedBundleRoot(): Promise<string> {
  if (!isTauri()) return linkedBundleRoot();
  try {
    const root = await invokeCommand<string>("linked_bundle_root");
    if (root) knownBundleRoot = root;
  } catch {
    /* keep whatever localStorage had */
  }
  return linkedBundleRoot();
}

/** Extract a real prefab GLB into the local cache. Never throws in the UI. */
export async function extractPrefabGlb(
  prefabPath: string,
  bundleRoot = linkedBundleRoot(),
  onProgress?: (last: TaskProgress | null, status: TaskStatus) => void,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invokeCommand<unknown>("extract_prefab_glb", {
      prefabPath,
      bundleRoot: bundleRoot || null,
    });
    await waitForTask(
      () => invokeCommand<TaskStatus>("prefab_extraction_status"),
      onProgress,
    );
    void enforceCacheLimit();
    return true;
  } catch {
    return false;
  }
}

export async function pickBundleFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return invokeCommand<string | null>("pick_bundle_folder");
}

export interface CacheBucket {
  files: number;
  bytes: number;
}

export interface CacheStats {
  root: string;
  meshes: CacheBucket;
  thumbs: CacheBucket;
  totalBytes: number;
  limitBytes: number;
}

export async function cacheStats(): Promise<CacheStats | null> {
  if (!isTauri()) return null;
  return invokeCommand<CacheStats>("cache_stats");
}

export async function pruneCache(limitBytes: number): Promise<CacheStats> {
  if (!isTauri()) throw new Error("Cache maintenance needs the desktop shell.");
  return invokeCommand<CacheStats>("prune_cache", { limitBytes });
}

export async function enforceCacheLimit(): Promise<CacheStats | null> {
  if (!isTauri()) return null;
  try {
    return await invokeCommand<CacheStats>("enforce_cache_limit");
  } catch {
    return null;
  }
}

export interface DeltaReceipt {
  path: string;
  bytes: number;
  operations: number;
}

export async function queueProjectDelta(delta: unknown): Promise<DeltaReceipt> {
  if (!isTauri()) {
    const path = `localStorage://rust-studio:sync-outbox/${Date.now()}`;
    window.localStorage.setItem(path, JSON.stringify(delta));
    const operations =
      typeof delta === "object" && delta && "operations" in delta && Array.isArray(delta.operations)
        ? delta.operations.length
        : 0;
    return { path, bytes: JSON.stringify(delta).length, operations };
  }
  return invokeCommand<DeltaReceipt>("queue_project_delta", { delta });
}

export interface RustInstall {
  root: string;
  bundles: string[];
  source: string;
  found: boolean;
}

export async function findRustInstall(root?: string): Promise<RustInstall> {
  if (!isTauri()) {
    return { root: "", bundles: [], source: "browser", found: false };
  }
  return invokeCommand<RustInstall>("find_rust_install", { root: root || null });
}

export function demoMode(): boolean {
  return !isTauri();
}
