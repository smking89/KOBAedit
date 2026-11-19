/**
 * Domain model for the dual-branch wizard.
 *
 * The state machine in `machine.ts` is pure: it owns this draft, the current
 * step, and validation. Everything here must stay JSON-serializable so a project
 * can be resumed offline from SQLite or localStorage.
 */

export type EntryMode = "offline" | "online";
export type ProjectKind = "map" | "monument" | "skin";
export type Branch = "world" | "skin";

export type WorldStepId = "entry" | "terrain" | "monuments" | "paths" | "loot" | "validate";
export type SkinStepId = "entry" | "baseItem" | "materials" | "paint" | "wear" | "workshop";
export type WizardStepId = WorldStepId | SkinStepId;

export type TerrainPreset = "islands" | "mountains" | "valley" | "flat" | "archipelago";

export type BrushMode = "raise" | "lower" | "smooth" | "flatten" | "splat" | "topology" | "alpha";
export type BrushLayer = "height" | "splat" | "biome" | "topology" | "alpha";
export type SplatChannel = "dirt" | "snow" | "sand" | "rock" | "grass" | "forest" | "stones" | "gravel";
export type BiomeChannel = "arid" | "temperate" | "tundra" | "arctic";
export type TopologyFlag =
  | "no_build"
  | "monument_pad"
  | "foliage_cleared"
  | "path_clear"
  | "loot_zone"
  | "npc_zone"
  | "safe_zone";

export interface BrushSync {
  height: boolean;
  splat: boolean;
  biome: boolean;
  topology: boolean;
  alpha: boolean;
}

export interface TerrainBrush {
  mode: BrushMode;
  radius: number;
  strength: number;
  falloff: number;
  splatChannel: SplatChannel;
  biomeChannel: BiomeChannel;
  topologyFlags: TopologyFlag[];
  topologyClearFlags: TopologyFlag[];
  sync: BrushSync;
}

export interface SlopeTopologyRule {
  id: string;
  minSlope: number;
  maxSlope: number;
  flags: TopologyFlag[];
}

export type TerrainLayerKind = "sculpt" | "splat" | "biome" | "topology";

/**
 * Strokes are captured into layers. Layers replay in array order; hidden or
 * zero-opacity layers are skipped by the editor preview and the exporter.
 */
export interface TerrainLayer {
  id: string;
  name: string;
  kind: TerrainLayerKind;
  visible: boolean;
  /** 0–1 effect multiplier applied on replay. */
  opacity: number;
  strokes: TerrainStroke[];
}

export interface TerrainStroke {
  id: string;
  x: number;
  z: number;
  /** Layer this stroke was captured into (absent on pre-layer projects). */
  layerId?: string;
  mode: BrushMode;
  radius: number;
  strength: number;
  falloff: number;
  splatChannel: SplatChannel;
  biomeChannel: BiomeChannel;
  topologyFlags: TopologyFlag[];
  topologyClearFlags: TopologyFlag[];
  sync: BrushSync;
}

export interface TerrainHeightImport {
  name: string;
  resolution: number;
  encoding: "raw16" | "png16";
  /** Base64 little-endian uint16 heights, row-major. */
  data: string;
  minHeight: number;
  maxHeight: number;
  verticalScale: number;
}

export interface TerrainMaskImport {
  id: string;
  name: string;
  kind: "splat" | "biome" | "topology" | "alpha";
  channel: number;
  resolution: number;
  /** Base64 single-channel 8-bit mask, row-major. */
  data: string;
}

export interface TerrainSettings {
  seed: number;
  preset: TerrainPreset;
  sizeMetres: number;
  mountainScale: number;
  waterLevel: number;
  detail: number;
  treeDensity: number;
  biomeWeights: [number, number, number, number];
  brush: TerrainBrush;
  sculptStrokes: number;
  /** Legacy flat history; new strokes live in `layers`. */
  strokes: TerrainStroke[];
  layers: TerrainLayer[];
  activeLayerId: string | null;
  slopeTopology: SlopeTopologyRule[];
  heightmap?: TerrainHeightImport;
  masks: TerrainMaskImport[];
  /**
   * Flat starting floor. When set the generator writes this height everywhere
   * instead of noise, which backs the ocean/sandbox map starters and the
   * monument testing stage.
   */
  floorHeight?: number;
  /** Ground channel painted across the whole floor instead of height mixes. */
  floorSplat?: SplatChannel;
  /** Biome channel blended across the whole floor. */
  floorBiome?: BiomeChannel;
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface PrefabAsset {
  id: string;
  name: string;
  category: "Monument" | "Decor" | "Building" | "Vehicle" | "Entity" | "Terrain" | "Other";
  bounds: Bounds3;
  flattenRadius: number;
  hasLoot: boolean;
  hasIO: boolean;
  hasNpc: boolean;
  thumbnailPath?: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PrefabPlacement {
  id: string;
  assetId: string;
  name: string;
  position: Vec3;
  rotationEuler: Vec3;
  scale: Vec3;
  parentId: string | null;
  /** Horizontal collision half-extent in metres, before placement scale. */
  collisionRadius: number;
  /** Collision box height in metres, before placement scale. */
  collisionHeight: number;
  flatten: boolean;
  flattenRadius: number;
  flattenFalloff: number;
  clearFoliage: boolean;
  noBuildZone: boolean;
  lootTier: 1 | 2 | 3;
  lootProfile: string;
  ioWiring: string;
  npcCount: number;
  locked: boolean;
}

export type SplineKind =
  | "road"
  | "river"
  | "rail"
  | "apc"
  | "cargo"
  | "chinook"
  | "powerline"
  /** Underground tunnel path; carves surface portals into the alpha mask. */
  | "cave";
export type SplineCurve = "catmull-rom" | "bezier";

export interface SplineNode {
  x: number;
  y: number;
  z: number;
}

export interface RouteSpline {
  id: string;
  name: string;
  kind: SplineKind;
  width: number;
  closed: boolean;
  autoRoute: boolean;
  curve: SplineCurve;
  tension: number;
  deformTerrain: boolean;
  paintSplat: boolean;
  topologyFlag: TopologyFlag | null;
  nodes: SplineNode[];
  /** Cave/tunnel ceiling above the path, in metres. */
  ceilingHeight?: number;
  /** 0 = machined tunnel, 1 = very broken rock. Drives portal jitter. */
  roughness?: number;
  /** Segment preset: rock, mine shaft, sewer conduit or buildable chamber. */
  cavePreset?: CavePresetId;
}

export type CavePresetId = "natural" | "mine" | "sewer" | "chamber";

export type WeatherPreset = "clear" | "overcast" | "fog" | "dust";

/** Viewport-only sun/weather state; it is saved with the project. */
export interface LightingSettings {
  /** Minutes after midnight (0–1439). */
  timeOfDay: number;
  weather: WeatherPreset;
}

export type IOComponentKind =
  | "switch"
  | "card_reader"
  | "door"
  | "generator"
  | "timer"
  | "light"
  | "vending_machine";

export interface IONode {
  id: string;
  name: string;
  kind: IOComponentKind;
  placementId: string | null;
  x: number;
  z: number;
  cardLevel: "green" | "blue" | "red" | null;
}

export interface IOLink {
  id: string;
  from: string;
  to: string;
  cardLevel: "green" | "blue" | "red" | null;
}

export interface VendingOverride {
  id: string;
  placementId: string;
  profile: string;
  stock: number;
  priceMultiplier: number;
}

export interface IOGraph {
  nodes: IONode[];
  links: IOLink[];
  vendingOverrides: VendingOverride[];
}

export interface LootSettings {
  tier: 1 | 2 | 3;
  crateCount: number;
  vendingMachines: number;
  cardPuzzles: number;
  npcSpawners: number;
  radiationZones: number;
  noBuildZones: number;
  lootDensity: number;
  cardLevels: [boolean, boolean, boolean];
}

export interface MaterialLayer {
  id: string;
  preset: "metal" | "polymer" | "wood" | "carbon" | "custom";
  name: string;
  metallic: number;
  smoothness: number;
  baseColor: string;
  textureName: string | null;
  blend: "normal" | "multiply" | "overlay";
  scale: number;
  enabled: boolean;
}

export type DecalStamp = "stripe" | "hazard" | "circle" | "number" | "scratch" | "custom";
export type PaintMode = "projected" | "brush2d" | "brush3d";

export interface DecalStroke {
  id: string;
  stamp: DecalStamp;
  mode: PaintMode;
  color: string;
  size: number;
  opacity: number;
  rotation: number;
  uvAnchor: [number, number] | null;
}

export interface WearSettings {
  edgeWear: number;
  grunge: number;
  dirt: number;
  scratches: number;
  emissionStrength: number;
  lighting: "day" | "dusk" | "flashlight" | "night";
  showSeams: boolean;
}

export interface SkinSettings {
  baseMeshId: string | null;
  baseMeshName: string;
  uvChannels: number;
  resolution: 1024 | 2048;
  layers: MaterialLayer[];
  decals: DecalStroke[];
  wear: WearSettings;
  paintStrokes: number;
  smartProjection: boolean;
}

export interface ExportSettings {
  fileName: string;
  outputDir: string;
  stripEditorData: boolean;
  mapPassword: string;
  mapLock: boolean;
  workshopTags: string[];
  includeEmission: boolean;
}

export interface WizardDraft {
  /** Stable id used as the sync entity id; survives project renames. */
  projectId: string;
  name: string;
  mode: EntryMode;
  projectKind: ProjectKind;
  branch: Branch;
  syncEndpoint: string;
  studioMode: boolean;
  walkMode: boolean;
  lighting: LightingSettings;
  terrain: TerrainSettings;
  placements: PrefabPlacement[];
  selectedPlacementId: string | null;
  splines: RouteSpline[];
  io: IOGraph;
  loot: LootSettings;
  skin: SkinSettings;
  export: ExportSettings;
}

export interface StepMeta {
  id: WizardStepId;
  label: string;
  title: string;
  description: string;
  branch: Branch;
  /** Studio Mode unlocks manual controls, it never hides the step itself. */
  studioTools: string[];
}

export interface ValidationIssue {
  id: string;
  step: WizardStepId;
  severity: "error" | "warning" | "info";
  message: string;
  detail?: string;
}

export interface WizardState {
  draft: WizardDraft;
  stepId: WizardStepId;
  furthestIndex: number;
  dirty: boolean;
  lastSavedAt: string | null;
  exportReport: ExportReport | null;
}

export interface ExportReport {
  kind: "map" | "prefab" | "skin";
  path: string;
  bytes: number;
  channels?: string[];
  createdAt: string;
}
