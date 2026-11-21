import assert from "node:assert/strict";
import test from "node:test";

import {
  draftForStorage,
  stateForLocalStorage,
  stateForStorage,
  writeAutosave,
} from "../src/wizard/autosave.ts";
import type { WizardDraft, WizardState } from "../src/wizard/types.ts";

function stateWithTerrain(dataChars: number, masks: number): WizardState {
  const draft = {
    name: "quota-test",
    cuiFrame: {
      name: "frame.png",
      width: 1024,
      height: 1024,
      bytes: 1_500_000,
      interiorOpaque: 0,
      dataUrl: `data:image/png;base64,${"A".repeat(2_000_000)}`,
    },
    terrain: {
      heightmap: {
        name: "height.raw",
        resolution: 4097,
        encoding: "raw16",
        data: "B".repeat(dataChars),
        minHeight: -500,
        maxHeight: 500,
        verticalScale: 1,
      },
      masks: Array.from({ length: masks }, (_, index) => ({
        id: `mask-${index}`,
        name: `mask-${index}.png`,
        kind: "splat" as const,
        channel: index,
        resolution: 4097,
        data: "C".repeat(dataChars),
      })),
    },
    placements: [{ id: "p1" }],
  };
  return { draft: draft as unknown as WizardDraft } as WizardState;
}

test("the CUI frame is stripped from durable saves but a heightmap survives", () => {
  const state = stateWithTerrain(64, 1);
  const stored = stateForStorage(state);
  assert.equal(stored.draft.cuiFrame, undefined);
  assert.ok(stored.draft.terrain.heightmap?.data);
  assert.equal(stored.draft.terrain.masks.length, 1);
});

test("the localStorage fallback drops heightmaps and masks only", () => {
  const state = stateWithTerrain(64, 2);
  const compact = stateForLocalStorage(state);
  assert.equal(compact.draft.cuiFrame, undefined);
  assert.equal(compact.draft.terrain.heightmap, undefined);
  assert.deepEqual(compact.draft.terrain.masks, []);
  assert.deepEqual(compact.draft.placements, state.draft.placements);
});

test("an oversized payload is written compactly without a doomed full write", () => {
  const store = new Map<string, string>();
  let attempts = 0;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      attempts += 1;
      if (value.length > 2_000_000) throw new Error("QuotaExceededError");
      store.set(key, value);
    },
  };
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage };
  try {
    const state = stateWithTerrain(3_000_000, 2);
    const result = writeAutosave("test:key", state);
    assert.equal(result.ok, true);
    assert.equal(result.omittedGrids, true);
    assert.equal(attempts, 1);
    const raw = store.get("test:key");
    assert.ok(raw);
    assert.ok(raw.length < 100_000, `stored ${raw.length} characters`);
    const parsed = JSON.parse(raw) as WizardState;
    assert.equal(parsed.draft.terrain.heightmap, undefined);
    assert.deepEqual(parsed.draft.terrain.masks, []);
    assert.deepEqual(parsed.draft.placements, state.draft.placements);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("small drafts are written in full", () => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  };
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage };
  try {
    const state = stateWithTerrain(64, 1);
    const result = writeAutosave("test:small", state);
    assert.equal(result.ok, true);
    assert.equal(result.omittedGrids, false);
    const parsed = JSON.parse(store.get("test:small") ?? "{}") as WizardState;
    assert.ok(parsed.draft.terrain.heightmap?.data);
    assert.equal(parsed.draft.terrain.masks.length, 1);
    assert.equal(parsed.draft.cuiFrame, undefined);
    assert.equal(draftForStorage(state.draft).cuiFrame, undefined);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});
