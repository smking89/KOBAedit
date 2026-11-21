import { DEMO_BASE_MESHES, DEMO_PREFABS, type BaseMeshAsset } from "../lib/demoAssets";
import {
  createInitialDraft,
  createMaterialLayer,
  createPlacement,
  createSpline,
  flattenRadiusFromBounds,
} from "../wizard/machine";
import type {
  DecalStamp,
  LootSettings,
  MaterialLayer,
  PrefabPlacement,
  PrefabAsset,
  ProjectKind,
  RouteSpline,
  SplineKind,
  TerrainPreset,
  WizardDraft,
} from "../wizard/types";
import type { ImageProfile, KobaAttachment, KobaGeneration } from "./types";
import { runDeterministicCommand } from "./commands";

const COLOR_WORDS: { words: string[]; hex: string; label: string }[] = [
  { words: ["crimson", "blood red"], hex: "#7f1d1d", label: "Crimson" },
  { words: ["red"], hex: "#b3261e", label: "Red" },
  { words: ["orange", "rust orange"], hex: "#c2611c", label: "Orange" },
  { words: ["gold", "golden"], hex: "#b08a3e", label: "Gold" },
  { words: ["yellow"], hex: "#d6b23a", label: "Yellow" },
  { words: ["olive"], hex: "#556b2f", label: "Olive" },
  { words: ["green", "emerald"], hex: "#3f6b3a", label: "Green" },
  { words: ["cyan", "teal"], hex: "#2aa7a1", label: "Cyan" },
  { words: ["navy"], hex: "#1e3a5f", label: "Navy" },
  { words: ["blue"], hex: "#2f6fb3", label: "Blue" },
  { words: ["purple", "violet"], hex: "#6c4a8f", label: "Purple" },
  { words: ["pink", "magenta"], hex: "#c95c8e", label: "Pink" },
  { words: ["white", "arctic"], hex: "#e8eaed", label: "White" },
  { words: ["black", "matte black"], hex: "#14161a", label: "Black" },
  { words: ["grey", "gray", "silver"], hex: "#8c9196", label: "Grey" },
  { words: ["tan", "sand", "desert"], hex: "#b09a72", label: "Tan" },
  { words: ["rust"], hex: "#8a4b2a", label: "Rust" },
  { words: ["camo", "camouflage"], hex: "#4b5d3a", label: "Camo" },
];

const TERRAIN_LABELS: Record<TerrainPreset, string> = {
  islands: "Island",
  mountains: "Mountain",
  valley: "Valley",
  flat: "Flatland",
  archipelago: "Archipelago",
};

function uid(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) =>
    new RegExp(`(^|[^a-z0-9])${escapeRegex(word)}([^a-z0-9]|$)`).test(lower),
  );
}

function countFor(text: string, nouns: string, fallback: number): number {
  const match = text.match(new RegExp(`(\\d{1,2})\\s+(?:${nouns})\\b`, "i"));
  return match ? clamp(Number.parseInt(match[1], 10), 0, 24) : fallback;
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 1_000_000;
}

function withDefaults(input?: Partial<WizardDraft>): WizardDraft {
  const base = createInitialDraft();
  if (!input) return base;
  return {
    ...base,
    ...input,
    terrain: {
      ...base.terrain,
      ...(input.terrain ?? {}),
      brush: {
        ...base.terrain.brush,
        ...(input.terrain?.brush ?? {}),
        sync: { ...base.terrain.brush.sync, ...(input.terrain?.brush?.sync ?? {}) },
        topologyClearFlags:
          input.terrain?.brush?.topologyClearFlags ?? base.terrain.brush.topologyClearFlags,
      },
      strokes: input.terrain?.strokes ?? [],
      slopeTopology: input.terrain?.slopeTopology ?? [],
      masks: input.terrain?.masks ?? [],
    },
    splines: (input.splines ?? []).map((spline) => ({
      ...spline,
      curve: spline.curve ?? "catmull-rom",
      tension: spline.tension ?? 0.5,
      deformTerrain: spline.deformTerrain ?? true,
      paintSplat: spline.paintSplat ?? true,
      topologyFlag: spline.topologyFlag ?? null,
    })),
    io: {
      nodes: input.io?.nodes ?? [],
      links: input.io?.links ?? [],
      vendingOverrides: input.io?.vendingOverrides ?? [],
    },
    loot: { ...base.loot, ...(input.loot ?? {}) },
    skin: {
      ...base.skin,
      ...(input.skin ?? {}),
      wear: { ...base.skin.wear, ...(input.skin?.wear ?? {}) },
    },
    export: { ...base.export, ...(input.export ?? {}) },
  };
}

function detectKind(text: string, fallback: ProjectKind): ProjectKind {
  const skin = hasAny(text, ["skin", "wrap", "camo", "paint job", "finish", "workshop skin"]);
  if (skin) return "skin";
  if (hasAny(text, ["map", "island", "terrain", "world", "server"])) return "map";
  if (hasAny(text, ["monument", "prefab"])) return "monument";
  return fallback;
}

function detectPreset(text: string, base: TerrainPreset): TerrainPreset {
  if (hasAny(text, ["archipelago"])) return "archipelago";
  if (hasAny(text, ["island", "coastal", "coast", "ocean"])) return "islands";
  if (hasAny(text, ["mountain", "alpine", "snow", "snowy", "arctic", "peak"])) return "mountains";
  if (hasAny(text, ["flat", "desert", "plain", "plains", "barren"])) return "flat";
  if (hasAny(text, ["valley", "canyon", "gorge"])) return "valley";
  return base;
}

function biomeFor(text: string): [number, number, number, number] | null {
  if (hasAny(text, ["snow", "snowy", "arctic", "frozen", "winter"])) return [0.02, 0.08, 0.52, 0.38];
  if (hasAny(text, ["desert", "arid", "sand", "dune", "dry"])) return [0.9, 0.08, 0.02, 0];
  if (hasAny(text, ["forest", "temperate", "green", "woodland", "jungle"]))
    return [0.04, 0.84, 0.1, 0.02];
  if (hasAny(text, ["tundra", "barren", "wasteland"])) return [0.28, 0.12, 0.5, 0.1];
  return null;
}

function biomeFromImage(image?: ImageProfile): [number, number, number, number] | null {
  if (!image) return null;
  const hex = image.dominant.replace("#", "");
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (image.luminance > 0.72 && Math.max(r, g, b) - Math.min(r, g, b) < 35) {
    return [0.02, 0.08, 0.5, 0.4];
  }
  if (r > g * 1.12 && g > b * 1.05) return [0.82, 0.14, 0.04, 0];
  if (g > r * 1.1 && g > b * 1.15) return [0.04, 0.84, 0.1, 0.02];
  return null;
}

function biomeName(weights: [number, number, number, number]): string {
  const names = ["arid", "temperate", "tundra", "arctic"];
  return names[weights.indexOf(Math.max(...weights))];
}

function parseSize(text: string, fallback: number): number {
  const kilometres = text.match(/(\d+(?:\.\d+)?)\s*(?:km|kilomet(?:er|re)s?)\b/i);
  if (kilometres) return clamp(Math.round(Number.parseFloat(kilometres[1]) * 1000), 1000, 6000);
  const metres = text.match(/(\d{3,5})\s*(?:m|met(?:er|re)s?)\b/i);
  if (metres) return clamp(Number.parseInt(metres[1], 10), 1000, 6000);
  return fallback;
}

function quotedName(text: string): string | null {
  const match = text.match(/["“]([^"”]{3,64})["”]/);
  return match ? match[1].trim() : null;
}

function colorMentions(text: string): { hex: string; label: string; at: number }[] {
  const lower = text.toLowerCase();
  const found: { hex: string; label: string; at: number }[] = [];
  for (const match of text.matchAll(/#([0-9a-f]{6})\b/gi)) {
    found.push({
      hex: `#${match[1].toUpperCase()}`,
      label: `#${match[1].toUpperCase()}`,
      at: match.index ?? 0,
    });
  }
  for (const entry of COLOR_WORDS) {
    for (const word of entry.words) {
      const at = lower.indexOf(word);
      if (at >= 0) {
        found.push({ hex: entry.hex, label: entry.label, at });
        break;
      }
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

function darken(hexColor: string, factor: number): string {
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return hexColor;
  const channels = [0, 2, 4].map((offset) =>
    Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * factor),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function pickMesh(text: string, base: WizardDraft): BaseMeshAsset {
  const matches: { pattern: RegExp; index: number }[] = [
    { pattern: /\b(ak|ak47|ak-47)\b/i, index: 0 },
    { pattern: /\b(lr300|lr-300)\b/i, index: 1 },
    { pattern: /\b(bolt|sniper|bolty)\b/i, index: 2 },
    { pattern: /\b(chest|plate|armor|armour)\b/i, index: 3 },
    { pattern: /\b(hoodie|jacket|clothing|shirt)\b/i, index: 4 },
    { pattern: /\b(receiver|rifle|gun|weapon)\b/i, index: 0 },
    { pattern: /\b(door)\b/i, index: 5 },
    { pattern: /\b(cupboard|tc)\b/i, index: 6 },
  ];
  for (const match of matches) {
    if (match.pattern.test(text)) return DEMO_BASE_MESHES[match.index];
  }
  const existing = DEMO_BASE_MESHES.find((mesh) => mesh.id === base.skin.baseMeshId);
  return existing ?? DEMO_BASE_MESHES[0];
}

function decalStamps(text: string, hasImage: boolean): DecalStamp[] {
  const stamps: DecalStamp[] = [];
  if (hasAny(text, ["stripe", "racing"])) stamps.push("stripe");
  if (hasAny(text, ["hazard", "warning", "industrial"])) stamps.push("hazard");
  if (hasAny(text, ["circle", "roundel", "target"])) stamps.push("circle");
  if (hasAny(text, ["number", "serial"])) stamps.push("number");
  if (hasAny(text, ["scratch", "scratched", "battle worn"])) stamps.push("scratch");
  if (hasImage && stamps.length < 2) stamps.push("custom");
  return stamps.length ? stamps.slice(0, 3) : ["hazard"];
}

function attachmentLines(attachments: KobaAttachment[], usedDraft: boolean): string[] {
  const lines: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.image) {
      lines.push(
        `Reference image ${attachment.name}: ${attachment.image.width}x${attachment.image.height}, ` +
          `palette ${attachment.image.dominant} / ${attachment.image.accent}.`,
      );
    } else if (attachment.kind === "zip" && attachment.zip) {
      const { entries, mapFiles, prefabFiles, projectDraft } = attachment.zip;
      lines.push(
        `Archive ${attachment.name}: ${entries} files, ${mapFiles.length} maps, ${prefabFiles.length} prefabs.`,
      );
      if (projectDraft && usedDraft) {
        lines.push(`Restored the saved "${projectDraft.name}" draft and applied the prompt on top.`);
      }
      if (attachment.image) {
        lines.push(`Palette sampled from the archive preview: ${attachment.image.dominant} / ${attachment.image.accent}.`);
      }
    }
  }
  return lines;
}

function worldLoot(
  base: LootSettings,
  text: string,
  placements: PrefabPlacement[],
): LootSettings {
  const tier: 1 | 2 | 3 = hasAny(text, ["hardcore", "tier 3", "tier three", "endgame"])
    ? 3
    : hasAny(text, ["easy", "tier 1", "tier one", "starter"])
      ? 1
      : 2;
  const crateCount = countFor(text, "crates?", 8 + placements.length * 3 + tier * 4);
  const vendingMachines = countFor(text, "vending machines?", Math.max(2, placements.length));
  const npcSpawners = countFor(text, "npcs?|npcs? spawners?", 4 + placements.length + tier);
  return {
    ...base,
    tier,
    crateCount,
    vendingMachines,
    npcSpawners,
    cardPuzzles: tier === 3 ? 3 : 2,
    radiationZones: hasAny(text, ["radiation", "hazard", "toxic"]) ? 2 : 0,
    noBuildZones: placements.length,
    lootDensity: tier === 3 ? 1.25 : tier === 2 ? 1 : 0.8,
    cardLevels: [true, tier >= 2, tier >= 3],
  };
}

function makeSplines(text: string, kind: ProjectKind, size: number, hasWater: boolean): RouteSpline[] {
  if (kind === "monument") return [];
  const noRoads = hasAny(text, ["no roads", "without roads"]);
  const roads = noRoads ? 0 : countFor(text, "roads?|highways?", 2);
  const rivers = countFor(text, "rivers?", hasWater ? 1 : 0);
  const rails = countFor(text, "rails?|railways?", 0);
  const splines: RouteSpline[] = [];
  const half = size / 2;

  const build = (splineKind: SplineKind, index: number, total: number) => {
    const spline = createSpline(splineKind, index);
    const lane = (index - (total - 1) / 2) * size * 0.07;
    spline.name = `${splineKind === "road" ? "Road" : splineKind === "river" ? "River" : "Rail"} ${index + 1}`;
    spline.width = splineKind === "river" ? 26 : splineKind === "road" ? 10 + index * 2 : 7;
    spline.closed = false;
    spline.autoRoute = true;
    spline.nodes = [
      { x: -half * 0.72, y: 0, z: -half * 0.34 + lane },
      { x: -half * 0.24, y: 0, z: -half * 0.08 + lane },
      { x: half * 0.2, y: 0, z: half * 0.2 + lane * 0.6 },
      { x: half * 0.7, y: 0, z: half * 0.44 + lane },
    ];
    splines.push(spline);
  };

  for (let index = 0; index < roads; index += 1) build("road", index, Math.max(1, roads));
  for (let index = 0; index < rivers; index += 1) build("river", index, Math.max(1, rivers));
  for (let index = 0; index < rails; index += 1) build("rail", index, Math.max(1, rails));
  return splines;
}

function generateWorld(
  base: WizardDraft,
  text: string,
  kind: ProjectKind,
  image: ImageProfile | undefined,
  attachments: KobaAttachment[],
  usedDraft: boolean,
): KobaGeneration {
  const preset = detectPreset(text, base.terrain.preset);
  const size = parseSize(text, base.terrain.sizeMetres);
  const weights =
    biomeFor(text) ?? biomeFromImage(image) ?? base.terrain.biomeWeights;
  const water = hasAny(text, ["no water", "dry", "desert"])
    ? -60
    : hasAny(text, ["flood", "flooded"])
      ? 18
      : hasAny(text, ["coast", "island", "ocean", "lake", "river", "water"])
        ? 0
        : base.terrain.waterLevel;
  const mountains = hasAny(text, ["mountain", "alpine", "snow", "snowy", "peak"])
    ? 1.45
    : preset === "flat"
      ? 0.2
      : preset === "valley"
        ? 0.85
        : 1;
  const treeDensity = hasAny(text, ["forest", "jungle", "woodland"])
    ? 0.95
    : hasAny(text, ["desert", "arid", "barren"])
      ? 0.08
      : hasAny(text, ["snow", "snowy", "arctic"])
        ? 0.3
        : base.terrain.treeDensity;

  const monuments = DEMO_PREFABS.filter((asset) => asset.category === "Monument");
  const preferred = monuments.filter((asset) =>
    text.toLowerCase().includes(asset.name.toLowerCase().replace(/^the\s+/, "")),
  );
  const ordered = [...preferred, ...monuments.filter((asset) => !preferred.includes(asset))];
  const count = kind === "monument" ? 1 : clamp(countFor(text, "monuments?|prefabs?|towns?|villages?|sites?", 6), 1, 18);
  const tier: 1 | 2 | 3 = hasAny(text, ["hardcore", "tier 3", "tier three", "endgame"])
    ? 3
    : hasAny(text, ["easy", "tier 1", "tier one", "starter"])
      ? 1
      : 2;
  const radius = size * 0.27;
  const placements: PrefabPlacement[] = Array.from({ length: count }, (_, index) => {
    const asset = ordered[index % ordered.length];
    const placement = createPlacement(asset, index);
    const cycle = Math.floor(index / ordered.length);
    const angle = index * 2.399963 + 0.4;
    placement.name = cycle > 0 ? `${asset.name} ${cycle + 1}` : asset.name;
    placement.position =
      kind === "monument"
        ? { x: 0, y: 0, z: 0 }
        : {
            x: Math.round(Math.cos(angle) * radius * (0.55 + (index % 3) * 0.18)),
            y: 0,
            z: Math.round(Math.sin(angle) * radius * (0.55 + ((index + 1) % 3) * 0.18)),
          };
    placement.rotationEuler = { x: 0, y: (index * 37) % 360, z: 0 };
    placement.flatten = true;
    placement.flattenRadius = asset.flattenRadius || flattenRadiusFromBounds(asset.bounds, 80);
    placement.flattenFalloff = Math.max(8, Math.round(placement.flattenRadius * 0.18));
    placement.clearFoliage = true;
    placement.noBuildZone = true;
    placement.lootTier = tier;
    placement.lootProfile = tier === 3 ? "tier-3-elite" : tier === 2 ? "tier-2-standard" : "tier-1-basic";
    placement.ioWiring = asset.hasIO ? "Auto IO" : "";
    placement.npcCount = asset.hasNpc ? (tier === 3 ? 6 : tier === 2 ? 3 : 1) : 0;
    return placement;
  });

  const splines = makeSplines(text, kind, size, water > -10);
  const loot = worldLoot(base.loot, text, placements);
  const presetLabel = TERRAIN_LABELS[preset];
  const primaryAsset = ordered[0]?.name ?? "Monument";
  const name =
    quotedName(text) ||
    (kind === "monument"
      ? `KOBA ${preferred[0]?.name ?? primaryAsset} Monument`
      : `KOBA ${presetLabel} ${hasAny(text, ["snow", "snowy", "arctic"]) ? "Snow" : ""} Map`.replace(/\s+/g, " ").trim());

  const draft = withDefaults({
    ...base,
    name,
    projectKind: kind,
    branch: "world",
    terrain: {
      ...base.terrain,
      seed: seedFrom(text) || base.terrain.seed,
      preset,
      sizeMetres: size,
      mountainScale: mountains,
      waterLevel: water,
      treeDensity,
      biomeWeights: weights,
      sculptStrokes: 0,
    },
    placements,
    selectedPlacementId: placements[0]?.id ?? null,
    splines,
    loot,
    export: {
      ...base.export,
      fileName: slug(name) || "koba-build",
      mapLock: false,
      mapPassword: "",
    },
  });

  const lines = attachmentLines(attachments, usedDraft);
  lines.push(
    `Terrain: ${preset} preset, ${size} m, ${biomeName(weights)} biome, water ${water} m.`,
    `${placements.length} ${kind === "monument" ? "monument prefab" : "landmarks"} placed with flatten pads, foliage clearing and no-build zones.`,
    splines.length
      ? `${splines.length} route splines: ${splines.map((spline) => `${spline.name} (${spline.width} m)`).join(", ")}.`
      : "No routes generated for this build.",
    `Loot tier ${loot.tier}: ${loot.crateCount} crates, ${loot.vendingMachines} vending machines, ${loot.npcSpawners} NPC spawns.`,
    `Export target: ${draft.export.fileName}.${kind === "monument" ? "prefab" : "map"}.`,
  );

  return {
    draft,
    kind: kind === "monument" ? "monument" : "map",
    step: "validate",
    name,
    summary: lines,
    chips: [
      { label: `${placements.length} prefabs`, prompt: `generate ${size / 1000}k ${preset} with ${placements.length} monuments` },
      { label: `${splines.length} routes`, prompt: `generate ${size / 1000}k ${preset} with ${Math.max(1, splines.length)} roads` },
      { label: `Tier ${loot.tier}`, prompt: `generate ${size / 1000}k ${preset} with tier ${loot.tier} loot` },
    ],
  };
}

function generateSkin(
  base: WizardDraft,
  text: string,
  image: ImageProfile | undefined,
  attachments: KobaAttachment[],
  usedDraft: boolean,
): KobaGeneration {
  const mesh = pickMesh(text, base);
  const mentions = colorMentions(text);
  const primary = mentions[0]?.hex ?? image?.dominant ?? "#3f4a52";
  const accent = mentions[1]?.hex ?? image?.accent ?? (mentions[0] ? darken(mentions[0].hex, 0.45) : "#b3261e");
  const style = mentions.map((mention) => mention.label).join(" and ") || "Custom";
  const basePreset: MaterialLayer["preset"] =
    mesh.itemKind === "weapon"
      ? "metal"
      : /door|cupboard|wood/i.test(mesh.name)
        ? "wood"
        : mesh.itemKind === "attire"
          ? "custom"
          : "metal";
  const baseLayer = createMaterialLayer(basePreset, 0);
  baseLayer.name = "Base finish";
  baseLayer.baseColor = primary;
  baseLayer.metallic = mesh.itemKind === "weapon" ? 0.82 : 0.1;
  baseLayer.smoothness = mesh.itemKind === "weapon" ? 0.44 : 0.22;

  const accentLayer = createMaterialLayer("carbon", 1);
  accentLayer.name = "Accent";
  accentLayer.baseColor = accent;
  accentLayer.metallic = 0.35;
  accentLayer.smoothness = 0.62;
  accentLayer.blend = "overlay";

  const grungeLayer = createMaterialLayer("polymer", 2);
  grungeLayer.name = "Grunge";
  grungeLayer.baseColor = darken(primary, 0.5);
  grungeLayer.metallic = 0.1;
  grungeLayer.smoothness = 0.18;
  grungeLayer.blend = "multiply";

  const heavy = hasAny(text, ["heavy", "battle", "rusted", "rust", "worn", "scratched"]);
  const pristine = hasAny(text, ["pristine", "factory", "clean", "new"]);
  const wearLevel = pristine ? 0.06 : heavy ? 0.82 : 0.38;
  const stamps = decalStamps(text, Boolean(image));
  const decals = stamps.map((stamp, index) => ({
    id: uid("decal"),
    stamp,
    mode: "projected" as const,
    color: stamp === "scratch" ? "#cfd6dd" : accent,
    size: 120 + index * 55,
    opacity: 0.8,
    rotation: index * 18,
    uvAnchor: null,
  }));
  const emission = hasAny(text, ["neon", "glow", "emissive"]) ? 2.4 : 0;
  const lighting = hasAny(text, ["night", "dark"])
    ? "night"
    : hasAny(text, ["dusk", "sunset"])
      ? "dusk"
      : hasAny(text, ["flashlight", "tactical"])
        ? "flashlight"
        : "day";
  const resolution = hasAny(text, ["1024", "1k"]) ? 1024 : 2048;
  const name =
    quotedName(text) ||
    `KOBA ${style} ${mesh.name} Skin`.replace(/\s+/g, " ").trim();

  const draft = withDefaults({
    ...base,
    name,
    projectKind: "skin",
    branch: "skin",
    placements: [],
    splines: [],
    selectedPlacementId: null,
    skin: {
      ...base.skin,
      baseMeshId: mesh.id,
      baseMeshName: mesh.name,
      uvChannels: mesh.uvChannels,
      resolution,
      layers: [baseLayer, accentLayer, grungeLayer],
      decals,
      paintStrokes: decals.length,
      wear: {
        edgeWear: wearLevel,
        grunge: heavy ? 0.72 : 0.24,
        dirt: heavy ? 0.55 : 0.16,
        scratches: heavy ? 0.78 : 0.3,
        emissionStrength: emission,
        lighting,
        showSeams: false,
      },
      smartProjection: true,
    },
    export: {
      ...base.export,
      fileName: slug(name) || "koba-skin",
      workshopTags: [mesh.itemKind === "weapon" ? "Weapon" : mesh.itemKind === "attire" ? "Attire" : "Deployable", style],
      includeEmission: emission > 0,
    },
  });

  const lines = attachmentLines(attachments, usedDraft);
  lines.push(
    `Base item: ${mesh.name} (${mesh.triangles.toLocaleString()} tris, ${mesh.materialSlots.length} material slots).`,
    `Palette: ${primary} base, ${accent} accent${image ? " sampled from the attached reference" : ""}.`,
    `Material stack: base finish, accent overlay and grunge multiply at ${resolution} px.`,
    `${decals.length} projected ${decals.map((decal) => decal.stamp).join(", ")} decal(s); wear ${Math.round(wearLevel * 100)} percent.`,
    `Lighting check: ${lighting}${emission ? " with emission" : ""}; export ${draft.export.fileName}.zip.`,
  );

  return {
    draft,
    kind: "skin",
    step: "workshop",
    name,
    summary: lines,
    chips: [
      { label: primary, prompt: `apply ${primary} base with ${accent} trim on ${mesh.name.toLowerCase()}` },
      { label: `${Math.round(wearLevel * 100)}% wear`, prompt: `set wear ${wearLevel.toFixed(2)}` },
      { label: resolution === 1024 ? "1K" : "2K", prompt: `apply ${style} finish at ${resolution}` },
    ],
  };
}

export function generateProject(
  prompt: string,
  attachments: KobaAttachment[],
  current: WizardDraft,
  catalog: PrefabAsset[] = [],
): KobaGeneration {
  const text = prompt.trim() || "Build a balanced Rust project from the attached references.";
  const command = runDeterministicCommand(text, current, catalog);
  if (command) return command;
  const archiveDraft = attachments.find((attachment) => attachment.zip?.projectDraft)?.zip?.projectDraft;
  const kind = detectKind(text, archiveDraft?.projectKind ?? current.projectKind);
  const usableDraft = archiveDraft?.projectKind === kind ? archiveDraft : undefined;
  const base = withDefaults(
    usableDraft ?? (current.projectKind === kind ? current : undefined),
  );
  const image = attachments.find((attachment) => attachment.image)?.image;

  const result =
    kind === "skin"
      ? generateSkin(base, text, image, attachments, Boolean(usableDraft))
      : generateWorld(base, text, kind, image, attachments, Boolean(usableDraft));

  return {
    ...result,
    draft: {
      ...result.draft,
      name: result.name,
      export: { ...result.draft.export, fileName: result.draft.export.fileName || slug(result.name) },
    },
  };
}
