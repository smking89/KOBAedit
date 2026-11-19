import { DEMO_PREFABS } from "../lib/demoAssets";
import { sampleSplineNodes } from "../lib/splineMath";
import {
  createIONode,
  createIOLink,
  createPlacement,
  flattenRadiusFromBounds,
} from "../wizard/machine";
import type {
  IOLink,
  IOComponentKind,
  PrefabAsset,
  PrefabPlacement,
  TopologyFlag,
  WizardDraft,
  WizardStepId,
} from "../wizard/types";
import type { KobaGeneration } from "./types";

export interface CommandChip {
  label: string;
  prompt: string;
}

export interface DeterministicCommand extends KobaGeneration {
  chips?: CommandChip[];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function title(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

function result(
  draft: WizardDraft,
  step: WizardStepId,
  summary: string[],
  chips: CommandChip[] = [],
): DeterministicCommand {
  return {
    draft,
    kind: draft.projectKind === "skin" ? "skin" : draft.projectKind,
    step,
    name: draft.name,
    summary,
    chips,
  };
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_#.]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function chooseAsset(
  phrase: string,
  catalog: PrefabAsset[],
  fallbackKind: PrefabAsset["category"] = "Entity",
): PrefabAsset {
  const needles = words(phrase).filter(
    (word) => !["the", "along", "with", "into", "onto", "some", "each"].includes(word),
  );
  let best: { score: number; asset: PrefabAsset } | null = null;
  for (const asset of catalog) {
    const haystack = `${asset.name} ${asset.id} ${asset.category}`.toLowerCase();
    const score = needles.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { score, asset };
  }
  if (best) return best.asset;
  const label = title(needles.join(" ")) || "Custom Prefab";
  return {
    id: `assets/bundled/prefabs/autospawn/${fallbackKind.toLowerCase()}/${slug(label) || "custom"}.prefab`,
    name: label,
    category: fallbackKind,
    bounds: { min: [-2, -1, -2], max: [2, 3, 2] },
    flattenRadius: 8,
    hasLoot: false,
    hasIO: false,
    hasNpc: false,
  };
}

function placeAlongRoute(
  draft: WizardDraft,
  phrase: string,
  count: number,
  routeName: string,
  catalog: PrefabAsset[],
): { placements: PrefabPlacement[]; splineName: string } | null {
  const target = routeName.toLowerCase().replace(/[\s_-]+/g, "");
  const spline =
    draft.splines.find((entry) => entry.name.toLowerCase().replace(/[\s_-]+/g, "").includes(target)) ??
    draft.splines.find((entry) => entry.kind === "road") ??
    draft.splines[0];
  if (!spline || spline.nodes.length < 2) return null;
  const asset = chooseAsset(phrase, catalog.length ? catalog : DEMO_PREFABS);
  const points = sampleSplineNodes(spline.nodes, spline.closed, spline.curve, 16);
  const placements: PrefabPlacement[] = [];
  for (let index = 0; index < count; index += 1) {
    const fraction = (index + 1) / (count + 1);
    const point = points[Math.min(points.length - 1, Math.round(fraction * (points.length - 1)))];
    if (!point) continue;
    const placement = createPlacement(asset, index);
    placement.name = `${asset.name} ${index + 1}`;
    placement.position = { x: Math.round(point.x), y: 0, z: Math.round(point.z) };
    placement.rotationEuler = { x: 0, y: Math.round((index * 360) / Math.max(1, count)), z: 0 };
    placement.flatten = true;
    placement.flattenRadius = asset.flattenRadius || flattenRadiusFromBounds(asset.bounds, 12);
    placement.flattenFalloff = Math.max(6, Math.round(placement.flattenRadius * 0.2));
    placement.clearFoliage = true;
    placement.noBuildZone = asset.category === "Monument" || asset.category === "Building";
    placements.push(placement);
  }
  return placements.length ? { placements, splineName: spline.name } : null;
}

const IO_WORDS: { pattern: RegExp; kind: IOComponentKind }[] = [
  { pattern: /card\s*reader|keycard\s*reader|key\s*card/, kind: "card_reader" },
  { pattern: /switch|button|lever/, kind: "switch" },
  { pattern: /generator|power/, kind: "generator" },
  { pattern: /timer/, kind: "timer" },
  { pattern: /light|lamp/, kind: "light" },
  { pattern: /vending/, kind: "vending_machine" },
  { pattern: /door|gate/, kind: "door" },
];

function ioKind(value: string): IOComponentKind | null {
  return IO_WORDS.find((entry) => entry.pattern.test(value))?.kind ?? null;
}

function wireNodes(draft: WizardDraft, text: string): DeterministicCommand | null {
  const match = text.match(
    /\bwire\s+(?:(green|blue|red)\s+)?(card\s*reader|keycard\s*reader|switch|button|lever|generator|timer|light|lamp)\s+(?:to|into)\s+(?:the\s+)?([a-z0-9 _-]+)/i,
  );
  if (!match) return null;
  const fromKind = ioKind(match[2]);
  const toKind = ioKind(match[3]) ?? "door";
  if (!fromKind) return null;
  const io = draft.io ?? { nodes: [], links: [], vendingOverrides: [] };
  const nodes = [...io.nodes];
  const links = [...io.links];
  const existingTarget = nodes.find((node) => node.kind === toKind);
  const from = createIONode(fromKind, nodes.length);
  const to = existingTarget ?? createIONode(toKind, nodes.length + 1);
  const cardLevel = (match[1]?.toLowerCase() as IOLink["cardLevel"]) ?? (fromKind === "card_reader" ? "green" : null);
  from.cardLevel = cardLevel;
  from.name = `${fromKind === "card_reader" ? "Card reader" : title(fromKind.replace("_", " "))} ${nodes.length + 1}`;
  if (!existingTarget) {
    to.name = `${title(toKind.replace("_", " "))} ${nodes.length + 2}`;
    nodes.push(to);
  }
  nodes.push(from);
  links.push(createIOLink(from.id, to.id, cardLevel));
  const next: WizardDraft = {
    ...draft,
    io: { ...io, nodes, links },
  };
  return result(
    next,
    "loot",
    [
      `Wired ${from.name} -> ${to.name}${cardLevel ? ` with a ${cardLevel} card level` : ""}.`,
      `${links.length} IO link(s) are serialized into the RustEdit metadata layer.`,
    ],
    [
      { label: cardLevel ? `${cardLevel} card` : "No card", prompt: "wire blue card reader to door_01" },
      { label: "Add switch", prompt: "wire switch to door_01" },
    ],
  );
}

/**
 * Deterministic grammar for commands that edit the current project rather than
 * regenerating it. No model, network call or randomness beyond local ids.
 */
export function runDeterministicCommand(
  prompt: string,
  draft: WizardDraft,
  catalog: PrefabAsset[] = [],
): DeterministicCommand | null {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  if (/\b(exit|leave|stop)\s+walk\s*mode\b/.test(lower)) {
    return result({ ...draft, walkMode: false }, "terrain", ["Walk mode disabled. Orbit camera restored."]);
  }
  if (/\b(enter|start|toggle|open|use)\s+walk\s*mode\b|\bwalk\s*mode\b/.test(lower) && !/\block|\bmap\b/.test(lower)) {
    if (draft.projectKind === "skin") {
      return result(draft, "workshop", ["Walk mode is only available for map and monument projects."]);
    }
    return result(
      { ...draft, walkMode: true, branch: "world" },
      "terrain",
      [
        "Walk mode enabled at the selected prefab (or map centre).",
        "WASD walk, Shift sprint, Ctrl crouch, Space jump, mouse look. Escape releases the cursor.",
      ],
      [{ label: "Exit walk", prompt: "exit walk mode" }],
    );
  }
  if (/\bunlock\s+(the\s+)?map\b/.test(lower)) {
    return result(
      { ...draft, export: { ...draft.export, mapLock: false, mapPassword: "" } },
      "validate",
      ["Map lock removed. The next export writes an unprotected map."],
    );
  }
  const lock = text.match(
    /\b(?:lock|protect)\s+(?:the\s+)?map(?:\s+with\s+(?:password\s+)?["']?([^\s"']{6,})["']?)?/i,
  );
  if (lock) {
    const password = lock[1] || draft.export.mapPassword;
    if (password.length < 6) {
      return result(
        { ...draft, export: { ...draft.export, mapLock: true } },
        "validate",
        ["Map lock enabled. Enter a password of at least 6 characters in Validate and Export."],
        [{ label: "Set password", prompt: "lock map with password koba-local" }],
      );
    }
    return result(
      { ...draft, export: { ...draft.export, mapLock: true, mapPassword: password } },
      "validate",
      ["Map lock enabled. The exporter writes a PBKDF2 lock layer and a .map.lock sidecar; the password is never written."],
      [{ label: "Unlock map", prompt: "unlock map" }],
    );
  }

  const slope = text.match(
    /\bpaint\s+(.+?)\s+topology\s+(?:on\s+)?slopes?\s*(?:>|above|over|greater than)\s*(\d{1,2})/i,
  );
  if (slope) {
    const threshold = Math.max(0, Math.min(89, Number.parseInt(slope[2], 10)));
    const label = slope[1].toLowerCase();
    const flags: TopologyFlag[] = label.includes("cliff") || label.includes("rock")
      ? ["no_build", "foliage_cleared"]
      : ["no_build"];
    const rule = {
      id: `slope-${threshold}-${draft.terrain.slopeTopology.length}`,
      minSlope: threshold,
      maxSlope: 89,
      flags,
    };
    return result(
      {
        ...draft,
        terrain: {
          ...draft.terrain,
          slopeTopology: [...draft.terrain.slopeTopology, rule],
        },
      },
      "terrain",
      [
        `Added a ${threshold} degree slope rule: ${flags.join(", ")}.`,
        "The preview and exporter stamp the topology mask from the terrain gradient.",
      ],
      [
        { label: `${threshold} deg`, prompt: `paint cliff topology on slopes > ${threshold}` },
        { label: "35 deg", prompt: "paint cliff topology on slopes > 35" },
      ],
    );
  }

  const place = text.match(/\bplace\s+(\d{1,2})\s+(.+?)\s+(?:along|on)\s+(.+)$/i);
  if (place) {
    const count = Math.max(1, Math.min(32, Number.parseInt(place[1], 10)));
    const placed = placeAlongRoute(draft, place[2], count, place[3], catalog);
    if (placed) {
      const placements = [...draft.placements, ...placed.placements];
      return result(
        { ...draft, placements, selectedPlacementId: placed.placements.at(-1)?.id ?? draft.selectedPlacementId },
        "monuments",
        [
          `Placed ${placed.placements.length} prefab(s) along ${placed.splineName}.`,
          "Each placement received an automatic flatten pad, foliage clearing and category splat/topology blending.",
        ],
        [
          { label: `${count} units`, prompt: `place ${count} ${place[2]} along ${place[3]}` },
          { label: placed.splineName, prompt: `place ${count} ${place[2]} along ${placed.splineName}` },
        ],
      );
    }
  }

  const wire = wireNodes(draft, text);
  if (wire) return wire;

  const wear = text.match(/\bset\s+wear\s+(?:to\s+)?(\d*\.?\d+)/i);
  if (wear && draft.projectKind === "skin") {
    const value = Math.max(0, Math.min(1, Number.parseFloat(wear[1])));
    return result(
      {
        ...draft,
        skin: {
          ...draft.skin,
          wear: { ...draft.skin.wear, edgeWear: value, grunge: value * 0.7, scratches: value * 0.9 },
        },
      },
      "wear",
      [`Wear set to ${Math.round(value * 100)} percent edge wear, ${Math.round(value * 70)} grunge and ${Math.round(value * 90)} scratches.`],
      [{ label: "35% wear", prompt: "set wear 0.35" }],
    );
  }

  return null;
}
