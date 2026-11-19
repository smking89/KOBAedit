import { STEP_META, stepsFor } from "../wizard/machine";
import { useWizard } from "../wizard/context";
import type { WizardStepId } from "../wizard/types";

export function StepsNav() {
  const { state, dispatch, issues } = useWizard();
  const steps = stepsFor(state.draft.projectKind);
  const currentIndex = steps.indexOf(state.stepId);

  return (
    <nav className="steps-nav" aria-label="Wizard steps">
      <div className="steps-branch">
        <span className="section-label">Workflow</span>
        <p>{state.draft.branch === "skin" ? "Skin creation" : state.draft.projectKind === "monument" ? "Monument" : "Full map"}</p>
      </div>
      <ol>
        {steps.map((stepId: WizardStepId, index) => {
          const meta = STEP_META[stepId];
          const locked = !state.draft.studioMode && index > state.furthestIndex;
          const active = stepId === state.stepId;
          const blocking = issues.some((issue) => issue.step === stepId && issue.severity === "error");
          const done = index < currentIndex && !blocking;
          return (
            <li key={stepId}>
              <button
                type="button"
                className={`step-item${active ? " is-active" : ""}${locked ? " is-locked" : ""}`}
                disabled={locked}
                onClick={() => dispatch({ type: "goTo", step: stepId })}
              >
                <span className={`step-index${done ? " is-done" : ""}${blocking ? " has-error" : ""}`}>
                  {done ? "OK" : String(index + 1).padStart(2, "0")}
                </span>
                <span className="step-copy">
                  <span className="step-label">{meta.label}</span>
                  <span className="step-sub">{locked ? "Complete previous steps" : meta.studioTools.length ? `${meta.studioTools.length} studio tools` : "Setup"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="steps-foot">
        <span className="section-label">Offline state</span>
        <p>Project autosaves locally. Sync queues when the shell reports connectivity.</p>
      </div>
    </nav>
  );
}
