import type { WizardDraft } from "../wizard/types";
import {
  applyCavePortals,
  applyPlacementPads,
  applySlopeTopology,
  applySplineCorridors,
  applyStrokesToPreview,
  generateTerrainPreview,
  type TerrainPreview,
} from "./procedural";
import { applyHeightmapToPreview, applyMasksToPreview } from "./terrainImport";

/**
 * The editor's terrain preview: generated noise or a flat floor, then every
 * non-destructive modifier in the same order the exporter applies them.
 *
 * The 3D viewport and the 2D G-key map must agree, so both build their data
 * here instead of re-implementing the stack.
 */
export function buildTerrainPreview(draft: WizardDraft, resolution: number): TerrainPreview {
  const preview = generateTerrainPreview(draft.terrain, resolution);
  if (draft.terrain.heightmap) {
    applyHeightmapToPreview(preview, draft.terrain.heightmap);
  }
  applySplineCorridors(preview, draft.splines, draft.terrain.sizeMetres);
  applyPlacementPads(preview, draft.placements, draft.terrain.sizeMetres);
  applyCavePortals(preview, draft.splines, draft.terrain.sizeMetres);
  applySlopeTopology(preview, draft.terrain);
  applyMasksToPreview(preview, draft.terrain);
  applyStrokesToPreview(preview, draft.terrain);
  return preview;
}
