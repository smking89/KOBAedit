import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AssetBrowser } from "./assets/AssetBrowser";
import { BrandingPanel } from "./components/BrandingPanel";
import { PromoStudio } from "./components/PromoStudio";
import { SplashScreen } from "./components/SplashScreen";
import { captureWithRadar } from "./lib/radarCapture";
import { WalkHud } from "./components/WalkHud";
import { WatermarkOverlay } from "./components/WatermarkOverlay";
import { Icon } from "./components/Icons";
import { DEMO_PREFABS } from "./lib/demoAssets";
import {
  clampWatermark,
  loadBranding,
  sanitizeBranding,
  saveBranding,
  type WatermarkSettings,
} from "./lib/branding";
import { parseAppSegment, type AppEffect, type PromoRequest } from "./lib/appCommands";
import { applyTheme } from "./lib/theme";
import {
  composeSnippet,
  copySnippet,
  createWatermarkPainter,
  downloadBlob,
  snippetFileName,
  videoExtension,
} from "./lib/snippet";
import { Badge, Button } from "./components/ui";
import { KobaPanel } from "./koba/KobaPanel";
import { demoMode, exportProject, isTauri, saveProject, syncStatus } from "./lib/ipc";
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

type OutlinerItem = {
  key: string;
  label: string;
  hidden: boolean;
  layer?: { id: string; name: string; visible: boolean };
  placement?: { id: string; name: string; visible?: boolean };
};

export default function App() {
  const { state, dispatch, issues, stepIssues, canContinue, undo, canUndo, redo, canRedo, switchWorkspace } =
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
  const [promoOpen, setPromoOpen] = useState(false);
  const [radarView, setRadarView] = useState(false);
  const [selectedObject, setSelectedObject] = useState("Assault Rifle");
  const [hiddenObjects, setHiddenObjects] = useState<string[]>([]);
  useEffect(() => {
    setSelectedObject(draft.branch === "skin" ? "Assault Rifle" : "Terrain");
  }, [draft.branch]);
  const [outlinerQuery, setOutlinerQuery] = useState("");
  const [railTool, setRailTool] = useState("select");
  const [interactionMode, setInteractionMode] = useState("Object Mode");
  const [shading, setShading] = useState("Solid");
  const [snaps, setSnaps] = useState<string[]>(["Grid"]);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [skinPreview, setSkinPreview] = useState("weapon");
  const [skinSubjectVisible, setSkinSubjectVisible] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);
  const [overlaysVisible, setOverlaysVisible] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [skinMaterial, setSkinMaterial] = useState({
    type: "Standard",
    baseColor: 0.55,
    metallic: 0.65,
    smoothness: 0.4,
    wear: 0.15,
    glow: 0.8,
  });
  const [propertyTab, setPropertyTab] = useState<
    "step" | "transform" | "terrain" | "material" | "puzzle" | "branding" | "render"
  >("step");
  useEffect(() => {
    // Leaving the project or entering Walk Mode must not keep the radar camera.
    setRadarView((current) => {
      if (current) groundTools.current?.restoreRadarCamera();
      return false;
    });
  }, [state.draft.projectKind, state.draft.walkMode]);
  const [snippetBusy, setSnippetBusy] = useState<"still" | "loop" | null>(null);
  const [snippetNote, setSnippetNote] = useState<string | null>(null);
  const [brandingState, setBrandingState] = useState(loadBranding);
  const [launcherOpen, setLauncherOpen] = useState(true);
  const [splashDone, setSplashDone] = useState(false);
  const [promoRequest, setPromoRequest] = useState<(PromoRequest & { id: number }) | null>(null);
  const brandingRef = useRef(brandingState);

  useEffect(() => {
    applyTheme("dark");
  }, []);



  useEffect(() => {
    if (!snippetNote) return;
    const timer = window.setTimeout(() => setSnippetNote(null), 3200);
    return () => window.clearTimeout(timer);
  }, [snippetNote]);

  const snippetRun = useRef(0);
  const captureSnippet = async (
    mode: "still" | "loop",
    options: { filename?: string; seconds?: number; watermark?: WatermarkSettings; copy?: boolean } = {},
  ) => {
    const tools = groundTools.current;
    if (!tools || snippetBusy) return;
    const run = ++snippetRun.current;
    const cancelled = () => snippetRun.current !== run;
    setSnippetBusy(mode);
    try {
      const { branding, watermark: activeWatermark } = brandingRef.current;
      const watermark = options.watermark ?? activeWatermark;
      if (mode === "still") {
        const frame = tools.captureFrame();
        if (!frame) {
          setSnippetNote("Viewport is not ready yet.");
          return;
        }
        const blob = await composeSnippet(frame, watermark, branding);
        if (cancelled()) return;
        const copied = options.copy === false ? false : await copySnippet(blob);
        if (cancelled()) return;
        downloadBlob(blob, options.filename ?? `${snippetFileName()}.png`);
        setSnippetNote(
          copied
            ? "Snippet copied to clipboard and saved as PNG."
            : "Snippet saved as PNG (clipboard unavailable).",
        );
        return;
      }
      const selected = draft.placements.find((item) => item.id === draft.selectedPlacementId);
      const focus = selected?.position ?? { x: 0, z: 0 };
      const radius = Math.max(90, (selected?.collisionRadius ?? 20) * 7);
      const painter = await createWatermarkPainter(watermark, branding);
      if (cancelled()) return;
      const seconds = Math.max(1, Math.min(30, options.seconds ?? 5));
      const blob = await tools.recordTour({
        shots: [{ x: focus.x, z: focus.z, radius, seconds }],
        draw: (ctx, width, height) => painter(ctx, width, height),
      });
      if (cancelled()) return;
      if (!blob) {
        setSnippetNote("This machine cannot record video loops.");
        return;
      }
      downloadBlob(blob, `${snippetFileName("koba-loop")}.${videoExtension(blob)}`);
      setSnippetNote(`${seconds} s turntable loop saved as ${videoExtension(blob).toUpperCase()}.`);
    } catch (error) {
      setSnippetNote(error instanceof Error ? error.message : "Snippet capture failed.");
    } finally {
      setSnippetBusy(null);
    }
  };

  useEffect(() => {
    brandingRef.current = brandingState;
    saveBranding(brandingState);
  }, [brandingState]);

  /** Executes prompt-derived app commands in order and returns receipts. */
  const applyAppEffects = async (effects: AppEffect[]): Promise<string[]> => {
    const receipts: string[] = [];
    for (const effect of effects) {
      switch (effect.kind) {
        case "watermark": {
          const next = clampWatermark({ ...brandingRef.current.watermark, ...effect.patch });
          const nextState = { ...brandingRef.current, watermark: next };
          brandingRef.current = nextState;
          setBrandingState(nextState);
          const visible = next.source === "off" ? "hidden" : `${Math.round(next.opacity * 100)}% · ${next.anchor}`;
          receipts.push(`${effect.note} (${visible}).`);
          break;
        }
        case "brand": {
          const next = sanitizeBranding({ ...brandingRef.current.branding, ...effect.patch });
          const nextState = { ...brandingRef.current, branding: next };
          brandingRef.current = nextState;
          setBrandingState(nextState);
          receipts.push(effect.note + ".");
          break;
        }
        case "snippet-still":
          await captureSnippet("still", { filename: effect.filename });
          receipts.push(effect.note + ".");
          break;
        case "radar-still": {
          const tools = groundTools.current;
          if (!tools) {
            receipts.push("Viewport is not ready for a radar capture.");
            break;
          }
          try {
            await captureWithRadar(tools, () =>
              captureSnippet("still", { filename: effect.filename }),
            );
            receipts.push(effect.note + ".");
          } catch (error) {
            // Invalidate the late capture: when it eventually resolves it must
            // not copy, download or overwrite the note.
            snippetRun.current += 1;
            setSnippetBusy(null);
            receipts.push(`Radar capture failed: ${String(error)}`);
          }
          break;
        }
        case "snippet-turntable":
          await captureSnippet("loop", { seconds: effect.seconds });
          receipts.push(effect.note + ".");
          break;
        case "promo":
          setPromoOpen(true);
          setPromoRequest({ ...effect.request, id: Date.now() });
          receipts.push(effect.note + ".");
          break;
        case "timeline":
          setPromoOpen(effect.open);
          receipts.push(effect.note + ".");
          break;
        case "unavailable":
          receipts.push(effect.note);
          break;
      }
    }
    return receipts;
  };
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
        setRailTool("move");
        return;
      }
      if ((event.key === "r" || event.key === "R") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setRailTool("rotate");
        return;
      }
      if ((event.key === "s" || event.key === "S") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setRailTool("scale");
        return;
      }
      if (event.key === "Home" || event.code === "NumpadDecimal") {
        event.preventDefault();
        const tools = groundTools.current;
        const selected = state.draft.placements.find((item) => item.id === state.draft.selectedPlacementId);
        tools?.focus(
          selected?.position.x ?? 0,
          selected?.position.z ?? 0,
          Math.max(60, state.draft.terrain.sizeMetres * 0.45),
        );
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

  const onExport = async () => {
    setExporting(true);
    try {
      const report = await exportProject(draft);
      setSnippetNote(
        `${isTauri() ? "Exported" : "Demo export (no native shell)"} ${report.kind.toUpperCase()} · ${report.path}`,
      );
    } catch (cause) {
      setSnippetNote(cause instanceof Error ? cause.message : "Export failed");
    } finally {
      setExporting(false);
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
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/koba-wordmark.png" alt="KOBA EDIT" />
          <p className="brand-sub">Map, monument and skin workspace</p>
        </div>

        <nav className="classic-menus" aria-label="Main menu">
          {([
            ["File", ["New File", "Open…", "Import .prefab / .map", "Save .koba", "Export"]],
            ["Edit", ["Undo", "Redo", "Preferences"]],
            ["Add", ["Monument", "Spline", "Puzzle Zone", "Terrain Layer"]],
            ["View", ["Frame All", "Radar View", "Toggle Grid", "Toggle Overlays", "Snippet", "Walk Mode"]],
            ["Build", ["Validate Project", "Build Bundle", "Auto-Conform", "Export .map", "Export .prefab"]],
            ["Help", ["Quick Launch", "Documentation", "About KOBA EDIT"]],
          ] as const).map(([label, items]) => (
            <details className="classic-menu" key={label}>
              <summary>{label}</summary>
              <div className="classic-menu-pop" role="menu">
                {items.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="menuitem"
                    disabled={
                      (label === "Edit" && item === "Redo" && !canRedo) ||
                      (label === "Edit" && item === "Undo" && !canUndo)
                    }
                    onClick={(event) => {
                      (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                      if (label === "File" && item === "Save .koba") void onSave();
                      if (label === "File" && item === "Import .prefab / .map") setAssetsOpen(true);
                      if (label === "File" && item === "Open…") setAssetsOpen(true);
                      if (label === "Edit" && item === "Undo") undo();
                      if (label === "Edit" && item === "Redo") redo();
                      if (label === "View" && item === "Frame All") {
                        groundTools.current?.focus(0, 0, Math.max(60, state.draft.terrain.sizeMetres * 0.45));
                      }
                      if (label === "View" && item === "Radar View") setRadarOpen((open) => !open);
                      if (label === "View" && item === "Toggle Grid") setGridVisible((value) => !value);
                      if (label === "View" && item === "Toggle Overlays") setOverlaysVisible((value) => !value);
                      if (label === "Build" && item === "Validate Project") setTestMode(true);
                      if (label === "Build" && (item === "Export .map" || item === "Export .prefab")) void onExport();
                      if (label === "File" && item === "Export") void onExport();
                      if (label === "Add" && item === "Monument" && DEMO_PREFABS[0]) {
                        dispatch({ type: "addPlacement", asset: DEMO_PREFABS[0] });
                      }
                      if (label === "Add" && item === "Spline") {
                        dispatch({ type: "addSpline", kind: "road" });
                      }
                      if (label === "Add" && item === "Puzzle Zone") {
                        const base = DEMO_PREFABS.find((asset) => /cave|tunnel/i.test(asset.name)) ?? DEMO_PREFABS[0];
                        if (base) dispatch({ type: "addPlacement", asset: base });
                      }
                      if (label === "Add" && item === "Terrain Layer") {
                        dispatch({ type: "addLayer", kind: "splat" });
                      }
                      if (label === "Help" && item === "Quick Launch") setLauncherOpen(true);
                    }}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </details>
          ))}
        </nav>

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
          {(["Plugins", "Cinematics"] as const).map((label) => (
            <button key={label} type="button" className="mode-tab" disabled title={`${label} workspace is not connected yet`}>
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
          <Button variant="primary" onClick={() => void onExport()} disabled={exporting}>
            {exporting ? "Exporting…" : "Export"}
          </Button>
          {draft.branch === "world" && (
            <>
              <Button
                variant={draft.walkMode ? "primary" : "ghost"}
                onClick={() => dispatch({ type: "setWalkMode", enabled: !draft.walkMode })}
              >
                {draft.walkMode ? "Exit Walk" : "Walk Mode"}
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="shell">
        <main className="stage">
          <div className="viewport-frame">
            <nav className="tool-rail" aria-label="Viewport tools">
              {([
                ["select", "select", "Select", "V"],
                ["move", "move", "Move / Grab", "G"],
                ["rotate", "rotate", "Rotate", "R"],
                ["scale", "scale", "Scale", "S"],
                ["brush", "sculpt", "Terrain Sculpt", "B"],
                ["paint", "paint", "Splat Paint", "P"],
                ["spline", "spline", "Road / Cave Spline", "C"],
                ["cut", "cut", "Auto-Cut Hole", "H"],
                ["ruler", "ruler", "Measure", "M"],
              ] as const).map(([id, icon, label, shortcut]) => (
                <button
                  key={id}
                  type="button"
                  className={`tool-rail-btn${railTool === id ? " is-active" : ""}`}
                  title={`${label} (${shortcut})`}
                  aria-label={label}
                  aria-pressed={railTool === id}
                  onClick={() => setRailTool(id)}
                >
                  <Icon name={icon} size={20} />
                </button>
              ))}
            </nav>
            <div className="viewport-subheader" role="toolbar" aria-label="Viewport controls">
              <div className="vsh-group">
                <select
                  className="vsh-select"
                  value={interactionMode}
                  aria-label="Interaction mode"
                  onChange={(event) => setInteractionMode(event.target.value)}
                >
                  {["Object Mode", "Sculpt", "Paint", "Wire IO"].map((mode) => (
                    <option key={mode}>{mode}</option>
                  ))}
                </select>
                <span className="vsh-sep" />
                {["Grid", "Terrain", "Socket"].map((snap) => (
                  <button
                    key={snap}
                    type="button"
                    className={`vsh-chip${snaps.includes(snap) ? " is-active" : ""}`}
                    aria-pressed={snaps.includes(snap)}
                    onClick={() =>
                      setSnaps((current) =>
                        current.includes(snap) ? current.filter((item) => item !== snap) : [...current, snap],
                      )
                    }
                  >
                    {snap}
                  </button>
                ))}
              </div>
              <div className="vsh-group vsh-center">
                <span className="vsh-clock">{lighting.label}</span>
                <input
                  className="vsh-time"
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
                <span className="vsh-sep" />
                {WEATHER_PRESETS.slice(0, 4).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`vsh-chip${draft.lighting?.weather === preset.id ? " is-active" : ""}`}
                    onClick={() => dispatch({ type: "setLighting", patch: { weather: preset.id } })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              {draft.branch === "skin" && (
                <div className="vsh-group vsh-preview">
                  {[
                    ["weapon", "Weapon"],
                    ["character", "Full Character"],
                    ["arms", "First-Person Arms"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={`vsh-chip${skinPreview === id ? " is-active" : ""}`}
                      aria-pressed={skinPreview === id}
                      onClick={() => setSkinPreview(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <div className="vsh-group vsh-right">
                {["Wireframe", "Solid", "Material", "Rendered"].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`vsh-chip${shading === mode ? " is-active" : ""}`}
                    aria-pressed={shading === mode}
                    onClick={() => setShading(mode)}
                  >
                    {mode === "Material" ? "Mat" : mode === "Wireframe" ? "Wire" : mode}
                  </button>
                ))}
                <span className="vsh-sep" />
                <button type="button" className="vsh-chip">Gizmos</button>
                <button type="button" className="vsh-chip">Overlays</button>
              </div>
            </div>
            {/* Tiled proof is an export/promo look; keep it off the editing viewport. */}
            {brandingState.watermark.anchor !== "tiled" && (
              <WatermarkOverlay
                settings={brandingState.watermark}
                branding={brandingState.branding}
              />
            )}
            <Viewport
              key={quality}
              theme="dark"
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
              skinPreview={skinPreview}
              skinVisible={skinSubjectVisible}
              gridVisible={gridVisible}
              overlaysVisible={overlaysVisible}
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
            {draft.walkMode && <WalkHud branding={brandingState.branding} />}
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
          <section className={`timeline-dock${timelineOpen ? "" : " is-collapsed"}`} aria-label="Cinematics timeline">
            <header className="timeline-head">
              <button type="button" className="link-button" onClick={() => setTimelineOpen((open) => !open)}>
                {timelineOpen ? "▾" : "▸"} Timeline
              </button>
              <span className="timeline-meta">Scene 1 · 240 frames · 24 fps</span>
              <div className="timeline-actions">
                <button type="button" className="vsh-chip">⏮</button>
                <button type="button" className="vsh-chip">▶</button>
                <button type="button" className="vsh-chip">⏭</button>
                <span className="vsh-sep" />
                <button type="button" className="vsh-chip">Audio</button>
              </div>
            </header>
            {timelineOpen && (
              <div className="timeline-body">
                <div className="timeline-ruler" aria-hidden="true">
                  {Array.from({ length: 25 }, (_, index) => (
                    <span key={index} className={index % 5 === 0 ? "is-major" : ""}>
                      {index * 10}
                    </span>
                  ))}
                  <i className="timeline-playhead" />
                </div>
                <div className="timeline-track">
                  <span className="timeline-track-label">KOBA</span>
                  <i className="timeline-key" style={{ left: "12%" }} />
                  <i className="timeline-key" style={{ left: "46%" }} />
                  <i className="timeline-key" style={{ left: "78%" }} />
                </div>
                <div className="timeline-track is-audio">
                  <span className="timeline-track-label">AUDIO</span>
                </div>
              </div>
            )}
          </section>
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
            <button
              type="button"
              className="btn-primary"
              onClick={() => dispatch({ type: "next" })}
              disabled={blocker || isLast}
            >
              {isLast ? "Final step" : "Continue"}
            </button>
            <span className="step-count">
              Step {stepIndex + 1} / {steps.length}
            </span>
          </footer>
        </main>

        <aside className="inspector">
          <section className="outliner" aria-label="Scene outliner">
            <header className="outliner-head">
              <span className="eyebrow">Scene</span>
              <h2>Outliner</h2>
            </header>
            <label className="outliner-search">
              <span className="sr-only">Search scene objects</span>
              <input
                type="search"
                value={outlinerQuery}
                placeholder="Search scene..."
                onChange={(event) => setOutlinerQuery(event.target.value)}
              />
            </label>
            <ul className="outliner-tree">
              {((draft.branch === "skin"
                ? [
                    {
                      key: "skin-subject",
                      label: draft.skin.baseMeshName || "Base mesh",
                      hidden: !skinSubjectVisible,
                    },
                  ]
                : [
                    ...(draft.terrain.layers ?? []).map((layer) => ({
                      key: `layer-${layer.id}`,
                      label: `Layer: ${layer.name}`,
                      hidden: !layer.visible,
                      layer,
                    })),
                    ...draft.placements.map((placement) => ({
                      key: `placement-${placement.id}`,
                      label: placement.name,
                      hidden: placement.visible === false,
                      placement,
                    })),
                  ]
              ) as OutlinerItem[])
                .filter((item) => item.label.toLowerCase().includes(outlinerQuery.trim().toLowerCase()))
                .map((item) => (
                  <li key={item.key} className={selectedObject === item.label ? "is-selected" : ""}>
                    <button
                      type="button"
                      className={`outliner-eye${item.hidden ? " is-off" : ""}`}
                      aria-label={`${item.hidden ? "Show" : "Hide"} ${item.label}`}
                      aria-pressed={!item.hidden}
                      onClick={() => {
                        if ("layer" in item && item.layer) {
                          dispatch({
                            type: "patchTerrain",
                            patch: {
                              layers: (draft.terrain.layers ?? []).map((layer) =>
                                layer.id === item.layer!.id ? { ...layer, visible: !layer.visible } : layer,
                              ),
                            },
                          });
                          return;
                        }
                        if ("placement" in item && item.placement) {
                          dispatch({
                            type: "updatePlacement",
                            id: item.placement.id,
                            patch: { visible: item.placement.visible === false },
                          });
                          return;
                        }
                        setSkinSubjectVisible((visible) => !visible);
                      }}
                    >
                      {item.hidden ? "◌" : "◉"}
                    </button>
                    <button
                      type="button"
                      className="outliner-name"
                      onClick={() => {
                        setSelectedObject(item.label);
                        if ("placement" in item && item.placement) {
                          dispatch({ type: "selectPlacement", id: item.placement.id });
                        }
                      }}
                    >
                      <span className="outliner-icon" aria-hidden="true">
                        {"placement" in item ? "◈" : "◇"}
                      </span>
                      {item.label}
                    </button>
                  </li>
                ))}
            </ul>
          </section>

          <section className="properties" aria-label="Properties">
            <header className="properties-head">
              <span className="eyebrow">Properties</span>
              <h2>{selectedObject}</h2>
            </header>
            <div className="properties-body">
              <nav className="property-rail" aria-label="Property categories">
                {([
                  ["step", "step", "Step editor"],
                  ["transform", "transform", "Transform"],
                  ["terrain", "terrain", "Terrain & Auto-Conform"],
                  ["material", "material", "PBR Materials & Tattoos"],
                  ["puzzle", "puzzle", "Puzzles & Zones"],
                  ["branding", "branding", "Branding & Watermark"],
                  ["render", "render", "Render & Export"],
                ] as const).map(([id, icon, label]) => (
                  <button
                    key={id}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-pressed={propertyTab === id}
                    className={`property-tab${propertyTab === id ? " is-active" : ""}`}
                    onClick={() => setPropertyTab(id)}
                  >
                    <Icon name={icon} size={18} />
                  </button>
                ))}
              </nav>

              <div className="property-content">
                {propertyTab === "material" && (
                  <div className="material-editor">
                    <label className="material-row">
                      <span>Skin Type</span>
                      <select
                        value={skinMaterial.type}
                        onChange={(event) => setSkinMaterial((m) => ({ ...m, type: event.target.value }))}
                      >
                        {["Standard", "Camo", "Glow-in-the-Dark", "Glowing Sights", "Animated", "Transparent Cutout", "3D Sculpted"].map(
                          (type) => (
                            <option key={type}>{type}</option>
                          ),
                        )}
                      </select>
                    </label>
                    {([
                      ["Base Color", "baseColor"],
                      ["Metallic", "metallic"],
                      ["Smoothness", "smoothness"],
                      ["Edge Wear", "wear"],
                      ["Glow Intensity", "glow"],
                    ] as const).map(([label, key]) => (
                      <label className="material-row" key={key}>
                        <span>{label}</span>
                        <span className="material-control">
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={skinMaterial[key]}
                            onChange={(event) =>
                              setSkinMaterial((m) => ({ ...m, [key]: Number(event.target.value) }))
                            }
                          />
                          <em>{Math.round(skinMaterial[key] * 100)}%</em>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {propertyTab === "step" && (
                  <div className="property-step">
                    <StepComponent />
                  </div>
                )}
                {propertyTab === "branding" && (
                  <BrandingPanel
                    open
                    state={brandingState}
                    onChange={setBrandingState}
                    onClose={() => setPropertyTab("transform")}
                  />
                )}
                {propertyTab === "render" && (
                  <PromoStudio
                    open
                    onClose={() => setPropertyTab("transform")}
                    placements={draft.placements}
                    sizeMetres={draft.terrain.sizeMetres}
                    branding={brandingState.branding}
                    watermark={brandingState.watermark}
                    request={promoRequest}
                    onRequestApplied={() => setPromoRequest(null)}
                    record={(options) => groundTools.current?.recordTour(options) ?? Promise.resolve(null)}
                  />
                )}
                {propertyTab !== "branding" && propertyTab !== "render" && propertyTab !== "step" && propertyTab !== "material" && (
                  <dl className="property-rows">
                    {(propertyTab === "terrain"
                      ? [
                          ["Seed", String(draft.terrain.seed)],
                          ["Size", `${draft.terrain.sizeMetres} m`],
                          ["Water line", `${draft.terrain.waterLevel} m`],
                          ["Preset", draft.terrain.preset],
                          ["Weather", lighting.weather ?? "Clear"],
                          ["Snap", draft.studioMode ? "Studio" : "Terrain"],
                        ]
                      : propertyTab === "puzzle"
                          ? [
                              ["Zone type", "Puzzle"],
                              ["Radius", "18 m"],
                              ["Loot tier", "T2"],
                              ["Sockets", "4"],
                              ["Auto-cut", "Off"],
                              ["Validation", "Not run"],
                            ]
                          : [
                              ["Name", selectedObject],
                              ["Type", draft.branch === "skin" ? "Mesh" : "Scene object"],
                              ["Position X", "0.00 m"],
                              ["Position Y", "0.00 m"],
                              ["Position Z", "0.00 m"],
                              ["Rotation", "0°"],
                              ["Scale", "1.00"],
                            ]
                    ).map(([label, value]) => (
                      <div className="property-row" key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </section>
        </aside>
      </div>

      <KobaPanel
        open={kobaOpen}
        onClose={() => setKobaOpen(false)}
        onAppEffects={applyAppEffects}
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
      {launcherOpen && (
        <div className="launcher-backdrop" role="presentation" onClick={() => setLauncherOpen(false)}>
          <section className="launcher" role="dialog" aria-modal="true" aria-label="Quick launch" onClick={(event) => event.stopPropagation()}>
            <div className="launcher-art">
              <img src="/koba-hero.webp" alt="KOBA EDIT showcase" />
            </div>
            <div className="launcher-banner">
              <img src="/koba-wordmark.png" alt="KOBA EDIT" />
              <p>OFFLINE MAP &amp; MONUMENT STUDIO</p>
            </div>
            <div className="launcher-grid">
              <div className="launcher-presets">
                <span className="section-label">New file</span>
                {([
                  ["Full Map", "map"],
                  ["Custom Monument", "monument"],
                  ["Item & Player Skin", "skin"],
                ] as const).map(([label, kind]) => (
                  <button key={label} type="button" className="launcher-preset" onClick={() => { switchWorkspace(kind); setLauncherOpen(false); }}>
                    <strong>{label}</strong>
                    <span>{kind === "map" ? "Terrain, monuments, paths and puzzles" : kind === "monument" ? "Single monument with sockets" : "UV skin and PBR materials"}</span>
                  </button>
                ))}
                <button type="button" className="launcher-preset" onClick={() => setLauncherOpen(false)}>
                  <strong>Plugin &amp; Shop</strong>
                  <span>Requires the Plugins workspace</span>
                </button>
                <button type="button" className="launcher-preset" onClick={() => { setPropertyTab("render"); setLauncherOpen(false); }}>
                  <strong>Auto Cinematic</strong>
                  <span>Promo timeline and render settings</span>
                </button>
              </div>
              <div className="launcher-recent">
                <span className="section-label">Recent files</span>
                <p className="launcher-empty">No recent projects yet. Saved .koba files appear here.</p>
                <button type="button" className="launcher-browse" onClick={() => { setLauncherOpen(false); setAssetsOpen(true); }}>
                  Browse assets
                </button>
              </div>
            </div>
            <footer className="launcher-foot">
              <button type="button" className="link-button" onClick={() => setLauncherOpen(false)}>Close</button>
            </footer>
          </section>
        </div>
      )}
      {snippetNote && (
        <div className="snippet-toast" role="status" aria-live="polite">
          {snippetNote}
        </div>
      )}
    </div>
  );
}
