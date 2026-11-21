/**
 * Persisted studio theme. KOBA Studios opens in the daylight palette; the dark
 * theme stays available and is restored when the user has chosen it.
 */

export type Theme = "dark" | "light";

const THEME_KEY = "koba-edit:theme:v1";

export function loadTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function saveTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the theme simply lasts for the session.
  }
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

/** Stage-synced splash artwork: local files only, no network at runtime. */
export const SPLASH_ART = [
  "/splash-heroes/sunset-ridge.jpg",
  "/splash-heroes/ember-swamp.jpg",
  "/splash-heroes/cyber-swamp.jpg",
  "/splash-heroes/toxic-dome.jpg",
  "/splash-heroes/cobalt-town.jpg",
];
