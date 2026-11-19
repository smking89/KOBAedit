/**
 * Pure wizard state machine.
 *
 * No React, no side effects: `wizardReducer` maps (state, event) -> state, and
 * `validateDraft` derives blocking errors from the draft. Steps read validation
 * through `issuesForStep`; the reducer refuses to advance past a step with
 * blocking issues, so the UI cannot get into an invalid exported state.
 */

import { collisionExtents } from "../lib/collision";
import {
  collisionFromBounds,
  createPlacement,
  createSpline,
  flattenRadiusFromBounds,
} from "../lib/factories";
import { connectorTarget } from "../lib/splineMath";
import { createLayer, layerKindForStroke, plannedStrokes } from "../lib/layers";
import type {
  Bounds3,
  Branch,
  DecalStroke,
  LightingSettings,
  IOComponentKind,
  IOLink,
  IONode,
  LootSettings,
  MaterialLayer,
  PrefabAsset,
  PrefabPlacement,
  ProjectKind,
  RouteSpline,
  SkinSettings,
  SkinStepId,
  SplineKind,
  TerrainLayer,
  TerrainLayerKind,
  TerrainSettings,
  TerrainStroke,
  ValidationIssue,
  VendingOverride,
  WizardDraft,
  WizardState,
  WizardStepId,
  WorldStepId,
} from "./types";

export const WORLD_STEPS: WorldStepId[] = [
  "entry",
  "terrain",
  "monuments",
  "paths",
  "loot",
  "validate",
];

export const SKIN_STEPS: SkinStepId[] = [
  "entry",
  "baseItem",
  "materials",
  "paint",
  "wear",
  "workshop",
];

export const STEP_META: Record<WizardStepId, import("./types").StepMeta> = {
  entry: {
    id: "entry",
    label: "Project",
    title: "Project setup",
    description: "Choose offline or online, then pick a map, monument or skin project.",
    branch: "world",
    studioTools: [],
  },
  terrain: {
    id: "terrain",
    label: "Terrain",
    title: "Terrain generation",
    description: "Seed the heightmap, set the water line, and paint biomes or splat layers.",
    branch: "world",
    studioTools: [
      "Raise / lower / smooth / flatten brushes",
      "Manual splat, biome, alpha and topology painting",
      "Heightmap import and raw layer inspection",
    ],
  },
  monuments: {
    id: "monuments",
    label: "Monuments",
    title: "Monuments and prefabs",
    description: "Place prefabs with automatic flattening, edge falloff and foliage clearing.",
    branch: "world",
    studioTools: [
      "Full prefab hierarchy outliner",
      "Transform gizmos and numeric transforms",
      "Collider, radiation and no-build visualizers",
    ],
  },
  paths: {
    id: "paths",
    label: "Paths",
    title: "Roads, rivers and routes",
    description: "Draw splines for roads, rivers, rails, APC routes and cargo paths.",
    branch: "world",
    studioTools: [
      "Per-node spline editing and auto-routing",
      "Width, padding, fade and topology masks",
      "Terrain conforming and mesh offsets",
    ],
  },
  loot: {
    id: "loot",
    label: "Loot and IO",
    title: "Loot, IO and NPCs",
    description: "Set difficulty tiers for crates, vending machines, card puzzles and NPCs.",
    branch: "world",
    studioTools: [
      "IO wiring graph and power routing",
      "Per-entity loot and vending profiles",
      "NPC spawn densities and radiation zones",
    ],
  },
  validate: {
    id: "validate",
    label: "Validate",
    title: "Validate and export",
    description: "Check collisions, no-build zones and topology, then write a server-ready file.",
    branch: "world",
    studioTools: [
      "Raw topology and alpha masks",
      "Map lock and password serialization",
      "RustEdit metadata preservation",
    ],
  },
  baseItem: {
    id: "baseItem",
    label: "Base item",
    title: "Base item and UVs",
    description: "Load a local Rust base mesh and confirm its UV layout.",
    branch: "skin",
    studioTools: ["UV channel inspection", "Custom mesh import", "Mesh statistics and bounds"],
  },
  materials: {
    id: "materials",
    label: "Materials",
    title: "Materials and layers",
    description: "Stack procedural smart materials and custom textures.",
    branch: "skin",
    studioTools: ["Layer reorder and blend modes", "Texture channel overrides", "Material parameter export"],
  },
  paint: {
    id: "paint",
    label: "Paint",
    title: "Projection and painting",
    description: "Project decals onto the mesh and paint in 2D or 3D without UV seams.",
    branch: "skin",
    studioTools: ["Camera-aligned decal projection", "UV-space 2D brush", "Triplanar 3D brush"],
  },
  wear: {
    id: "wear",
    label: "Wear",
    title: "Wear and lighting",
    description: "Add edge wear and grime, then check the skin under four lighting setups.",
    branch: "skin",
    studioTools: ["Procedural edge mask", "Grunge and dirt layers", "Emission and flashlight checks"],
  },
  workshop: {
    id: "workshop",
    label: "Export",
    title: "Workshop export",
    description: "Pack diffuse, normal, specular and emission maps at Rust resolutions.",
    branch: "skin",
    studioTools: ["Channel packing preview", "Custom output naming", "Texture validation report"],
  },
};

function uid(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

export { collisionFromBounds, createPlacement, createSpline, flattenRadiusFromBounds };

export function branchFor(kind: ProjectKind): Branch {
  return kind === "skin" ? "skin" : "world";
}

export function stepsFor(kind: ProjectKind): WizardStepId[] {
  return kind === "skin" ? SKIN_STEPS : WORLD_STEPS;
}


export function createInitialDraft(): WizardDraft {
  return {
    projectId: uid("project"),
    name: "Untitled project",
    mode: "offline",
    projectKind: "map",
    branch: "world",
    syncEndpoint: "",
    studioMode: false,
    walkMode: false,
    lighting: { timeOfDay: 10 * 60 + 30, weather: "clear" },
    terrain: {
      seed: 1337,
      preset: "islands",
      sizeMetres: 4500,
      mountainScale: 1,
      waterLevel: -8,
      detail: 0.55,
      treeDensity: 0.7,
      biomeWeights: [0.15, 0.65, 0.15, 0.05],
      brush: {
        mode: "raise",
        radius: 60,
        strength: 2,
        falloff: 2,
        splatChannel: "grass",
        biomeChannel: "temperate",
        topologyFlags: ["no_build"],
        topologyClearFlags: ["foliage_cleared"],
        sync: { height: false, splat: false, biome: false, topology: false, alpha: false },
      },
      sculptStrokes: 0,
      strokes: [],
      layers: [],
      activeLayerId: null,
      slopeTopology: [],
      masks: [],
    },
    placements: [],
    selectedPlacementId: null,
    splines: [],
    io: { nodes: [], links: [], vendingOverrides: [] },
    loot: {
      tier: 2,
      crateCount: 24,
      vendingMachines: 6,
      cardPuzzles: 2,
      npcSpawners: 8,
      radiationZones: 0,
      noBuildZones: 0,
      lootDensity: 1,
      cardLevels: [true, true, false],
    },
    skin: {
      baseMeshId: null,
      baseMeshName: "",
      uvChannels: 1,
      resolution: 2048,
      layers: [],
      decals: [],
      wear: {
        edgeWear: 0.35,
        grunge: 0.2,
        dirt: 0.15,
        scratches: 0.25,
        emissionStrength: 0,
        lighting: "day",
        showSeams: false,
      },
      paintStrokes: 0,
      smartProjection: true,
    },
    export: {
      fileName: "untitled",
      outputDir: "",
      stripEditorData: true,
      mapPassword: "",
      mapLock: false,
      workshopTags: ["Skin", "Weapon"],
      includeEmission: true,
    },
  };
}

export function initialState(draft: WizardDraft = createInitialDraft()): WizardState {
  return {
    draft,
    stepId: "entry",
    furthestIndex: 0,
    dirty: false,
    lastSavedAt: null,
    exportReport: null,
  };
}

// ---------------------------------------------------------------------------
// Placement / spline factories
// ---------------------------------------------------------------------------

/**
 * A road from a prefab entrance to the closest existing road node (or the
 * nearest map edge when no road exists yet). The spline carries the same
 * corridor deformation and gravel paint the Paths step uses, so the connector
 * is flattened and textured without extra work.
 */
export const CONNECTOR_PREFIX = "Road to ";

export function createConnectorSpline(
  placement: PrefabPlacement,
  splines: RouteSpline[],
  index: number,
  sizeMetres: number,
): RouteSpline | null {
  const inset = Math.max(4, sizeMetres / 2 - 40);
  const clearance = Math.max(12, placement.collisionRadius, placement.flattenRadius * 0.6);
  // Only ordinary roads are targets: rivers, rails, route splines and the
  // connectors generated for other prefabs are not a road network, and
  // chaining onto another connector produced roads that join mid-stub.
  const roads = splines.filter(
    (spline) => spline.kind === "road" && !spline.name.startsWith(CONNECTOR_PREFIX),
  );
  const target = connectorTarget(roads, placement.position, clearance, inset);
  // Already touching the road, or no usable target: no stub is needed.
  if (!target) return null;

  const dx = target.x - placement.position.x;
  const dz = target.z - placement.position.z;
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length;
  const uz = dz / length;
  const start = {
    x: placement.position.x + ux * clearance,
    z: placement.position.z + uz * clearance,
  };
  // Pressing the button twice must not stack two identical stubs.
  const existing = splines.find(
    (spline) => spline.kind === "road" && spline.name === `${CONNECTOR_PREFIX}${placement.name}`,
  );
  const existingEnd = existing?.nodes[existing.nodes.length - 1];
  if (existingEnd && Math.hypot(existingEnd.x - target.x, existingEnd.z - target.z) < 2) {
    return null;
  }
  const bow = Math.min(50, Math.max(6, length * 0.1));
  const middle = {
    x: (start.x + target.x) / 2 - uz * bow,
    z: (start.z + target.z) / 2 + ux * bow,
  };
  const spline = createSpline("road", index);
  return {
    ...spline,
    name: `${CONNECTOR_PREFIX}${placement.name}`,
    width: 8,
    deformTerrain: true,
    paintSplat: true,
    topologyFlag: "path_clear",
    nodes: [start, middle, target].map((point) => ({
      x: Math.round(point.x),
      y: 0,
      z: Math.round(point.z),
    })),
  };
}

export function createStroke(
  x: number,
  z: number,
  brush: Omit<TerrainStroke, "id" | "x" | "z">,
): TerrainStroke {
  return { ...brush, id: uid("stroke"), x, z };
}

export function createIONode(
  kind: IOComponentKind,
  index: number,
  placement?: PrefabPlacement,
): IONode {
  const labels: Record<IOComponentKind, string> = {
    switch: "Switch",
    card_reader: "Card reader",
    door: "Door",
    generator: "Generator",
    timer: "Timer",
    light: "Light",
    vending_machine: "Vending machine",
  };
  return {
    id: uid("io"),
    name: `${labels[kind]} ${index + 1}`,
    kind,
    placementId: placement?.id ?? null,
    x: placement?.position.x ?? 0,
    z: placement?.position.z ?? 12 * index,
    cardLevel: kind === "card_reader" ? "green" : null,
  };
}

export function createIOLink(from: string, to: string, cardLevel: IOLink["cardLevel"] = null): IOLink {
  return { id: uid("link"), from, to, cardLevel };
}

export function createVendingOverride(placementId: string, index: number): VendingOverride {
  return {
    id: uid("vending"),
    placementId,
    profile: index % 2 === 0 ? "bandit" : "outpost",
    stock: 12,
    priceMultiplier: 1,
  };
}

export function createMaterialLayer(preset: MaterialLayer["preset"], index: number): MaterialLayer {
  const presets: Record<string, { name: string; metallic: number; smoothness: number; color: string }> = {
    metal: { name: "Painted Metal", metallic: 0.85, smoothness: 0.45, color: "#3f4a52" },
    polymer: { name: "Polymer Matte", metallic: 0.0, smoothness: 0.22, color: "#22262b" },
    wood: { name: "Wood Laminate", metallic: 0.0, smoothness: 0.3, color: "#6d4a2f" },
    carbon: { name: "Carbon Fiber", metallic: 0.1, smoothness: 0.65, color: "#141618" },
    custom: { name: "Custom Layer", metallic: 0.5, smoothness: 0.5, color: "#8c9196" },
  };
  const base = presets[preset] ?? presets.custom;
  return {
    id: uid("layer"),
    preset,
    name: `${base.name}${index > 0 ? ` ${index + 1}` : ""}`,
    metallic: base.metallic,
    smoothness: base.smoothness,
    baseColor: base.color,
    textureName: null,
    blend: "normal",
    scale: 1,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDraft(draft: WizardDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (
    id: string,
    step: WizardStepId,
    severity: ValidationIssue["severity"],
    message: string,
    detail?: string,
  ) => issues.push({ id, step, severity, message, detail });

  if (!draft.name.trim()) {
    add("name-empty", "entry", "error", "Project name is required.");
  }
  if (draft.mode === "online" && draft.syncEndpoint && !/^https?:\/\//.test(draft.syncEndpoint)) {
    add("sync-url", "entry", "error", "Sync endpoint must be an http(s) URL.");
  }

  if (draft.branch === "world") {
    // Hidden placements stay in the project but are not part of the build.
    const placements = draft.placements.filter((placement) => placement.visible !== false);
    const terrain = draft.terrain;
    if (terrain.sizeMetres < 1000 || terrain.sizeMetres > 6000) {
      add("terrain-size", "terrain", "error", "Map size must be between 1000 and 6000 metres.");
    }
    if (!Number.isFinite(terrain.seed)) {
      add("terrain-seed", "terrain", "error", "Terrain seed must be a number.");
    }
    if (terrain.waterLevel > 450) {
      add("terrain-water", "terrain", "warning", "Water level above 450 m will flood most terrain.");
    }
    if (
      terrain.heightmap &&
      terrain.heightmap.resolution >= 1025 &&
      terrain.sizeMetres !== terrain.heightmap.resolution - 1
    ) {
      add(
        "heightmap-native-size",
        "terrain",
        "warning",
        `The native ${terrain.heightmap.resolution}² heightmap exports as a ${terrain.heightmap.resolution - 1} m map, not ${terrain.sizeMetres} m.`,
        "Re-import the heightmap or set the map size back to resolution − 1 to keep validation and the exported grid aligned.",
      );
    }

    const triangles = placements.reduce((total) => total + 1, 0);
    if (draft.projectKind === "monument" && triangles === 0) {
      add("monument-empty", "monuments", "error", "A monument project needs at least one prefab.");
    }
    if (draft.projectKind === "map" && triangles === 0) {
      add("map-empty", "monuments", "warning", "No monuments or prefabs placed yet.");
    }

    const halfSize = terrain.sizeMetres / 2;
    let previous = "";
    const sorted = [...placements].sort((a, b) => a.name.localeCompare(b.name));
    for (const placement of sorted) {
      if (placement.name === previous) {
        add(
          `duplicate-${placement.id}`,
          "monuments",
          "warning",
          `Two prefabs share the name "${placement.name}".`,
          "The outliner allows duplicates, but unique names make IO wiring clearer.",
        );
      }
      previous = placement.name;
      // Scale and yaw apply to the rendered proxy, so they must apply here
      // too; otherwise a scaled-up prefab passes validation with a footprint
      // that is larger than the one drawn in the viewport.
      const extents = collisionExtents(placement);
      if (
        Math.abs(placement.position.x) + extents.halfX > halfSize ||
        Math.abs(placement.position.z) + extents.halfZ > halfSize
      ) {
        add(
          `edge-${placement.id}`,
          "monuments",
          "error",
          `"${placement.name}" extends beyond the ${terrain.sizeMetres} m map edge.`,
          "Move it inward or reduce its collision radius or scale before exporting.",
        );
      }
      if (placement.scale.x <= 0 || placement.scale.y <= 0 || placement.scale.z <= 0) {
        add(
          `scale-${placement.id}`,
          "monuments",
          "error",
          `"${placement.name}" has a zero or negative scale.`,
        );
      }
      if (placement.position.y > 25) {
        add(
          `float-${placement.id}`,
          "validate",
          "warning",
          `"${placement.name}" is ${Math.round(placement.position.y)} m above its terrain pad.`,
          "Check for a floating prefab before writing the .map.",
        );
      }
      const monumentLike = /monument|launch|airfield|military|bandit|outpost|dome|village/i.test(
        `${placement.assetId} ${placement.name}`,
      );
      if (monumentLike && placement.flatten && !placement.noBuildZone) {
        add(
          `missing-nobuild-${placement.id}`,
          "validate",
          "warning",
          `"${placement.name}" has no Prevent Building topology mask.`,
          "Monuments normally need the no-build flag inside the flattened footprint.",
        );
      }
      if (monumentLike && !placement.clearFoliage) {
        add(
          `missing-foliage-${placement.id}`,
          "validate",
          "warning",
          `"${placement.name}" does not clear foliage in the topology layer.`,
        );
      }
      if (placement.ioWiring.includes("->")) {
        const [source, target] = placement.ioWiring.split("->").map((part) => part.trim());
        if (!source || !target) {
          add(
            `io-broken-${placement.id}`,
            "validate",
            "error",
            `"${placement.name}" has an incomplete IO connection.`,
            "Use the form source -> target.",
          );
        }
      }
      if (placement.flatten && placement.flattenFalloff < 4) {
        add(
          `falloff-${placement.id}`,
          "monuments",
          "warning",
          `Flatten falloff for "${placement.name}" is very tight.`,
          "Use at least 8 m so the terrain blend does not form a visible wall.",
        );
      }
    }

    for (let first = 0; first < sorted.length; first += 1) {
      for (let second = first + 1; second < sorted.length; second += 1) {
        const a = sorted[first];
        const b = sorted[second];
        if (a.locked || b.locked) continue;
        const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
        const required = Math.max(2, collisionExtents(a).reach) + Math.max(2, collisionExtents(b).reach);
        if (distance + 0.01 < required) {
          add(
            `collision-${a.id}-${b.id}`,
            "monuments",
            "warning",
            `Collision volumes for "${a.name}" and "${b.name}" overlap by ${Math.round(required - distance)} m.`,
            "Move one prefab or reduce its collision radius so placement validation matches the rendered proxy.",
          );
        }
      }
    }

    // Map health: pad stacking, prefab budget and spawn topology.
    const padPairs: string[] = [];
    for (let first = 0; first < sorted.length; first += 1) {
      for (let second = first + 1; second < sorted.length; second += 1) {
        const a = sorted[first];
        const b = sorted[second];
        if (!a.flatten || !b.flatten) continue;
        const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
        // Half-overlap is the point where one pad starts re-flattening the
        // other and the blend rings stack visibly.
        const threshold = (a.flattenRadius + b.flattenRadius) * 0.5;
        if (distance > 0 && distance < threshold && padPairs.length < 3) {
          padPairs.push(`${a.name} / ${b.name}`);
        }
      }
    }
    for (const pair of padPairs) {
      add(
        `pad-overlap-${pair}`,
        "validate",
        "warning",
        `Flatten pads of ${pair} overlap by more than half.`,
        "Stacked pads fight over the same terrain and can leave a visible seam ring.",
      );
    }

    if (sorted.length > 150) {
      add(
        "prefab-budget",
        "validate",
        "warning",
        `${sorted.length} prefabs on one map is above the draw-call budget.`,
        "Merge repeated decor into fewer prefabs or reuse them with transforms so lower-end clients keep their frame rate.",
      );
    }
    const padArea = sorted.reduce(
      (total, placement) =>
        total + Math.PI * Math.max(0, placement.flattenRadius) * Math.max(0, placement.flattenRadius),
      0,
    );
    const padCoverage = padArea / Math.max(1, terrain.sizeMetres * terrain.sizeMetres);
    if (padCoverage > 0.4) {
      add(
        "pad-coverage",
        "validate",
        "warning",
        `Flatten pads cover ${Math.round(padCoverage * 100)}% of the map.`,
        "That much flattened ground removes the natural terrain the map is judged on.",
      );
    }
    const floorHeight = terrain.floorHeight;
    if (
      draft.projectKind === "map" &&
      typeof floorHeight === "number" &&
      floorHeight > terrain.waterLevel
    ) {
      add(
        "no-water",
        "validate",
        "warning",
        "This map has no water, so it has no beach or oceanside spawn area.",
        "Rust places spawns on coastal topology; a dry flat map can drop players into the ocean. Add a coast or lower the floor below the water line.",
      );
    }

    if (draft.projectKind === "map" && draft.splines.length === 0) {
      add("no-paths", "paths", "warning", "No roads or rivers yet. Rust maps normally include both.");
    }
    for (const spline of draft.splines) {
      if (spline.nodes.length < 2) {
        add(`short-${spline.id}`, "paths", "error", `"${spline.name}" needs at least two nodes.`);
      }
      if (spline.width <= 0) {
        add(`width-${spline.id}`, "paths", "error", `"${spline.name}" needs a positive width.`);
      }
      const outside = spline.nodes.some(
        (node) => Math.abs(node.x) > halfSize || Math.abs(node.z) > halfSize,
      );
      if (outside) {
        add(
          `spline-edge-${spline.id}`,
          "paths",
          "warning",
          `"${spline.name}" has nodes outside the map bounds.`,
        );
      }
      if ((spline.kind === "road" || spline.kind === "rail") && !spline.topologyFlag) {
        add(
          `spline-topology-${spline.id}`,
          "validate",
          "info",
          `"${spline.name}" does not stamp a path-clear topology flag.`,
        );
      }
    }

    const nodeIds = new Set(draft.io.nodes.map((node) => node.id));
    for (const link of draft.io.links) {
      if (!nodeIds.has(link.from) || !nodeIds.has(link.to)) {
        add(
          `io-link-${link.id}`,
          "validate",
          "error",
          "An IO link references a component that no longer exists.",
          "Delete the dangling wire and reconnect the nodes.",
        );
      }
    }
    for (const node of draft.io.nodes) {
      if (node.placementId && !placements.some((item) => item.id === node.placementId)) {
        add(
          `io-node-${node.id}`,
          "validate",
          "warning",
          `IO component "${node.name}" is not attached to a placed prefab.`,
        );
      }
      if (node.kind === "card_reader" && !draft.io.links.some((link) => link.from === node.id)) {
        add(
          `io-reader-${node.id}`,
          "validate",
          "warning",
          `Card reader "${node.name}" is not wired to a door or generator.`,
        );
      }
    }
    if (draft.io.links.some((link) => link.from === link.to)) {
      add("io-loop", "validate", "error", "An IO component is wired to itself.");
    }

    const alphaStrokes = plannedStrokes(terrain).filter((entry) => entry.stroke.mode === "alpha");
    if (alphaStrokes.length > 0) {
      add(
        "terrain-holes",
        "validate",
        "warning",
        `${alphaStrokes.length} alpha hole stroke(s) will create non-watertight terrain.`,
        "Verify cave entrances have walls or a matching alpha mask before export.",
      );
    }
    if (terrain.heightmap && terrain.heightmap.resolution < 2) {
      add("heightmap-import", "terrain", "error", "Imported heightmap has no readable samples.");
    }
    for (const mask of terrain.masks ?? []) {
      if (mask.resolution < 2) {
        add(`mask-${mask.id}`, "terrain", "error", `Mask "${mask.name}" is empty.`);
      }
    }

    const loot = draft.loot;
    if (loot.crateCount < 0 || loot.vendingMachines < 0 || loot.npcSpawners < 0) {
      add("loot-negative", "loot", "error", "Loot, vending and NPC counts cannot be negative.");
    }
    if (loot.tier === 3 && loot.cardPuzzles < 1) {
      add("loot-cards", "loot", "warning", "Tier 3 monuments usually include a card puzzle.");
    }
    if (loot.noBuildZones > 0) {
      add(
        "nobuild-zones",
        "validate",
        "info",
        `${loot.noBuildZones} no-build zone(s) will be written to the topology layer.`,
      );
    }
    if (draft.export.mapLock && draft.export.mapPassword.length < 6) {
      add("map-password", "validate", "error", "Map lock requires a password of at least 6 characters.");
    }
    if (!draft.export.fileName.trim()) {
      add("export-name", "validate", "error", "Export file name is required.");
    }
  } else {
    const skin = draft.skin;
    if (!skin.baseMeshId) {
      add("skin-mesh", "baseItem", "error", "Select a base mesh before continuing.");
    }
    if (skin.uvChannels < 1) {
      add("skin-uv", "baseItem", "warning", "The selected mesh has no UV channel; projection still works.");
    }
    if (skin.layers.length === 0) {
      add("skin-layers", "materials", "error", "Add at least one material layer.");
    }
    if (!skin.layers.some((layer) => layer.enabled)) {
      add("skin-layers-off", "materials", "error", "Every material layer is disabled.");
    }
    if (skin.decals.length === 0 && skin.paintStrokes === 0) {
      add("skin-paint", "paint", "warning", "No decals or brush strokes yet.");
    }
    for (const decal of skin.decals) {
      if (decal.size <= 0) {
        add(`decal-${decal.id}`, "paint", "error", "Decal size must be greater than zero.");
      }
    }
    if (skin.resolution !== 1024 && skin.resolution !== 2048) {
      add("skin-resolution", "workshop", "error", "Rust skins must be 1024 or 2048 px.");
    }
    if (!draft.export.fileName.trim()) {
      add("skin-name", "workshop", "error", "Export name is required.");
    }
    if (!draft.export.includeEmission) {
      add(
        "no-emission",
        "workshop",
        "info",
        "Emission is disabled; the night lighting preview will have no glow.",
      );
    }
  }

  return issues;
}

export function issuesForStep(draft: WizardDraft, step: WizardStepId): ValidationIssue[] {
  return validateDraft(draft).filter((issue) => issue.step === step);
}

export function canAdvance(draft: WizardDraft, step: WizardStepId): boolean {
  return !issuesForStep(draft, step).some((issue) => issue.severity === "error");
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type WizardAction =
  | { type: "patch"; patch: Partial<WizardDraft> }
  | { type: "patchTerrain"; patch: Partial<TerrainSettings> }
  | { type: "patchLoot"; patch: Partial<LootSettings> }
  | { type: "patchSkin"; patch: Partial<SkinSettings> }
  | { type: "patchSkinWear"; patch: Partial<SkinSettings["wear"]> }
  | { type: "setKind"; kind: ProjectKind }
  | { type: "addPlacement"; asset: PrefabAsset; position?: { x: number; z: number } }
  | { type: "addPlacements"; placements: PrefabPlacement[] }
  | { type: "connectPlacement"; placementId: string }
  | { type: "updatePlacement"; id: string; patch: Partial<PrefabPlacement> }
  | { type: "removePlacement"; id: string }
  | { type: "selectPlacement"; id: string | null }
  | { type: "addSpline"; kind: SplineKind }
  | { type: "updateSpline"; id: string; patch: Partial<RouteSpline> }
  | { type: "removeSpline"; id: string }
  | { type: "addStrokes"; strokes: TerrainStroke[] }
  | { type: "removeStrokes"; ids: string[] }
  | { type: "addLayer"; kind: TerrainLayerKind }
  | { type: "removeLayer"; id: string }
  | { type: "updateLayer"; id: string; patch: Partial<Omit<TerrainLayer, "id" | "strokes">> }
  | { type: "moveLayer"; id: string; direction: -1 | 1 }
  | { type: "setActiveLayer"; id: string | null }
  | { type: "addIONode"; kind: IOComponentKind; placementId?: string | null }
  | { type: "updateIONode"; id: string; patch: Partial<IONode> }
  | { type: "removeIONode"; id: string }
  | { type: "addIOLink"; from: string; to: string }
  | { type: "removeIOLink"; id: string }
  | { type: "addVendingOverride"; placementId: string }
  | { type: "updateVendingOverride"; id: string; patch: Partial<VendingOverride> }
  | { type: "removeVendingOverride"; id: string }
  | { type: "addMaterialLayer"; preset: MaterialLayer["preset"] }
  | { type: "updateMaterialLayer"; id: string; patch: Partial<MaterialLayer> }
  | { type: "removeMaterialLayer"; id: string }
  | { type: "addDecal"; decal: DecalStroke }
  | { type: "removeDecal"; id: string }
  | { type: "registerPaintStroke" }
  | { type: "toggleStudio" }
  | { type: "setWalkMode"; enabled: boolean }
  | { type: "setLighting"; patch: Partial<LightingSettings> }
  | { type: "next" }
  | { type: "back" }
  | { type: "goTo"; step: WizardStepId }
  | { type: "markSaved"; at: string; report?: WizardState["exportReport"] }
  | { type: "applyGenerated"; draft: WizardDraft; step: WizardStepId }
  | { type: "hydrate"; state: WizardState }
  | { type: "reset" };

export type { WizardAction };

function markDirty(state: WizardState, draft: WizardDraft): WizardState {
  return { ...state, draft: { ...draft, export: { ...draft.export } }, dirty: true };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "patch":
      return markDirty(state, { ...state.draft, ...action.patch });

    case "patchTerrain":
      return markDirty(state, { ...state.draft, terrain: { ...state.draft.terrain, ...action.patch } });

    case "patchLoot":
      return markDirty(state, { ...state.draft, loot: { ...state.draft.loot, ...action.patch } });

    case "patchSkin":
      return markDirty(state, { ...state.draft, skin: { ...state.draft.skin, ...action.patch } });

    case "patchSkinWear":
      return markDirty(state, {
        ...state.draft,
        skin: { ...state.draft.skin, wear: { ...state.draft.skin.wear, ...action.patch } },
      });

    case "setKind": {
      if (state.stepId !== "entry") return state;
      return markDirty(state, {
        ...state.draft,
        projectKind: action.kind,
        branch: branchFor(action.kind),
      });
    }

    case "addPlacement": {
      const placement = createPlacement(
        action.asset,
        state.draft.placements.length,
        action.position,
      );
      return markDirty(state, {
        ...state.draft,
        placements: [...state.draft.placements, placement],
        selectedPlacementId: placement.id,
      });
    }

    case "addPlacements": {
      if (!action.placements.length) return state;
      return markDirty(state, {
        ...state.draft,
        placements: [...state.draft.placements, ...action.placements],
        selectedPlacementId: action.placements[action.placements.length - 1]?.id ?? null,
      });
    }

    case "updatePlacement":
      return markDirty(state, {
        ...state.draft,
        placements: state.draft.placements.map((placement) =>
          placement.id === action.id ? { ...placement, ...action.patch } : placement,
        ),
      });

    case "removePlacement":
      return markDirty(state, {
        ...state.draft,
        placements: state.draft.placements.filter((placement) => placement.id !== action.id),
        selectedPlacementId:
          state.draft.selectedPlacementId === action.id ? null : state.draft.selectedPlacementId,
      });

    case "selectPlacement":
      return { ...state, draft: { ...state.draft, selectedPlacementId: action.id } };

    case "connectPlacement": {
      const placement = state.draft.placements.find((item) => item.id === action.placementId);
      if (!placement) return state;
      const spline = createConnectorSpline(
        placement,
        state.draft.splines,
        state.draft.splines.length,
        state.draft.terrain.sizeMetres,
      );
      if (!spline) return state;
      return markDirty(state, { ...state.draft, splines: [...state.draft.splines, spline] });
    }

    case "addSpline": {
      const spline = createSpline(action.kind, state.draft.splines.length);
      return markDirty(state, { ...state.draft, splines: [...state.draft.splines, spline] });
    }

    case "updateSpline":
      return markDirty(state, {
        ...state.draft,
        splines: state.draft.splines.map((spline) =>
          spline.id === action.id ? { ...spline, ...action.patch } : spline,
        ),
      });

    case "removeSpline":
      return markDirty(state, {
        ...state.draft,
        splines: state.draft.splines.filter((spline) => spline.id !== action.id),
      });

    case "addStrokes": {
      if (!action.strokes.length) return state;
      const terrain = state.draft.terrain;
      let layers = terrain.layers ?? [];
      let active = layers.find((layer) => layer.id === terrain.activeLayerId) ?? null;
      if (!active) {
        active = createLayer(layerKindForStroke(action.strokes[0]), layers.length);
        layers = [...layers, active];
      }
      const targetId = active.id;
      layers = layers.map((layer) =>
        layer.id === targetId
          ? {
              ...layer,
              strokes: [
                ...layer.strokes,
                ...action.strokes.map((stroke) => ({ ...stroke, layerId: targetId })),
              ].slice(-20_000),
            }
          : layer,
      );
      return markDirty(state, {
        ...state.draft,
        terrain: {
          ...terrain,
          layers,
          activeLayerId: targetId,
          sculptStrokes: terrain.sculptStrokes + action.strokes.length,
        },
      });
    }

    case "removeStrokes": {
      const ids = new Set(action.ids);
      const terrain = state.draft.terrain;
      return markDirty(state, {
        ...state.draft,
        terrain: {
          ...terrain,
          strokes: (terrain.strokes ?? []).filter((stroke) => !ids.has(stroke.id)),
          layers: (terrain.layers ?? []).map((layer) => ({
            ...layer,
            strokes: layer.strokes.filter((stroke) => !ids.has(stroke.id)),
          })),
        },
      });
    }

    case "addLayer": {
      const layers = state.draft.terrain.layers ?? [];
      const layer = createLayer(action.kind, layers.length);
      return markDirty(state, {
        ...state.draft,
        terrain: {
          ...state.draft.terrain,
          layers: [...layers, layer],
          activeLayerId: layer.id,
        },
      });
    }

    case "removeLayer": {
      const layers = (state.draft.terrain.layers ?? []).filter((layer) => layer.id !== action.id);
      const activeLayerId =
        state.draft.terrain.activeLayerId === action.id ||
        !layers.some((layer) => layer.id === state.draft.terrain.activeLayerId)
          ? (layers[0]?.id ?? null)
          : state.draft.terrain.activeLayerId;
      return markDirty(state, {
        ...state.draft,
        terrain: { ...state.draft.terrain, layers, activeLayerId },
      });
    }

    case "updateLayer": {
      return markDirty(state, {
        ...state.draft,
        terrain: {
          ...state.draft.terrain,
          layers: (state.draft.terrain.layers ?? []).map((layer) =>
            layer.id === action.id ? { ...layer, ...action.patch } : layer,
          ),
        },
      });
    }

    case "moveLayer": {
      const layers = [...(state.draft.terrain.layers ?? [])];
      const index = layers.findIndex((layer) => layer.id === action.id);
      const target = index + action.direction;
      if (index < 0 || target < 0 || target >= layers.length) return state;
      [layers[index], layers[target]] = [layers[target], layers[index]];
      return markDirty(state, {
        ...state.draft,
        terrain: { ...state.draft.terrain, layers },
      });
    }

    case "setActiveLayer": {
      // A stale layer id (removed elsewhere) falls back to the first layer
      // instead of leaving the toolbar pointing at nothing.
      const exists = (state.draft.terrain.layers ?? []).some((layer) => layer.id === action.id);
      const activeLayerId = action.id === null || exists
        ? action.id
        : (state.draft.terrain.layers?.[0]?.id ?? null);
      return markDirty(state, {
        ...state.draft,
        terrain: { ...state.draft.terrain, activeLayerId },
      });
    }

    case "addIONode": {
      const placement = action.placementId
        ? state.draft.placements.find((item) => item.id === action.placementId)
        : undefined;
      const node = createIONode(action.kind, state.draft.io.nodes.length, placement);
      return markDirty(state, {
        ...state.draft,
        io: { ...state.draft.io, nodes: [...state.draft.io.nodes, node] },
      });
    }

    case "updateIONode":
      return markDirty(state, {
        ...state.draft,
        io: {
          ...state.draft.io,
          nodes: state.draft.io.nodes.map((node) =>
            node.id === action.id ? { ...node, ...action.patch } : node,
          ),
        },
      });

    case "removeIONode":
      return markDirty(state, {
        ...state.draft,
        io: {
          nodes: state.draft.io.nodes.filter((node) => node.id !== action.id),
          links: state.draft.io.links.filter(
            (link) => link.from !== action.id && link.to !== action.id,
          ),
          vendingOverrides: state.draft.io.vendingOverrides,
        },
      });

    case "addIOLink": {
      if (action.from === action.to) return state;
      const exists = state.draft.io.links.some(
        (link) => link.from === action.from && link.to === action.to,
      );
      if (exists) return state;
      const source = state.draft.io.nodes.find((node) => node.id === action.from);
      return markDirty(state, {
        ...state.draft,
        io: {
          ...state.draft.io,
          links: [
            ...state.draft.io.links,
            createIOLink(action.from, action.to, source?.cardLevel ?? null),
          ],
        },
      });
    }

    case "removeIOLink":
      return markDirty(state, {
        ...state.draft,
        io: {
          ...state.draft.io,
          links: state.draft.io.links.filter((link) => link.id !== action.id),
        },
      });

    case "addVendingOverride": {
      if (!action.placementId) return state;
      return markDirty(state, {
        ...state.draft,
        io: {
          ...state.draft.io,
          vendingOverrides: [
            ...state.draft.io.vendingOverrides,
            createVendingOverride(action.placementId, state.draft.io.vendingOverrides.length),
          ],
        },
      });
    }

    case "updateVendingOverride":
      return markDirty(state, {
        ...state.draft,
        io: {
          ...state.draft.io,
          vendingOverrides: state.draft.io.vendingOverrides.map((override) =>
            override.id === action.id ? { ...override, ...action.patch } : override,
          ),
        },
      });

    case "removeVendingOverride":
      return markDirty(state, {
        ...state.draft,
        io: {
          ...state.draft.io,
          vendingOverrides: state.draft.io.vendingOverrides.filter(
            (override) => override.id !== action.id,
          ),
        },
      });

    case "addMaterialLayer":
      return markDirty(state, {
        ...state.draft,
        skin: {
          ...state.draft.skin,
          layers: [
            ...state.draft.skin.layers,
            createMaterialLayer(action.preset, state.draft.skin.layers.length),
          ],
        },
      });

    case "updateMaterialLayer":
      return markDirty(state, {
        ...state.draft,
        skin: {
          ...state.draft.skin,
          layers: state.draft.skin.layers.map((layer) =>
            layer.id === action.id ? { ...layer, ...action.patch } : layer,
          ),
        },
      });

    case "removeMaterialLayer":
      return markDirty(state, {
        ...state.draft,
        skin: {
          ...state.draft.skin,
          layers: state.draft.skin.layers.filter((layer) => layer.id !== action.id),
        },
      });

    case "addDecal":
      return markDirty(state, {
        ...state.draft,
        skin: { ...state.draft.skin, decals: [...state.draft.skin.decals, action.decal] },
      });

    case "removeDecal":
      return markDirty(state, {
        ...state.draft,
        skin: {
          ...state.draft.skin,
          decals: state.draft.skin.decals.filter((decal) => decal.id !== action.id),
        },
      });

    case "registerPaintStroke":
      return markDirty(state, {
        ...state.draft,
        skin: { ...state.draft.skin, paintStrokes: state.draft.skin.paintStrokes + 1 },
      });

    case "toggleStudio":
      return { ...state, draft: { ...state.draft, studioMode: !state.draft.studioMode } };

    case "setWalkMode": {
      if (action.enabled && state.draft.branch !== "world") return state;
      return { ...state, draft: { ...state.draft, walkMode: action.enabled } };
    }

    case "setLighting": {
      const time = action.patch.timeOfDay;
      const patch: Partial<LightingSettings> = {
        ...action.patch,
        ...(time === undefined
          ? {}
          : { timeOfDay: Math.min(1439, Math.max(0, Math.round(time))) }),
      };
      return markDirty(state, {
        ...state.draft,
        lighting: { ...state.draft.lighting, ...patch },
      });
    }

    case "next": {
      if (!canAdvance(state.draft, state.stepId)) return state;
      const steps = stepsFor(state.draft.projectKind);
      const index = steps.indexOf(state.stepId);
      const next = steps[index + 1];
      if (!next) return state;
      const nextIndex = steps.indexOf(next);
      return {
        ...state,
        stepId: next,
        furthestIndex: Math.max(state.furthestIndex, nextIndex),
      };
    }

    case "back": {
      const steps = stepsFor(state.draft.projectKind);
      const index = steps.indexOf(state.stepId);
      if (index <= 0) return state;
      return { ...state, stepId: steps[index - 1] };
    }

    case "goTo": {
      const steps = stepsFor(state.draft.projectKind);
      const index = steps.indexOf(action.step);
      if (index < 0) return state;
      if (!state.draft.studioMode && index > state.furthestIndex) return state;
      return { ...state, stepId: action.step };
    }

    case "markSaved":
      return {
        ...state,
        dirty: false,
        lastSavedAt: action.at,
        exportReport: action.report ?? state.exportReport,
      };

    case "applyGenerated": {
      const steps = stepsFor(action.draft.projectKind);
      const index = Math.max(0, steps.indexOf(action.step));
      return {
        draft: action.draft,
        stepId: steps[index] ?? steps[0],
        furthestIndex: Math.max(state.furthestIndex, index),
        dirty: true,
        lastSavedAt: null,
        exportReport: null,
      };
    }

    case "hydrate":
      return action.state;

    case "reset":
      return initialState();

    default:
      return state;
  }
}

export function progress(state: WizardState): { index: number; total: number; steps: WizardStepId[] } {
  const steps = stepsFor(state.draft.projectKind);
  return { index: Math.max(0, steps.indexOf(state.stepId)), total: steps.length, steps };
}
