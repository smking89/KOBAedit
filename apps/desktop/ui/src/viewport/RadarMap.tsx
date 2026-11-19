import { useEffect, useRef, useState } from "react";

import { buildTerrainPreview } from "../lib/preview";
import { drawRadarMap } from "../lib/radar";
import type { WizardDraft } from "../wizard/types";

const RADAR_PX = 720;

/**
 * 1-click top-down view of the map players see with the G key. It redraws from
 * the same preview stack as the 3D viewport, so sculpting, pads, splines and
 * paint strokes show up here immediately.
 */
export function RadarMap({ draft, onClose }: { draft: WizardDraft; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [redraws, setRedraws] = useState(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // A timeout rather than rAF: a hidden/throttled tab pauses rAF, which left
    // the overlay blank. Debounce coalesces the burst of draft updates a brush
    // drag or opacity slider produces into one 257² preview rebuild.
    const timer = window.setTimeout(() => {
      try {
        const preview = buildTerrainPreview(draft, 257);
        drawRadarMap(canvas, draft, preview);
        setError(null);
        setRedraws((value) => value + 1);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [draft]);

  return (
    <div className="radar-overlay" role="dialog" aria-label="G-key map preview">
      <header className="radar-head">
        <div>
          <p className="eyebrow">
            G-key map · {draft.terrain.sizeMetres} m · seed {draft.terrain.seed}
          </p>
          <strong>
            {draft.placements.length} prefabs · {draft.splines.length} paths · water{" "}
            {draft.terrain.waterLevel} m
          </strong>
        </div>
        <div className="radar-legend" aria-hidden="true">
          <span>
            <i className="radar-swatch" style={{ background: "#1d4a74" }} />
            water
          </span>
          <span>
            <i className="radar-swatch" style={{ background: "#5e8440" }} />
            ground
          </span>
          <span>
            <i className="radar-swatch" style={{ background: "#d8c9a4" }} />
            road
          </span>
          <span>
            <i className="radar-swatch" style={{ background: "#d9a45b" }} />
            prefab
          </span>
        </div>
        <button type="button" className="asset-close" onClick={onClose}>
          Close
        </button>
      </header>
      <canvas
        ref={canvasRef}
        className="radar-canvas"
        width={RADAR_PX}
        height={RADAR_PX}
        data-redraws={redraws}
      />
      {error && (
        <p className="radar-error" role="status">
          Radar unavailable: {error}
        </p>
      )}
    </div>
  );
}
