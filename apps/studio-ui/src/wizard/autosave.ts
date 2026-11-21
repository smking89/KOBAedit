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

/** True when the compact variant actually omitted something. */
export function hasOmittedTerrain(state: WizardState): boolean {
  return Boolean(state.draft.terrain.heightmap) || state.draft.terrain.masks.length > 0;
}

/**
 * Base64 larger than this cannot fit a ~5 MB localStorage quota even before
 * the rest of the draft, so there is no point stringifying tens of megabytes
 * on every edit just to watch setItem reject it.
 */
const AUTOSAVE_PAYLOAD_CHARS = 4_000_000;

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
  /** Grids were left out of this write (they live in IndexedDB). */
  partial: boolean;
}

/**
 * Writes the autosave key, dropping imported terrain grids up front when they
 * cannot fit, and retrying once with them stripped if a normal write is
 * rejected. Callers can distinguish success from failure and report a partial
 * write instead of guessing from a boolean.
 */
export function writeAutosave(key: string, state: WizardState): AutosaveWriteResult {
  const compact = stateForLocalStorage(state);
  const omitted = hasOmittedTerrain(state);
  if (terrainPayloadChars(state) > AUTOSAVE_PAYLOAD_CHARS) {
    try {
      window.localStorage.setItem(key, JSON.stringify(compact));
      return { ok: true, partial: true };
    } catch {
      return { ok: false, partial: true };
    }
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(stateForStorage(state)));
    return { ok: true, partial: false };
  } catch {
    try {
      window.localStorage.setItem(key, JSON.stringify(compact));
      return { ok: true, partial: omitted };
    } catch {
      // Even the compact draft cannot fit; editing continues in memory.
      return { ok: false, partial: omitted };
    }
  }
}
