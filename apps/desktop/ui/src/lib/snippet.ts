/**
 * Snippet capture helpers: watermark compositing and clipboard/download.
 * Pure maths lives here so the same placement is used by stills, loops and
 * (later) exported promo frames.
 */

import type { CreatorBranding, WatermarkSettings } from "./branding";

export interface Point {
  x: number;
  y: number;
}

/** Top-left corner of the watermark box for a 9-point anchor. */
export function watermarkOrigin(
  anchor: WatermarkSettings["anchor"],
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
  padding: number,
): Point {
  const left = padding;
  const centerX = (width - boxWidth) / 2;
  const right = width - boxWidth - padding;
  const top = padding;
  const centerY = (height - boxHeight) / 2;
  const bottom = height - boxHeight - padding;
  switch (anchor) {
    case "top-left":
      return { x: left, y: top };
    case "top":
      return { x: centerX, y: top };
    case "top-right":
      return { x: right, y: top };
    case "left":
      return { x: left, y: centerY };
    case "right":
      return { x: right, y: centerY };
    case "bottom-left":
      return { x: left, y: bottom };
    case "bottom":
      return { x: centerX, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
    case "tiled":
    case "center":
    default:
      return { x: centerX, y: centerY };
  }
}

export function snippetFileName(prefix = "koba-snippet", at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(
    at.getHours(),
  )}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${prefix}-${stamp}`;
}

/** Applies the watermark tint with a 2D-context filter string. */
export function watermarkFilter(tint: WatermarkSettings["tint"]): string {
  if (tint === "white") return "brightness(0) invert(1)";
  if (tint === "black") return "brightness(0)";
  return "none";
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error("watermark logo load timed out")), 4000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error("watermark logo could not be decoded"));
    };
    image.src = source;
  });
}

function paintWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  settings: WatermarkSettings,
  branding: CreatorBranding,
  image: HTMLImageElement | null,
): void {
  const padding = (settings.padding / 100) * Math.min(width, height) * 0.6;
  ctx.save();
  ctx.globalAlpha = settings.opacity;
  ctx.filter = watermarkFilter(settings.tint);

  if (settings.source === "logo" && image) {
    const box = Math.min(width, height) * settings.scale;

    if (settings.anchor === "tiled") {
      for (let y = padding; y < height; y += box * 1.4) {
        for (let x = padding; x < width; x += box * 1.4) {
          ctx.drawImage(image, x, y, box, box);
        }
      }
      ctx.restore();
      return;
    }

    const ratio = image.height / Math.max(1, image.width);
    const boxHeight = box * ratio;
    const origin = watermarkOrigin(settings.anchor, width, height, box, boxHeight, padding);
    ctx.drawImage(image, origin.x, origin.y, box, boxHeight);
    ctx.restore();
    return;
  }

  const size = Math.max(10, Math.round(Math.min(width, height) * settings.scale * 0.55));
  ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.letterSpacing = `${Math.round(size * 0.08)}px`;
  ctx.fillStyle = settings.tint === "black" ? "#000000" : "#ffffff";
  const measure = ctx.measureText(settings.text);

  if (settings.anchor === "tiled") {
    const columns = Math.max(2, Math.floor(width / Math.max(1, measure.width * 1.4)));
    const rows = Math.max(2, Math.floor(height / Math.max(1, size * 4)));
    const stepX = width / columns;
    const stepY = height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        ctx.fillText(settings.text, column * stepX + padding, row * stepY + padding);
      }
    }
    ctx.restore();
    return;
  }

  const origin = watermarkOrigin(settings.anchor, width, height, measure.width, size, padding);
  ctx.fillText(settings.text, origin.x, origin.y);
  ctx.restore();
}

/** Loads the logo once so per-frame painters do no async work. */
export async function createWatermarkPainter(
  settings: WatermarkSettings,
  branding: CreatorBranding,
): Promise<(ctx: CanvasRenderingContext2D, width: number, height: number) => void> {
  const image =
    settings.source === "logo" && branding.logo ? await loadImage(branding.logo) : null;
  return (ctx, width, height) => paintWatermark(ctx, width, height, settings, branding, image);
}

/**
 * Draws the watermark onto a 2D canvas at the same anchor/scale/padding the
 * live overlay uses, so a capture matches what the creator saw.
 */
export async function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  settings: WatermarkSettings,
  branding: CreatorBranding,
): Promise<void> {
  if (settings.source === "off") return;
  if (settings.source === "logo" && !branding.logo) return;
  if (settings.source === "text" && !settings.text.trim()) return;
  const image =
    settings.source === "logo" && branding.logo ? await loadImage(branding.logo) : null;
  paintWatermark(ctx, width, height, settings, branding, image);
}

/** Composites a viewport frame and the watermark into a PNG blob. */
export async function composeSnippet(
  frame: HTMLCanvasElement | string,
  settings: WatermarkSettings,
  branding: CreatorBranding,
): Promise<Blob> {
  const source =
    typeof frame === "string"
      ? await loadImage(frame)
      : { width: frame.width, height: frame.height, image: frame };
  const width = "image" in source ? source.width : source.width;
  const height = "image" in source ? source.height : source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  if (typeof frame === "string") {
    ctx.drawImage(source as HTMLImageElement, 0, 0, width, height);
  } else {
    ctx.drawImage(frame, 0, 0, width, height);
  }
  await drawWatermark(ctx, width, height, settings, branding);
  return new Promise((resolve, reject) => {
    // A hidden/backgrounded tab can leave toBlob pending forever; bound it so
    // callers can restore the camera and report a failure.
    const timer = setTimeout(() => reject(new Error("PNG encode timed out")), 8000);
    canvas.toBlob((blob) => {
      clearTimeout(timer);
      blob ? resolve(blob) : reject(new Error("PNG encode failed"));
    }, "image/png");
  });
}

export async function copySnippet(blob: Blob): Promise<boolean> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
    // Clipboard permission prompts can hang in embedded/background tabs.
    const written = await Promise.race([
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    return written;
  } catch {
    return false;
  }
}

/** Container extension for a recorded clip, matching the blob the browser produced. */
export function videoExtension(blob: Blob): "mp4" | "webm" {
  return blob.type.includes("mp4") ? "mp4" : "webm";
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
