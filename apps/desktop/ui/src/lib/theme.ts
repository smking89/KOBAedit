/** Persisted Light / Dark studio theme. */

export type Theme = "dark" | "light";

const THEME_KEY = "koba-edit:theme:v1";

export function loadTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
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
  "/splash/hero-1.jpg",
  "/splash/hero-2.png",
  "/splash/hero-3.png",
  "/splash/hero-4.png",
  "/splash/hero-5.png",
];
