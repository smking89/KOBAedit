import { invoke } from "@tauri-apps/api/core";

import { extractPrefabGlb, isTauri, loadCachedMeshBytes } from "../lib/ipc";
import type { PrefabAsset, SkinSettings, WizardDraft } from "../wizard/types";
import {
  OffscreenThumbnailGenerator,
  type ProxyBounds,
} from "./thumbnailGenerator";

export interface ThumbnailBatchItem {
  hash: string;
  prefabPath: string;
  category: string;
  bounds: ProxyBounds;
}

export interface ThumbnailBatchOptions {
  onThumbnail?: (hash: string, dataUrl: string) => void;
  onError?: (hash: string, error: string) => void;
  /** Extraction ran but found no usable geometry in the linked bundles. */
  onExtractionFailed?: (hash: string) => void;
  cancelled?: () => boolean;
  /** Real mesh extraction is slower than proxy rendering; cap it per batch. */
  maxExtract?: number;
  signal?: AbortSignal;
}

export function prefabThumbnailHash(prefabPath: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(prefabPath);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function prefabThumbnailItem(prefab: PrefabAsset): ThumbnailBatchItem {
  return {
    hash: prefabThumbnailHash(prefab.id),
    prefabPath: prefab.id,
    category: prefab.category,
    bounds: prefab.bounds,
  };
}

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, 12));

async function cachedThumbnail(hash: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("get_thumbnail_data", { prefabHash: hash });
  } catch {
    return null;
  }
}

async function cachedMesh(hash: string): Promise<Uint8Array | null> {
  if (!isTauri()) return null;
  try {
    const bytes = await invoke<number[]>("load_cached_mesh_bytes", {
      prefabHash: hash,
    });
    return Uint8Array.from(bytes);
  } catch {
    return null;
  }
}

async function extractMesh(
  prefabPath: string,
): Promise<Uint8Array | null> {
  if (!isTauri()) return null;
  if (!(await extractPrefabGlb(prefabPath))) return null;
  return cachedMesh(prefabThumbnailHash(prefabPath));
}

function hasBounds(bounds: ProxyBounds): boolean {
  return (
    bounds.max[0] > bounds.min[0] ||
    bounds.max[1] > bounds.min[1] ||
    bounds.max[2] > bounds.min[2]
  );
}

/**
 * Render missing prefab cards sequentially. Each render yields for 12 ms so
 * orbit/brush input in the main viewport stays responsive.
 */
function cardKey(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120) || "project";
}

/** Stable cache key so the skin card can find the last rendered preview. */
export function skinThumbnailKey(baseMeshId: string): string {
  return `skin-${prefabThumbnailHash(baseMeshId)}`;
}

/** Refresh a monument card after a deterministic prompt generates a project. */
export async function refreshMonumentThumbnail(draft: WizardDraft): Promise<void> {
  if (draft.projectKind !== "monument" || !draft.placements.length) return;
  const generator = new OffscreenThumbnailGenerator();
  try {
    await generator.generateMonumentThumbnail(
      cardKey(draft.name),
      draft.placements.map((placement) => ({
        prefabHash: prefabThumbnailHash(placement.assetId),
        position: [placement.position.x, placement.position.y, placement.position.z],
        rotation: [
          placement.rotationEuler.x,
          placement.rotationEuler.y,
          placement.rotationEuler.z,
        ],
        scale: [placement.scale.x, placement.scale.y, placement.scale.z],
      })),
      async (hash) => {
        const bytes = await loadCachedMeshBytes(hash);
        if (!bytes) throw new Error(`no cached mesh for ${hash}`);
        return bytes;
      },
    );
  } finally {
    document
      .querySelectorAll("canvas[data-koba-thumbnail-canvas]")
      .forEach((canvas) => canvas.remove());
  }
}

function skinTexture(skin: SkinSettings, kind: "albedo" | "metallic" | "emission"): string {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const top = skin.layers.find((layer) => layer.enabled) ?? skin.layers[0];
  const base = top?.baseColor ?? "#3f4a52";
  const accent = skin.layers[1]?.baseColor ?? "#b3261e";
  if (kind === "metallic") {
    context.fillStyle = "#d8d8d8";
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = "#404040";
    for (const layer of skin.layers.slice(1)) {
      if (!layer.enabled) continue;
      context.globalAlpha = 0.45;
      context.fillRect(0, 256 * 0.62, 256, 34);
    }
  } else if (kind === "emission") {
    context.fillStyle = skin.wear.emissionStrength > 0 ? accent : "#000000";
    context.fillRect(0, 0, 256, 256);
  } else {
    context.fillStyle = base;
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = accent;
    context.globalAlpha = 0.85;
    context.fillRect(0, 190, 256, 20);
    context.fillRect(178, 0, 16, 256);
    context.globalAlpha = 0.12;
    for (let index = 0; index < 900; index += 1) {
      context.fillStyle = index % 2 ? "#ffffff" : "#000000";
      context.fillRect((index * 53) % 256, (index * 97) % 256, 1, 1);
    }
  }
  return canvas.toDataURL("image/png");
}

/** Render the card art immediately after a save or deterministic prompt. */
export async function refreshProjectThumbnail(draft: WizardDraft): Promise<void> {
  if (draft.projectKind === "monument") {
    await refreshMonumentThumbnail(draft);
    return;
  }
  if (draft.projectKind !== "skin" || !draft.skin.baseMeshId) return;
  const hash = prefabThumbnailHash(draft.skin.baseMeshId);
  const bytes = await loadCachedMeshBytes(hash);
  if (!bytes) return;
  const generator = new OffscreenThumbnailGenerator();
  try {
    await generator.generateSkinThumbnail(skinThumbnailKey(draft.skin.baseMeshId), bytes, {
      albedoUrl: skinTexture(draft.skin, "albedo"),
      metallicUrl: skinTexture(draft.skin, "metallic"),
      emissionUrl: draft.skin.wear.emissionStrength > 0 ? skinTexture(draft.skin, "emission") : null,
      emissiveIntensity: draft.skin.wear.emissionStrength || 1,
    });
  } finally {
    document
      .querySelectorAll("canvas[data-koba-thumbnail-canvas]")
      .forEach((canvas) => canvas.remove());
  }
}

export async function runBackgroundThumbnailBatch(
  items: ThumbnailBatchItem[],
  options: ThumbnailBatchOptions = {},
): Promise<void> {
  if (!items.length) return;
  const generator = new OffscreenThumbnailGenerator();
  const maxExtract = options.maxExtract ?? 16;
  let extracted = 0;
  const pendingRealMesh: ThumbnailBatchItem[] = [];

  try {
    // Pass one is deliberately cheap: cached thumbnails and proxy boxes fill
    // the drawer immediately, without waiting on Unity bundle parsing.
    for (const item of items) {
      if (options.cancelled?.() || options.signal?.aborted) return;
      try {
        const cached = await cachedThumbnail(item.hash);
        if (cached) {
          options.onThumbnail?.(item.hash, cached);
          continue;
        }
        const bytes = await cachedMesh(item.hash);
        if (bytes) {
          const dataUrl = await generator.generatePrefabThumbnail(item.hash, bytes);
          if (dataUrl) options.onThumbnail?.(item.hash, dataUrl);
        } else {
          const dataUrl = await generator.generateProxyThumbnail(
            item.hash,
            item.bounds,
            item.category,
          );
          if (dataUrl) options.onThumbnail?.(item.hash, dataUrl);
          if (hasBounds(item.bounds) || item.category === "Monument") {
            pendingRealMesh.push(item);
          }
        }
      } catch (error) {
        options.onError?.(
          item.hash,
          error instanceof Error ? error.message : String(error),
        );
      }
      await yieldToMain();
    }

    // Pass two upgrades a bounded number of cards to real extracted geometry.
    // Each Unity bundle parse is relatively expensive, so it stays capped.
    for (const item of pendingRealMesh) {
      if (extracted >= maxExtract) break;
      if (options.cancelled?.() || options.signal?.aborted) return;
      try {
        const bytes = await extractMesh(item.prefabPath);
        if (!bytes) {
          options.onExtractionFailed?.(item.hash);
          continue;
        }
        extracted += 1;
        const dataUrl = await generator.generatePrefabThumbnail(item.hash, bytes);
        if (dataUrl) options.onThumbnail?.(item.hash, dataUrl);
      } catch (error) {
        options.onError?.(
          item.hash,
          error instanceof Error ? error.message : String(error),
        );
      }
      await yieldToMain();
    }
  } finally {
    // The detached canvas is intentionally removed after the batch.
    document
      .querySelectorAll("canvas[data-koba-thumbnail-canvas]")
      .forEach((canvas) => canvas.remove());
  }
}
