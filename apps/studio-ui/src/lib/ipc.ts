import { draftForStorage } from "../wizard/autosave.ts";
import type { ExportReport, PrefabAsset, WizardDraft } from "../wizard/types";
import { DEMO_BASE_MESHES, DEMO_PREFABS, type BaseMeshAsset } from "./demoAssets";
import { prettifyPrefabName } from "./prefabName";

/**
 * Bridge to the Rust shell. In a browser (vite dev without Tauri) every call
 * resolves against a local mock so the full wizard remains usable; the UI marks
 * the session as demo data. No network request is ever made from here.
 */

export function isTauri(): boolean {
  // Tauri 2 exposes this flag itself. Check the official flag as well as the
  // internals object so older and newer runtimes are both detected.
  return (
    typeof window !== "undefined" &&
    ((globalThis as { isTauri?: boolean }).isTauri === true ||
      "__TAURI_INTERNALS__" in window)
  );
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

export interface BaseMeshPage {
  rows: BaseMeshAsset[];
  total: number;
}

/** Search-backed page of meshes; the catalogue can hold 30k+ GLBs. */
export async function browseBaseMeshes(
  options: { query?: string; kind?: string; limit?: number; offset?: number } = {},
): Promise<BaseMeshPage> {
  const query = options.query?.trim().toLowerCase() ?? "";
  const kind = options.kind ?? "all";
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  if (!isTauri()) {
    const filtered = DEMO_BASE_MESHES.filter(
      (mesh) =>
        (kind === "all" || mesh.itemKind === kind) &&
        (!query || mesh.name.toLowerCase().includes(query)),
    );
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
  }
  return invokeCommand<BaseMeshPage>("browse_base_meshes", {
    query,
    kind,
    limit,
    offset,
  });
}

export async function listBaseMeshes(): Promise<BaseMeshAsset[]> {
  if (!isTauri()) {
    await wait();
    return DEMO_BASE_MESHES;
  }
  const rows = await invokeCommand<BaseMeshAsset[]>("list_base_meshes");
  return rows.length ? rows : DEMO_BASE_MESHES;
}

export interface MeshGroupAsset {
  id: string;
  /** Stable SQLite group key; use this for expansion state. */
  groupKey: string;
  name: string;
  itemKind: string;
  partCount: number;
  triangles: number;
  uvChannels: number;
  hasTangents: boolean;
  materialSlots: string[];
  previewPath: string;
}

export interface MeshGroupPage {
  rows: MeshGroupAsset[];
  total: number;
}

export interface MeshPart {
  assetPath: string;
  name: string;
  partIndex: number;
  triangles: number;
}

export async function browseMeshGroups(
  options: { query?: string; kind?: string; limit?: number; offset?: number } = {},
): Promise<MeshGroupPage> {
  const query = options.query?.trim().toLowerCase() ?? "";
  const kind = options.kind ?? "all";
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  if (!isTauri()) {
    const groups = new Map<string, MeshGroupAsset>();
    for (const mesh of DEMO_BASE_MESHES) {
      if (kind !== "all" && mesh.itemKind !== kind) continue;
      if (query && !mesh.name.toLowerCase().includes(query)) continue;
      const match = mesh.name.match(/^(.*?)[._-](?:part|piece)[._-]?(\d{1,3})$/i);
      const key = match ? `group:${match[1].toLowerCase()}` : mesh.id;
      const current = groups.get(key);
      if (current) {
        current.partCount += 1;
        current.triangles += mesh.triangles;
      } else {
        groups.set(key, {
          id: key,
          groupKey: key,
          name: match ? match[1] : mesh.name,
          itemKind: mesh.itemKind,
          partCount: 1,
          triangles: mesh.triangles,
          uvChannels: mesh.uvChannels,
          hasTangents: mesh.hasTangents,
          materialSlots: mesh.materialSlots,
          previewPath: mesh.id,
        });
      }
    }
    const rows = [...groups.values()];
    return { rows: rows.slice(offset, offset + limit), total: rows.length };
  }
  return invokeCommand<MeshGroupPage>("browse_mesh_groups", { query, kind, limit, offset });
}

export async function listGroupParts(groupKey: string): Promise<MeshPart[]> {
  if (!isTauri()) {
    const base = groupKey.replace(/^group:/, "").toLowerCase();
    return DEMO_BASE_MESHES.filter((mesh) => mesh.name.toLowerCase().startsWith(base)).map(
      (mesh, index) => ({
        assetPath: mesh.id,
        name: mesh.name,
        partIndex: index,
        triangles: mesh.triangles,
      }),
    );
  }
  return invokeCommand<MeshPart[]>("list_group_parts", { groupKey });
}

export interface PlaceableMeshPage {
  rows: BaseMeshAsset[];
  total: number;
  nextCursor: number | null;
}

export async function browsePlaceableMeshes(
  options: { query?: string; cursor?: number | null; limit?: number } = {},
): Promise<PlaceableMeshPage> {
  const query = options.query?.trim().toLowerCase() ?? "";
  const limit = options.limit ?? 100;
  const cursor = options.cursor ?? 0;
  if (!isTauri()) {
    const filtered = DEMO_BASE_MESHES.filter(
      (mesh) => !query || mesh.name.toLowerCase().includes(query),
    );
    const rows = filtered.slice(cursor, cursor + limit);
    return {
      rows,
      total: filtered.length,
      nextCursor: cursor + limit < filtered.length ? cursor + limit : null,
    };
  }
  return invokeCommand<PlaceableMeshPage>("browse_placeable_meshes", { query, cursor, limit });
}

export interface LocalAssetStatus {
  roots: string[];
  counts: Record<string, number>;
  /** Asset folders detected on disk, offered as one-click roots. */
  candidates: string[];
}

export async function localAssetStatus(): Promise<LocalAssetStatus> {
  if (!isTauri()) return { roots: [], counts: {}, candidates: [] };
  return invokeCommand<LocalAssetStatus>("local_asset_status");
}

export async function saveAssetRoots(roots: string[]): Promise<void> {
  if (!isTauri()) return;
  await invokeCommand("save_asset_roots", { roots });
}

export async function scanLocalAssets(): Promise<string> {
  if (!isTauri()) return "{}";
  return invokeCommand<string>("scan_local_assets");
}

/** Native multi-folder picker. Returns absolute paths, or [] when cancelled. */
export async function pickAssetFolders(): Promise<string[]> {
  if (!isTauri()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: true, title: "Add Rust asset folders" });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export async function loadLocalMeshBytesOrThrow(assetPath: string): Promise<Uint8Array> {
  if (!isTauri()) throw new Error("Local meshes are only available in the native app.");
  try {
    const bytes = await invokeCommand<number[]>("load_local_mesh", { assetPath });
    return new Uint8Array(bytes);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not load ${assetPath}: ${message}`);
  }
}

export async function loadLocalMeshBytes(assetPath: string): Promise<Uint8Array | null> {
  if (!isTauri()) return null;
  try {
    return await loadLocalMeshBytesOrThrow(assetPath);
  } catch {
    return null;
  }
}

/** Check a drop target against the roots persisted in app_settings. */
export function pathWithinRoots(assetPath: string, roots: string[]): boolean {
  if (!roots.length || !assetPath) return false;
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const candidate = normalize(assetPath);
  return roots.some((root) => {
    const base = normalize(root);
    if (!base) return false;
    const caseInsensitive = /^[a-zA-Z]:\//.test(base) || base.includes("\\");
    return caseInsensitive
      ? candidate.toLowerCase().startsWith(`${base.toLowerCase()}/`)
      : candidate.startsWith(`${base}/`);
  });
}

export async function localTexture(name: string): Promise<string | null> {
  if (!isTauri() || !name) return null;
  try {
    return await invokeCommand<string | null>("local_texture", { name });
  } catch {
    return null;
  }
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

export interface RecentProject {
  id: string;
  name: string;
  kind: string;
  updatedAt: string;
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  if (!isTauri()) return [];
  return invokeCommand<RecentProject[]>("list_recent_projects");
}

export interface SnapshotRecord {
  id: string;
  projectId: string;
  label: string;
  createdAt: string;
  bytes: number;
}

export async function saveSnapshot(
  projectId: string,
  label: string,
  dataUrl: string,
): Promise<SnapshotRecord | null> {
  if (!isTauri()) return null;
  return invokeCommand<SnapshotRecord>("save_snapshot", { projectId, label, dataUrl });
}

export async function listSnapshots(projectId: string): Promise<SnapshotRecord[]> {
  if (!isTauri()) return [];
  return invokeCommand<SnapshotRecord[]>("list_snapshots", { projectId });
}

export async function loadSnapshot(id: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invokeCommand<string>("load_snapshot", { id });
}

export async function deleteSnapshot(id: string): Promise<void> {
  if (!isTauri()) return;
  await invokeCommand<void>("delete_snapshot", { id });
}

/** One-shot URL for a launch that happened before the workspace subscribed. */
export async function takePendingDeepLink(): Promise<string | null> {
  if (!isTauri()) return null;
  return invokeCommand<string | null>("take_pending_deep_link");
}

export interface LoadedProject {
  draft: unknown;
  stepId: string;
  savedAt: string;
}

export async function loadProject(projectId: string): Promise<LoadedProject> {
  return invokeCommand<LoadedProject>("load_project", { projectId });
}

export interface DirectoryEntryView {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntryView[];
}

export async function listDirectories(path?: string | null): Promise<DirectoryListing> {
  if (!isTauri()) return { path: "/", parent: null, entries: [] };
  return invokeCommand<DirectoryListing>("list_directories", { path: path ?? null });
}

/** Project id from the `projects/<id>/project.json` path `save_project` returns. */
export function projectIdFromSavePath(savedPath: string): string | null {
  const parts = savedPath.split(/[\\/]/);
  const id = parts[parts.length - 2] ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

export async function saveProject(
  draft: WizardDraft,
  stepId: string,
  projectId?: string | null,
): Promise<string> {
  if (!isTauri()) {
    await wait(40);
    window.localStorage.setItem(
      "rust-studio:last-project",
      JSON.stringify({ draft: draftForStorage(draft), stepId, savedAt: new Date().toISOString() }),
    );
    return "localStorage://rust-studio:last-project";
  }
  return invokeCommand<string>("save_project", { draft, stepId, projectId: projectId ?? null });
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

export interface EngineFinding {
  id: string;
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  detail?: string;
  placementId?: string;
  position?: number[];
}

export interface EngineMapCheckReport {
  ok: boolean;
  projectKind: string;
  counts: Record<string, number>;
  findings: EngineFinding[];
}

export interface GenesisReport {
  ok: boolean;
  players: number;
  hours: number;
  hourlyScrap: number[];
  perMonument: { name: string; tier: number; scrapPerHour: number; visitsPerHour: number }[];
  findings: EngineFinding[];
  suggestions: { field: string; from: number | string; to: number | string; reason: string }[];
  summary: {
    totalScrap: number;
    peakHour: number;
    peakScrapPerHour: number;
    scrapPerPlayerPerHour: number;
    topMonument: string;
    topMonumentShare: number;
    tier3SaturationHour: number;
  };
}

export interface ServerBundleReport {
  path: string;
  bytes: number;
  files: string[];
  botProfiles: number;
  plugin: string;
}

export interface SketchImport {
  path: string;
  resolution: number;
  dataUrl: string;
  coverage: Record<string, number>;
  minimum: number;
  maximum: number;
}

/**
 * Rebuild a 16-bit heightmap from a colour sketch. The engine returns the PNG as
 * a data URL so the wizard can decode it with the normal heightmap importer.
 */
export async function engineSketch(
  sketchPath: string,
  options: { resolution?: number; verticalScale?: number; seaLevel?: number; smooth?: number } = {},
): Promise<SketchImport> {
  if (!isTauri()) {
    throw new Error("Sketch reconstruction needs the desktop shell and its Python engine.");
  }
  return invokeCommand<SketchImport>("engine_sketch", {
    sketchPath,
    resolution: options.resolution ?? 1025,
    verticalScale: options.verticalScale ?? 1,
    seaLevel: options.seaLevel ?? 0,
    smooth: options.smooth ?? 2,
  });
}

export async function engineMapCheck(draft: WizardDraft): Promise<EngineMapCheckReport> {
  if (!isTauri()) {
    await wait(260);
    return { ok: true, projectKind: draft.projectKind, counts: { error: 0, warning: 0, info: 0 }, findings: [] };
  }
  return invokeCommand<EngineMapCheckReport>("engine_map_check", { draft });
}

export async function engineGenesis(draft: WizardDraft, players: number, hours = 72): Promise<GenesisReport> {
  if (!isTauri()) {
    await wait(700);
    const hourly = Array.from({ length: hours }, (_value, hour) => 120 * players * (0.4 + hour / hours));
    const total = hourly.reduce((sum, value) => sum + value, 0);
    return {
      ok: true,
      players,
      hours,
      hourlyScrap: hourly,
      perMonument: draft.placements.slice(0, 6).map((placement) => ({
        name: placement.name,
        tier: placement.lootTier,
        scrapPerHour: 40 * placement.lootTier * 10,
        visitsPerHour: players / Math.max(1, draft.placements.length),
      })),
      findings: [],
      suggestions: [],
      summary: {
        totalScrap: total,
        peakHour: hours - 2,
        peakScrapPerHour: hourly[hours - 2] ?? 0,
        scrapPerPlayerPerHour: total / Math.max(1, players) / hours,
        topMonument: draft.placements[0]?.name ?? "",
        topMonumentShare: draft.placements.length > 0 ? 1 / draft.placements.length : 0,
        tier3SaturationHour: Math.floor(hours * 0.8),
      },
    };
  }
  return invokeCommand<GenesisReport>("engine_genesis", { draft, players, hours });
}

export async function engineServerBundle(draft: WizardDraft): Promise<ServerBundleReport> {
  if (!isTauri()) {
    await wait(420);
    return {
      path: "data/exports/server-pack/server-bundle.zip",
      bytes: 8192,
      files: ["server.cfg", "oxide/config/BetterLoot.json", "oxide/config/AlphaLoot.json", "manifest.json"],
      botProfiles: draft.placements.filter((placement) => placement.lootTier === 3).length,
      plugin: "KobaGenerated",
    };
  }
  return invokeCommand<ServerBundleReport>("engine_server_bundle", { draft });
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
  force = false,
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
  await invokeCommand("scan_rust_bundles", { root, force });
  const result = await waitForTask(
    () => invokeCommand<TaskStatus>("bundle_scan_status"),
    onProgress,
  );
  void enforceCacheLimit();
  return result as BundleScanSummary;
}

export async function getThumbnailData(
  hash: string,
  sourcePath?: string | null,
): Promise<string | null> {
  if (!isTauri()) return null;
  return invokeCommand<string | null>("get_thumbnail_data", {
    prefabHash: hash,
    sourcePath: sourcePath ?? null,
  });
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
