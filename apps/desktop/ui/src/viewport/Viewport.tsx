import { useEffect, useRef, useState } from "react";

import { cancelPrefabExtraction, type TaskProgress } from "../lib/ipc";
import type { TerrainStroke, WizardDraft, WizardStepId } from "../wizard/types";
import { SkinViewport } from "./SkinViewport";
import { TerrainViewport, type BuildPlanStatus, type DragGhost } from "./TerrainViewport";

/** Screen-to-terrain tools the shell uses for drag-and-drop placement. */
export interface GroundTools {
  pick: (x: number, y: number) => { x: number; z: number } | null;
  info: (x: number, y: number) => { x: number; z: number; height: number; slope: number } | null;
  ghost: (ghost: DragGhost | null) => void;
  /** Walk Mode build test layer: temporary pieces, never project data. */
  clearBuilds: () => void;
  /** Smooth camera framing for the live prompt build. */
  focus: (x: number, z: number, radius: number) => void;
  /** Touch overlay thumbstick and jump input for Walk Mode. */
  setWalkInput: (input: {
    forward?: number;
    strafe?: number;
    jump?: boolean;
    sprint?: boolean;
  }) => void;
}

export function Viewport({
  draft,
  stepId,
  onSculpt,
  onPaint,
  onGroundPicker,
  onSelectPlacement,
  onMovePlacement,
  onBuildStatus,
  onFlashlight,
  onScrubTime,
  onExitWalk,
  onWalkCollision,
  onOpenPlacement,
}: {
  draft: WizardDraft;
  stepId: WizardStepId;
  onSculpt: (strokes: TerrainStroke[]) => void;
  onPaint: () => void;
  /** Receives a screen-to-terrain projector while the world viewport exists. */
  onGroundPicker?: (tools: GroundTools | null) => void;
  /** Map clicks: select the prefab under the cursor (or nothing). */
  onSelectPlacement?: (id: string | null) => void;
  /** Dragging a selected prefab on the map: commit its new position. */
  onMovePlacement?: (id: string, position: { x: number; y: number; z: number }) => void;
  /** Walk Mode build-plan readout. */
  onBuildStatus?: (status: BuildPlanStatus | null) => void;
  onFlashlight?: (on: boolean) => void;
  onScrubTime?: (deltaMinutes: number) => void;
  onExitWalk?: () => void;
  onWalkCollision?: (name: string | null) => void;
  onOpenPlacement?: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const worldRef = useRef<TerrainViewport | null>(null);
  const skinRef = useRef<SkinViewport | null>(null);
  const [extraction, setExtraction] = useState<{ progress: TaskProgress | null; running: boolean }>({
    progress: null,
    running: false,
  });
  const callbacks = useRef({
    onSculpt,
    onPaint,
    onExtraction: setExtraction,
    onGroundPicker,
    onSelectPlacement,
    onMovePlacement,
    onBuildStatus,
    onFlashlight,
    onScrubTime,
    onExitWalk,
    onWalkCollision,
    onOpenPlacement,
  });
  callbacks.current = {
    onSculpt,
    onPaint,
    onExtraction: setExtraction,
    onGroundPicker,
    onSelectPlacement,
    onMovePlacement,
    onBuildStatus,
    onFlashlight,
    onScrubTime,
    onExitWalk,
    onWalkCollision,
    onOpenPlacement,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setError(null);

    try {
      if (draft.branch === "world") {
        const viewport = new TerrainViewport(
          host,
          (strokes) => callbacks.current.onSculpt(strokes),
          (progress, running) => callbacks.current.onExtraction({ progress, running }),
          {
            onSelectPlacement: (id) => callbacks.current.onSelectPlacement?.(id),
            onMovePlacement: (id, position) => callbacks.current.onMovePlacement?.(id, position),
            onBuildStatus: (status) => callbacks.current.onBuildStatus?.(status),
            onFlashlight: (on) => callbacks.current.onFlashlight?.(on),
            onScrubTime: (delta) => callbacks.current.onScrubTime?.(delta),
            onExitWalk: () => callbacks.current.onExitWalk?.(),
            onWalkCollision: (name) => callbacks.current.onWalkCollision?.(name),
            onOpenPlacement: (id) => callbacks.current.onOpenPlacement?.(id),
          },
        );
        worldRef.current = viewport;
        callbacks.current.onGroundPicker?.({
          pick: (x, y) => viewport.pickGround(x, y),
          info: (x, y) => viewport.groundInfo(x, y),
          ghost: (ghost) => viewport.setDragGhost(ghost),
          clearBuilds: () => viewport.clearTestBuilds(),
          setWalkInput: (input) => viewport.setWalkInput(input),
          focus: (x, z, radius) => viewport.focusOn(x, z, radius),
        });
        return () => {
          callbacks.current.onGroundPicker?.(null);
          viewport.dispose();
          worldRef.current = null;
        };
      }

      const viewport = new SkinViewport(host, () => callbacks.current.onPaint());
      skinRef.current = viewport;
      return () => {
        viewport.dispose();
        skinRef.current = null;
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    // Branch changes rebuild the scene; draft updates are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.branch]);

  useEffect(() => {
    worldRef.current?.setDraft(draft);
    skinRef.current?.setDraft(draft);
  }, [draft]);

  useEffect(() => {
    worldRef.current?.setInteraction(stepId, draft.studioMode);
    skinRef.current?.setInteraction(stepId, draft.studioMode);
  }, [stepId, draft.studioMode]);

  const sculptHint = draft.studioMode && stepId === "terrain";
  const paintHint = draft.studioMode && stepId === "paint";

  return (
    <div className="viewport-host" ref={hostRef}>
      {error && (
        <div className="viewport-fallback" role="status">
          <strong>3D preview unavailable</strong>
          <span>The wizard, validation and export still work without the viewport.</span>
          <code>{error}</code>
        </div>
      )}
      {!error && <div className="viewport-note">
        {draft.branch === "world" ? (
          <span>
            {draft.walkMode
              ? "WASD to walk, Shift to sprint, Ctrl to crouch, Space to jump. [B] build plan, [1-5] piece, [R] rotate, [E]/click place, [X] demolish, [F] flashlight, [ ] time, Esc exits."
              : sculptHint
                ? "Shift + drag to sculpt / paint. Drag to orbit, wheel to zoom."
                : "Drag to orbit, drag a prefab pad to move it. Generate terrain from the inspector, or unlock Studio Mode to sculpt."}
          </span>
        ) : (
          <span>
            {paintHint
              ? "Click the item to project the latest stencil. Drag to orbit."
              : "Drag to orbit. Lighting and material changes preview live."}
          </span>
        )}
      </div>}
      {!error && draft.branch === "world" && draft.studioMode && stepId === "terrain" && (
        <div className="viewport-brush">
          <span>Brush</span>
          <strong>{draft.terrain.brush.mode}</strong>
          <span>{draft.terrain.brush.radius} m</span>
        </div>
      )}
      {!error && extraction.running && (
        <div className="viewport-brush" role="status">
          <span>Prefab GLB</span>
          <strong>{extraction.progress?.stage ?? "starting"}</strong>
          <span>{extraction.progress?.message ?? "Scanning local bundles..."}</span>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ pointerEvents: "auto" }}
            onClick={() => void cancelPrefabExtraction()}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
