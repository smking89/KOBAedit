import { samplePreviewHeight, type TerrainPreview } from "./procedural";
import {
  clamp,
  contourBand,
  contourTint,
  hillShade,
  toRadarPixel,
  waterColor,
} from "./radarMath";
import { sampleSplineNodes } from "./splineMath";
import { SPLAT_PALETTE } from "../viewport/shaders/terrain";
import type { WizardDraft } from "../wizard/types";

/**
 * Top-down "G-key" map: the 2D view players get in game.
 *
 * Water depth shading, 20 m contours with a stronger line every 100 m, road and
 * river ribbons, monument footprints and labels — all drawn from the same
 * preview the 3D viewport uses, so what a creator sees here is what the map
 * data actually contains.
 */

const CONTOUR_STEP = 20;
const MAJOR_STEP = 100;

const SPLINE_COLORS: Record<string, string> = {
  road: "#d8c9a4",
  river: "#3f8fc4",
  rail: "#c9cdd5",
  apc: "#c98686",
  cargo: "#9ab6d6",
  chinook: "#a6d0ad",
  powerline: "#d6c07a",
};

export function drawRadarMap(
  canvas: HTMLCanvasElement,
  draft: WizardDraft,
  preview: TerrainPreview,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  const size = draft.terrain.sizeMetres;
  const half = size / 2;
  const water = draft.terrain.waterLevel;
  const texel = size / Math.max(1, preview.resolution - 1);
  const image = context.createImageData(width, height);
  const data = image.data;

  const heightAt = (x: number, z: number) => samplePreviewHeight(preview, x, z, size);

  for (let py = 0; py < height; py += 1) {
    const z = -half + (py / (height - 1)) * size;
    for (let px = 0; px < width; px += 1) {
      const x = -half + (px / (width - 1)) * size;
      const elevation = heightAt(x, z);
      const index = (py * width + px) * 4;
      const waterTint = waterColor(elevation, water);
      if (waterTint) {
        data[index] = waterTint.r;
        data[index + 1] = waterTint.g;
        data[index + 2] = waterTint.b;
        data[index + 3] = 255;
        continue;
      }

      const ix = clamp(Math.round((x + half) / texel), 0, preview.resolution - 1);
      const iz = clamp(Math.round((z + half) / texel), 0, preview.resolution - 1);
      const texelIndex = iz * preview.resolution + ix;
      let channel = 4;
      let weight = -1;
      for (let candidate = 0; candidate < 8; candidate += 1) {
        const value = preview.splat[texelIndex * 8 + candidate];
        if (value > weight) {
          weight = value;
          channel = candidate;
        }
      }
      const palette = SPLAT_PALETTE[channel] ?? SPLAT_PALETTE[4];
      const dx = heightAt(Math.min(half, x + texel * 2), z);
      const dz = heightAt(x, Math.min(half, z + texel * 2));
      const shade = hillShade(elevation, dx, dz);
      const tint = contourTint(contourBand(elevation, CONTOUR_STEP, MAJOR_STEP));

      const red = palette[0] * 255 * shade * tint;
      const green = palette[1] * 255 * shade * tint;
      const blue = palette[2] * 255 * shade * tint;

      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);

  const toPixel = (x: number, z: number): [number, number] =>
    toRadarPixel(x, z, size, width, height);

  for (const spline of draft.splines) {
    if (spline.nodes.length < 2) continue;
    const points = sampleSplineNodes(spline.nodes, spline.closed, spline.curve, 12);
    if (points.length < 2) continue;
    context.beginPath();
    points.forEach((point, index) => {
      const [px, py] = toPixel(point.x, point.z);
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.strokeStyle = SPLINE_COLORS[spline.kind] ?? "#cfd6de";
    context.lineWidth = Math.max(1.5, (spline.width / size) * width);
    context.globalAlpha = 0.85;
    context.stroke();
  }
  context.globalAlpha = 1;

  for (const placement of draft.placements) {
    const [px, py] = toPixel(placement.position.x, placement.position.z);
    const radius = Math.max(3, (placement.collisionRadius / size) * width);
    const selected = placement.id === draft.selectedPlacementId;
    context.beginPath();
    context.arc(px, py, radius, 0, Math.PI * 2);
    context.fillStyle = selected ? "rgba(159, 208, 255, 0.3)" : "rgba(217, 164, 91, 0.22)";
    context.fill();
    context.strokeStyle = selected ? "#9fd0ff" : "#d9a45b";
    context.lineWidth = selected ? 2 : 1.2;
    context.stroke();
    if (placement.collisionRadius >= 30) {
      context.fillStyle = "rgba(236, 241, 247, 0.92)";
      context.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.fillText(placement.name, px + radius + 3, py + 3);
    }
  }
}
