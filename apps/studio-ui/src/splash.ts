import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { loadSplashPrefs, splashBackgrounds } from "./lib/splashPrefs";

interface SplashProgress {
  percent: number;
  message?: string;
  advanceHero?: boolean;
}

// The splash lives about 2.4 s, so a 3.2 s cycle would never advance: one
// crossfade per 1.15 s shows two or three heroes on every launch.
const HERO_INTERVAL_MS = 1150;
const ROTATE_KEY = "koba-splash-rotate-index";

const layerA = document.getElementById("bg-a");
const layerB = document.getElementById("bg-b");
const stepLabel = document.getElementById("splash-step");
const percentLabel = document.getElementById("splash-percent");
const fill = document.getElementById("splash-fill");

const backgrounds = splashBackgrounds(loadSplashPrefs());
const layers = [layerA, layerB];

let heroIndex = 0;
let activeLayer = 0;
let shownPercent = 0;
let painted = false;
let fallbackStarted = false;

/**
 * Paint the next hero into the idle layer and raise it above the visible one, so
 * the incoming image fades in rather than behind the outgoing image.
 */
function showBackground(url: string): void {
  const incoming = layers[activeLayer];
  const outgoing = layers[1 - activeLayer];
  if (!incoming) return;

  incoming.style.backgroundImage = `url("${url}")`;
  incoming.style.zIndex = "2";
  outgoing?.style.setProperty("z-index", "1");
  // Restart the Ken Burns animation: it only runs on a freshly activated layer.
  incoming.classList.remove("is-on");
  void incoming.offsetWidth;
  incoming.classList.add("is-on");
  activeLayer = 1 - activeLayer;
}

function advanceHero(): void {
  if (backgrounds.length === 0) return;
  // A locked or custom background stays put: re-painting it on every tick would
  // restart the Ken Burns animation and make the image pulse.
  if (painted && backgrounds.length === 1) return;
  showBackground(backgrounds[heroIndex % backgrounds.length]);
  heroIndex += 1;
  painted = true;
}

function setProgress(percent: number, message?: string): void {
  // Startup stages only move forward; a late event from a slower stage must not
  // pull the bar back.
  shownPercent = Math.max(shownPercent, Math.min(100, Math.round(percent)));
  if (fill) fill.style.width = `${shownPercent}%`;
  if (percentLabel) percentLabel.textContent = `${shownPercent}%`;
  if (message && stepLabel) stepLabel.textContent = message;
}

function startFallbackClock(): void {
  // Browser preview and a shell that never reports stages: keep the splash
  // alive and legible instead of freezing at zero. Only one clock may run: the
  // timeout and a failed listener can both ask for it.
  if (fallbackStarted) return;
  fallbackStarted = true;
  const messages = [
    "Indexing local assets",
    "Checking Rust bundle cache",
    "Preparing 3D viewport",
  ];
  let percent = 6;
  window.setInterval(() => {
    percent = Math.min(94, percent + 3);
    setProgress(percent, messages[Math.min(messages.length - 1, Math.floor(percent / 32))]);
  }, 260);
}

async function connectProgress(): Promise<void> {
  // The shell starts its startup thread as soon as the app is set up, which can
  // be before this window has finished loading. If no stage arrives shortly,
  // drive the bar locally instead of leaving it at zero.
  let received = false;
  window.setTimeout(() => {
    if (!received) startFallbackClock();
  }, 900);
  try {
    await listen<SplashProgress>("splash://progress", (event) => {
      const payload = event.payload ?? { percent: 0 };
      received = true;
      if (payload.percent > 0) setProgress(payload.percent, payload.message);
      if (payload.advanceHero) advanceHero();
    });
  } catch {
    startFallbackClock();
    return;
  }
  // Stages emitted before the listener existed are gone. Pull the stage the
  // shell has already reached instead of showing 0% for the whole splash.
  try {
    const latest = await invoke<SplashProgress>("splash_state");
    if (latest && latest.percent > 0) {
      received = true;
      setProgress(latest.percent, latest.message);
    }
  } catch {
    // Shell without the pull command: the fallback clock covers it.
  }
}

/**
 * Rotate mode opens on the next hero of the cycle, so two launches in a row do
 * not show the same image even when the splash is shorter than the interval.
 */
function rotateStartIndex(count: number): number {
  if (count <= 1) return 0;
  try {
    const last = Number(localStorage.getItem(ROTATE_KEY));
    const next = Number.isFinite(last) ? (last + 1) % count : 0;
    localStorage.setItem(ROTATE_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

/** Decode the first hero before the window is shown, so nobody sees the
 * webview's unpainted frame. Resolves even on error or a slow disk. */
function preloadHero(url: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const image = new Image();
    image.onload = done;
    image.onerror = done;
    image.src = url;
    window.setTimeout(done, 400);
  });
}

async function revealSplash(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    // The shell maps the window itself; the page only says "painted".
    await invoke("splash_present");
  } catch {
    // A failure here must not leave the shell without a splash: Rust maps the
    // window on its own watchdog shortly after launch.
  }
}

/** Show the splash only once the first hero is painted. */
async function presentSplash(): Promise<void> {
  // advanceHero() already painted the first hero and moved the cursor on.
  const total = Math.max(1, backgrounds.length);
  const hero = backgrounds[(heroIndex - 1 + total) % total];
  if (hero) await preloadHero(hero);
  document.body.classList.add("is-ready");
  // One frame for the class change to lay out before the window appears.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await revealSplash();
}

heroIndex = rotateStartIndex(backgrounds.length);
advanceHero();
window.setInterval(advanceHero, HERO_INTERVAL_MS);
void connectProgress();
void presentSplash();
