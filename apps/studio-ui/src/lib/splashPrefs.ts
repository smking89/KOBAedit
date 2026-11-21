import { SPLASH_ART } from "./theme";

/**
 * Splash background options. The preference lives in `localStorage`, which the
 * main window and the splash window share (same origin), so a change applies on
 * the next launch without a round trip through the shell.
 */
export type SplashMode = "rotate" | "lock" | "custom";

export interface SplashPrefs {
  mode: SplashMode;
  /** Bundled hero used when `mode` is `lock`. */
  hero: string;
  /** Data URL of a user-supplied image when `mode` is `custom`. */
  custom: string | null;
}

const STORE_KEY = "koba-splash-prefs";

/** A data URL larger than this would crowd out the rest of local storage. */
export const MAX_CUSTOM_SPLASH_CHARS = 3_500_000;

export const DEFAULT_SPLASH_PREFS: SplashPrefs = {
  mode: "rotate",
  hero: SPLASH_ART[0],
  custom: null,
};

export function loadSplashPrefs(): SplashPrefs {
  if (typeof localStorage === "undefined") return DEFAULT_SPLASH_PREFS;
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (!stored) return DEFAULT_SPLASH_PREFS;
    const parsed = JSON.parse(stored) as Partial<SplashPrefs>;
    return sanitizeSplashPrefs(parsed);
  } catch {
    return DEFAULT_SPLASH_PREFS;
  }
}

export function saveSplashPrefs(prefs: SplashPrefs): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sanitizeSplashPrefs(prefs)));
  } catch {
    // Storage full or unavailable: the previous preference stays in effect.
  }
}

export function sanitizeSplashPrefs(input: Partial<SplashPrefs>): SplashPrefs {
  const mode: SplashMode =
    input.mode === "lock" || input.mode === "custom" ? input.mode : "rotate";
  const hero = SPLASH_ART.includes(String(input.hero)) ? String(input.hero) : SPLASH_ART[0];
  const custom =
    typeof input.custom === "string" &&
    input.custom.startsWith("data:image/") &&
    input.custom.length <= MAX_CUSTOM_SPLASH_CHARS
      ? input.custom
      : null;
  // A custom mode without a usable image falls back to rotating heroes.
  return custom || mode !== "custom" ? { mode, hero, custom } : { mode: "rotate", hero, custom: null };
}

/** The ordered list of backgrounds the splash window should show. */
export function splashBackgrounds(prefs: SplashPrefs): string[] {
  if (prefs.mode === "custom" && prefs.custom) return [prefs.custom];
  if (prefs.mode === "lock") return [prefs.hero];
  return [...SPLASH_ART];
}
