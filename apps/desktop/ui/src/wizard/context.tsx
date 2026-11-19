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
import type {
  PrefabPlacement,
  ProjectKind,
  ValidationIssue,
  WizardDraft,
  WizardState,
  WizardStepId,
} from "./types";

const STORAGE_KEY = "rust-studio:wizard:v1";
const WORKSPACES_KEY = "rust-studio:wizard:workspaces:v1";

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
  try {
    window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
  } catch {
    // Quota failures must never break editing.
  }
}

interface WizardContextValue {
  state: WizardState;
  dispatch: (action: WizardAction) => void;
  /** Restore the placements as they were before the last map edit. */
  undo: () => void;
  canUndo: boolean;
  steps: WizardStepId[];
  issues: ValidationIssue[];
  stepIssues: ValidationIssue[];
  canContinue: boolean;
  progressIndex: number;
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

  // Placement edits are the ones made directly on the map (drop, select,
  // delete, nudge), so that is the history a creator expects to undo there.
  type UndoEntry =
    | { kind: "placements"; placements: PrefabPlacement[]; selectedPlacementId: string | null }
    | { kind: "state"; state: WizardState };
  const history = useRef<UndoEntry[]>([]);
  const lastEdit = useRef<{ key: string; at: number } | null>(null);
  const [historyDepth, setHistoryDepth] = useState(0);

  const dispatch = useCallback(
    (action: WizardAction) => {
      const tracksPlacements =
        action.type === "addPlacement" ||
        action.type === "removePlacement" ||
        action.type === "updatePlacement";
      if (tracksPlacements) {
        const key = action.type === "updatePlacement" ? `update:${action.id}` : action.type;
        const now = Date.now();
        // Slider drags fire many updates for the same placement; collapse them
        // into one undo step instead of filling the stack with tiny moves.
        const coalesce =
          action.type === "updatePlacement" &&
          lastEdit.current?.key === key &&
          now - lastEdit.current.at < 900;
        if (!coalesce) {
          history.current.push({
            kind: "placements",
            placements: state.draft.placements,
            selectedPlacementId: state.draft.selectedPlacementId,
          });
          if (history.current.length > 40) history.current.shift();
          setHistoryDepth(history.current.length);
        }
        lastEdit.current = { key, at: now };
      } else {
        lastEdit.current = null;
      }
      applyAction(action);
    },
    [state.draft.placements, state.draft.selectedPlacementId],
  );

  const undo = useCallback(() => {
    const snapshot = history.current.pop();
    if (!snapshot) return;
    setHistoryDepth(history.current.length);
    lastEdit.current = null;
    if (snapshot.kind === "state") {
      applyAction({ type: "hydrate", state: snapshot.state });
      return;
    }
    applyAction({ type: "patch", patch: snapshot });
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
      history.current.push({ kind: "state", state: snapshot });
      if (history.current.length > 40) history.current.shift();
      setHistoryDepth(history.current.length);
    }
    applyAction({ type: "applyGenerated", draft, step });
  }, []);

  const cancelStagedBuild = useCallback(() => {
    const snapshot = stagedSnapshot.current;
    stagedSnapshot.current = null;
    if (snapshot) applyAction({ type: "hydrate", state: snapshot });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Offline quota failures must never break editing.
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [state]);

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
    steps,
    issues,
    stepIssues,
    canContinue,
    progressIndex,
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
