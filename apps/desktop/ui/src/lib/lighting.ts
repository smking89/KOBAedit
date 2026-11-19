import type { WeatherPreset } from "../wizard/types";

/**
 * Sun, moon and weather model shared by the map and skin viewports.
 *
 * Pure maths on purpose: the same numbers drive the WebGL lights, the fog and
 * the HUD label, so the time slider cannot drift from what is rendered, and the
 * engine-facing export stays untouched by a viewport preference.
 */

export interface LightingState {
  minutes: number;
  /** "13:40" */
  label: string;
  /** "Night", "Sunrise", "Morning", "Noon", "Golden hour", "Dusk" */
  phase: string;
  /** Degrees above the horizon; negative at night. */
  elevation: number;
  /** Radians, 0 = +X. */
  azimuth: number;
  /** 0 at night, 1 in full day. */
  daylight: number;
  sunColor: number;
  sunIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  skyColor: number;
  fogColor: number;
  /** Fog distances for a 4500 m map; callers scale them to their terrain. */
  fogNear: number;
  fogFar: number;
  /** 0–1 surface sheen hint for wet ground after rain. */
  wetness: number;
  weather: WeatherPreset;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number) => {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
};

function mixHex(a: number, b: number, t: number): number {
  const weight = clamp01(t);
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * weight);
  const g = Math.round(ag + (bg - ag) * weight);
  const bl = Math.round(ab + (bb - ab) * weight);
  return (r << 16) | (g << 8) | bl;
}

export const blendHex = mixHex;

const WEATHER: Record<
  WeatherPreset,
  { sun: number; ambient: number; sky: number; fog: number; near: number; far: number; wetness: number }
> = {
  clear: { sun: 1, ambient: 1, sky: 0x9ec6ea, fog: 0x0b0e12, near: 1600, far: 5200, wetness: 0 },
  overcast: { sun: 0.42, ambient: 1.25, sky: 0x5d6b78, fog: 0x2a323a, near: 700, far: 3200, wetness: 0.55 },
  fog: { sun: 0.28, ambient: 1.35, sky: 0x4a535c, fog: 0x3c454d, near: 90, far: 720, wetness: 0.3 },
  dust: { sun: 0.5, ambient: 1.1, sky: 0x8a6a44, fog: 0x6b4f31, near: 130, far: 980, wetness: 0.05 },
};

export function lightingState(minutes: number, weather: WeatherPreset): LightingState {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour = normalized / 60;
  // Simple solar arc: rises at 06:00, peaks at 12:00, sets at 18:00.
  const elevation = Math.sin(((hour - 6) / 12) * Math.PI) * 68;
  const daylight = smoothstep((elevation + 6) / 16);
  const azimuth = ((hour - 6) / 12) * Math.PI + Math.PI * 0.15;

  const night = 1 - daylight;
  // Golden hour is the band just above the horizon.
  const golden = clamp01(1 - Math.abs(elevation) / 22) * daylight;
  const sunColor = mixHex(mixHex(0xa9c8ff, 0xfff3e0, daylight), 0xff9a4d, golden * 0.85);
  const sunIntensity = 0.06 + daylight * 2.15;
  const ambientColor = mixHex(0x1b2740, 0x9db4c8, daylight);
  const ambientIntensity = 0.12 + daylight * 0.5;
  const skyColor = mixHex(0x05070c, 0x6f9ac2, daylight);
  const preset = WEATHER[weather] ?? WEATHER.clear;
  const sky = mixHex(skyColor, preset.sky, weather === "clear" ? 0.25 * daylight : 0.7);

  const label = `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(
    normalized % 60,
  ).padStart(2, "0")}`;
  const phase =
    daylight < 0.08
      ? "Night"
      : elevation < 8
        ? hour < 12
          ? "Sunrise"
          : "Sunset"
        : hour >= 11 && hour < 13
          ? "Noon"
          : hour < 11
            ? "Morning"
            : "Afternoon";

  return {
    minutes: normalized,
    label,
    phase,
    elevation,
    azimuth,
    daylight,
    sunColor,
    sunIntensity: sunIntensity * preset.sun,
    ambientColor,
    ambientIntensity: ambientIntensity * preset.ambient,
    skyColor: sky,
    fogColor: mixHex(0x0b0e12, preset.fog, 0.35 + daylight * 0.4),
    fogNear: preset.near * (0.6 + daylight * 0.4),
    fogFar: preset.far * (0.55 + daylight * 0.45),
    wetness: preset.wetness,
    weather,
  };
}

/** Underground override: no sun, tight fog, local lights only. */
export const UNDERGROUND_LIGHTING = {
  sunIntensity: 0,
  ambientIntensity: 0.06,
  ambientColor: 0x08090c,
  fogColor: 0x05070a,
  fogNear: 5,
  fogFar: 35,
} as const;
