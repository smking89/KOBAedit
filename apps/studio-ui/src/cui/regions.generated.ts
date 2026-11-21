/**
 * CUI guide constants, generated from
 * engine/koba_engine/cui/frame_processor.py. Do not edit by hand:
 *
 *   cd engine && ../.venv/bin/python -m koba_engine.cui.regions_guide \
 *     > ../apps/studio-ui/src/cui/regions.generated.ts
 *
 * engine/tests/test_cui_regions_guide.py fails when this file drifts.
 */

export const FRAME_MIN = { width: 1280, height: 720 } as const;
export const FRAME_RECOMMENDED = { width: 1920, height: 1080 } as const;
export const FRAME_MAX = { width: 2560, height: 1440 } as const;
export const FRAME_MAX_BYTES = 1500000;

export const INNER_CUTOUT = [0.12, 0.14, 0.88, 0.86] as const;
export const EXIT_ZONE = [0.86, 0.84, 0.92, 0.92] as const;

export const LOGO_ANCHORS = {
  crest: [0.45, 0.87, 0.55, 0.96],
  header: [0.13, 0.84, 0.28, 0.92],
  medallion: [0.82, 0.08, 0.91, 0.18],
} as const;

export const LOGO_TARGET_CONTRAST = 2.2;
export const LOGO_MIN_CONTRAST = 1.5;
