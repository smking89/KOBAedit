import assert from "node:assert/strict";
import test from "node:test";

import { applyCompletion, slashCompletion, walkSlashSuggestions } from "../src/lib/autocomplete.ts";

test("completes command ids after a slash", () => {
  const result = slashCompletion("/map.pla");
  assert.ok(result);
  assert.equal(result.items[0]?.label, "/map.placeMonument");
  assert.equal(result.from, 0);
  assert.equal(result.to, 8);
});

test("completes missing slots for the typed command", () => {
  const result = slashCompletion("/map.placeMonument type=harbor c");
  assert.ok(result);
  assert.deepEqual(result.items.map((item) => item.label), ["count"]);
  assert.equal(result.items[0]?.value, "count=");
});

test("hides slots already present and ignores non-slash text", () => {
  assert.equal(slashCompletion("place 3 harbors"), null);
  const result = slashCompletion("/map.generate size=4500 ");
  assert.ok(result);
  assert.deepEqual(result.items.map((item) => item.label), ["biome", "seed"]);
});

test("applies a completion and returns the caret position", () => {
  const completion = slashCompletion("/cave");
  assert.ok(completion);
  const applied = applyCompletion("/cave", completion, completion.items[0]!);
  assert.equal(applied.text, "/cave.extrudeSpline ");
  assert.equal(applied.caret, applied.text.length);
});

test("completes slot values after an equals sign", () => {
  const biome = slashCompletion("/map.generate biome=arc");
  assert.ok(biome);
  assert.deepEqual(biome.items.map((item) => item.value), ["biome=arctic"]);

  const ring = slashCompletion("/map.connectRoads ringRoad=");
  assert.ok(ring);
  assert.deepEqual(ring.items.map((item) => item.label), ["true", "false"]);
});

test("walk chat completes in-game commands only on the first token", () => {
  assert.deepEqual(walkSlashSuggestions("/s").map((item) => item.value), ["/shop", "/skin", "/safe"]);
  assert.deepEqual(walkSlashSuggestions("/sh").map((item) => item.value), ["/shop"]);
  assert.deepEqual(walkSlashSuggestions("/shop "), []);
  assert.deepEqual(walkSlashSuggestions("hello"), []);
});
