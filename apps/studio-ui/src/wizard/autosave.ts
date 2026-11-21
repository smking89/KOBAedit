import type { WizardDraft, WizardState } from "./types.ts";

/**
 * Drop the imported CUI frame before a draft leaves the in-memory session.
 *
 * The frame is stored as a full PNG data URL (up to 1.5 MB, and base64 makes
 * it larger again). It is a design aid, not part of the map project, so it is
 * re-imported after a reload. This runs for every durable save (localStorage,
 * SQLite and sync) so the frame never inflates project files either.
 */
export function draftForStorage(draft: WizardDraft): WizardDraft {
  if (!draft.cuiFrame) return draft;
  const { cuiFrame: _frame, ...rest } = draft;
  return rest;
}

export function stateForStorage(state: WizardState): WizardState {
  const draft = draftForStorage(state.draft);
  return draft === state.draft ? state : { ...state, draft };
}

/**
 * Autosave-only compaction for terrain payloads.
 *
 * A native heightmap or a set of 2049²/4097² masks is tens of megabytes once
 * base64 encoded, far past the roughly 5 MB localStorage quota. A failed
 * write would otherwise leave every later autosave stuck on the last good
 * snapshot. This variant is only used when a normal write throws: it keeps the
 * editable draft (placements, strokes, settings) and drops the imported grids.
 * SQLite/project.json saves still use `stateForStorage` and keep the data.
 */
export function stateForLocalStorage(state: WizardState): WizardState {
  const stored = stateForStorage(state);
  const terrain = stored.draft.terrain;
  const hasGrids = Boolean(terrain.heightmap) || terrain.masks.length > 0;
  if (!hasGrids) return stored;
  return {
    ...stored,
    draft: {
      ...stored.draft,
      terrain: {
        ...terrain,
        heightmap: undefined,
        masks: [],
      },
    },
  };
}

/** True when the draft carries grids that localStorage cannot hold. */
function hasTerrainGrids(state: WizardState): boolean {
  return Boolean(state.draft.terrain.heightmap) || state.draft.terrain.masks.length > 0;
}

/**
 * Base64 larger than this cannot fit a ~5 MB localStorage quota even before
 * the rest of the draft, so there is no point stringifying tens of megabytes
 * on every edit just to watch setItem reject it. A native 2049² raw16
 * heightmap is about 11.2M base64 characters and a 4097² grid about 44.8M,
 * so both are omitted from the local autosave and reported as partial there.
 */
export const AUTOSAVE_GRID_CHAR_LIMIT = 4_000_000;

function terrainPayloadChars(state: WizardState): number {
  const terrain = state.draft.terrain;
  return (
    (terrain.heightmap?.data.length ?? 0) +
    terrain.masks.reduce((total, mask) => total + mask.data.length, 0)
  );
}

export interface AutosaveWriteResult {
  /** The draft reached localStorage. */
  ok: boolean;
  /** Terrain grids were too large for localStorage and left out. */
  omittedGrids: boolean;
}

/**
 * Writes the autosave key, dropping imported terrain grids up front when they
 * cannot fit, and retrying once with them stripped if a normal write is
 * rejected. Callers can distinguish success from failure and report a partial
 * write instead of guessing from a boolean.
 */
export function writeAutosave(key: string, state: WizardState): AutosaveWriteResult {
  const compact = stateForLocalStorage(state);
  const omittedGrids = hasTerrainGrids(state);
  if (terrainPayloadChars(state) > AUTOSAVE_GRID_CHAR_LIMIT) {
    try {
      window.localStorage.setItem(key, JSON.stringify(compact));
      return { ok: true, omittedGrids };
    } catch {
      return { ok: false, omittedGrids };
    }
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(stateForStorage(state)));
    return { ok: true, omittedGrids: false };
  } catch {
    try {
      window.localStorage.setItem(key, JSON.stringify(compact));
      return { ok: true, omittedGrids };
    } catch {
      // Even the compact draft cannot fit; editing continues in memory.
      return { ok: false, omittedGrids };
    }
  }
}
