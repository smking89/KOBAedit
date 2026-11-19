import type { PrefabAsset } from "../wizard/types";

/**
 * The prefab currently being dragged from a catalogue card onto the map.
 *
 * HTML5 drag data is only readable on drop, and `prefab.id` alone cannot rebuild
 * bounds/flatten settings, so the card keeps the full asset here while the drag
 * is in flight.
 */
export const PREFAB_MIME = "application/x-koba-prefab";

let current: PrefabAsset | null = null;

export function startPrefabDrag(prefab: PrefabAsset): void {
  current = prefab;
}

export function endPrefabDrag(): void {
  current = null;
}

export function draggedPrefab(): PrefabAsset | null {
  return current;
}
