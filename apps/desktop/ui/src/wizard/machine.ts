/**
 * Pure wizard state machine.
 *
 * No React, no side effects: `wizardReducer` maps (state, event) -> state, and
 * `validateDraft` derives blocking errors from the draft. Steps read validation
 * through `issuesForStep`; the reducer refuses to advance past a step with
 * blocking issues, so the UI cannot get into an invalid exported state.
 */

import type {
  Bounds3,
  Branch,
  DecalStroke,
  LootSettings,
  MaterialLayer,
  PrefabAsset,
  PrefabPlacement,
  ProjectKind,
  RouteSpline,
  SkinSettings,
  SkinStepId,
  SplineKind,
  TerrainSettings,
  ValidationIssue,
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

export function branchFor(kind: ProjectKind): Branch {
  return kind === "skin" ? "skin" : "world";
}

export function stepsFor(kind: ProjectKind): WizardStepId[] {
  return kind === "skin" ? SKIN_STEPS : WORLD_STEPS;
}

export function createInitialDraft(): WizardDraft {
  return {
    name: "Untitled project",
    mode: "offline",
    projectKind: "map",
    branch: "world",
    syncEndpoint: "",
    studioMode: false,
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
      },
      sculptStrokes: 0,
    },
    placements: [],
    selectedPlacementId: null,
    splines: [],
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

export function flattenRadiusFromBounds(
  bounds: Bounds3 | null | undefined,
  fallback = 40,
): number {
  if (!bounds) return fallback;
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[2] - bounds.min[2];
  const footprint = Math.max(width, depth);
  if (!Number.isFinite(footprint) || footprint <= 0) return fallback;
  return Math.max(8, Math.round(footprint * 0.55 + 4));
}

export function createPlacement(asset: PrefabAsset, index = 0): PrefabPlacement {
  const angle = (index % 8) * (Math.PI / 4);
  const radius = Math.min(400, 90 + index * 18);
  return {
    id: uid("prefab"),
    assetId: asset.id,
    name: asset.name,
    position: {
      x: Math.round(Math.cos(angle) * radius),
      y: 0,
      z: Math.round(Math.sin(angle) * radius),
    },
    rotationEuler: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    parentId: null,
    flatten: true,
    flattenRadius: asset.flattenRadius || flattenRadiusFromBounds(asset.bounds),
    flattenFalloff: 18,
    clearFoliage: true,
    noBuildZone: true,
    lootTier: 2,
    lootProfile: "",
    ioWiring: "",
    npcCount: 0,
    locked: false,
  };
}

export function createSpline(kind: SplineKind, index: number): RouteSpline {
  const names: Record<SplineKind, string> = {
    road: "Road",
    river: "River",
    rail: "Rail",
    apc: "APC Route",
    cargo: "Cargo Route",
    powerline: "Powerline",
  };
  const offset = index * 120;
  return {
    id: uid("spline"),
    name: `${names[kind]} ${index}`,
    kind,
    width: kind === "river" ? 22 : kind === "road" ? 9 : 6,
    closed: false,
    autoRoute: true,
    nodes: [
      { x: -900 + offset, y: 0, z: -600 },
      { x: -300 + offset, y: 0, z: 0 },
      { x: 500 + offset, y: 0, z: 450 },
      { x: 950, y: 0, z: 900 },
    ],
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

    const triangles = draft.placements.reduce((total, placement) => total + 1, 0);
    if (draft.projectKind === "monument" && triangles === 0) {
      add("monument-empty", "monuments", "error", "A monument project needs at least one prefab.");
    }
    if (draft.projectKind === "map" && triangles === 0) {
      add("map-empty", "monuments", "warning", "No monuments or prefabs placed yet.");
    }

    let previous = "";
    const sorted = [...draft.placements].sort((a, b) => a.name.localeCompare(b.name));
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
  | { type: "addPlacement"; asset: PrefabAsset }
  | { type: "updatePlacement"; id: string; patch: Partial<PrefabPlacement> }
  | { type: "removePlacement"; id: string }
  | { type: "selectPlacement"; id: string | null }
  | { type: "addSpline"; kind: SplineKind }
  | { type: "updateSpline"; id: string; patch: Partial<RouteSpline> }
  | { type: "removeSpline"; id: string }
  | { type: "addMaterialLayer"; preset: MaterialLayer["preset"] }
  | { type: "updateMaterialLayer"; id: string; patch: Partial<MaterialLayer> }
  | { type: "removeMaterialLayer"; id: string }
  | { type: "addDecal"; decal: DecalStroke }
  | { type: "removeDecal"; id: string }
  | { type: "registerPaintStroke" }
  | { type: "toggleStudio" }
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
      const placement = createPlacement(action.asset, state.draft.placements.length);
      return markDirty(state, {
        ...state.draft,
        placements: [...state.draft.placements, placement],
        selectedPlacementId: placement.id,
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
