import assert from "node:assert/strict";
import test from "node:test";

import { captureWithRadar } from "../src/lib/radarCapture.ts";

function fakeTools(order: string[]) {
  return {
    setRadarCamera: () => order.push("set"),
    restoreRadarCamera: () => order.push("restore"),
  };
}

test("captures from the radar view then restores", async () => {
  const order: string[] = [];
  const result = await captureWithRadar(
    fakeTools(order),
    async () => {
      order.push("capture");
      return "png";
    },
    async () => order.push("wait"),
  );
  assert.equal(result, "png");
  assert.deepEqual(order, ["set", "wait", "capture", "restore"]);
});

test("restores the camera when the capture throws", async () => {
  const order: string[] = [];
  await assert.rejects(
    captureWithRadar(
      fakeTools(order),
      async () => {
        order.push("capture");
        throw new Error("download blocked");
      },
      async () => {},
    ),
    /download blocked/,
  );
  assert.deepEqual(order, ["set", "capture", "restore"]);
});

test("restores the camera when the frame wait throws", async () => {
  const order: string[] = [];
  await assert.rejects(
    captureWithRadar(fakeTools(order), async () => "png", async () => {
      throw new Error("no frame");
    }),
    /no frame/,
  );
  assert.deepEqual(order, ["set", "restore"]);
});

test("times out a stalled capture and still restores the camera", async () => {
  const order: string[] = [];
  await assert.rejects(
    captureWithRadar(fakeTools(order), () => new Promise(() => {}), async () => {}, 20),
    /timed out/,
  );
  assert.deepEqual(order, ["set", "restore"]);
});
