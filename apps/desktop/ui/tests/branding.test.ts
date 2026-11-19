import assert from "node:assert/strict";
import test from "node:test";

import {
  clampWatermark,
  DEFAULT_BRANDING,
  DEFAULT_WATERMARK,
  isBrandingLogo,
  safeSupportUrl,
  sanitizeBranding,
} from "../src/lib/branding.ts";

test("watermark ranges clamp instead of trusting the UI", () => {
  const clamped = clampWatermark({ opacity: 4, scale: 9, padding: -20 });
  assert.equal(clamped.opacity, 1);
  assert.equal(clamped.scale, 0.5);
  assert.equal(clamped.padding, 0);
  const tooSmall = clampWatermark({ opacity: -1, scale: 0.001, padding: 400 });
  assert.equal(tooSmall.opacity, 0);
  assert.equal(tooSmall.scale, 0.05);
  assert.equal(tooSmall.padding, 120);
});

test("unknown anchors, tints and sources fall back safely", () => {
  const watermark = clampWatermark({
    source: "banner" as never,
    anchor: "middle" as never,
    tint: "sepia" as never,
  });
  assert.equal(watermark.source, "off");
  assert.equal(watermark.anchor, DEFAULT_WATERMARK.anchor);
  assert.equal(watermark.tint, "white");
});

test("watermark text keeps a default and is length-capped", () => {
  assert.equal(clampWatermark({ text: "   " }).text, DEFAULT_WATERMARK.text);
  assert.equal(clampWatermark({ text: "x".repeat(200) }).text.length, 48);
});

test("branding trims fields and rejects unsafe links", () => {
  const branding = sanitizeBranding({
    author: "  Koba  ",
    brand: " KOBA EDIT ",
    supportUrl: "javascript:alert(1)",
    chatPrefix: "  ",
  });
  assert.equal(branding.author, "Koba");
  assert.equal(branding.brand, "KOBA EDIT");
  assert.equal(branding.supportUrl, "");
  assert.equal(branding.chatPrefix, DEFAULT_BRANDING.chatPrefix);
});

test("only image data URLs are accepted as a creator logo", () => {
  assert.equal(isBrandingLogo("data:image/png;base64,AAAA"), true);
  assert.equal(isBrandingLogo("data:image/svg+xml;utf8,<svg/>"), true);
  assert.equal(isBrandingLogo("data:text/html,<script>"), false);
  assert.equal(isBrandingLogo("https://example.com/logo.png"), false);
  const branding = sanitizeBranding({ logo: "data:text/html,<script>" });
  assert.equal(branding.logo, null);
});

test("support URLs get a protocol and stay http(s)", () => {
  assert.equal(safeSupportUrl("koba.example/support"), "https://koba.example/support");
  assert.equal(safeSupportUrl("http://example.com"), "http://example.com/");
});
