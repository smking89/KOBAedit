import type { WizardDraft } from "../wizard/types";

type DeltaOperation =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string };

export interface ProjectDelta {
  format: "koba-delta/1";
  projectId: string;
  project: string;
  baseHash: string;
  createdAt: string;
  operations: DeltaOperation[];
}

const SNAPSHOT_KEY = "rust-studio:last-sync-snapshot";

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffValue(
  previous: unknown,
  next: unknown,
  path: string,
  operations: DeltaOperation[],
): void {
  if (stable(previous) === stable(next)) return;
  if (Array.isArray(previous) && Array.isArray(next)) {
    // Stroke history dominates a map draft: send only the appended tail.
    if (path === "terrain.strokes" || path.endsWith("/strokes")) {
      if (next.length < previous.length) {
        operations.push({ op: "set", path, value: next });
        return;
      }
      for (let index = previous.length; index < next.length; index += 1) {
        operations.push({ op: "set", path: `${path}/${index}`, value: next[index] });
      }
      return;
    }
    const previousIds = previous.filter(isRecord).map((item) => String(item.id ?? ""));
    const nextIds = next.filter(isRecord).map((item) => String(item.id ?? ""));
    const keyed =
      previousIds.length === previous.length &&
      nextIds.length === next.length &&
      previousIds.every(Boolean) &&
      nextIds.every(Boolean);
    if (keyed) {
      const existing = new Map<string, unknown>();
      for (const item of previous) {
        if (isRecord(item)) existing.set(String(item.id), item);
      }
      const nextSet = new Set(nextIds);
      for (const item of next) {
        if (!isRecord(item)) continue;
        const id = String(item.id);
        if (!existing.has(id) || stable(existing.get(id)) !== stable(item)) {
          operations.push({ op: "set", path: `${path}/${id}`, value: item });
        }
      }
      for (const id of previousIds) {
        if (!nextSet.has(id)) operations.push({ op: "remove", path: `${path}/${id}` });
      }
      return;
    }
    operations.push({ op: "set", path, value: next });
    return;
  }
  if (isRecord(previous) && isRecord(next)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
      if (!(key in next)) operations.push({ op: "remove", path: path ? `${path}.${key}` : key });
      else diffValue(previous[key], next[key], path ? `${path}.${key}` : key, operations);
    }
    return;
  }
  operations.push({ op: "set", path, value: next });
}

export function createProjectDelta(previous: WizardDraft | null, next: WizardDraft): ProjectDelta {
  const operations: DeltaOperation[] = [];
  if (previous) diffValue(previous, next, "", operations);
  else operations.push({ op: "set", path: "", value: next });
  return {
    format: "koba-delta/1",
    projectId: next.projectId,
    project: next.name || "untitled",
    baseHash: hash(previous ? stable(previous) : ""),
    createdAt: new Date().toISOString(),
    operations,
  };
}

export function readSyncSnapshot(): WizardDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as WizardDraft) : null;
  } catch {
    return null;
  }
}

export function writeSyncSnapshot(draft: WizardDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(draft));
  } catch {
    // A full localStorage quota must not prevent an offline save.
  }
}

export function nextProjectDelta(draft: WizardDraft): ProjectDelta {
  const previous = readSyncSnapshot();
  const delta = createProjectDelta(previous, draft);
  writeSyncSnapshot(draft);
  return delta;
}
