import assert from "node:assert/strict";
import test from "node:test";

import {
  clamp,
  contourBand,
  contourTint,
  hillShade,
  toRadarPixel,
  toRadarWorld,
  waterColor,
} from "../src/lib/radarMath.ts";

test("water colour is null on land and shades deeper water darker", () => {
  assert.equal(waterColor(10, 0), null);
  assert.equal(waterColor(0.01, 0), null);

  const surface = waterColor(0, 0);
  const deep = waterColor(-40, 0);
  const floor = waterColor(-200, 0);
  assert.ok(surface && deep && floor);
  assert.deepEqual(surface, { r: 12, g: 36, b: 62 });
  assert.ok(deep.r > surface.r && deep.g > surface.g && deep.b > surface.b);
  // Depth clamps at 80 m, so 200 m below the waterline matches 80 m.
  assert.deepEqual(floor, waterColor(-80, 0));
  assert.deepEqual(floor, { r: 34, g: 82, b: 154 });
});

test("contour bands separate 20 m lines from 100 m major lines", () => {
  assert.equal(contourBand(0), 2);
  assert.equal(contourBand(100), 2);
  assert.equal(contourBand(200), 2);
  assert.equal(contourBand(-100), 2);
  assert.equal(contourBand(20), 1);
  assert.equal(contourBand(40), 1);
  assert.equal(contourBand(160), 1);
  assert.equal(contourBand(-20), 1);
  assert.equal(contourBand(30), 0);
  assert.equal(contourBand(101.5), 0);
  assert.equal(contourBand(99), 0);
});

test("contour tint darkens minor and major lines", () => {
  assert.equal(contourTint(0), 1);
  assert.equal(contourTint(1), 0.74);
  assert.equal(contourTint(2), 0.5);
});

test("world and radar pixels round-trip", () => {
  const size = 4500;
  const width = 720;
  const height = 720;

  assert.deepEqual(toRadarPixel(-2250, -2250, size, width, height), [0, 0]);
  assert.deepEqual(toRadarPixel(0, 0, size, width, height), [359.5, 359.5]);
  assert.deepEqual(toRadarPixel(2250, 2250, size, width, height), [719, 719]);

  for (const [x, z] of [
    [-2250, 1200],
    [0, 0],
    [1750.5, -320.25],
    [2250, -2250],
  ]) {
    const [px, py] = toRadarPixel(x, z, size, width, height);
    const [wx, wz] = toRadarWorld(px, py, size, width, height);
    assert.ok(Math.abs(wx - x) < 1e-9, `${x} → ${wx}`);
    assert.ok(Math.abs(wz - z) < 1e-9, `${z} → ${wz}`);
  }
});

test("hill shade brightens uphill faces and clamps hard values", () => {
  assert.equal(hillShade(10, 10, 10), 0.74);
  assert.ok(hillShade(20, 10, 10) > 0.74);
  assert.equal(hillShade(100, 0, 0), 1.32);
  assert.equal(hillShade(0, 100, 100), 0.34);
});

test("clamp keeps values inside the range", () => {
  assert.equal(clamp(-4, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(9, 0, 1), 1);
});
