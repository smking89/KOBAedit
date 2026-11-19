import assert from "node:assert/strict";
import test from "node:test";

import { parseAppSegment } from "../src/lib/appCommands.ts";

function first(segment: string) {
  const effects = parseAppSegment(segment);
  assert.ok(effects && effects.length > 0, `no effects for: ${segment}`);
  return effects![0];
}

test("logo watermark with anchor and opacity", () => {
  const effect = first("Add my logo watermark to the bottom right at 40% opacity");
  assert.equal(effect.kind, "watermark");
  if (effect.kind !== "watermark") return;
  assert.equal(effect.patch.source, "logo");
  assert.equal(effect.patch.anchor, "bottom-right");
  assert.equal(effect.patch.opacity, 0.4);
});

test("opacity-only and anchor-only follow-ups stay on the watermark", () => {
  const opacity = first("Set watermark opacity to 25%");
  assert.equal(opacity.kind, "watermark");
  if (opacity.kind === "watermark") {
    assert.equal(opacity.patch.opacity, 0.25);
    assert.equal(opacity.patch.source, undefined);
  }
  const moved = first("move it to top left");
  assert.equal(moved.kind, "watermark");
  if (moved.kind === "watermark") assert.equal(moved.patch.anchor, "top-left");
});

test("tiled proof enables the text watermark at 15%", () => {
  const effect = first("Tile my watermark across the screen at 15% opacity");
  assert.equal(effect.kind, "watermark");
  if (effect.kind !== "watermark") return;
  assert.equal(effect.patch.anchor, "tiled");
  assert.equal(effect.patch.source, "text");
  assert.equal(effect.patch.opacity, 0.15);
});

test("monochrome tint and disabling", () => {
  const white = first("Make my watermark solid white for night shots");
  assert.equal(white.kind, "watermark");
  if (white.kind === "watermark") assert.equal(white.patch.tint, "white");

  const off = first("Turn off watermark");
  assert.equal(off.kind, "watermark");
  if (off.kind === "watermark") assert.equal(off.patch.source, "off");
});

test("brand profile keeps creator casing and prefix", () => {
  const effect = first("Set plugin brand name to RustyHorizon with prefix [RH]");
  assert.equal(effect.kind, "brand");
  if (effect.kind !== "brand") return;
  assert.equal(effect.patch.brand, "RustyHorizon");
  assert.equal(effect.patch.chatPrefix, "[RH]");
});

test("snippet still and turntable commands", () => {
  assert.equal(first("Take a snippet").kind, "snippet-still");
  assert.equal(first("Capture screenshot").kind, "snippet-still");

  const turntable = first("Capture a 5-second 360 turntable snippet");
  assert.equal(turntable.kind, "snippet-turntable");
  if (turntable.kind === "snippet-turntable") assert.equal(turntable.seconds, 5);
});

test("radar snippet uses the top-down camera", () => {
  const effects = parseAppSegment("Capture top-down radar snippet of this monument");
  assert.ok(effects);
  assert.equal(effects![0].kind, "radar-still");
  if (effects![0].kind === "radar-still") assert.equal(effects![0].filename, "radar_preview.png");
  assert.ok(!effects!.some((effect) => effect.kind === "unavailable"));
});

test("promo generation picks length, style and beat sync", () => {
  const orbit = first("Generate a 30-second promo video at sunset with my audio");
  assert.equal(orbit.kind, "promo");
  if (orbit.kind === "promo") {
    assert.equal(orbit.request.length, 30);
    assert.equal(orbit.request.style, "orbit");
    assert.equal(orbit.request.beatSync, false);
  }

  const fly = first("Create a 15-second fly-through clip synced to the beat");
  assert.equal(fly.kind, "promo");
  if (fly.kind === "promo") {
    assert.equal(fly.request.length, 15);
    assert.equal(fly.request.style, "flythrough");
    assert.equal(fly.request.beatSync, true);
  }
});

test("timelapse trailer carries the watermark percentage", () => {
  const effects = parseAppSegment("Make a 60-second day-to-night timelapse trailer with 35% watermark");
  assert.ok(effects);
  const promo = effects!.find((effect) => effect.kind === "promo");
  assert.ok(promo);
  if (promo?.kind === "promo") {
    assert.equal(promo.request.length, 60);
    assert.equal(promo.request.style, "timelapse");
  }
  const watermark = effects!.find((effect) => effect.kind === "watermark");
  assert.ok(watermark);
  if (watermark?.kind === "watermark") assert.equal(watermark.patch.opacity, 0.35);
});

test("timeline, audio fade and export commands", () => {
  const open = first("Open the video timeline editor");
  assert.equal(open.kind, "timeline");
  if (open.kind === "timeline") assert.equal(open.open, true);

  const fade = first("Fade audio in and out over 2 seconds");
  assert.equal(fade.kind, "promo");
  if (fade.kind === "promo") {
    assert.equal(fade.request.fadeIn, 2);
    assert.equal(fade.request.fadeOut, 2);
  }

  const exported = first("export 1080p video");
  assert.equal(exported.kind, "promo");
  if (exported.kind === "promo") {
    assert.equal(exported.request.exportNow, true);
    assert.equal(exported.request.resolution, "1080p");
    assert.equal(exported.request.fps, 60);
  }
});

test("plugin bundling is reported as unavailable, not silently dropped", () => {
  const effect = first("generate a zippered PC plugin bundle");
  assert.equal(effect.kind, "unavailable");
});

test("draft sentences are left for the registry parser", () => {
  assert.equal(parseAppSegment("Place 3 harbors on the coast"), null);
  assert.equal(parseAppSegment("Apply matte black finish"), null);
});
