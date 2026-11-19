import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import {
  createInitialDraft,
  initialState,
  progress,
  stepsFor,
  validateDraft,
  wizardReducer,
  type WizardAction,
} from "./machine";
import type { ValidationIssue, WizardDraft, WizardState, WizardStepId } from "./types";

const STORAGE_KEY = "rust-studio:wizard:v1";

interface WizardContextValue {
  state: WizardState;
  dispatch: (action: WizardAction) => void;
  steps: WizardStepId[];
  issues: ValidationIssue[];
  stepIssues: ValidationIssue[];
  canContinue: boolean;
  progressIndex: number;
  update: (patch: Partial<WizardDraft>) => void;
}

const WizardContext = createContext<WizardContextValue | null>(null);

function mergeDraft(draft: Partial<WizardDraft> | undefined): WizardDraft {
  const base = createInitialDraft();
  if (!draft) return base;
  return {
    ...base,
    ...draft,
    terrain: { ...base.terrain, ...draft.terrain, brush: { ...base.terrain.brush, ...draft.terrain?.brush } },
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
  const [state, dispatch] = useReducer(wizardReducer, undefined, loadInitialState);

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

  const value: WizardContextValue = {
    state,
    dispatch,
    steps,
    issues,
    stepIssues,
    canContinue,
    progressIndex,
    update,
  };

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizard(): WizardContextValue {
  const context = useContext(WizardContext);
  if (!context) throw new Error("useWizard must be used inside <WizardProvider>");
  return context;
}

export { STORAGE_KEY };
