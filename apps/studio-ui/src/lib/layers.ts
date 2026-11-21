import type {
  TerrainLayer,
  TerrainLayerKind,
  TerrainSettings,
  TerrainStroke,
} from "../wizard/types";

/**
 * Terrain layers: strokes are grouped per layer, and replay walks the layer
 * list in order, skipping hidden layers and scaling every effect by opacity.
 *
 * `terrain.strokes` is the legacy flat history; when no layer exists the same
 * helpers fall back to it so old projects keep replaying unchanged.
 */

export const LAYER_KINDS: { id: TerrainLayerKind; label: string }[] = [
  { id: "sculpt", label: "Sculpt" },
  { id: "splat", label: "Splat" },
  { id: "biome", label: "Biome" },
  { id: "topology", label: "Topology" },
];

export function layerKindLabel(kind: TerrainLayerKind): string {
  return LAYER_KINDS.find((entry) => entry.id === kind)?.label ?? kind;
}

/** Which layer a captured stroke belongs to when no layer is active. */
export function layerKindForStroke(stroke: TerrainStroke): TerrainLayerKind {
  if (stroke.mode === "splat") return "splat";
  if (stroke.mode === "topology" || stroke.mode === "alpha") return "topology";
  if (stroke.mode === "raise" || stroke.mode === "lower" || stroke.mode === "smooth" || stroke.mode === "flatten") {
    return "sculpt";
  }
  if (stroke.sync.height) return "sculpt";
  if (stroke.sync.splat) return "splat";
  if (stroke.sync.biome) return "biome";
  if (stroke.sync.topology || stroke.sync.alpha) return "topology";
  return "sculpt";
}

export function clampOpacity(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function createLayer(
  kind: TerrainLayerKind,
  index: number,
  id = `layer-${kind}-${index + 1}`,
): TerrainLayer {
  const label = layerKindLabel(kind);
  return {
    id,
    name: `${label} ${index + 1}`,
    kind,
    visible: true,
    opacity: 1,
    strokes: [],
  };
}

export function activeLayer(settings: {
  layers?: TerrainLayer[];
  activeLayerId?: string | null;
}): TerrainLayer | null {
  const layers = settings.layers ?? [];
  if (!layers.length) return null;
  return layers.find((layer) => layer.id === settings.activeLayerId) ?? layers[0];
}

export interface PlannedStroke {
  stroke: TerrainStroke;
  /** Layer opacity, 1 for legacy flat history. */
  opacity: number;
  layerId: string | null;
}

/**
 * Replay plan shared by the editor preview and the Python exporter: visible
 * layers in stored order, strokes in capture order inside each layer.
 */
export function plannedStrokes(settings: {
  layers?: TerrainLayer[];
  strokes?: TerrainStroke[];
}): PlannedStroke[] {
  const layers = settings.layers ?? [];
  if (!layers.length) {
    return (settings.strokes ?? []).map((stroke) => ({ stroke, opacity: 1, layerId: null }));
  }
  const plan: PlannedStroke[] = [];
  for (const layer of layers) {
    if (!layer.visible) continue;
    const opacity = clampOpacity(layer.opacity);
    if (opacity <= 0) continue;
    for (const stroke of layer.strokes) plan.push({ stroke, opacity, layerId: layer.id });
  }
  return plan;
}

/**
 * Saved-project migration: flat stroke history becomes layers grouped by the
 * channels the stroke writes, keeping capture order inside each group.
 */
export function migrateLayers(terrain: {
  strokes?: TerrainStroke[];
  layers?: TerrainLayer[];
  activeLayerId?: string | null;
}): { layers: TerrainLayer[]; activeLayerId: string | null } {
  if (terrain.layers?.length) {
    return {
      layers: terrain.layers,
      activeLayerId: terrain.activeLayerId ?? terrain.layers[0].id,
    };
  }
  const strokes = terrain.strokes ?? [];
  if (!strokes.length) return { layers: [], activeLayerId: null };

  const grouped = new Map<TerrainLayerKind, TerrainStroke[]>();
  for (const stroke of strokes) {
    const kind = layerKindForStroke(stroke);
    const list = grouped.get(kind) ?? [];
    list.push(stroke);
    grouped.set(kind, list);
  }
  const layers: TerrainLayer[] = [];
  for (const kind of LAYER_KINDS) {
    const list = grouped.get(kind.id);
    if (!list?.length) continue;
    const layer = createLayer(kind.id, layers.length);
    layer.strokes = list;
    layers.push(layer);
  }
  return { layers, activeLayerId: layers[0]?.id ?? null };
}

export type { TerrainLayer, TerrainLayerKind, TerrainSettings };
