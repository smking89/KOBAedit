import assert from "node:assert/strict";
import test from "node:test";

import { connectorTarget } from "../src/lib/splineMath.ts";
import type { RouteShape } from "../src/lib/splineMath.ts";

function road(nodes: { x: number; z: number }[], closed = false): RouteShape {
  return {
    nodes: nodes.map((node) => ({ x: node.x, y: 0, z: node.z })),
    closed,
    curve: "linear",
  };
}

const straight = road([
  { x: -100, z: 0 },
  { x: 100, z: 0 },
]);

test("connector joins the nearest point on the road, not the nearest node", () => {
  const target = connectorTarget([straight], { x: 10, z: 40 }, 12, 2210);
  assert.deepEqual(target, { x: 10, z: 0 });
});

test("connector clamps to the end of a road, not past it", () => {
  const target = connectorTarget([straight], { x: -200, z: 30 }, 12, 2210);
  assert.deepEqual(target, { x: -100, z: 0 });
});

test("connector picks the closest of several roads", () => {
  const far = road([
    { x: -400, z: 0 },
    { x: -300, z: 0 },
  ]);
  const near = road([
    { x: 0, z: 60 },
    { x: 40, z: 60 },
  ]);
  const target = connectorTarget([far, near], { x: 0, z: 0 }, 12, 2210);
  assert.deepEqual(target, { x: 0, z: 60 });
});

test("closed roads are joined anywhere along the loop", () => {
  const ring = road(
    Array.from({ length: 12 }, (_, index) => {
      const angle = (index / 12) * Math.PI * 2;
      return { x: Math.round(Math.cos(angle) * 100), z: Math.round(Math.sin(angle) * 100) };
    }),
    true,
  );
  const target = connectorTarget([ring], { x: 0, z: 50 }, 12, 2210);
  assert.ok(target);
  // Straight out from the centre, not at a corner node.
  assert.ok(Math.abs(target.x) < 10, `x=${target.x}`);
  assert.ok(Math.abs(target.z - 100) < 10, `z=${target.z}`);
});

test("no stub is generated when the prefab already sits on the road", () => {
  assert.equal(connectorTarget([straight], { x: 0, z: 5 }, 12, 2210), null);
});

test("with no road yet the connector runs to the closest map edge", () => {
  assert.deepEqual(connectorTarget([], { x: 0, z: 0 }, 12, 2210), { x: -2210, z: 0 });
  assert.deepEqual(connectorTarget([], { x: 2000, z: 50 }, 12, 2210), { x: 2210, z: 50 });
});
