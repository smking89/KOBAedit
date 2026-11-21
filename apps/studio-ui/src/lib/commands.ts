/**
 * Deterministic command registry for the KOBA Studios prompt engine.
 *
 * Each command is a pure (draft, args) -> { draft, receipt } transform, so the
 * prompt drawer, future sidebar buttons and tests all run the same code. No
 * command reads or writes outside the draft it is handed.
 */

import { createPlacement, createSpline } from "./factories.ts";
import { WORLD_SIZE_MAX, WORLD_SIZE_MIN } from "./worldSize.ts";
import type {
  MaterialLayer,
  PrefabAsset,
  PrefabPlacement,
  RouteSpline,
  TerrainPreset,
  WizardDraft,
  WizardStepId,
} from "../wizard/types";


/** Used when the drawer has not indexed the Rust prefab list yet. */
const FALLBACK_ASSET: PrefabAsset = {
  id: "demo:foundation",
  name: "Foundation",
  category: "Building",
  bounds: { min: [-4, 0, -4], max: [4, 6, 4] },
  flattenRadius: 12,
  hasLoot: false,
  hasIO: false,
  hasNpc: false,
};

let sequence = 0;

/** Deterministic ids: the same prompt produces byte-identical drafts. */
function uid(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** Keeps a generated id unique against ids already present in the draft. */
function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

export interface CommandContext {
  catalog: PrefabAsset[];
}

export interface CommandResult {
  draft: WizardDraft;
  receipt: string;
}

export interface CommandDefinition {
  id: string;
  label: string;
  step: WizardStepId;
  apply: (draft: WizardDraft, args: Record<string, unknown>, context: CommandContext) => CommandResult;
}

export interface ParsedCommand {
  id: string;
  args: Record<string, unknown>;
  raw: string;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

function stringArg(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function pickAsset(
  context: CommandContext,
  phrase: string,
  fallbackName: string,
): { asset: PrefabAsset; label: string } {
  const catalog = context.catalog.length ? context.catalog : [FALLBACK_ASSET];
  const needle = phrase.toLowerCase();
  const exact = catalog.find((asset) => asset.name.toLowerCase() === needle);
  if (exact) return { asset: exact, label: exact.name };
  const partial = catalog.find(
    (asset) => asset.name.toLowerCase().includes(needle) || needle.includes(asset.name.toLowerCase()),
  );
  if (partial) return { asset: partial, label: partial.name };
  const fallback = catalog.find((asset) => asset.name === fallbackName);
  // No catalog match: keep the creator's word in the draft and say so, rather
  // than silently renaming their harbor into an airfield.
  return { asset: fallback ?? catalog[0] ?? FALLBACK_ASSET, label: phrase };
}

function withPlacements(draft: WizardDraft, placements: PrefabPlacement[], selected?: string): WizardDraft {
  return {
    ...draft,
    placements,
    selectedPlacementId: selected ?? placements[placements.length - 1]?.id ?? null,
  };
}

/** Rough map anchor for landmark placement. */
function anchorPosition(
  location: string,
  size: number,
  index: number,
): { x: number; z: number } {
  const ring = size * 0.3;
  switch (location) {
    case "north":
      return { x: 0, z: -ring };
    case "south":
      return { x: 0, z: ring };
    case "east":
      return { x: ring, z: 0 };
    case "west":
      return { x: -ring, z: 0 };
    case "coast":
      return { x: Math.cos(index * 1.1) * ring, z: Math.sin(index * 1.1) * ring };
    case "center":
    default:
      return { x: Math.cos(index * 2.1) * size * 0.08, z: Math.sin(index * 2.1) * size * 0.08 };
  }
}

const BIOME_PRESETS: Record<string, { preset: TerrainPreset; weights: [number, number, number, number] }> = {
  arctic: { preset: "islands", weights: [0.05, 0.15, 0.55, 0.25] },
  arid: { preset: "valley", weights: [0.55, 0.1, 0.25, 0.1] },
  temperate: { preset: "islands", weights: [0.2, 0.3, 0.3, 0.2] },
  jungle: { preset: "archipelago", weights: [0.15, 0.25, 0.5, 0.1] },
  ocean: { preset: "archipelago", weights: [0.0, 0.1, 0.35, 0.55] },
};

export const COMMAND_REGISTRY: CommandDefinition[] = [
  {
    id: "map.generate",
    label: "Generate terrain",
    step: "terrain",
    apply: (draft, args) => {
      const size = Math.min(
        WORLD_SIZE_MAX,
        Math.max(WORLD_SIZE_MIN, numberArg(args, "size", draft.terrain.sizeMetres)),
      );
      const biome = stringArg(args, "biome", "temperate");
      const preset = BIOME_PRESETS[biome] ?? BIOME_PRESETS.temperate;
      const seed = numberArg(args, "seed", draft.terrain.seed);
      return {
        draft: {
          ...draft,
          terrain: {
            ...draft.terrain,
            sizeMetres: size,
            preset: preset.preset,
            seed: Math.round(seed),
            biomeWeights: preset.weights,
          },
        },
        receipt: `Generated a ${Math.round(size / 100) / 10}k ${biome} terrain (seed ${Math.round(seed)}).`,
      };
    },
  },
  {
    id: "map.placeMonument",
    label: "Place monuments",
    step: "monuments",
    apply: (draft, args, context) => {
      const phrase = stringArg(args, "type", "monument");
      const count = Math.min(12, Math.max(1, Math.round(numberArg(args, "count", 1))));
      const location = stringArg(args, "location", "center");
      const { asset, label } = pickAsset(context, phrase, "Airfield");
      const placements = [...draft.placements];
      const usedIds = new Set(placements.map((item) => item.id));
      let selected = draft.selectedPlacementId;
      for (let index = 0; index < count; index += 1) {
        const position = anchorPosition(location, draft.terrain.sizeMetres, placements.length + index);
        const placement = createPlacement(asset, placements.length + index, position);
        placement.id = uniqueId(placement.id, usedIds);
        if (label !== asset.name) placement.name = label;
        placements.push(placement);
        selected = placement.id;
      }
      return {
        draft: withPlacements(draft, placements, selected ?? undefined),
        receipt: `Placed ${count} × ${label}${label === asset.name ? "" : ` (${asset.name} proxy)`} (${location}).`,
      };
    },
  },
  {
    id: "map.connectRoads",
    label: "Connect roads",
    step: "paths",
    apply: (draft, args) => {
      const kind = stringArg(args, "type", "road") === "rail" ? "rail" : "road";
      const ring = Boolean(args.ringRoad);
      let splines: RouteSpline[] = [...draft.splines];
      const usedIds = new Set(splines.map((item) => item.id));
      if (ring) {
        const radius = draft.terrain.sizeMetres * 0.22;
        const nodes = Array.from({ length: 8 }, (_, index) => {
          const angle = (index / 8) * Math.PI * 2;
          return {
            x: Math.round(Math.cos(angle) * radius),
            y: 0,
            z: Math.round(Math.sin(angle) * radius),
          };
        });
        const spline = { ...createSpline(kind, splines.length), name: "Ring road", closed: true, nodes };
        spline.id = uniqueId(spline.id, usedIds);
        splines = [...splines, spline];
      }
      for (const placement of draft.placements) {
        splines = [
          ...splines,
          {
            ...createSpline(kind, splines.length),
            id: uniqueId(createSpline(kind, splines.length).id, usedIds),
            name: `Road to ${placement.name}`,
            nodes: [
              { x: placement.position.x, y: 0, z: placement.position.z },
              { x: 0, y: 0, z: 0 },
            ],
          },
        ];
      }
      if (!ring && draft.placements.length === 0) {
        const spline = {
          ...createSpline(kind, splines.length),
          id: uniqueId(createSpline(kind, splines.length).id, usedIds),
          name: "Main road",
          nodes: [
            { x: -draft.terrain.sizeMetres * 0.3, y: 0, z: 0 },
            { x: 0, y: 0, z: 0 },
            { x: draft.terrain.sizeMetres * 0.3, y: 0, z: 0 },
          ],
        };
        splines = [...splines, spline];
      }
      return {
        draft: { ...draft, splines },
        receipt: ring ? "Connected a closed ring road." : "Connected the roads between monuments.",
      };
    },
  },
  {
    id: "monument.assemble",
    label: "Assemble compound",
    step: "monuments",
    apply: (draft, args, context) => {
      const footprint = stringArg(args, "footprint", "2x2");
      const grid = footprint === "3x3" ? 3 : footprint === "compound" ? 3 : 2;
      const material = stringArg(args, "material", "stone");
      const { asset } = pickAsset(context, "foundation", "Foundation");
      const placements = [...draft.placements];
      const usedIds = new Set(placements.map((item) => item.id));
      const origin = { x: 0, z: 0 };
      for (let row = 0; row < grid; row += 1) {
        for (let column = 0; column < grid; column += 1) {
          const position = {
            x: origin.x + (column - (grid - 1) / 2) * 6,
            z: origin.z + (row - (grid - 1) / 2) * 6,
          };
          const placement = createPlacement(asset, placements.length, position);
          placement.id = uniqueId(placement.id, usedIds);
          placement.name = `${material} foundation ${row * grid + column + 1}`;
          placements.push(placement);
        }
      }
      return {
        draft: withPlacements(draft, placements),
        receipt: `Assembled a ${grid}×${grid} ${material} compound.`,
      };
    },
  },
  {
    id: "cave.extrudeSpline",
    label: "Extrude cave tunnel",
    step: "paths",
    apply: (draft, args) => {
      const direction = stringArg(args, "direction", "north");
      const length = Math.min(600, Math.max(10, numberArg(args, "length", 80)));
      const preset = stringArg(args, "preset", "mineshaft");
      const heading: Record<string, { x: number; z: number }> = {
        north: { x: 0, z: -1 },
        south: { x: 0, z: 1 },
        east: { x: 1, z: 0 },
        west: { x: -1, z: 0 },
      };
      const unit = heading[direction] ?? heading.north;
      const start = draft.placements[0]?.position ?? { x: 0, z: 0 };
      const usedSplineIds = new Set(draft.splines.map((item) => item.id));
      const spline = {
        ...createSpline("cave", draft.splines.length),
        id: uniqueId(createSpline("cave", draft.splines.length).id, usedSplineIds),
        name: `${preset} tunnel`,
        width: preset === "sewer" ? 5 : 4.5,
        ceilingHeight: preset === "natural" ? 5.5 : 3.2,
        nodes: [
          { x: Math.round(start.x), y: -6, z: Math.round(start.z) },
          {
            x: Math.round(start.x + unit.x * length * 0.5),
            y: -14,
            z: Math.round(start.z + unit.z * length * 0.5),
          },
          {
            x: Math.round(start.x + unit.x * length),
            y: -4,
            z: Math.round(start.z + unit.z * length),
          },
        ],
      };
      return {
        draft: { ...draft, splines: [...draft.splines, spline] },
        receipt: `Carved a ${length} m ${preset} tunnel heading ${direction}.`,
      };
    },
  },
  {
    id: "skin.applyBase",
    label: "Apply skin base",
    step: "baseItem",
    apply: (draft, args) => {
      const color = stringArg(args, "color", "#141414");
      const raw = stringArg(args, "base", "polymer");
      const preset = (["metal", "polymer", "wood", "carbon"].includes(raw) ? raw : "polymer") as MaterialLayer["preset"];
      const usedLayerIds = new Set(draft.skin.layers.map((item) => item.id));
      const layer: MaterialLayer = {
        id: uniqueId(uid("layer"), usedLayerIds),
        preset,
        name: `${preset} base`,
        baseColor: color,
        textureName: preset === "carbon" ? "carbon_weave" : null,
        blend: "normal",
        scale: 1,
        enabled: true,
        metallic: preset === "metal" ? 0.9 : preset === "carbon" ? 0.4 : 0.1,
        smoothness: preset === "metal" ? 0.7 : 0.3,
      };
      return {
        draft: { ...draft, skin: { ...draft.skin, layers: [...draft.skin.layers, layer] } },
        receipt: `Applied a ${preset} base finish in ${color}.`,
      };
    },
  },
  {
    id: "skin.setLighting",
    label: "Set preview lighting",
    step: "materials",
    apply: (draft, args) => {
      const preset = stringArg(args, "preset", "noon");
      const times: Record<string, number> = { noon: 720, sunset: 1110, midnight: 30, interior: 600 };
      return {
        draft: {
          ...draft,
          lighting: { ...draft.lighting, timeOfDay: times[preset] ?? 720 },
        },
        receipt: `Set preview lighting to ${preset}.`,
      };
    },
  },
];

export function findCommand(id: string): CommandDefinition | undefined {
  return COMMAND_REGISTRY.find((command) => command.id === id);
}

export function commandIds(): string[] {
  return COMMAND_REGISTRY.map((command) => command.id);
}

export function applyCommand(
  command: ParsedCommand,
  draft: WizardDraft,
  context: CommandContext,
): CommandResult & { step: WizardStepId } {
  const definition = findCommand(command.id);
  if (!definition) {
    return { draft, receipt: `Unknown command ${command.id}.`, step: draft.projectKind === "skin" ? "baseItem" : "terrain" };
  }
  try {
    const result = definition.apply(draft, command.args, context);
    return { ...result, step: definition.step };
  } catch (error) {
    return {
      draft,
      receipt: `${definition.label} failed: ${error instanceof Error ? error.message : String(error)}`,
      step: definition.step,
    };
  }
}
