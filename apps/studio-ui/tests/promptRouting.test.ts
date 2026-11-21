import assert from "node:assert/strict";
import test from "node:test";

import { parsePrompt, shouldRouteToLegacy } from "../src/lib/promptParser.ts";

function route(text: string, attachments = false) {
  return shouldRouteToLegacy(text, parsePrompt(text, "map").commands, attachments);
}

test("project-scale sentences go to the legacy generator", () => {
  assert.equal(route("build me a base with loot"), true);
  assert.equal(route("Snowy 4 km island map with 8 monuments and two roads"), true);
  assert.equal(route("make a dense forest town"), true);
});

test("targeted commands stay on the command path", () => {
  assert.equal(route("place 3 harbors on the coast"), false);
  assert.equal(route("connect a ring road"), false);
  assert.equal(route("dig an 80 m tunnel north"), false);
});

test("shortcuts and attachments are routed deterministically", () => {
  assert.equal(route("/map.generate size=4500 biome=arctic"), false);
  assert.equal(route("build a base", true), true);
  assert.equal(route("", true), true);
});
