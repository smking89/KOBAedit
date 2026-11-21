/**
 * CUI frame geometry for the designer.
 *
 * `regions.generated.ts` is rendered from `engine/koba_engine/cui/frame_processor.py`
 * and pinned by `engine/tests/test_cui_regions_guide.py`, so the canvas and the
 * validator can never disagree about a cutout or an anchor.
 *
 * Rectangles are normalised with Rust's bottom-left origin, matching
 * AnchorMin/AnchorMax. The designer draws them with `bottom` offsets, so no
 * pixel flip is needed in the UI.
 */

import { LOGO_ANCHORS } from "./regions.generated";

export {
  EXIT_ZONE,
  FRAME_MAX,
  FRAME_MAX_BYTES,
  FRAME_MIN,
  FRAME_RECOMMENDED,
  INNER_CUTOUT,
  LOGO_ANCHORS,
  LOGO_MIN_CONTRAST,
  LOGO_TARGET_CONTRAST,
} from "./regions.generated";

export type NormalisedRect = readonly [number, number, number, number];

export type LogoAnchor = keyof typeof LOGO_ANCHORS;

export const LOGO_ANCHOR_LABELS: Record<LogoAnchor, string> = {
  crest: "Top-centre crest",
  header: "Top-left header",
  medallion: "Bottom-right medallion",
};

export function pixelBox(rect: NormalisedRect, width: number, height: number) {
  const [xMin, yMin, xMax, yMax] = rect;
  return {
    left: Math.round(xMin * width),
    right: Math.round(xMax * width),
    top: Math.round((1 - yMax) * height),
    bottom: Math.round((1 - yMin) * height),
  };
}

/** Percentage offsets for an absolutely positioned overlay on the canvas. */
export function rectStyle(rect: NormalisedRect) {
  const [xMin, yMin, xMax, yMax] = rect;
  return {
    left: `${xMin * 100}%`,
    bottom: `${yMin * 100}%`,
    width: `${(xMax - xMin) * 100}%`,
    height: `${(yMax - yMin) * 100}%`,
  };
}
