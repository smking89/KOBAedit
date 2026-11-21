import assert from "node:assert/strict";
import test from "node:test";

import { applyCommand, commandIds } from "../src/lib/commands.ts";
import { parsePrompt } from "../src/lib/promptParser.ts";
import { DEMO_PREFABS } from "../src/lib/demoAssets.ts";
import type { WizardDraft } from "../src/wizard/types.ts";

function makeDraft(): WizardDraft {
  return {
    projectKind: "map",
    terrain: {
      preset: "islands",
      sizeMetres: 4000,
      mountainScale: 1,
      seed: 7,
      waterLevel: 0,
      biomeWeights: [0.2, 0.3, 0.3, 0.2],
    },
    placements: [],
    splines: [],
    selectedPlacementId: null,
    skin: { layers: [], decals: [], baseMeshId: null, baseMeshName: "", uvChannels: 1, resolution: 1024, wear: {}, paintStrokes: 0, smartProjection: true },
    lighting: { timeOfDay: 720, weather: "clear" },
  } as unknown as WizardDraft;
}

const context = { catalog: DEMO_PREFABS };

test("parser turns one sentence into ordered terrain, landmark and road commands", () => {
  const parsed = parsePrompt("Make a 4.5k arctic island, place 3 harbors on the coast and connect a ring road");
  assert.deepEqual(parsed.commands.map((command) => command.id), [
    "map.generate",
    "map.placeMonument",
    "map.connectRoads",
  ]);
  assert.equal(parsed.commands[0].args.size, 4500);
  assert.equal(parsed.commands[0].args.biome, "arctic");
  assert.equal(parsed.commands[1].args.count, 3);
  assert.equal(parsed.commands[1].args.location, "coast");
  assert.equal(parsed.commands[2].args.ringRoad, true);
});

test("parser expands word numbers and named colours", () => {
  const twoHarbors = parsePrompt("place two harbors");
  assert.equal(twoHarbors.commands[0].args.count, 2);

  const skin = parsePrompt("apply matte black finish", "skin");
  assert.equal(skin.commands[0].id, "skin.applyBase");
  assert.equal(skin.commands[0].args.color, "#141414");
});

test("parser supports /command shortcuts with key=value slots", () => {
  const parsed = parsePrompt("/map.generate size=6200 biome=arid");
  assert.deepEqual(parsed.commands, [
    { id: "map.generate", args: { size: 6200, biome: "arid" }, raw: "/map.generate size=6200 biome=arid" },
  ]);
});

test("parser carves a tunnel with direction and length", () => {
  const parsed = parsePrompt("dig an 80 m mineshaft tunnel heading north");
  assert.equal(parsed.commands[0].id, "cave.extrudeSpline");
  assert.equal(parsed.commands[0].args.direction, "north");
  assert.equal(parsed.commands[0].args.length, 80);
  assert.equal(parsed.commands[0].args.preset, "mineshaft");
});

test("unmatched prose offers clarification chips instead of a command", () => {
  const parsed = parsePrompt("paint the beaches with sand");
  assert.deepEqual(parsed.commands, []);
  assert.ok(parsed.clarification);
  assert.ok(parsed.clarification!.chips.length >= 2);
});

test("lighting commands work outside the skin workspace", () => {
  const parsed = parsePrompt("set lighting to midnight", "map");
  assert.equal(parsed.commands[0].id, "skin.setLighting");
  assert.equal(parsed.commands[0].args.preset, "midnight");
});

test("applyCommand is pure and returns a receipt", () => {
  const draft = makeDraft();
  const parsed = parsePrompt("place 2 harbors on the north shore");
  const result = applyCommand(parsed.commands[0], draft, context);
  assert.equal(draft.placements.length, 0, "input draft must not be mutated");
  assert.equal(result.draft.placements.length, 2);
  assert.match(result.receipt, /Placed 2/);
  assert.equal(result.draft.terrain.sizeMetres, draft.terrain.sizeMetres);
});

test("every registered command id applies without throwing", () => {
  const draft = makeDraft();
  for (const id of commandIds()) {
    const result = applyCommand({ id, args: {}, raw: "" }, draft, context);
    assert.ok(result.receipt.length > 0, `${id} produced no receipt`);
    assert.equal(result.draft.projectKind, "map", `${id} changed unrelated state`);
  }
});

test("generated ids never collide with ids already in the draft", () => {
  const seeded = applyCommand(
    { id: "map.placeMonument", args: { type: "harbor", count: 1 }, raw: "" },
    makeDraft(),
    context,
  ).draft;
  const existingId = seeded.placements[0].id;
  const draft = { ...makeDraft(), placements: seeded.placements };
  const next = applyCommand(
    { id: "map.placeMonument", args: { type: "harbor", count: 2 }, raw: "" },
    draft,
    context,
  ).draft;
  const ids = next.placements.map((placement) => placement.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(ids[1], existingId);
  assert.notEqual(ids[2], existingId);
});

test("ring road creates a closed spline and skips duplicates per placement", () => {
  const draft = makeDraft();
  const placed = applyCommand(
    { id: "map.placeMonument", args: { type: "harbor", count: 1 }, raw: "" },
    draft,
    context,
  ).draft;
  const routed = applyCommand({ id: "map.connectRoads", args: { ringRoad: true }, raw: "" }, placed, context).draft;
  const ring = routed.splines.find((spline) => spline.name === "Ring road");
  assert.ok(ring);
  assert.equal(ring!.closed, true);
  assert.ok(routed.splines.some((spline) => spline.name.startsWith("Road to")));
});
