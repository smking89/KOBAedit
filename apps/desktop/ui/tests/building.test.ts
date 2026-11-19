import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_LIFT,
  TRI_ALTITUDE,
  TRI_EDGE_TO_CENTRE,
  footprintCorners,
  pieceTopY,
  rotationStep,
  snapToSocket,
  socketHeight,
} from "../src/lib/building.ts";

const structure = (piece: any, x: number, z: number, rotation = 0, y = 0) => ({
  id: `${piece}-1`,
  piece,
  x,
  z,
  y,
  rotation,
});

test("socket distances are the Rust grid values", () => {
  const foundation = structure("foundation", 0, 0);
  const round = (value: number) => Number(value.toFixed(3));

  const square = snapToSocket("foundation", 3.4, 0, 0, [foundation]);
  assert.equal(round(Math.hypot(square.x, square.z)), 3);
  assert.equal(square.rotation, 0);

  const triangle = snapToSocket("triangle", 2.766, 0, 0, [foundation]);
  assert.equal(round(Math.hypot(triangle.x, triangle.z)), 2.366);

  const triangleParent = structure("triangle", 0, 0);
  const tri = snapToSocket("triangle", 0, 2.132, 0, [triangleParent]);
  assert.equal(round(Math.hypot(tri.x, tri.z)), 1.732);

  const squareOnTriangle = snapToSocket("foundation", 2.766, 0, 0, [triangleParent]);
  assert.equal(round(Math.hypot(squareOnTriangle.x, squareOnTriangle.z)), 2.366);
});

test("rotation steps and triangle metrics match the 3 m triangle", () => {
  assert.equal(Math.round((rotationStep("foundation") * 180) / Math.PI), 90);
  assert.equal(Math.round((rotationStep("triangle") * 180) / Math.PI), 60);
  assert.equal(Number(TRI_ALTITUDE.toFixed(4)), 2.5981);
  assert.equal(Number(TRI_EDGE_TO_CENTRE.toFixed(4)), 0.866);
});

test("ghost footprint swaps shape with the piece", () => {
  const square = footprintCorners("foundation", 0, 0, 0);
  const triangle = footprintCorners("triangle", 0, 0, 0);
  const span = (points: { x: number; z: number }[], axis: "x" | "z") => {
    const values = points.map((point) => point[axis]);
    return Number((Math.max(...values) - Math.min(...values)).toFixed(4));
  };

  assert.equal(square.length, 4);
  assert.equal(triangle.length, 3);
  assert.equal(span(square, "x"), 3);
  assert.equal(span(square, "z"), 3);
  assert.equal(span(triangle, "x"), 3);
  assert.equal(span(triangle, "z"), 2.5981);
  // Rotating by 90° leaves the square spanning 3 m but turns the triangle's
  // long axis around; the outline has to follow that too.
  const rotated = footprintCorners("triangle", 0, 0, Math.PI / 2);
  assert.equal(span(rotated, "x"), 2.5981);
  assert.equal(span(rotated, "z"), 3);
});

test("wall and floor sockets adopt the parent's top surface", () => {
  const foundation = structure("foundation", 0, 0, 0, 40);
  const foundationTop = pieceTopY("foundation", 40);
  assert.equal(Number(foundationTop.toFixed(2)), 40.15);
  assert.equal(socketHeight("wall", foundation, 0), foundationTop);

  const wall = structure("wall", 3, 0, 0, foundationTop);
  const wallTop = pieceTopY("wall", foundationTop);
  assert.equal(Number(wallTop.toFixed(2)), 43.15);
  assert.equal(socketHeight("floor", wall, 0), wallTop);
  assert.equal(socketHeight("stairs", wall, 0), wallTop);
  // Ground pieces stay on the terrain even when socketed sideways.
  assert.equal(socketHeight("foundation", wall, 12), 12);
  assert.equal(BUILD_LIFT.foundation, 0);
});
