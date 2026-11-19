/**
 * Pure radar-map maths, split out so it can be tested without a canvas.
 *
 * `drawRadarMap` paints with these helpers: the same water depth ramp, contour
 * bands and world↔pixel mapping the 2D map shows.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface WaterColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Depth tint below the water line. Returns null on land so the caller can fall
 * through to splat-based ground colouring.
 */
export function waterColor(
  elevation: number,
  waterLevel: number,
  depthScale = 80,
): WaterColor | null {
  if (elevation > waterLevel) return null;
  const depth = clamp((waterLevel - elevation) / depthScale, 0, 1);
  return {
    r: 12 + depth * 22,
    g: 36 + depth * 46,
    b: 62 + depth * 92,
  };
}

/**
 * 0 = no contour, 1 = 20 m contour, 2 = 100 m major contour.
 * Heights are metres and may be negative, so the modulo is normalised.
 */
export function contourBand(
  elevation: number,
  step = 20,
  major = 100,
  tolerance = 1.2,
): 0 | 1 | 2 {
  const majorOffset = ((elevation % major) + major) % major;
  if (majorOffset < tolerance) return 2;
  const contourOffset = ((elevation % step) + step) % step;
  if (contourOffset < tolerance) return 1;
  return 0;
}

const CONTOUR_TINT: Record<1 | 2, number> = { 1: 0.74, 2: 0.5 };

export function contourTint(band: 0 | 1 | 2): number {
  return band === 0 ? 1 : CONTOUR_TINT[band];
}

/** World metres → radar pixel, with x/z mapped straight onto the canvas axes. */
export function toRadarPixel(
  x: number,
  z: number,
  sizeMetres: number,
  width: number,
  height: number,
): [number, number] {
  const half = sizeMetres / 2;
  return [
    ((x + half) / sizeMetres) * (width - 1),
    ((z + half) / sizeMetres) * (height - 1),
  ];
}

/** Radar pixel → world metres (inverse of `toRadarPixel`). */
export function toRadarWorld(
  px: number,
  py: number,
  sizeMetres: number,
  width: number,
  height: number,
): [number, number] {
  const half = sizeMetres / 2;
  return [
    (px / Math.max(1, width - 1)) * sizeMetres - half,
    (py / Math.max(1, height - 1)) * sizeMetres - half,
  ];
}

/** Hill-shade multiplier from the height difference to the east and south. */
export function hillShade(elevation: number, east: number, south: number): number {
  return clamp(0.74 + (elevation - east + (elevation - south)) / 24, 0.34, 1.32);
}
