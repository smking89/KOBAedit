import type { ExportReport, PrefabAsset, WizardDraft } from "../wizard/types";
import { DEMO_BASE_MESHES, DEMO_PREFABS, type BaseMeshAsset } from "./demoAssets";

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
  return rows.length ? rows : DEMO_PREFABS;
}

export async function listBaseMeshes(): Promise<BaseMeshAsset[]> {
  if (!isTauri()) {
    await wait();
    return DEMO_BASE_MESHES;
  }
  const rows = await invokeCommand<BaseMeshAsset[]>("list_base_meshes");
  return rows.length ? rows : DEMO_BASE_MESHES;
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
}

export async function syncStatus(): Promise<SyncStatus> {
  if (!isTauri()) {
    await wait(30);
    const last = window.localStorage.getItem("rust-studio:last-sync");
    return { active: false, pending: 0, conflicts: 0, lastSyncAt: last };
  }
  return invokeCommand<SyncStatus>("sync_status");
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

export function demoMode(): boolean {
  return !isTauri();
}
