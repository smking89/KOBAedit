import { useEffect, useMemo, useState } from "react";

import { AssetBrowser } from "./assets/AssetBrowser";
import { StepsNav } from "./components/StepsNav";
import { Badge, Button } from "./components/ui";
import { KobaPanel } from "./koba/KobaPanel";
import { demoMode, saveProject, syncStatus } from "./lib/ipc";
import {
  getQualityPreference,
  setQualityPreference,
  type QualityPreference,
} from "./lib/quality";
import { useWizard } from "./wizard/context";
import { STEP_META, stepsFor } from "./wizard/machine";
import { STEP_COMPONENTS } from "./wizard/steps";
import { Viewport } from "./viewport/Viewport";
import type { WizardStepId } from "./wizard/types";

export default function App() {
  const { state, dispatch, issues, stepIssues, canContinue } = useWizard();
  const draft = state.draft;
  const meta = STEP_META[state.stepId];
  const steps = stepsFor(draft.projectKind);
  const stepIndex = steps.indexOf(state.stepId);
  const isLast = stepIndex === steps.length - 1;
  const StepComponent = STEP_COMPONENTS[state.stepId];
  const [saving, setSaving] = useState(false);
  const [kobaOpen, setKobaOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [sync, setSync] = useState<{ active: boolean; pending: number; conflicts: number } | null>(null);
  const [quality, setQuality] = useState<QualityPreference>(() => getQualityPreference());

  useEffect(() => {
    syncStatus()
      .then((value) => setSync({ active: value.active, pending: value.pending, conflicts: value.conflicts }))
      .catch(() => setSync(null));
  }, [state.stepId]);

  const errors = useMemo(() => issues.filter((issue) => issue.severity === "error"), [issues]);
  const warnings = useMemo(() => issues.filter((issue) => issue.severity === "warning"), [issues]);
  const nextStep: WizardStepId | undefined = steps[stepIndex + 1];
  const blocker = !canContinue;

  const onSave = async () => {
    setSaving(true);
    try {
      await saveProject(draft, state.stepId);
      dispatch({ type: "markSaved", at: new Date().toISOString() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <div>
            <p className="brand-title">Rust Studio</p>
            <p className="brand-sub">Map, monument and skin workspace</p>
          </div>
        </div>

        <div className="topbar-project">
          <span className="project-name">{draft.name || "Untitled project"}</span>
          <span className="topbar-sep" />
          <Badge tone="neutral">
            {draft.projectKind === "map" ? "Full map" : draft.projectKind === "monument" ? "Monument" : "Skin"}
          </Badge>
          <Badge tone={draft.mode === "online" ? "accent" : "neutral"}>
            {draft.mode === "online" ? "Online sync" : "Offline"}
          </Badge>
          {demoMode() && <Badge tone="warn">Preview data</Badge>}
        </div>

        <div className="topbar-actions">
          <span className={`save-state${state.dirty ? " is-dirty" : ""}`}>
            {saving
              ? "Saving"
              : state.dirty
                ? "Unsaved changes"
                : state.lastSavedAt
                  ? "Saved locally"
                  : "Autosaved draft"}
          </span>
          <button
            type="button"
            className={`koba-launch${kobaOpen ? " is-active" : ""}`}
            aria-expanded={kobaOpen}
            onClick={() => {
              setAssetsOpen(false);
              setKobaOpen((value) => !value);
            }}
          >
            <span className="koba-launch-mark" aria-hidden="true">
              K
            </span>
            <span>
              <strong>KOBA EDIT</strong>
              <em>Prompt build</em>
            </span>
          </button>
          <button
            type="button"
            className={`asset-launch${assetsOpen ? " is-active" : ""}`}
            aria-expanded={assetsOpen}
            onClick={() => {
              setKobaOpen(false);
              setAssetsOpen((value) => !value);
            }}
          >
            <span className="asset-launch-mark" aria-hidden="true">
              A
            </span>
            <span>
              <strong>Assets</strong>
              <em>Local index</em>
            </span>
          </button>
          <Button variant="ghost" onClick={onSave} disabled={saving}>
            Save project
          </Button>
          <button
            type="button"
            className="studio-toggle"
            aria-pressed={draft.studioMode}
            onClick={() => dispatch({ type: "toggleStudio" })}
          >
            <span className="studio-toggle-track">
              <span />
            </span>
            <span>
              <strong>Studio Mode</strong>
              <em>{draft.studioMode ? "Full manual controls unlocked" : "Guided wizard"}</em>
            </span>
          </button>
        </div>
      </header>

      <div className="shell">
        <StepsNav />

        <main className="stage">
          <div className="viewport-frame">
            <Viewport
              key={quality}
              draft={draft}
              stepId={state.stepId}
              onSculpt={() => dispatch({ type: "registerPaintStroke" })}
              onPaint={() => dispatch({ type: "registerPaintStroke" })}
            />
            <div className="viewport-hud">
              <div>
                <span className="hud-label">Viewport</span>
                <span className="hud-value">
                  {draft.branch === "world"
                    ? `${draft.terrain.sizeMetres} m terrain / ${draft.placements.length} prefabs / ${draft.splines.length} splines`
                    : draft.skin.baseMeshName || "No base mesh selected"}
                </span>
              </div>
              <div className="hud-right">
                <span className="hud-label">Mode</span>
                <span className="hud-value">{draft.studioMode ? "Studio" : "Guided"}</span>
              </div>
            </div>
          </div>
          <footer className="stagebar">
            <div className="stagebar-group">
              <span>Engine</span>
              <strong>Tauri / WebGL2</strong>
            </div>
            <div className="stagebar-group">
              <span>Validation</span>
              <strong className={errors.length ? "text-danger" : warnings.length ? "text-warn" : "text-ok"}>
                {errors.length} errors / {warnings.length} warnings
              </strong>
            </div>
            <div className="stagebar-group">
              <span>Sync</span>
              <strong>
                {draft.mode === "offline"
                  ? "Local only"
                  : sync?.active
                    ? `${sync.pending} queued / ${sync.conflicts} conflicts`
                    : "Queued for connection"}
              </strong>
            </div>
            <div className="stagebar-spacer" />
            <label className="quality-control">
              <span>Quality</span>
              <select
                value={quality}
                aria-label="Viewport quality"
                onChange={(event) => {
                  const next = event.target.value as QualityPreference;
                  setQualityPreference(next);
                  setQuality(next);
                }}
              >
                <option value="auto">Auto</option>
                <option value="low">Low</option>
                <option value="mid">Mid</option>
                <option value="high">High</option>
              </select>
            </label>
            <button
              type="button"
              className="link-button"
              onClick={() => dispatch({ type: "back" })}
              disabled={stepIndex === 0}
            >
              Previous step
            </button>
            <span className="step-count">
              Step {stepIndex + 1} / {steps.length}
            </span>
          </footer>
        </main>

        <aside className="inspector">
          <header className="inspector-head">
            <p className="eyebrow">
              {draft.branch === "skin" ? "Skin branch" : "World branch"} / Step{" "}
              {String(stepIndex + 1).padStart(2, "0")}
            </p>
            <h1>{meta.title}</h1>
            <p className="inspector-desc">{meta.description}</p>
            {meta.studioTools.length > 0 && (
              <div className={`studio-hint${draft.studioMode ? " is-on" : ""}`}>
                <span>{draft.studioMode ? "Studio tools active" : "Advanced tools available"}</span>
                <ul>
                  {meta.studioTools.map((tool) => (
                    <li key={tool}>{tool}</li>
                  ))}
                </ul>
              </div>
            )}
          </header>

          <div className="inspector-scroll">
            <StepComponent />
          </div>

          <footer className="inspector-foot">
            <div className={`guard-note${blocker ? " is-error" : ""}`}>
              {blocker
                ? stepIssues.find((issue) => issue.severity === "error")?.message
                : isLast
                  ? "Review the export settings, then write the final file."
                  : nextStep
                    ? `Next: ${STEP_META[nextStep].label}`
                    : "Ready"}
            </div>
            <div className="inspector-actions">
              <Button variant="ghost" onClick={() => dispatch({ type: "back" })} disabled={stepIndex === 0}>
                Back
              </Button>
              <Button
                variant="primary"
                onClick={() => dispatch({ type: "next" })}
                disabled={blocker || isLast}
              >
                {isLast ? "Final step" : "Continue"}
              </Button>
            </div>
          </footer>
        </aside>
      </div>

      <KobaPanel open={kobaOpen} onClose={() => setKobaOpen(false)} />
      <AssetBrowser open={assetsOpen} onClose={() => setAssetsOpen(false)} />
    </div>
  );
}
