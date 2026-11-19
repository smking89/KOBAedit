export type QualityTier = "low" | "mid" | "high";
export type QualityPreference = "auto" | QualityTier;

export interface QualityProfile {
  tier: QualityTier;
  pixelRatio: number;
  antialias: boolean;
  /** Terrain mesh subdivisions; always previewResolution - 1. */
  terrainSegments: number;
  previewResolution: number;
}

const STORAGE_KEY = "rust-studio:quality";
const PREFERENCES: QualityPreference[] = ["auto", "low", "mid", "high"];

let cachedProfile: QualityProfile | null = null;
let preference: QualityPreference = readPreference();

const PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: "low",
    pixelRatio: 1,
    antialias: false,
    terrainSegments: 96,
    previewResolution: 97,
  },
  mid: {
    tier: "mid",
    pixelRatio: 1.25,
    antialias: true,
    terrainSegments: 160,
    previewResolution: 161,
  },
  high: {
    tier: "high",
    pixelRatio: 1.5,
    antialias: true,
    terrainSegments: 256,
    previewResolution: 257,
  },
};

function readPreference(): QualityPreference {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return PREFERENCES.includes(stored as QualityPreference)
      ? (stored as QualityPreference)
      : "auto";
  } catch {
    return "auto";
  }
}

export function getQualityPreference(): QualityPreference {
  return preference;
}

export function setQualityPreference(next: QualityPreference): void {
  preference = PREFERENCES.includes(next) ? next : "auto";
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
}

function probeGpu(): { name: string; webgl2: boolean } {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    if (!context) return { name: "", webgl2: false };
    const info = context.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    context.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.width = 0;
    canvas.height = 0;
    return { name, webgl2: true };
  } catch {
    return { name: "", webgl2: false };
  }
}

function detectTier(): QualityTier {
  const cores = navigator.hardwareConcurrency || 2;
  const memory =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  const gpu = probeGpu();

  let tier: QualityTier = "mid";
  // deviceMemory is unavailable in Firefox; do not treat "unknown" as low RAM.
  if (!gpu.webgl2 || cores <= 2 || (memory > 0 && memory <= 4)) {
    tier = "low";
  } else if (cores >= 8 && (memory === 0 || memory >= 8)) {
    tier = "high";
  }

  const name = gpu.name.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render|mesa offscreen/.test(name)) {
    tier = "low";
  } else if (tier === "high" && /intel.*(hd|uhd) graphics|mali|adreno|powervr/.test(name)) {
    tier = "mid";
  }
  return tier;
}

/**
 * Pick the active quality profile. An explicit preference wins; "auto" probes
 * hardware once per session so older integrated machines stay usable.
 */
export function detectQualityProfile(): QualityProfile {
  if (preference !== "auto") return PROFILES[preference];
  if (cachedProfile) return cachedProfile;
  cachedProfile = PROFILES[detectTier()];
  return cachedProfile;
}
