/**
 * Creator branding and the live watermark overlay.
 *
 * Both are creator-owned, stored locally and never sent anywhere. The values
 * here feed the watermark preview today and the export manifests once those
 * pipelines land, so validation lives in one place.
 */

export const BRANDING_KEY = "koba-edit:branding:v1";

export type WatermarkSource = "off" | "logo" | "text";
export type WatermarkTint = "original" | "white" | "black";
export type WatermarkAnchor =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right"
  | "tiled";

export interface CreatorBranding {
  author: string;
  brand: string;
  supportUrl: string;
  chatPrefix: string;
  /** PNG/SVG/WebP data URL, or null when the creator has not uploaded one. */
  logo: string | null;
}

export interface WatermarkSettings {
  source: WatermarkSource;
  text: string;
  /** 0..1 alpha. */
  opacity: number;
  anchor: WatermarkAnchor;
  /** Fraction of the preview's smallest side, 0.05..0.5. */
  scale: number;
  /** Pixels of edge padding. */
  padding: number;
  tint: WatermarkTint;
}

export const DEFAULT_BRANDING: CreatorBranding = {
  author: "",
  brand: "",
  supportUrl: "",
  chatPrefix: "KOBA",
  logo: null,
};

export const DEFAULT_WATERMARK: WatermarkSettings = {
  source: "off",
  text: "KOBA EDIT",
  opacity: 0.5,
  anchor: "bottom-right",
  scale: 0.18,
  padding: 20,
  tint: "white",
};

export const WATERMARK_ANCHORS: { id: WatermarkAnchor; label: string }[] = [
  { id: "top-left", label: "Top left" },
  { id: "top", label: "Top" },
  { id: "top-right", label: "Top right" },
  { id: "left", label: "Left" },
  { id: "center", label: "Center" },
  { id: "right", label: "Right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "bottom", label: "Bottom" },
  { id: "bottom-right", label: "Bottom right" },
  { id: "tiled", label: "Tiled proof" },
];

export const WATERMARK_TINTS: { id: WatermarkTint; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "white", label: "Mono white" },
  { id: "black", label: "Mono black" },
];

const ANCHORS = new Set<WatermarkAnchor>(WATERMARK_ANCHORS.map((anchor) => anchor.id));
const TINTS = new Set<WatermarkTint>(WATERMARK_TINTS.map((tint) => tint.id));
const LOGO_PREFIXES = [
  "data:image/png",
  "data:image/jpeg",
  "data:image/webp",
  "data:image/svg+xml",
];

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** Accepts only http(s) links so a pasted `javascript:` URL never renders. */
export function safeSupportUrl(value: unknown): string {
  const raw = text(value, 240);
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function isBrandingLogo(value: unknown): value is string {
  return typeof value === "string" && LOGO_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function sanitizeBranding(input: Partial<CreatorBranding> | null | undefined): CreatorBranding {
  if (!input) return { ...DEFAULT_BRANDING };
  return {
    author: text(input.author, 64),
    brand: text(input.brand, 64),
    supportUrl: safeSupportUrl(input.supportUrl),
    chatPrefix: text(input.chatPrefix, 16) || DEFAULT_BRANDING.chatPrefix,
    logo: isBrandingLogo(input.logo) ? input.logo : null,
  };
}

export function clampWatermark(input: Partial<WatermarkSettings> | null | undefined): WatermarkSettings {
  const merged = { ...DEFAULT_WATERMARK, ...(input ?? {}) };
  return {
    source:
      merged.source === "logo" || merged.source === "text" || merged.source === "off"
        ? merged.source
        : "off",
    text: text(merged.text, 48) || DEFAULT_WATERMARK.text,
    opacity: clamp(Number(merged.opacity), 0, 1, DEFAULT_WATERMARK.opacity),
    anchor: ANCHORS.has(merged.anchor as WatermarkAnchor)
      ? (merged.anchor as WatermarkAnchor)
      : DEFAULT_WATERMARK.anchor,
    scale: clamp(Number(merged.scale), 0.05, 0.5, DEFAULT_WATERMARK.scale),
    padding: clamp(Number(merged.padding), 0, 120, DEFAULT_WATERMARK.padding),
    tint: TINTS.has(merged.tint as WatermarkTint) ? (merged.tint as WatermarkTint) : "white",
  };
}

export interface BrandingState {
  branding: CreatorBranding;
  watermark: WatermarkSettings;
}

export const DEFAULT_BRANDING_STATE: BrandingState = {
  branding: DEFAULT_BRANDING,
  watermark: DEFAULT_WATERMARK,
};

export function loadBranding(): BrandingState {
  if (typeof window === "undefined") return DEFAULT_BRANDING_STATE;
  try {
    const raw = window.localStorage.getItem(BRANDING_KEY);
    if (!raw) return DEFAULT_BRANDING_STATE;
    const parsed = JSON.parse(raw) as Partial<BrandingState>;
    return {
      branding: sanitizeBranding(parsed.branding),
      watermark: clampWatermark(parsed.watermark),
    };
  } catch {
    return DEFAULT_BRANDING_STATE;
  }
}

export function saveBranding(state: BrandingState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BRANDING_KEY, JSON.stringify(state));
  } catch {
    // Storage quota or private mode: branding simply stays session-only.
  }
}
