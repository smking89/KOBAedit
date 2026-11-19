/**
 * App-level commands: branding, watermark, snippet capture and promo video.
 *
 * These cannot be pure draft transforms — they touch creator settings, the
 * viewport and the recorder — so they are parsed into declarative effects that
 * the App applies. Parsing stays pure and is unit-tested.
 */

import type { CreatorBranding, WatermarkAnchor, WatermarkSettings, WatermarkTint } from "./branding";
import { PROMO_LENGTHS, type PromoLength, type PromoStyle } from "./promo.ts";

export interface PromoRequest {
  length: PromoLength;
  style: PromoStyle;
  beatSync: boolean;
  fadeIn?: number;
  fadeOut?: number;
  exportNow?: boolean;
  resolution?: "1080p";
  fps?: 60;
}

export type AppEffect =
  | { kind: "watermark"; patch: Partial<WatermarkSettings>; note: string }
  | { kind: "brand"; patch: Partial<CreatorBranding>; note: string }
  | { kind: "snippet-still"; filename?: string; note: string }
  | { kind: "snippet-turntable"; seconds: number; note: string }
  | { kind: "promo"; request: PromoRequest; note: string }
  | { kind: "timeline"; open: boolean; note: string }
  | { kind: "unavailable"; note: string };

const ANCHOR_WORDS: { words: string[]; anchor: WatermarkAnchor }[] = [
  { words: ["top left", "top-left", "upper left", "upper-left"], anchor: "top-left" },
  { words: ["top right", "top-right", "upper right", "upper-right"], anchor: "top-right" },
  { words: ["bottom left", "bottom-left", "lower left", "lower-left"], anchor: "bottom-left" },
  { words: ["bottom right", "bottom-right", "lower right", "lower-right"], anchor: "bottom-right" },
  { words: ["tile", "tiled", "across the screen", "proof"], anchor: "tiled" },
  { words: ["centre", "center", "middle"], anchor: "center" },
];

function percent(text: string): number | null {
  const match = text.match(/(\d{1,3})\s*%/);
  if (!match) return null;
  return Math.min(100, Math.max(0, Number(match[1]))) / 100;
}

function seconds(text: string): number | null {
  const match = text.match(/(\d{1,3})\s*(?:-|\s)?(?:second|seconds|s\b)/i);
  return match ? Math.min(120, Math.max(1, Number(match[1]))) : null;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** `RustyHorizon` out of `set plugin brand name to RustyHorizon with prefix [RH]`. */
function brandName(text: string): string | null {
  const explicit = text.match(/(?:brand name|brand|creator)\s+(?:to|is)\s+([\w .'-]{2,40})/i);
  if (!explicit) return null;
  const raw = explicit[1]
    .replace(/\s+with\b.*$/i, "")
    .replace(/\s+and\b.*$/i, "")
    .trim();
  return (/[A-Z]/.test(raw) ? raw : titleCase(raw)).slice(0, 40);
}

function tintFor(text: string): WatermarkTint | null {
  if (/\b(solid white|mono white|monochrome white|white)\b/.test(text)) return "white";
  if (/\b(solid black|mono black|monochrome black|black)\b/.test(text)) return "black";
  return null;
}

function promoStyleFor(text: string): PromoStyle {
  if (/\b(action|fly[- ]?through|flythrough)\b/.test(text)) return "flythrough";
  if (/\b(timelapse|day[- ]to[- ]night|time[- ]lapse)\b/.test(text)) return "timelapse";
  if (/\b(reveal|dramatic)\b/.test(text)) return "reveal";
  return "orbit";
}

function promoLengthFor(text: string): PromoLength {
  const explicit = text.match(/\b(15|30|60)\s*(?:-|\s)?(?:second|seconds|s\b)/i);
  const value = explicit ? Number(explicit[1]) : null;
  const match = PROMO_LENGTHS.find((option) => option.value === value);
  return match ? match.value : 30;
}

/**
 * Returns effects for a segment, or null when the segment is not an app
 * command (the draft registry then gets a chance).
 */
export function parseAppSegment(segment: string): AppEffect[] | null {
  const text = segment.toLowerCase();
  const effects: AppEffect[] = [];

  // Follow-ups like "move it to top left" inherit the watermark target.
  const followAnchor = ANCHOR_WORDS.find((entry) => entry.words.some((word) => text.includes(word)));
  if (followAnchor && /^(move|put|place|position|align)\b/.test(text)) {
    return [
      { kind: "watermark", patch: { anchor: followAnchor.anchor }, note: `Watermark moved to ${followAnchor.anchor}` },
    ];
  }

  const promoIntent = /\b(promo|trailer|timelapse|time[- ]lapse|fly[- ]?through|export clip)\b/.test(text);
  const bundledIntent = /\b(zipp?ed|plugin bundle|storefront package)\b/.test(text);

  if (bundledIntent) {
    return [{ kind: "unavailable", note: "Plugin bundling is not part of the prompt engine yet." }];
  }

  // Watermark controls (unless the sentence is really about a promo render).
  if (!promoIntent && /watermark|logo overlay|proof mark/.test(text)) {
    if (/\b(turn off|hide|disable|remove)\b/.test(text)) {
      return [{ kind: "watermark", patch: { source: "off" }, note: "Watermark hidden" }];
    }
    const patch: Partial<WatermarkSettings> = {};
    let note = "Watermark updated";
    if (/\b(logo|my logo)\b/.test(text)) {
      patch.source = "logo";
      note = "Logo watermark enabled";
    } else if (/watermark/.test(text) && !/\bopacity|move|percent|%/.test(text)) {
      patch.source = "text";
    }
    const anchor = ANCHOR_WORDS.find((entry) => entry.words.some((word) => text.includes(word)));
    if (anchor) patch.anchor = anchor.anchor;
    const opacity = percent(text);
    if (opacity !== null) patch.opacity = opacity;
    if (patch.anchor === "tiled" && !patch.source) patch.source = "text";
    const tint = tintFor(text.replace(/\b(white|black)\b/, ""));
    if (/\b(night shots?|solid white|monochrome|contrast)\b/.test(text)) {
      patch.tint = tint ?? "white";
    }
    if (Object.keys(patch).length === 0) {
      return [{ kind: "unavailable", note: "Add an anchor, opacity, tint or say 'turn off watermark'." }];
    }
    effects.push({ kind: "watermark", patch, note });
    return effects;
  }

  // Creator / plugin branding profile.
  if (/\b(brand|creator name|plugin name|profile)\b/.test(text) && /\b(set|change|update|brand)\b/.test(text)) {
    const name = brandName(segment);
    const prefixMatch = segment.match(/\[([A-Za-z0-9]{1,6})\]/) ?? segment.match(/prefix\s+([A-Za-z0-9]{1,6})/i);
    if (!name && !prefixMatch) return null;
    const patch: Partial<CreatorBranding> = {};
    if (name) patch.brand = name;
    if (prefixMatch) patch.chatPrefix = `[${prefixMatch[1].replace(/[[\]]/g, "")}]`;
    return [
      {
        kind: "brand",
        patch,
        note: `Creator brand set to ${name ?? "current name"}${patch.chatPrefix ? ` ${patch.chatPrefix}` : ""}`,
      },
    ];
  }

  // Snippet capture.
  if (/\b(snippet|screenshot|screen grab|capture (?:a )?snippet)\b/.test(text)) {
    if (/\b(turntable|360|spin|orbit)\b/.test(text)) {
      const length = seconds(text) ?? 5;
      return [
        {
          kind: "snippet-turntable",
          seconds: length,
          note: `Recording a ${length}s 360° turntable snippet`,
        },
      ];
    }
    if (/\b(radar|top[- ]down|ortho|orthographic)\b/.test(text)) {
      return [
        { kind: "snippet-still", filename: "radar_preview.png", note: "Radar still captured" },
        {
          kind: "unavailable",
          note: "Top-down ortho camera is not wired to the viewport yet; captured the current view instead.",
        },
      ];
    }
    return [{ kind: "snippet-still", note: "Snippet captured with the active watermark" }];
  }

  // Promo video and timeline.
  if (/\b(promo|trailer|timeline|video|clip|timelapse|time[- ]lapse|fly[- ]?through|fade|beat)\b/.test(text)) {
    if (/\b(timeline editor|open (?:the )?timeline)\b/.test(text)) {
      return [{ kind: "timeline", open: true, note: "Timeline editor opened" }];
    }
    if (/\b(fade|audio)\b/.test(text) && !/\b(generate|make|create|promo video)\b/.test(text)) {
      const fade = seconds(text) ?? 2;
      const request: PromoRequest = {
        length: promoLengthFor(text),
        style: promoStyleFor(text),
        beatSync: false,
        fadeIn: fade,
        fadeOut: fade,
      };
      return [{ kind: "promo", request, note: `Audio fades set to ${fade}s in and out` }];
    }
    if (/\b(export|render)\b/.test(text) && !/\b(generate|make|create)\b/.test(text)) {
      return [
        {
          kind: "promo",
          request: { length: promoLengthFor(text), style: promoStyleFor(text), beatSync: false, exportNow: true, resolution: "1080p", fps: 60 },
          note: "Export queued in the promo panel",
        },
      ];
    }
    if (!/\b(promo|trailer|video|clip|timelapse|fly[- ]?through)\b/.test(text)) return null;
    if (/\b(zipp?ed|plugin bundle|package)\b/.test(text)) {
      return [{ kind: "unavailable", note: "Plugin bundling is not part of the prompt engine yet." }];
    }
    const request: PromoRequest = {
      length: promoLengthFor(text),
      style: promoStyleFor(text),
      beatSync: /\bbeat\b/.test(text),
      exportNow: /\bexport\b/.test(text),
      resolution: "1080p",
      fps: 60,
    };
    const watermarkOpacity = percent(text);
    if (watermarkOpacity !== null && /watermark/.test(text)) {
      effects.push({
        kind: "watermark",
        patch: { source: "text", opacity: watermarkOpacity },
        note: `Watermark opacity set to ${Math.round(watermarkOpacity * 100)}%`,
      });
    }
    return [
      ...effects,
      {
        kind: "promo",
        request,
        note: `Promo generated: ${request.length}s ${request.style}${request.beatSync ? " (beat-synced)" : ""}`,
      },
    ];
  }

  if (/\b(zipp?ed|plugin bundle)\b/.test(text)) {
    return [{ kind: "unavailable", note: "Plugin bundling is not part of the prompt engine yet." }];
  }

  return null;
}

/** Human-readable chip labels for a parsed prompt, used by tests and UI hints. */
export function describeEffect(effect: AppEffect): string {
  return effect.note;
}

