import type { ProjectKind } from "../wizard/types";

export type MarketKind = "Map" | "Monument" | "Prefab" | "Skin" | "Plugin";

export interface MarketItem {
  id: string;
  name: string;
  kind: MarketKind;
  author: string;
  price: number;
  summary: string;
}

/** Assets that can be used by each workspace. */
export const KINDS_BY_PROJECT: Record<ProjectKind, (MarketKind | "All")[]> = {
  map: ["All", "Map", "Monument", "Prefab", "Plugin"],
  monument: ["All", "Monument", "Prefab", "Plugin"],
  skin: ["All", "Skin"],
};

/**
 * Filters the catalogue for the active project.
 *
 * A deep link names one explicit asset. If that asset is outside the project's
 * scope it is still returned, so an install link can never open an empty
 * drawer; unrelated out-of-scope assets stay hidden.
 */
export function marketItemsFor(
  catalog: MarketItem[],
  projectKind: ProjectKind,
  kind: MarketKind | "All",
  query: string,
  focusAssetId?: string | null,
): MarketItem[] {
  const allowed = KINDS_BY_PROJECT[projectKind];
  const needle = query.trim().toLowerCase();
  return catalog.filter((item) => {
    const linked = item.id === focusAssetId;
    if (!allowed.includes(item.kind) && !linked) return false;
    if (kind !== "All" && item.kind !== kind && !linked) return false;
    if (!needle) return true;
    return (
      item.id.toLowerCase().includes(needle) ||
      item.name.toLowerCase().includes(needle) ||
      item.kind.toLowerCase().includes(needle) ||
      item.author.toLowerCase().includes(needle)
    );
  });
}
