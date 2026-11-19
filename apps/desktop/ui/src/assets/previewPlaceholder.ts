/**
 * Every asset card needs a visual before WebGL thumbnails have rendered (and
 * when a prefab has no extracted geometry at all). This draws a small
 * isometric block in the category colour on a 2D canvas, so cards never fall
 * back to a bare letter or a filename-only row. Results are memoised per
 * category and footprint.
 */

const COLORS: Record<string, [number, number, number]> = {
  Monument: [217, 164, 91],
  Decor: [95, 143, 90],
  Building: [139, 147, 161],
  Vehicle: [154, 111, 191],
  Entity: [85, 163, 201],
  Terrain: [111, 148, 97],
  Other: [124, 135, 148],
};

const cache = new Map<string, string>();

function shade(color: [number, number, number], factor: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value * factor)));
  return `rgb(${clamp(color[0])}, ${clamp(color[1])}, ${clamp(color[2])})`;
}

export interface PlaceholderBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function previewPlaceholder(category: string, bounds: PlaceholderBounds): string {
  const width = Math.max(0.5, Math.abs(bounds.max[0] - bounds.min[0]));
  const height = Math.max(0.5, Math.abs(bounds.max[1] - bounds.min[1]));
  const depth = Math.max(0.5, Math.abs(bounds.max[2] - bounds.min[2]));
  const key = `${category}:${Math.round(width)}:${Math.round(height)}:${Math.round(depth)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return "";

  const color = COLORS[category] ?? COLORS.Other;
  const longest = Math.max(width, height, depth);
  const ax = 30 * (width / longest);
  const ay = 40 * (height / longest);
  const az = 30 * (depth / longest);
  const ex = { x: ax * 0.866, y: ax * 0.5 };
  const ez = { x: -az * 0.866, y: az * 0.5 };
  const ey = { x: 0, y: -ay };
  const center = { x: 64, y: 68 };

  const corner = (sx: number, sz: number, top: boolean) => ({
    x: center.x + sx * ex.x + sz * ez.x + (top ? ey.x : 0),
    y: center.y + sx * ex.y + sz * ez.y + (top ? ey.y : 0),
  });

  const polygon = (points: { x: number; y: number }[], fill: string, stroke: string) => {
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = stroke;
    context.lineWidth = 1;
    context.stroke();
  };

  const stroke = "rgba(8, 12, 16, 0.75)";
  const top = [corner(-0.5, -0.5, true), corner(0.5, -0.5, true), corner(0.5, 0.5, true), corner(-0.5, 0.5, true)];
  const left = [corner(-0.5, -0.5, true), corner(-0.5, 0.5, true), corner(-0.5, 0.5, false), corner(-0.5, -0.5, false)];
  const right = [corner(0.5, -0.5, true), corner(0.5, 0.5, true), corner(0.5, 0.5, false), corner(0.5, -0.5, false)];

  // Ground shadow keeps the block readable against the dark card.
  context.beginPath();
  context.ellipse(center.x, center.y + 30, 36, 10, 0, 0, Math.PI * 2);
  context.fillStyle = "rgba(0, 0, 0, 0.35)";
  context.fill();

  polygon(left, shade(color, 0.62), stroke);
  polygon(right, shade(color, 0.82), stroke);
  polygon(top, shade(color, 1.18), stroke);

  const data = canvas.toDataURL("image/png");
  cache.set(key, data);
  return data;
}
