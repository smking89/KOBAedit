import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AssetBrowser } from "./assets/AssetBrowser";
import { BrandingPanel } from "./components/BrandingPanel";
import { StepsNav } from "./components/StepsNav";
import { WatermarkOverlay } from "./components/WatermarkOverlay";
import { loadBranding, saveBranding } from "./lib/branding";
import { Badge, Button } from "./components/ui";
import { KobaPanel } from "./koba/KobaPanel";
import { demoMode, saveProject, syncStatus } from "./lib/ipc";
import { lightingState } from "./lib/lighting";
import { draggedPrefab, endPrefabDrag } from "./lib/prefabDrag";
import { refreshProjectThumbnail } from "./utils/thumbnailQueue";
import {
  detectQualityProfile,
  getQualityPreference,
  setQualityPreference,
  type QualityPreference,
} from "./lib/quality";
import { useWizard } from "./wizard/context";
import { STEP_META, flattenRadiusFromBounds, stepsFor } from "./wizard/machine";
import { STEP_COMPONENTS } from "./wizard/steps";
import { Viewport, type GroundTools } from "./viewport/Viewport";
import { RadarMap } from "./viewport/RadarMap";
import type { BuildPlanStatus } from "./viewport/TerrainViewport";
import type { WeatherPreset, WizardStepId } from "./wizard/types";

const WEATHER_PRESETS: { id: WeatherPreset; label: string }[] = [
  { id: "clear", label: "Clear" },
  { id: "overcast", label: "Overcast" },
  { id: "fog", label: "Fog" },
  { id: "dust", label: "Dust" },
];

// Panels that float above the terrain: a prefab dropped on one of them must not
// raycast through and land somewhere the user cannot see.
const PANEL_SELECTOR = ".inspector, .asset-panel, .asset-backdrop, .koba-panel, .radar-overlay";

export default function App() {
  const { state, dispatch, issues, stepIssues, canContinue, undo, canUndo, switchWorkspace } =
    useWizard();
  const draft = state.draft;
  const meta = STEP_META[state.stepId];
  const steps = stepsFor(draft.projectKind);
  const stepIndex = steps.indexOf(state.stepId);
  const isLast = stepIndex === steps.length - 1;
  const StepComponent = STEP_COMPONENTS[state.stepId];
  const [saving, setSaving] = useState(false);
  const [kobaOpen, setKobaOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);
  const [brandingState, setBrandingState] = useState(loadBranding);

  useEffect(() => {
    saveBranding(brandingState);
  }, [brandingState]);
  const [radarOpen, setRadarOpen] = useState(false);
  const [sync, setSync] = useState<{ active: boolean; pending: number; conflicts: number } | null>(null);
  const [quality, setQuality] = useState<QualityPreference>(() => getQualityPreference());
  const [buildStatus, setBuildStatus] = useState<BuildPlanStatus | null>(null);
  const [flashlight, setFlashlight] = useState(false);
  const [walkCollision, setWalkCollision] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const lighting = lightingState(
    draft.lighting?.timeOfDay ?? 630,
    draft.lighting?.weather ?? "clear",
  );
  const resolvedQuality = useMemo(() => detectQualityProfile(), [quality]);
  // Test Mode is a read-only checklist over the draft: it never edits, so it is
  // safe to leave on while walking the map.
  const testChecks = useMemo(() => {
    if (draft.branch !== "world") return [];
    const roads = draft.splines.filter((spline) => spline.kind === "road" && spline.nodes.length >= 2);
    const caves = draft.splines.filter((spline) => spline.kind === "cave");
    return [
      { label: "Terrain generated", ok: draft.terrain.sizeMetres >= 1000 },
      { label: "Water level set", ok: Number.isFinite(draft.terrain.waterLevel) },
      {
        label: "Prefabs placed and conformed",
        ok: draft.placements.length > 0 && draft.placements.every((item) => item.flatten !== false),
      },
      { label: "Road network present", ok: roads.length > 0 },
      { label: "Cave tunnel carved", ok: caves.length > 0 },
    ];
  }, [draft]);

  useEffect(() => {
    syncStatus()
      .then((value) => setSync({ active: value.active, pending: value.pending, conflicts: value.conflicts }))
      .catch(() => setSync(null));
  }, [state.stepId]);

  const errors = useMemo(() => issues.filter((issue) => issue.severity === "error"), [issues]);
  const warnings = useMemo(() => issues.filter((issue) => issue.severity === "warning"), [issues]);
  const nextStep: WizardStepId | undefined = steps[stepIndex + 1];
  const blocker = !canContinue;

  // Prefab cards are dragged out of the asset drawer onto the terrain; the
  // viewport hands back a screen-to-ground projector while it is mounted.
  const groundTools = useRef<GroundTools | null>(null);
  const [prefabDragActive, setPrefabDragActive] = useState(false);

  const clearPrefabDrag = useCallback(() => {
    endPrefabDrag();
    setPrefabDragActive(false);
    groundTools.current?.ghost(null);
  }, []);

  // A prefab drag can end without a drop: Escape, a cancelled drag (the card's
  // dragend) or the pointer leaving the window. Without this the drop-target
  // highlight stays on until the next drag starts.
  useEffect(() => {
    const finish = () => clearPrefabDrag();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearPrefabDrag();
    };
    const onDragLeaveWindow = (event: DragEvent) => {
      if (event.relatedTarget) return;
      const { clientX, clientY } = event;
      const inside =
        clientX > 0 && clientY > 0 && clientX < window.innerWidth && clientY < window.innerHeight;
      if (!inside) clearPrefabDrag();
    };
    // dragend is captured so an unmounted card still reports it; drop stays in
    // the bubble phase because React's own drop handler reads the dragged prefab.
    window.addEventListener("dragend", finish, true);
    window.addEventListener("drop", finish);
    window.addEventListener("dragleave", onDragLeaveWindow);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("dragend", finish, true);
      window.removeEventListener("drop", finish);
      window.removeEventListener("dragleave", onDragLeaveWindow);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clearPrefabDrag]);

  // Drawer and map shortcuts. A toggles the asset drawer, Delete removes the
  // prefab selected on the map, Cmd/Ctrl+Z restores the previous placement.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Events dispatched at the window have no element target; only skip the
      // shortcut when a real field owns the keystroke.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if ((event.key === "z" || event.key === "Z") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        undo();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && state.draft.selectedPlacementId) {
        event.preventDefault();
        dispatch({ type: "removePlacement", id: state.draft.selectedPlacementId });
        return;
      }
      if ((event.key === "a" || event.key === "A") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setKobaOpen(false);
        setAssetsOpen((value) => !value);
        return;
      }
      if ((event.key === "g" || event.key === "G") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.repeat) return;
        event.preventDefault();
        // Walk mode owns pointer lock; the 2D map is a pointer surface, so a
        // G press leaves walk mode first instead of fighting the lock.
        if (!radarOpen && state.draft.walkMode) {
          dispatch({ type: "setWalkMode", enabled: false });
        }
        setRadarOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, undo, radarOpen, state.draft.selectedPlacementId, state.draft.walkMode]);

  const onPrefabDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    const prefab = draggedPrefab();
    if (!prefab) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!prefabDragActive) setPrefabDragActive(true);
    // Live conforming footprint: the same radius and falloff the drop will use,
    // coloured by how steep the ground under the cursor is.
    const tools = groundTools.current;
    if (!tools) return;
    const info = tools.info(event.clientX, event.clientY);
    if (!info) {
      tools.ghost(null);
      return;
    }
    tools.ghost({
      x: info.x,
      z: info.z,
      radius: Math.max(8, prefab.flattenRadius || flattenRadiusFromBounds(prefab.bounds)),
      falloff: 18,
      steep: info.slope > 18,
    });
  };

  const onPrefabDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const prefab = draggedPrefab();
    event.preventDefault();
    clearPrefabDrag();
    if (!prefab) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(PANEL_SELECTOR)) return;
    const hit = groundTools.current?.pick(event.clientX, event.clientY) ?? null;
    // Only a drop that lands on the terrain places a prefab; dropping over the
    // inspector or the drawer itself does nothing.
    if (!hit) return;
    dispatch({ type: "addPlacement", asset: prefab, position: { x: hit.x, z: hit.z } });
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await saveProject(draft, state.stepId);
      dispatch({ type: "markSaved", at: new Date().toISOString() });
      void refreshProjectThumbnail(draft).catch(() => {
        // The cached GLB may not exist yet; saving must not fail because of art.
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`app${prefabDragActive ? " is-prefab-drag" : ""}`}
      onDragOver={onPrefabDragOver}
      onDragLeave={(event) => {
        if (!event.relatedTarget) clearPrefabDrag();
      }}
      onDrop={onPrefabDrop}
    >
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/koba-wordmark.png" alt="KOBA EDIT" />
          <p className="brand-sub">Map, monument and skin workspace</p>
        </div>

        <nav className="mode-tabs" aria-label="Workspace mode">
          {([
            ["map", "Map"],
            ["monument", "Monument"],
            ["skin", "Skin"],
          ] as const).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className={`mode-tab${draft.projectKind === kind ? " is-active" : ""}`}
              aria-current={draft.projectKind === kind ? "page" : undefined}
              onClick={() => switchWorkspace(kind)}
            >
              {label}
            </button>
          ))}
        </nav>

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
          <Button
            variant={brandingOpen ? "primary" : "ghost"}
            aria-pressed={brandingOpen}
            onClick={() => setBrandingOpen((open) => !open)}
          >
            Branding
          </Button>
          <Button variant="ghost" onClick={undo} disabled={!canUndo}>
            Undo
          </Button>
          <Button variant="ghost" onClick={onSave} disabled={saving}>
            Save project
          </Button>
          {draft.branch === "world" && (
            <>
              <Button
                variant={draft.walkMode ? "primary" : "ghost"}
                onClick={() => dispatch({ type: "setWalkMode", enabled: !draft.walkMode })}
              >
                {draft.walkMode ? "Exit Walk" : "Walk Mode"}
              </Button>
              <Button
                variant={testMode ? "primary" : "ghost"}
                aria-pressed={testMode}
                onClick={() => setTestMode((enabled) => !enabled)}
              >
                Test Mode
              </Button>
            </>
          )}
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
            <WatermarkOverlay
              settings={brandingState.watermark}
              branding={brandingState.branding}
            />
            <Viewport
              key={quality}
              draft={draft}
              stepId={state.stepId}
              onSculpt={(strokes) => dispatch({ type: "addStrokes", strokes })}
              onPaint={() => dispatch({ type: "registerPaintStroke" })}
              onGroundPicker={(tools) => {
                groundTools.current = tools;
              }}
              onSelectPlacement={(id) => dispatch({ type: "selectPlacement", id })}
              onMovePlacement={(id, position) =>
                dispatch({ type: "updatePlacement", id, patch: { position } })
              }
              onBuildStatus={setBuildStatus}
              onFlashlight={setFlashlight}
              onScrubTime={(delta) => {
                const current = draft.lighting?.timeOfDay ?? 630;
                // Wrap around midnight so `[` at 00:00 lands on 23:00.
                const next = (((current + delta) % 1440) + 1440) % 1440;
                dispatch({ type: "setLighting", patch: { timeOfDay: next } });
              }}
              onExitWalk={() => dispatch({ type: "setWalkMode", enabled: false })}
              onWalkCollision={setWalkCollision}
              onOpenPlacement={(id) => {
                const placement = draft.placements.find((item) => item.id === id);
                if (!placement || draft.projectKind === "monument") return;
                switchWorkspace("monument", {
                  seedPlacements: [{ ...placement }],
                  step: "monuments",
                });
              }}
            />
            <div className="lighting-strip" role="group" aria-label="Time of day and weather">
              <span className="lighting-clock">{lighting.label}</span>
              <input
                type="range"
                min={0}
                max={1439}
                step={5}
                value={draft.lighting?.timeOfDay ?? 630}
                aria-label="Time of day"
                onChange={(event) =>
                  dispatch({ type: "setLighting", patch: { timeOfDay: Number(event.target.value) } })
                }
              />
              <span className="lighting-phase">{lighting.phase}</span>
              <span className="lighting-sep" aria-hidden="true" />
              <div className="lighting-weather">
                {WEATHER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`lighting-chip${draft.lighting?.weather === preset.id ? " is-active" : ""}`}
                    aria-pressed={draft.lighting?.weather === preset.id}
                    onClick={() => dispatch({ type: "setLighting", patch: { weather: preset.id } })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            {testMode && draft.branch === "world" && (
              <div className="test-panel" role="status" aria-live="polite">
                <header>
                  <strong>Test Mode</strong>
                  <span>
                    {testChecks.filter((check) => check.ok).length}/{testChecks.length}
                  </span>
                  <button type="button" className="link-button" onClick={() => setTestMode(false)}>
                    Close
                  </button>
                </header>
                <ul>
                  {testChecks.map((check) => (
                    <li key={check.label} className={check.ok ? "is-ok" : "is-fail"}>
                      <span aria-hidden="true">{check.ok ? "✓" : "✗"}</span> {check.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {draft.walkMode && (
              <div className="touch-walk" aria-label="Touch walk controls">
                <div className="touch-stick">
                  <button
                    type="button"
                    aria-label="Walk forward"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      groundTools.current?.setWalkInput({ forward: 1 });
                    }}
                    onPointerUp={() => groundTools.current?.setWalkInput({ forward: 0 })}
                    onPointerLeave={() => groundTools.current?.setWalkInput({ forward: 0 })}
                    onPointerCancel={() => groundTools.current?.setWalkInput({ forward: 0 })}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label="Strafe left"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      groundTools.current?.setWalkInput({ strafe: -1 });
                    }}
                    onPointerUp={() => groundTools.current?.setWalkInput({ strafe: 0 })}
                    onPointerLeave={() => groundTools.current?.setWalkInput({ strafe: 0 })}
                    onPointerCancel={() => groundTools.current?.setWalkInput({ strafe: 0 })}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    aria-label="Strafe right"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      groundTools.current?.setWalkInput({ strafe: 1 });
                    }}
                    onPointerUp={() => groundTools.current?.setWalkInput({ strafe: 0 })}
                    onPointerLeave={() => groundTools.current?.setWalkInput({ strafe: 0 })}
                    onPointerCancel={() => groundTools.current?.setWalkInput({ strafe: 0 })}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    aria-label="Walk back"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      groundTools.current?.setWalkInput({ forward: -1 });
                    }}
                    onPointerUp={() => groundTools.current?.setWalkInput({ forward: 0 })}
                    onPointerLeave={() => groundTools.current?.setWalkInput({ forward: 0 })}
                    onPointerCancel={() => groundTools.current?.setWalkInput({ forward: 0 })}
                  >
                    ▼
                  </button>
                </div>
                <div className="touch-actions">
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      groundTools.current?.setWalkInput({ jump: true });
                    }}
                    onPointerUp={() => groundTools.current?.setWalkInput({ jump: false })}
                    onPointerCancel={() => groundTools.current?.setWalkInput({ jump: false })}
                  >
                    Jump
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(
                        new KeyboardEvent("keydown", { code: "KeyF", key: "f", bubbles: true }),
                      );
                    }}
                  >
                    Flashlight
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(
                        new KeyboardEvent("keydown", { code: "KeyB", key: "b", bubbles: true }),
                      );
                    }}
                  >
                    Build plan
                  </button>
                </div>
              </div>
            )}
            {draft.walkMode && flashlight && <div className="walk-flag">F · Flashlight</div>}
            {draft.walkMode && walkCollision && (
              <div className="walk-flag is-collision">Capsule blocked · {walkCollision}</div>
            )}
            {draft.walkMode && buildStatus && (
              <div className={`build-hud${buildStatus.valid ? " is-valid" : " is-invalid"}`}>
                <span className="build-piece">{buildStatus.pieceLabel}</span>
                <span className="build-reason">{buildStatus.reason}</span>
                <span className="build-count">{buildStatus.placed} placed</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => groundTools.current?.clearBuilds()}
                >
                  Clear test builds
                </button>
              </div>
            )}
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
                <span className="hud-value">
                  {draft.walkMode ? "Walk" : draft.studioMode ? "Studio" : "Guided"}
                </span>
                <button
                  type="button"
                  className="link-button radar-launch"
                  aria-pressed={radarOpen}
                  onClick={() => setRadarOpen((value) => !value)}
                >
                  {radarOpen ? "3D view" : "G-key map"}
                </button>
              </div>
            </div>
            {radarOpen && <RadarMap draft={draft} onClose={() => setRadarOpen(false)} />}
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
              <span>Quality {quality === "auto" ? `Auto / ${resolvedQuality.tier}` : resolvedQuality.tier}</span>
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

      <KobaPanel
        open={kobaOpen}
        onClose={() => setKobaOpen(false)}
        onStageFocus={(next, stage) => {
          if (!next.placements.length) {
            if (stage === 0) groundTools.current?.focus(0, 0, 900);
            return;
          }
          const xs = next.placements.map((item) => item.position.x);
          const zs = next.placements.map((item) => item.position.z);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minZ = Math.min(...zs);
          const maxZ = Math.max(...zs);
          const span = Math.max(maxX - minX, maxZ - minZ, 240);
          groundTools.current?.focus((minX + maxX) / 2, (minZ + maxZ) / 2, span);
        }}
      />
      <AssetBrowser
        open={assetsOpen}
        mode={draft.projectKind}
        onClose={() => setAssetsOpen(false)}
      />
      <BrandingPanel
        open={brandingOpen}
        state={brandingState}
        onChange={setBrandingState}
        onClose={() => setBrandingOpen(false)}
      />
    </div>
  );
}
