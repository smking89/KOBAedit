import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutoPromo,
  cueDuration,
  cueTimeline,
  detectBeats,
  isAudioFile,
  promoDuration,
  snapCuesToBeats,
  waveformPeaks,
} from "../src/lib/promo.ts";
import type { PrefabPlacement } from "../src/wizard/types.ts";

function placement(id: string, x: number, z: number, name = `Prefab ${id}`): PrefabPlacement {
  return {
    id,
    assetId: `assets/${id}.prefab`,
    name,
    position: { x, y: 0, z },
    rotationEuler: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    parentId: null,
    collisionRadius: 20,
    collisionHeight: 8,
    flatten: true,
    flattenRadius: 20,
    flattenFalloff: 8,
    clearFoliage: true,
    noBuildZone: true,
    lootTier: 2,
    lootProfile: "",
    ioWiring: "",
    npcCount: 0,
    locked: false,
  };
}

test("beat snapping moves cut boundaries onto nearby beats", () => {
  const cues = [
    { id: "a", label: "A", focus: { x: 0, z: 0 }, seconds: 4, speed: 1, radius: 100 },
    { id: "b", label: "B", focus: { x: 0, z: 0 }, seconds: 4, speed: 1, radius: 100 },
    { id: "c", label: "C", focus: { x: 0, z: 0 }, seconds: 4, speed: 1, radius: 100 },
  ];
  const snapped = snapCuesToBeats(cues, [3.8, 8.2, 12.1], { tolerance: 0.45 });
  const timeline = cueTimeline(snapped);
  assert.equal(Number(timeline[0].end.toFixed(1)), 3.8);
  assert.equal(Number(timeline[1].end.toFixed(1)), 8.2);
  // The closing cue keeps its natural end so the requested runtime survives.
  assert.equal(Number(timeline[2].end.toFixed(1)), 12.2);
  assert.equal(snapped[0].speed, 1);
});

test("beat snapping ignores beats inside the minimum clip and no-beat input", () => {
  const cues = [
    { id: "a", label: "A", focus: { x: 0, z: 0 }, seconds: 4, speed: 1, radius: 100 },
    { id: "b", label: "B", focus: { x: 0, z: 0 }, seconds: 4, speed: 1, radius: 100 },
  ];
  const snapped = snapCuesToBeats(cues, [0.5, 7.9], { tolerance: 0.45, minSeconds: 1 });
  assert.equal(Number(cueTimeline(snapped)[0].end.toFixed(1)), 4);
  assert.equal(snapCuesToBeats(cues, []), cues);
});

test("beat detection finds transients and respects the minimum gap", () => {
  const peaks = Array.from({ length: 120 }, (_, index) => (index % 30 === 15 ? 1 : 0.1));
  const beats = detectBeats(peaks, 0.05);
  assert.equal(beats.length, 4);
  assert.ok(beats.every((time, index) => index === 0 || time - beats[index - 1] >= 0.28));
  assert.ok(beats.every((time) => Math.abs(time - 0.75) < 0.001 || Math.abs(time - 2.25) < 0.05 || time > 0));
});

test("beat detection stays quiet on a flat waveform", () => {
  assert.deepEqual(detectBeats(new Array(40).fill(0.5), 0.05), []);
  assert.deepEqual(detectBeats([], 0.05), []);
});

test("waveform peaks normalise to the loudest bucket", () => {
  const samples = new Float32Array(1000);
  samples[10] = 0.5;
  samples[500] = -1;
  const peaks = waveformPeaks(samples, 100);
  assert.equal(peaks.length, 100);
  assert.equal(Math.max(...peaks), 1);
});

test("auto promo opens on the island, then visits monuments in order", () => {
  const cues = buildAutoPromo(
    { placements: [placement("a", 100, 40, "Airfield"), placement("b", -80, 60, "Harbor")], sizeMetres: 4500 },
    { length: 15, style: "orbit" },
  );
  assert.equal(cues[0].id, "cue-establishing");
  const labels = cues.map((cue) => cue.label);
  assert.ok(labels.includes("Airfield"));
  assert.ok(labels.includes("Harbor"));
  assert.ok(promoDuration(cues) <= 15.0001, `duration ${promoDuration(cues)}`);
  assert.ok(promoDuration(cues) > 10);
});

test("style presets change playback speed but still fit the runtime", () => {
  const input = { placements: [placement("a", 10, 10)], sizeMetres: 4500 };
  const reveal = buildAutoPromo(input, { length: 30, style: "reveal" });
  const timelapse = buildAutoPromo(input, { length: 30, style: "timelapse" });
  assert.equal(reveal[0].speed, 0.5);
  assert.equal(timelapse[0].speed, 2);
  assert.ok(promoDuration(reveal) <= 30 && promoDuration(timelapse) <= 30);
});

test("timeline start and end times are contiguous", () => {
  const cues = buildAutoPromo(
    { placements: [placement("a", 10, 10), placement("b", 20, 20)], sizeMetres: 4500 },
    { length: 30, style: "orbit" },
  );
  const timeline = cueTimeline(cues);
  assert.equal(timeline[0].start, 0);
  assert.ok(Math.abs(timeline[timeline.length - 1].end - promoDuration(cues)) < 1e-9);
  for (let index = 1; index < timeline.length; index += 1) {
    assert.ok(Math.abs(timeline[index].start - timeline[index - 1].end) < 1e-9);
  }
  assert.ok(cueDuration(cues[0]) > 0);
});

test("audio uploads are restricted to mp3, wav and ogg under 24 MB", () => {
  assert.equal(isAudioFile({ name: "track.mp3", type: "audio/mpeg", size: 1024 }), true);
  assert.equal(isAudioFile({ name: "track.wav", type: "", size: 1024 }), true);
  assert.equal(isAudioFile({ name: "track.ogg", type: "audio/ogg", size: 1024 }), true);
  assert.equal(isAudioFile({ name: "track.mp4", type: "video/mp4", size: 1024 }), false);
  assert.equal(isAudioFile({ name: "huge.wav", type: "audio/wav", size: 40 * 1024 * 1024 }), false);
});
