import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { activeLayer, clampOpacity, migrateLayers } from "../lib/layers";
import { mergeSeedPlacements, syncSharedPlacements } from "../lib/workspaceSync";
import {
  branchFor,
  createInitialDraft,
  initialState,
  progress,
  stepsFor,
  validateDraft,
  wizardReducer,
  type WizardAction,
} from "./machine";
import { stateForLocalStorage, stateForStorage, writeAutosave } from "./autosave.ts";
import { clearTerrainGrids, readTerrainGrids, writeTerrainGrids } from "../lib/gridStore";
import type {
  PrefabPlacement,
  TerrainLayer,
  ProjectKind,
  ValidationIssue,
  WizardDraft,
  WizardState,
  WizardStepId,
} from "./types";

const STORAGE_KEY = "rust-studio:wizard:v1";
const WORKSPACES_KEY = "rust-studio:wizard:workspaces:v1";

/** The native shell persists grids in SQLite/project.json, not IndexedDB. */
const DESKTOP_SHELL = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function loadWorkspaces(): Partial<Record<ProjectKind, WizardState>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<ProjectKind, WizardState>>) : {};
  } catch {
    return {};
  }
}

function saveWorkspaces(workspaces: Partial<Record<ProjectKind, WizardState>>): void {
  // Grids live in IndexedDB, so the local copy stays small and always fits.
  const stored: Partial<Record<ProjectKind, WizardState>> = {};
  for (const [kind, workspace] of Object.entries(workspaces)) {
    if (workspace) stored[kind as ProjectKind] = stateForLocalStorage(workspace);
  }
  try {
    window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(stored));
  } catch {
    // Editing continues in memory if even the compact workspaces cannot fit.
  }
}

export type AutosavePhase = "idle" | "saving" | "saved" | "partial" | "error";

export interface AutosaveState {
  phase: AutosavePhase;
  /** Last successful draft write; retained when a later write fails. */
  savedAt: string | null;
}

interface WizardContextValue {
  state: WizardState;
  dispatch: (action: WizardAction) => void;
  /** Restore the placements as they were before the last map edit. */
  undo: () => string | null;
  canUndo: boolean;
  redo: () => string | null;
  canRedo: boolean;
  steps: WizardStepId[];
  issues: ValidationIssue[];
  stepIssues: ValidationIssue[];
  canContinue: boolean;
  progressIndex: number;
  /** Draft autosave phase and timestamp, surfaced in the top bar. */
  autosave: AutosaveState;
  update: (patch: Partial<WizardDraft>) => void;
  /** Prompt builds: preview drafts without history, commit once at the end. */
  beginStagedBuild: () => void;
  applyStagedDraft: (draft: WizardDraft, step: WizardStepId) => void;
  finishStagedBuild: (draft: WizardDraft, step: WizardStepId) => void;
  cancelStagedBuild: () => void;
  /**
   * Top-bar mode switch. Each mode keeps its own draft/step in memory, so
   * hopping Map → Monument → Skin never discards unfinished work.
   */
  switchWorkspace: (
    kind: ProjectKind,
    options?: { seedPlacements?: PrefabPlacement[]; step?: WizardStepId },
  ) => void;
}

const WizardContext = createContext<WizardContextValue | null>(null);



function mergeDraft(draft: Partial<WizardDraft> | undefined): WizardDraft {
  const base = createInitialDraft();
  if (!draft) return base;
  const migratedLayers = migrateLayers({
    strokes: draft.terrain?.strokes,
    layers: draft.terrain?.layers,
    activeLayerId: draft.terrain?.activeLayerId,
  });
  // An explicitly empty layer opacity is valid; only a missing value defaults.
  migratedLayers.layers = migratedLayers.layers.map((layer) => ({
    ...layer,
    opacity: clampOpacity(layer.opacity),
  }));
  if (!migratedLayers.activeLayerId) migratedLayers.activeLayerId = activeLayer(migratedLayers)?.id ?? null;
  return {
    ...base,
    ...draft,
    // Walk mode owns pointer lock and a transient camera; never resume it on reload.
    walkMode: false,
    lighting: {
      ...base.lighting,
      ...draft.lighting,
      timeOfDay: Math.min(1439, Math.max(0, Math.round(draft.lighting?.timeOfDay ?? base.lighting.timeOfDay))),
    },
    terrain: {
      ...base.terrain,
      ...draft.terrain,
      brush: {
        ...base.terrain.brush,
        ...draft.terrain?.brush,
        sync: { ...base.terrain.brush.sync, ...draft.terrain?.brush?.sync },
        topologyClearFlags:
          draft.terrain?.brush?.topologyClearFlags ?? base.terrain.brush.topologyClearFlags,
      },
      strokes: draft.terrain?.strokes ?? base.terrain.strokes,
      // Pre-layer projects keep their flat stroke history until it is migrated
      // into sculpt/splat/biome/topology groups on load.
      ...migratedLayers,
      slopeTopology: draft.terrain?.slopeTopology ?? base.terrain.slopeTopology,
      masks: draft.terrain?.masks ?? base.terrain.masks,
    },
    splines: (draft.splines ?? base.splines).map((spline) => ({
      ...spline,
      curve: spline.curve ?? "catmull-rom",
      tension: spline.tension ?? 0.5,
      deformTerrain: spline.deformTerrain ?? true,
      paintSplat: spline.paintSplat ?? true,
      topologyFlag: spline.topologyFlag ?? null,
    })),
    io: {
      nodes: draft.io?.nodes ?? [],
      links: draft.io?.links ?? [],
      vendingOverrides: draft.io?.vendingOverrides ?? [],
    },
    loot: { ...base.loot, ...draft.loot },
    skin: {
      ...base.skin,
      ...draft.skin,
      wear: { ...base.skin.wear, ...draft.skin?.wear },
    },
    export: { ...base.export, ...draft.export },
  };
}

function loadInitialState(): WizardState {
  if (typeof window === "undefined") return initialState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as Partial<WizardState>;
    if (!parsed?.draft) return initialState();
    const base = initialState(mergeDraft(parsed.draft));
    const steps = stepsFor(base.draft.projectKind);
    return {
      ...base,
      stepId: parsed.stepId && steps.includes(parsed.stepId) ? parsed.stepId : "entry",
      furthestIndex: Math.min(steps.length - 1, Math.max(0, parsed.furthestIndex ?? 0)),
      dirty: Boolean(parsed.dirty),
      lastSavedAt: parsed.lastSavedAt ?? null,
      exportReport: parsed.exportReport ?? null,
    };
  } catch {
    return initialState();
  }
}

export function WizardProvider({ children }: { children: ReactNode }) {
  const [state, applyAction] = useReducer(wizardReducer, undefined, loadInitialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  type HistoryEntry = { label: string; undo: WizardAction; redo: WizardAction };
  const history = useRef<HistoryEntry[]>([]);
  const future = useRef<HistoryEntry[]>([]);
  const lastEdit = useRef<{ key: string; at: number } | null>(null);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);

  const labelFor = (action: WizardAction): string => {
    switch (action.type) {
      case "addLayer": return "Add terrain layer";
      case "removeLayer": return "Remove terrain layer";
      case "addStrokes": return "Paint terrain";
      case "removeStrokes": return "Erase terrain strokes";
      case "addPlacement": return "Place object";
      case "removePlacement": return "Delete object";
      case "updatePlacement": return "Transform object";
      case "addSpline": return "Add spline";
      case "removeSpline": return "Remove spline";
      case "addDecal": return "Add decal";
      case "removeDecal": return "Remove decal";
      case "patchTerrain": return "Edit terrain";
      case "patchSkin": return "Edit skin";
      case "patchSkinWear": return "Edit wear";
      case "patchLoot": return "Edit loot";
      case "setLighting": return "Change lighting";
      default: return action.type;
    }
  };

  const semanticKey = (action: WizardAction): string => {
    const fields = (patch: object) => Object.keys(patch).sort().join("+");
    switch (action.type) {
      case "updatePlacement":
      case "updateLayer":
      case "updateSpline":
      case "updateIONode":
      case "updateMaterialLayer":
      case "updateVendingOverride":
        return `${action.type}:${action.id}:${fields(action.patch)}`;
      case "patchTerrain":
      case "patchSkin":
      case "patchLoot":
      case "patchSkinWear":
      case "patch":
      case "setLighting":
        return `${action.type}:${fields(action.patch)}`;
      default:
        return action.type;
    }
  };

  /** Delta inverse where the action carries enough information. */
  const inverseFor = (action: WizardAction, before: WizardState): WizardAction => {
    switch (action.type) {
      case "addStrokes":
        return { type: "removeStrokes", ids: action.strokes.map((stroke) => stroke.id) };
      case "addDecal":
        return { type: "removeDecal", id: action.decal.id };
      case "removeDecal": {
        const decal = before.draft.skin.decals.find((item) => item.id === action.id);
        return decal ? { type: "addDecal", decal } : { type: "hydrate", state: before };
      }
      case "patchTerrain": {
        const old: Partial<WizardDraft["terrain"]> = {};
        for (const key of Object.keys(action.patch) as (keyof WizardDraft["terrain"])[]) {
          (old as Record<string, unknown>)[key] = before.draft.terrain[key];
        }
        return { type: "patchTerrain", patch: old };
      }
      case "patchSkin": {
        const old: Partial<WizardDraft["skin"]> = {};
        for (const key of Object.keys(action.patch) as (keyof WizardDraft["skin"])[]) {
          (old as Record<string, unknown>)[key] = before.draft.skin[key];
        }
        return { type: "patchSkin", patch: old };
      }
      case "patchLoot": {
        const old: Partial<WizardDraft["loot"]> = {};
        for (const key of Object.keys(action.patch) as (keyof WizardDraft["loot"])[]) {
          (old as Record<string, unknown>)[key] = before.draft.loot[key];
        }
        return { type: "patchLoot", patch: old };
      }
      case "patch": {
        const old: Partial<WizardDraft> = {};
        for (const key of Object.keys(action.patch) as (keyof WizardDraft)[]) {
          (old as Record<string, unknown>)[key] = before.draft[key];
        }
        return { type: "patch", patch: old };
      }
      case "updatePlacement": {
        const current = before.draft.placements.find((item) => item.id === action.id);
        if (!current) return { type: "hydrate", state: before };
        const old: Partial<PrefabPlacement> = {};
        for (const key of Object.keys(action.patch) as (keyof PrefabPlacement)[]) {
          (old as Record<string, unknown>)[key] = current[key];
        }
        return { type: "updatePlacement", id: action.id, patch: old };
      }
      case "updateLayer": {
        const current = (before.draft.terrain.layers ?? []).find((item) => item.id === action.id);
        if (!current) return { type: "hydrate", state: before };
        const old: Partial<TerrainLayer> = {};
        for (const key of Object.keys(action.patch) as (keyof TerrainLayer)[]) {
          (old as Record<string, unknown>)[key] = current[key];
        }
        return { type: "updateLayer", id: action.id, patch: old };
      }
      default:
        return { type: "hydrate", state: before };
    }
  };

  const dispatch = useCallback(
    (action: WizardAction) => {
      const transient = new Set([
        "hydrate", "selectPlacement", "setActiveLayer", "toggleStudio",
        "setWalkMode", "markSaved", "applyGenerated",
      ]);
      if (transient.has(action.type)) {
        lastEdit.current = null;
        applyAction(action);
        return;
      }
      if (action.type === "next" || action.type === "back" || action.type === "goTo") {
        future.current = [];
        setRedoDepth(0);
        lastEdit.current = null;
        applyAction(action);
        return;
      }

      const key = semanticKey(action);
      const now = Date.now();
      const coalesce = lastEdit.current?.key === key && now - lastEdit.current.at < 900;
      if (coalesce && history.current.length) {
        // Keep the original inverse; extend the redo action to the latest edit.
        const top = history.current[history.current.length - 1];
        history.current[history.current.length - 1] = { ...top, redo: action };
      } else {
        history.current.push({ label: labelFor(action), undo: inverseFor(action, state), redo: action });
        while (history.current.length > 25) history.current.shift();
        setHistoryDepth(history.current.length);
        future.current = [];
        setRedoDepth(0);
      }
      lastEdit.current = { key, at: now };
      applyAction(action);
    },
    [state],
  );

  const undo = useCallback((): string | null => {
    const entry = history.current.pop();
    if (!entry) return null;
    future.current.push(entry);
    while (future.current.length > 25) future.current.shift();
    setRedoDepth(future.current.length);
    setHistoryDepth(history.current.length);
    lastEdit.current = null;
    applyAction(entry.undo);
    return entry.label;
  }, []);

  const redo = useCallback((): string | null => {
    const entry = future.current.pop();
    if (!entry) return null;
    history.current.push(entry);
    while (history.current.length > 25) history.current.shift();
    setHistoryDepth(history.current.length);
    setRedoDepth(future.current.length);
    lastEdit.current = null;
    applyAction(entry.redo);
    return entry.label;
  }, []);

  // Prompt builds animate through several drafts. All but the last are applied
  // without touching history; the snapshot taken before the first one becomes
  // a single undo entry when the build finishes.
  const stagedSnapshot = useRef<WizardState | null>(null);

  const beginStagedBuild = useCallback(() => {
    stagedSnapshot.current = state;
  }, [state]);

  const applyStagedDraft = useCallback((draft: WizardDraft, step: WizardStepId) => {
    applyAction({ type: "applyGenerated", draft, step });
  }, []);

  const finishStagedBuild = useCallback((draft: WizardDraft, step: WizardStepId) => {
    const snapshot = stagedSnapshot.current;
    stagedSnapshot.current = null;
    if (snapshot) {
      history.current.push({
        label: "Generate build",
        undo: { type: "hydrate", state: snapshot },
        redo: { type: "applyGenerated", draft, step },
      });
      while (history.current.length > 25) history.current.shift();
      setHistoryDepth(history.current.length);
      future.current = [];
      setRedoDepth(0);
    }
    applyAction({ type: "applyGenerated", draft, step });
  }, []);

  const cancelStagedBuild = useCallback(() => {
    const snapshot = stagedSnapshot.current;
    stagedSnapshot.current = null;
    if (snapshot) applyAction({ type: "hydrate", state: snapshot });
  }, []);

  const [autosave, setAutosave] = useState<AutosaveState>({ phase: "idle", savedAt: null });
  const [gridReadyFor, setGridReadyFor] = useState<string | null>(null);
  const savedGrids = useRef<{
    projectId: string;
    heightmap: WizardDraft["terrain"]["heightmap"];
    masks: WizardDraft["terrain"]["masks"];
  } | null>(null);

  // Restore imported grids before the first autosave can replace them. A draft
  // loaded from the native shell already carries its grids inline.
  useEffect(() => {
    const projectId = state.draft.projectId;
    // Desktop projects carry grids in their native state; never let a browser
    // IndexedDB copy shadow it.
    if (
      DESKTOP_SHELL ||
      state.draft.terrain.heightmap ||
      state.draft.terrain.masks.length > 0
    ) {
      setGridReadyFor(projectId);
      return;
    }
    let cancelled = false;
    void readTerrainGrids(projectId).then((grids) => {
      if (cancelled) return;
      const current = stateRef.current;
      if (
        grids &&
        current.draft.projectId === projectId &&
        !current.draft.terrain.heightmap &&
        current.draft.terrain.masks.length === 0
      ) {
        applyAction({
          type: "hydrate",
          state: {
            ...current,
            draft: {
              ...current.draft,
              terrain: {
                ...current.draft.terrain,
                heightmap: grids.heightmap,
                masks: grids.masks,
              },
            },
          },
        });
      }
      setGridReadyFor(projectId);
    });
    return () => {
      cancelled = true;
    };
  }, [state.draft.projectId]);

  useEffect(() => {
    let disposed = false;
    const projectId = state.draft.projectId;
    const timer = window.setTimeout(() => {
      void (async () => {
        setAutosave((current) => ({ ...current, phase: "saving" }));
        const terrain = state.draft.terrain;
        const hasGrids = Boolean(terrain.heightmap) || terrain.masks.length > 0;
        let gridsStored = true;
        const signature = savedGrids.current;
        const gridsChanged =
          !signature ||
          signature.projectId !== projectId ||
          signature.heightmap !== terrain.heightmap ||
          signature.masks !== terrain.masks;
        const hadSavedGrids = Boolean(
          signature &&
            signature.projectId === projectId &&
            (signature.heightmap || signature.masks.length > 0),
        );
        // Only touch IndexedDB when there is something to store or a previous
        // record to clear; an empty project must not report a grid failure.
        if (
          !DESKTOP_SHELL &&
          gridReadyFor === projectId &&
          gridsChanged &&
          (hasGrids || hadSavedGrids)
        ) {
          gridsStored = hasGrids
            ? await writeTerrainGrids(projectId, terrain.heightmap, terrain.masks)
            : await clearTerrainGrids(projectId);
          if (gridsStored) {
            savedGrids.current = {
              projectId,
              heightmap: terrain.heightmap,
              masks: terrain.masks,
            };
          }
        }
        const local = writeAutosave(STORAGE_KEY, stateForLocalStorage(state));
        if (disposed) return;
        const phase = !local.ok ? "error" : gridsStored ? "saved" : "partial";
        setAutosave((current) => ({
          phase,
          savedAt: local.ok ? new Date().toISOString() : current.savedAt,
        }));
      })();
    }, 350);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [state, gridReadyFor]);

  const steps = useMemo(() => stepsFor(state.draft.projectKind), [state.draft.projectKind]);
  const issues = useMemo(() => validateDraft(state.draft), [state.draft]);
  const stepIssues = useMemo(
    () => issues.filter((issue) => issue.step === state.stepId),
    [issues, state.stepId],
  );
  const canContinue = !stepIssues.some((issue) => issue.severity === "error");
  const progressIndex = progress(state).index;

  const update = useCallback((patch: Partial<WizardDraft>) => {
    dispatch({ type: "patch", patch });
  }, []);

  const workspaces = useRef<Partial<Record<ProjectKind, WizardState>>>(loadWorkspaces());

  // Keep the in-memory snapshot of the active mode current, so leaving a tab
  // never resumes a stale draft.
  useEffect(() => {
    workspaces.current[state.draft.projectKind] = state;
  }, [state]);
  const switchWorkspace = useCallback(
    (
      kind: ProjectKind,
      options?: { seedPlacements?: PrefabPlacement[]; step?: WizardStepId },
    ) => {
      if (kind === state.draft.projectKind) return;
      // A switch inside the autosave debounce must not lose freshly imported
      // grids: the workspace copy is compact, so flush them to IndexedDB now.
      const terrain = state.draft.terrain;
      if (!DESKTOP_SHELL && (terrain.heightmap || terrain.masks.length > 0)) {
        void writeTerrainGrids(state.draft.projectId, terrain.heightmap, terrain.masks);
      }
      // Walk mode is a transient camera state; never carry it across tabs.
      workspaces.current[state.draft.projectKind] = {
        ...state,
        draft: { ...state.draft, walkMode: false },
      };
      // Monument edits made on prefabs opened from the map flow back into the
      // map copies with the same placement id, whichever tab is opened next.
      if (state.draft.projectKind === "monument") {
        const map = workspaces.current.map;
        if (map) {
          const placements = syncSharedPlacements(map.draft.placements, state.draft.placements);
          if (placements !== map.draft.placements) {
            workspaces.current.map = { ...map, draft: { ...map.draft, placements } };
          }
        }
      }
      saveWorkspaces(workspaces.current);
      const saved = workspaces.current[kind];
      const seeds = options?.seedPlacements ?? [];
      // Map → Monument jump-to opens the clicked prefab inside the existing
      // monument workspace, keeping whatever was already assembled there.
      if (saved) {
        const available = stepsFor(kind);
        const placements = mergeSeedPlacements(saved.draft.placements, seeds);
        const stepId =
          options?.step && available.includes(options.step) ? options.step : saved.stepId;
        applyAction({
          type: "hydrate",
          state: {
            ...saved,
            stepId,
            draft: {
              ...saved.draft,
              placements,
              walkMode: false,
              selectedPlacementId: seeds[0]?.id ?? saved.draft.selectedPlacementId,
            },
          },
        });
        return;
      }
      const base = createInitialDraft();
      const draft: WizardDraft = {
        ...base,
        projectKind: kind,
        branch: branchFor(kind),
        name:
          kind === "skin"
            ? "Skin workspace"
            : kind === "monument"
              ? "Monument workspace"
              : "Map workspace",
        placements: seeds,
        selectedPlacementId: seeds[0]?.id ?? null,
      };
      const steps = stepsFor(kind);
      const preferred: WizardStepId =
        kind === "monument" ? "monuments" : kind === "skin" ? "baseItem" : "terrain";
      const step =
        options?.step && steps.includes(options.step)
          ? options.step
          : steps.includes(preferred)
            ? preferred
            : steps[0];
      applyAction({
        type: "hydrate",
        state: { ...initialState(draft), stepId: step, furthestIndex: steps.length - 1 },
      });
    },
    [state],
  );

  const value: WizardContextValue = {
    state,
    dispatch,
    undo,
    canUndo: historyDepth > 0,
    redo,
    canRedo: redoDepth > 0,
    steps,
    issues,
    stepIssues,
    canContinue,
    progressIndex,
    autosave,
    update,
    switchWorkspace,
    beginStagedBuild,
    applyStagedDraft,
    finishStagedBuild,
    cancelStagedBuild,
  };

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizard(): WizardContextValue {
  const context = useContext(WizardContext);
  if (!context) throw new Error("useWizard must be used inside <WizardProvider>");
  return context;
}

export { STORAGE_KEY };
