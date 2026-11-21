import assert from "node:assert/strict";
import test from "node:test";

import { runThumbnailQueue } from "../src/utils/thumbnailQueueRunner.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("visits every item exactly once", async () => {
  const seen: number[] = [];
  await runThumbnailQueue([1, 2, 3, 4, 5, 6, 7], async (item) => {
    await delay(1);
    seen.push(item);
  });
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test("never runs more workers than the requested concurrency", async () => {
  let active = 0;
  let peak = 0;
  await runThumbnailQueue(
    Array.from({ length: 12 }, (_, index) => index),
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(2);
      active -= 1;
    },
    { concurrency: 2 },
  );
  assert.equal(peak, 2, "two workers means at most two thumbnails at a time");
});

test("keeps the page order when running one worker", async () => {
  const order: number[] = [];
  await runThumbnailQueue(
    [0, 1, 2, 3, 4, 5],
    async (item) => {
      // Later items would finish sooner; the queue still starts them in order.
      await delay(item === 0 ? 6 : 1);
      order.push(item);
    },
    { concurrency: 1 },
  );
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
});

test("stops handing out work once cancelled", async () => {
  let cancelled = false;
  const seen: number[] = [];
  await runThumbnailQueue(
    Array.from({ length: 20 }, (_, index) => index),
    async (item) => {
      seen.push(item);
      if (seen.length === 2) cancelled = true;
      await delay(1);
    },
    { concurrency: 1, cancelled: () => cancelled },
  );
  assert.deepEqual(seen, [0, 1], "a drawer close must not keep loading thumbnails");
});

test("survives a failing item and keeps going", async () => {
  const seen: number[] = [];
  await runThumbnailQueue(
    [1, 2, 3, 4],
    async (item) => {
      if (item === 2) throw new Error("unreadable mesh");
      seen.push(item);
    },
    { concurrency: 2 },
  );
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    [1, 3, 4],
  );
});

test("handles an empty list", async () => {
  let calls = 0;
  await runThumbnailQueue(
    [],
    async () => {
      calls += 1;
    },
    { concurrency: 2 },
  );
  assert.equal(calls, 0);
});
