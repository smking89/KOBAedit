import assert from "node:assert/strict";
import test from "node:test";

import {
  CAVE_PRESETS,
  caveCeilingY,
  cavePreset,
  caveSectionAt,
  caveWalkSurface,
  portalCutRadius,
} from "../src/lib/cave.ts";

const section = (width: number, height: number, samples: { x: number; y: number; z: number }[]) => ({
  width,
  height,
  samples,
});

test("walk section floors and ceilings follow the tunnel axis", () => {
  const found = caveSectionAt([section(4.5, 4, [{ x: 0, y: 100, z: 0 }])], 0, 0);
  assert.ok(found);
  assert.equal(found.floor, 98.12);
  assert.equal(found.ceiling, 101.8);
  assert.deepEqual(found.axis, { x: 0, z: 0 });
  assert.equal(found.radius, 2.25);
});

test("nearest axis sample wins and outside the tunnel is null", () => {
  const tunnel = section(6, 4, [
    { x: 0, y: 50, z: 0 },
    { x: 4, y: 52, z: 0 },
  ]);
  const near = caveSectionAt([tunnel], 3.4, 0);
  assert.ok(near);
  assert.deepEqual(near.axis, { x: 4, z: 0 });
  assert.equal(near.floor, 50.12);

  // Nearest axis point is (4, 0); 3.1 m away is outside the 3 m radius.
  assert.equal(caveSectionAt([tunnel], 7.1, 0), null);
  assert.equal(caveSectionAt([], 0, 0), null);
});

test("tunnel radius has a floor and preset widths drive the portal cut", () => {
  const needle = caveSectionAt([section(0, 4, [{ x: 0, y: 0, z: 0 }])], 0, 0);
  assert.ok(needle);
  assert.equal(needle.radius, 0.5);

  const natural = cavePreset("natural");
  const sewer = cavePreset("sewer");
  assert.equal(natural.width, 4.5);
  assert.equal(sewer.width, 3.5);
  assert.equal(portalCutRadius(sewer), 2.275);
  assert.equal(caveCeilingY(10, natural), 12);
  assert.equal(cavePreset("missing" as never).id, "natural");
  assert.deepEqual(
    CAVE_PRESETS.map((preset) => preset.id),
    ["natural", "mine", "sewer", "chamber"],
  );
});

test("walking outside a cave keeps the heightfield", () => {
  const surface = caveWalkSurface({
    cave: null,
    x: 12,
    z: -4,
    terrainGround: 40.5,
    currentY: 40.5,
    overPortal: false,
  });
  assert.equal(surface.ground, 40.5);
  assert.equal(surface.inTunnel, false);
  assert.equal(surface.ceiling, Number.POSITIVE_INFINITY);
  assert.deepEqual([surface.x, surface.z], [12, -4]);
});

test("standing over a portal drops the walker onto the tunnel floor", () => {
  const section = caveSectionAt(
    [{ width: 4.5, height: 3, samples: [{ x: 0, y: 20, z: 0 }] }],
    0,
    0,
  );
  assert.ok(section);
  const surface = caveWalkSurface({
    cave: section,
    x: 0,
    z: 0,
    terrainGround: 30,
    currentY: 30,
    overPortal: true,
  });
  assert.equal(surface.ground, section.floor);
  assert.equal(surface.ceiling, section.ceiling);
  assert.equal(surface.inTunnel, false);
});

test("below the surface the tunnel walls clamp the walker", () => {
  const section = caveSectionAt(
    [{ width: 4.5, height: 3, samples: [{ x: 0, y: 20, z: 0 }] }],
    0,
    0,
  );
  assert.ok(section);
  const surface = caveWalkSurface({
    cave: section,
    x: 1.9,
    z: 0,
    terrainGround: 30,
    currentY: 19,
    overPortal: false,
  });
  assert.equal(surface.inTunnel, true);
  assert.equal(surface.ground, section.floor);
  const limit = Math.max(0.5, section.radius - 0.45);
  assert.ok(Math.abs(surface.x) <= limit + 1e-9, `x=${surface.x} limit=${limit}`);
  assert.equal(surface.z, 0);
});

test("inside the tunnel radius the walker keeps their exact spot", () => {
  const section = caveSectionAt(
    [{ width: 6, height: 3, samples: [{ x: 0, y: 20, z: 0 }] }],
    0,
    0,
  );
  assert.ok(section);
  const surface = caveWalkSurface({
    cave: section,
    x: 0.5,
    z: -0.4,
    terrainGround: 30,
    currentY: 20,
    overPortal: false,
  });
  assert.equal(surface.inTunnel, true);
  assert.deepEqual([surface.x, surface.z], [0.5, -0.4]);
});
