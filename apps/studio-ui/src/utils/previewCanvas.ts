/** Marks the shared offscreen preview canvas so a reload can find it again. */
export const PREVIEW_CANVAS_SELECTOR = "canvas[data-koba-thumbnail-canvas]";

const PREVIEW_SIZE = 128;

/**
 * One preview canvas for the whole app.
 *
 * Hot reloads re-run module top-level code, so creating a canvas per load leaked
 * a WebGL context each time. The browser only hands out a handful of contexts,
 * and once they are gone every thumbnail silently renders an empty frame. Reuse
 * the canvas that is already mounted instead of appending another one.
 */
export function previewCanvas(doc: Document = document): HTMLCanvasElement {
  const existing = doc.querySelector<HTMLCanvasElement>(PREVIEW_CANVAS_SELECTOR);
  if (existing) return existing;

  const canvas = doc.createElement("canvas");
  canvas.width = PREVIEW_SIZE;
  canvas.height = PREVIEW_SIZE;
  canvas.style.width = `${PREVIEW_SIZE}px`;
  canvas.style.height = `${PREVIEW_SIZE}px`;
  canvas.style.position = "fixed";
  canvas.style.left = "-10000px";
  canvas.style.top = "-10000px";
  canvas.dataset.kobaThumbnailCanvas = "true";
  doc.body.appendChild(canvas);
  return canvas;
}
