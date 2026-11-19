import { useEffect, useRef, useState } from "react";

import type { WizardDraft, WizardStepId } from "../wizard/types";
import { SkinViewport } from "./SkinViewport";
import { TerrainViewport } from "./TerrainViewport";

export function Viewport({
  draft,
  stepId,
  onSculpt,
  onPaint,
}: {
  draft: WizardDraft;
  stepId: WizardStepId;
  onSculpt: () => void;
  onPaint: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const worldRef = useRef<TerrainViewport | null>(null);
  const skinRef = useRef<SkinViewport | null>(null);
  const callbacks = useRef({ onSculpt, onPaint });
  callbacks.current = { onSculpt, onPaint };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setError(null);

    try {
      if (draft.branch === "world") {
        const viewport = new TerrainViewport(host, () => callbacks.current.onSculpt());
        worldRef.current = viewport;
        return () => {
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
          <span>{sculptHint ? "Shift + drag to sculpt / paint. Drag to orbit, wheel to zoom." : "Drag to orbit. Generate terrain from the inspector, or unlock Studio Mode to sculpt."}</span>
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
    </div>
  );
}
