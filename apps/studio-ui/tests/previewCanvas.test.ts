import assert from "node:assert/strict";
import test from "node:test";

import { PREVIEW_CANVAS_SELECTOR, previewCanvas } from "../src/utils/previewCanvas.ts";

type FakeCanvas = {
  width: number;
  height: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  remove: () => void;
};

/** Minimal document: one canvas at a time, and a count of appends. */
function fakeDocument() {
  const appended: FakeCanvas[] = [];
  let current: FakeCanvas | null = null;
  const doc = {
    querySelector: (selector: string) =>
      selector === PREVIEW_CANVAS_SELECTOR ? current : null,
    createElement: (): FakeCanvas => ({
      width: 0,
      height: 0,
      style: {},
      dataset: {},
      remove: () => {
        current = null;
      },
    }),
    body: {
      appendChild: (element: FakeCanvas) => {
        appended.push(element);
        current = element;
      },
    },
  };
  return { doc: doc as unknown as Document, appended };
}

test("reusing the preview canvas across reloads appends only one", () => {
  const { doc, appended } = fakeDocument();
  const canvases = Array.from({ length: 20 }, () => previewCanvas(doc));
  // Twenty module loads used to mean twenty canvases and twenty WebGL contexts.
  assert.equal(appended.length, 1, "a reload must not append a second preview canvas");
  assert.ok(canvases.every((canvas) => canvas === canvases[0]));
  assert.equal(canvases[0].width, 128);
  assert.equal(canvases[0].dataset.kobaThumbnailCanvas, "true");
});

test("an already mounted preview canvas is adopted instead of replaced", () => {
  const existing = {
    width: 128,
    height: 128,
    style: {},
    dataset: { kobaThumbnailCanvas: "true" },
    remove: () => {},
  } as FakeCanvas;
  const doc = {
    querySelector: () => existing,
    createElement: () => {
      throw new Error("should not create a second canvas");
    },
    body: { appendChild: () => assert.fail("should not append a second canvas") },
  } as unknown as Document;

  assert.equal(previewCanvas(doc), existing);
});
