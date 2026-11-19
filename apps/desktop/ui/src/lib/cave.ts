import type { CavePresetId } from "../wizard/types";

/**
 * Cave segment presets from the KOBA spec.
 *
 * `height` is the full tunnel height (ceiling above floor); the portal test
 * uses `splineY + height / 2` because a spline node is the tunnel axis.
 */
export interface CavePreset {
  id: CavePresetId;
  label: string;
  /** Clear tunnel width in metres. */
  width: number;
  /** Full tunnel height in metres. */
  height: number;
  /** Max random roll jitter in degrees. */
  rollJitter: number;
  /** Scale jitter range. */
  scaleJitter: [number, number];
  /** Timber arch / rib spacing in metres. */
  supportEvery: number;
  /** Industrial cage lamp spacing in metres (0 = none). */
  lampEvery: number;
  /** Minecart track along the floor. */
  track: boolean;
  /** Water puddle plane at the floor. */
  puddle: boolean;
  /** Rusted pipe props along the upper wall. */
  pipes: boolean;
  /** Endpoint stamp: flat buildable chamber. */
  chamber: boolean;
  /** PreventBuilding is disabled inside this radius around a chamber centre. */
  chamberRadius: number;
}

export const CAVE_PRESETS: CavePreset[] = [
  {
    id: "natural",
    label: "Natural rock tunnel",
    width: 4.5,
    height: 4,
    rollJitter: 12,
    scaleJitter: [0.95, 1.1],
    supportEvery: 0,
    lampEvery: 0,
    track: false,
    puddle: false,
    pipes: false,
    chamber: false,
    chamberRadius: 0,
  },
  {
    id: "mine",
    label: "Reinforced mine shaft",
    width: 4,
    height: 3.5,
    rollJitter: 0,
    scaleJitter: [1, 1.02],
    supportEvery: 4,
    lampEvery: 12,
    track: true,
    puddle: false,
    pipes: false,
    chamber: false,
    chamberRadius: 0,
  },
  {
    id: "sewer",
    label: "Sewer / bunker conduit",
    width: 3.5,
    height: 3.2,
    rollJitter: 0,
    scaleJitter: [1, 1],
    supportEvery: 6,
    lampEvery: 0,
    track: false,
    puddle: true,
    pipes: true,
    chamber: false,
    chamberRadius: 0,
  },
  {
    id: "chamber",
    label: "Buildable cave chamber",
    width: 12,
    height: 4,
    rollJitter: 0,
    scaleJitter: [1, 1],
    supportEvery: 0,
    lampEvery: 0,
    track: false,
    puddle: false,
    pipes: false,
    chamber: true,
    chamberRadius: 5.5,
  },
];

export const DEFAULT_CAVE_PRESET: CavePresetId = "natural";

export function cavePreset(id: CavePresetId | undefined): CavePreset {
  return CAVE_PRESETS.find((preset) => preset.id === id) ?? CAVE_PRESETS[0];
}

/**
 * Portal trigger from the spec: the tunnel roof is at `axisY + height / 2`; a
 * hole is cut when that roof reaches the terrain minus 0.5 m.
 */
export function portalCutRadius(preset: CavePreset): number {
  return Math.max(1.5, preset.width * 0.65);
}

export function caveCeilingY(axisY: number, preset: CavePreset): number {
  return axisY + preset.height * 0.5;
}

export interface CaveSectionSample {
  x: number;
  y: number;
  z: number;
}

/** Axis samples for one tunnel, ready for walk-mode queries. */
export interface CaveSection {
  width: number;
  height: number;
  samples: CaveSectionSample[];
}

export interface CaveWalkSection {
  /** Walkable tunnel floor elevation. */
  floor: number;
  /** Roof elevation minus head clearance. */
  ceiling: number;
  /** Nearest axis point, used to clamp the walker inside the rock. */
  axis: { x: number; z: number };
  /** Tunnel half-width. */
  radius: number;
}

/**
 * Nearest tunnel section under a point, or null outside every tunnel. Shared by
 * walk mode and its tests so entering a cave uses the same numbers as the
 * rendered shell.
 */
/** Where walk mode stands after a step: heightfield, portal drop or tunnel. */
export interface CaveWalkSurface {
  ground: number;
  ceiling: number;
  inTunnel: boolean;
  x: number;
  z: number;
}

/**
 * Cave entry rules shared by walk mode and its tests. Standing over a carved
 * portal drops the walker to the tunnel floor; once below the surface the
 * tunnel floor, roof and walls replace the heightfield.
 */
export function caveWalkSurface(options: {
  cave: CaveWalkSection | null;
  x: number;
  z: number;
  terrainGround: number;
  currentY: number;
  overPortal: boolean;
}): CaveWalkSurface {
  const { cave, terrainGround, currentY, overPortal } = options;
  let { x, z } = options;
  let ground = terrainGround;
  let ceiling = Number.POSITIVE_INFINITY;
  let inTunnel = false;
  if (cave) {
    inTunnel = currentY < terrainGround - 0.25;
    if (inTunnel) {
      ground = cave.floor;
      ceiling = cave.ceiling;
      const limit = Math.max(0.5, cave.radius - 0.45);
      const dx = x - cave.axis.x;
      const dz = z - cave.axis.z;
      const distance = Math.hypot(dx, dz);
      if (distance > limit) {
        const scale = limit / distance;
        x = cave.axis.x + dx * scale;
        z = cave.axis.z + dz * scale;
      }
    } else if (overPortal) {
      // The alpha hole has no floor: step in and fall to the tunnel floor.
      ground = cave.floor;
      ceiling = cave.ceiling;
    }
  }
  return { ground, ceiling, inTunnel, x, z };
}

export function caveSectionAt(
  sections: CaveSection[],
  x: number,
  z: number,
): CaveWalkSection | null {
  let best: CaveWalkSection | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const section of sections) {
    const radius = Math.max(0.5, section.width * 0.5);
    for (const sample of section.samples) {
      const distance = Math.hypot(sample.x - x, sample.z - z);
      if (distance > radius || distance >= bestDistance) continue;
      bestDistance = distance;
      best = {
        floor: sample.y - section.height * 0.5 + 0.12,
        ceiling: sample.y + section.height * 0.5 - 0.2,
        axis: { x: sample.x, z: sample.z },
        radius,
      };
    }
  }
  return best;
}
