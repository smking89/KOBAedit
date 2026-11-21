import { useState } from "react";

import { useWizard } from "../wizard/context";
import { stepsFor } from "../wizard/machine";
import type { WizardStepId } from "../wizard/types";
import { Icon, type IconName } from "./Icons";
import { StepsNav } from "./StepsNav";

type DrawerId = "outliner" | "layers";

const DRAWERS: { id: DrawerId; icon: IconName; label: string }[] = [
  { id: "outliner", icon: "select", label: "Outliner" },
  { id: "layers", icon: "terrain", label: "Terrain layers" },
];

const ACTIONS: { id: "assets" | "cui"; icon: IconName; label: string }[] = [
  { id: "assets", icon: "material", label: "Asset browser" },
  { id: "cui", icon: "puzzle", label: "CUI designer" },
];

export function ContextRail({
  collapsed,
  onToggleCollapsed,
  onOpenAssets,
  onOpenCui,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenAssets: () => void;
  onOpenCui: () => void;
}) {
  const { state, dispatch, issues } = useWizard();
  const draft = state.draft;
  const studio = draft.studioMode;
  const steps = stepsFor(draft.projectKind);
  const currentIndex = steps.indexOf(state.stepId);
  const [drawer, setDrawer] = useState<DrawerId | null>("outliner");

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  const layers = draft.terrain.layers ?? [];
  const activeTool = DRAWERS.find((tool) => tool.id === drawer);

  return (
    <aside
      className={`context-rail${collapsed ? " is-collapsed" : ""}`}
      aria-label={studio ? "Studio tools" : "Wizard steps"}
    >
      <header className="rail-head">
        {!collapsed && (
          <span className="rail-title">{studio ? "Studio tools" : "Wizard steps"}</span>
        )}
        <button
          type="button"
          className="rail-mode"
          title={studio ? "Switch to guided wizard" : "Switch to studio mode"}
          onClick={() => dispatch({ type: "toggleStudio" })}
        >
          {collapsed ? (studio ? "S" : "W") : studio ? "Wizard" : "Studio"}
        </button>
        <button
          type="button"
          className="rail-collapse"
          aria-label={collapsed ? "Expand context rail" : "Collapse context rail"}
          title={collapsed ? "Expand rail" : "Collapse rail"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? "\u00bb" : "\u00ab"}
        </button>
      </header>

      {!studio && !collapsed && <StepsNav />}

      {!studio && collapsed && (
        <ol className="rail-mini-steps">
          {steps.map((stepId: WizardStepId, index) => {
            const active = stepId === state.stepId;
            const blocking = issues.some(
              (issue) => issue.step === stepId && issue.severity === "error",
            );
            return (
              <li key={stepId}>
                <button
                  type="button"
                  className={`rail-mini-step${active ? " is-active" : ""}${
                    blocking ? " has-error" : ""
                  }`}
                  title={`${index + 1}. ${stepId}`}
                  aria-label={`Step ${index + 1}`}
                  aria-current={active ? "step" : undefined}
                  onClick={() => dispatch({ type: "goTo", step: stepId })}
                >
                  {index + 1}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {studio && (
        <div className="rail-studio">
          <nav className="rail-tools" aria-label="Studio tools">
            {DRAWERS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={`rail-tool${drawer === tool.id ? " is-active" : ""}`}
                title={tool.label}
                aria-label={tool.label}
                aria-pressed={drawer === tool.id}
                onClick={() => setDrawer((current) => (current === tool.id ? null : tool.id))}
              >
                <Icon name={tool.icon} size={18} />
              </button>
            ))}
            {ACTIONS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className="rail-tool"
                title={tool.label}
                aria-label={tool.label}
                onClick={() => {
                  setDrawer(null);
                  if (tool.id === "assets") onOpenAssets();
                  else onOpenCui();
                }}
              >
                <Icon name={tool.icon} size={18} />
              </button>
            ))}
          </nav>

          {!collapsed && activeTool && (
            <section className="rail-drawer" aria-label={activeTool.label}>
              <header className="rail-drawer-head">
                <h3>{activeTool.label}</h3>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setDrawer(null)}
                >
                  Close
                </button>
              </header>

              {drawer === "outliner" && (
                <ul className="rail-list">
                  <li className="rail-list-group">Terrain layers</li>
                  {layers.length === 0 && <li className="rail-empty">No painted layers yet.</li>}
                  {layers.map((layer) => (
                    <li key={layer.id}>
                      <button
                        type="button"
                        className="rail-list-row"
                        onClick={() =>
                          dispatch({
                            type: "patchTerrain",
                            patch: {
                              layers: layers.map((item) =>
                                item.id === layer.id ? { ...item, visible: !item.visible } : item,
                              ),
                            },
                          })
                        }
                      >
                        <span className="rail-row-dot" aria-hidden="true" data-visible={layer.visible} />
                        <span>{layer.name}</span>
                        <em>{layer.strokes.length} strokes</em>
                      </button>
                    </li>
                  ))}
                  <li className="rail-list-group">Placements</li>
                  {draft.placements.length === 0 && (
                    <li className="rail-empty">Nothing placed in this project yet.</li>
                  )}
                  {draft.placements.map((placement) => (
                    <li key={placement.id}>
                      <span className="rail-row-static">
                        <span>{placement.name}</span>
                        <em>
                          {placement.position.x.toFixed(0)}, {placement.position.z.toFixed(0)}
                        </em>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {drawer === "layers" && (
                <ul className="rail-list">
                  {layers.length === 0 && (
                    <li className="rail-empty">
                      Sculpt or paint in the viewport to create the first layer.
                    </li>
                  )}
                  {layers.map((layer) => (
                    <li key={layer.id}>
                      <button
                        type="button"
                        className="rail-list-row"
                        onClick={() =>
                          dispatch({
                            type: "patchTerrain",
                            patch: {
                              layers: layers.map((item) =>
                                item.id === layer.id ? { ...item, visible: !item.visible } : item,
                              ),
                            },
                          })
                        }
                      >
                        <span className="rail-row-dot" aria-hidden="true" data-visible={layer.visible} />
                        <span>{layer.name}</span>
                        <em>
                          {layer.kind} / {Math.round(layer.opacity * 100)}%
                        </em>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      {!studio && !collapsed && (
        <footer className="rail-foot">
          <span className="rail-title">Validation</span>
          <p className={errors ? "text-danger" : warnings ? "text-warn" : "text-ok"}>
            {errors} errors / {warnings} warnings
          </p>
          <p className="rail-step-count">
            Step {currentIndex + 1} / {steps.length}
          </p>
        </footer>
      )}
    </aside>
  );
}
