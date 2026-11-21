import assert from "node:assert/strict";
import test from "node:test";

import { autosaveBadge, autosavePhase } from "../src/wizard/autosaveStatus.ts";

test("an idle autosave shows no badge", () => {
  assert.equal(autosaveBadge({ phase: "idle", savedAt: null }), null);
});

test("a saving autosave uses the neutral badge", () => {
  const badge = autosaveBadge({ phase: "saving", savedAt: null });
  assert.equal(badge?.tone, "neutral");
  assert.equal(badge?.label, "Saving draft");
});

test("a saved autosave reports just now when no timestamp is set", () => {
  const badge = autosaveBadge({ phase: "saved", savedAt: null });
  assert.equal(badge?.tone, "ok");
  assert.equal(badge?.label, "Autosaved just now");
  assert.match(badge?.title ?? "", /autosaves locally/);
});

test("a saved autosave shows the write time", () => {
  const badge = autosaveBadge({ phase: "saved", savedAt: "2026-11-21T19:24:00.000Z" });
  assert.equal(badge?.tone, "ok");
  assert.match(badge?.label ?? "", /^Autosaved \S/);
});

test("a partial autosave warns that grids were not stored", () => {
  const badge = autosaveBadge({ phase: "partial", savedAt: null });
  assert.equal(badge?.tone, "warn");
  assert.equal(badge?.label, "Draft saved, grids not stored");
  assert.match(badge?.title ?? "", /heightmaps or masks were left out/);
});

test("a failed autosave uses the danger badge", () => {
  const badge = autosaveBadge({ phase: "error", savedAt: null });
  assert.equal(badge?.tone, "danger");
  assert.equal(badge?.label, "Autosave failed");
  assert.match(badge?.title ?? "", /could not write the draft/);
});

test("a desktop save keeps a small grid without IndexedDB", () => {
  assert.equal(
    autosavePhase({ ok: true, omittedGrids: false, gridsStored: false, desktop: true }),
    "saved",
  );
});

test("a desktop save that omits a grid is partial", () => {
  assert.equal(
    autosavePhase({ ok: true, omittedGrids: true, gridsStored: true, desktop: true }),
    "partial",
  );
});

test("a browser save is complete when IndexedDB stores the grid", () => {
  assert.equal(
    autosavePhase({ ok: true, omittedGrids: true, gridsStored: true, desktop: false }),
    "saved",
  );
});

test("a browser save is partial when the grid store fails", () => {
  assert.equal(
    autosavePhase({ ok: true, omittedGrids: false, gridsStored: false, desktop: false }),
    "partial",
  );
});

test("a failed local write is an error even when grids are durable", () => {
  assert.equal(
    autosavePhase({ ok: false, omittedGrids: false, gridsStored: true, desktop: false }),
    "error",
  );
});
