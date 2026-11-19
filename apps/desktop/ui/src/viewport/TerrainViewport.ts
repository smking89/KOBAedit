import * as THREE from "three";
import type { TourAudio } from "../lib/promo";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import {
  applyBrushToPreview,
  brushSnapshot,
  samplePreviewHeight,
  type TerrainPreview,
} from "../lib/procedural";
import {
  extractPrefabGlb,
  isTauri,
  loadCachedMeshBytes,
  type TaskProgress,
} from "../lib/ipc";
import {
  BUILD_GRID,
  BUILD_LABELS,
  BUILD_LIFT,
  BUILD_PIECES,
  footprintCorners,
  foundationSample,
  hitsCaveWall,
  rotationStep,
  snapToSocket,
  socketHeight,
  triangleVertices,
  type BuildPiece,
  type BuildStructure,
} from "../lib/building";
import { cavePreset, caveSectionAt, caveWalkSurface } from "../lib/cave";
import { collisionExtents } from "../lib/collision";
import { blendHex, lightingState, UNDERGROUND_LIGHTING } from "../lib/lighting";
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  CROUCH_CAPSULE_HEIGHT,
  capsuleHits,
  jumpArc,
} from "../lib/walk";
import { detectQualityProfile } from "../lib/quality";
import { sampleSplineNodes } from "../lib/splineMath";
import { buildTerrainPreview } from "../lib/preview";
import { prefabThumbnailHash } from "../utils/thumbnailQueue";
import type {
  PrefabPlacement,
  RouteSpline,
  SplineKind,
  TerrainStroke,
  WizardDraft,
} from "../wizard/types";
import {
  BIOME_PALETTE,
  SPLAT_PALETTE,
  terrainFragmentShader,
  terrainVertexShader,
} from "./shaders/terrain";

const CATEGORY_COLORS: Record<string, number> = {
  Monument: 0xd9a45b,
  Decor: 0x5f8f5a,
  Building: 0x8b93a1,
  Vehicle: 0x9a6fbf,
  Entity: 0x55a3c9,
  Terrain: 0x6f9461,
  Path: 0xb9a06a,
  Other: 0x7c8794,
};
const SPLINE_COLORS: Record<SplineKind, number> = {
  road: 0x8a7f6a,
  river: 0x2f7fa8,
  rail: 0xb5b9c0,
  apc: 0xc06a6a,
  cargo: 0x7f9fc0,
  cave: 0xd0a273,
  chinook: 0x9ac0a0,
  powerline: 0xc9b16a,
};

let savedCamera: {
  size: number;
  position: [number, number, number];
  target: [number, number, number];
} | null = null;

interface TerrainUniforms {
  uSplatA: THREE.IUniform<THREE.Texture | null>;
  uSplatB: THREE.IUniform<THREE.Texture | null>;
  uBiomeMap: THREE.IUniform<THREE.Texture | null>;
  uAlphaMap: THREE.IUniform<THREE.Texture | null>;
  uTopologyMap: THREE.IUniform<THREE.Texture | null>;
  uSplatColors: THREE.IUniform<THREE.Vector3[]>;
  uBiomeColors: THREE.IUniform<THREE.Vector3[]>;
  uSunDirection: THREE.IUniform<THREE.Vector3>;
  uShowTopology: THREE.IUniform<number>;
  uShowAlphaMask: THREE.IUniform<number>;
  uWaterLevel: THREE.IUniform<number>;
}

/** Conforming footprint previewed while a prefab hovers over the terrain. */
export interface DragGhost {
  x: number;
  z: number;
  /** Flatten pad radius, in metres (mirrors `flattenRadius`). */
  radius: number;
  falloff: number;
  /** Ground under the cursor is too steep for a clean pad. */
  steep: boolean;
}

/** Callbacks the shell registers on the terrain viewport. */
export interface TerrainHandlers {
  /** A prefab marker was clicked; keep its selection in sync with the outliner. */
  onSelectPlacement?: (id: string | null) => void;
  /** A prefab was dragged to a new spot on the map (reconformed on drop). */
  onMovePlacement?: (id: string, position: { x: number; y: number; z: number }) => void;
  /** Walk Mode build-plan readout for the HUD. */
  onBuildStatus?: (status: BuildPlanStatus | null) => void;
  /** F-key flashlight state for the HUD. */
  onFlashlight?: (on: boolean) => void;
  /** `[` / `]`: scrub the shared time-of-day by ±1 hour. */
  onScrubTime?: (deltaMinutes: number) => void;
  /** Esc outside build mode leaves Walk Mode. */
  onExitWalk?: () => void;
  /** Nearest collision-proxy the walker capsule overlaps, if any. */
  onWalkCollision?: (name: string | null) => void;
  /** Double-clicked placement: open it in the Monument workspace. */
  onOpenPlacement?: (id: string) => void;
}

const JUMP_ARC_STEPS = 24;

/** Cached cave axis samples: rebuild only when the spline array changes. */
interface CaveEntry {
  id: string;
  width: number;
  height: number;
  samples: { x: number; y: number; z: number }[];
}

export interface BuildPlanStatus {
  piece: BuildPiece;
  pieceLabel: string;
  valid: boolean;
  reason: string;
  placed: number;
}

function buildGeometry(piece: BuildPiece): THREE.BufferGeometry {
  if (piece === "triangle") {
    // Exact equilateral triangle: vertices on the 1.7321 m circumradius so the
    // 3 m sides and 2.5981 m altitude match Rust's triangle foundation.
    const shape = new THREE.Shape();
    triangleVertices().forEach((vertex, index) => {
      if (index === 0) shape.moveTo(vertex.x, -vertex.z);
      else shape.lineTo(vertex.x, -vertex.z);
    });
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -0.15, 0);
    return geometry;
  }
  if (piece === "wall") return new THREE.BoxGeometry(3, 3, 0.25);
  if (piece === "floor") return new THREE.BoxGeometry(3, 0.2, 3);
  if (piece === "stairs") {
    // 6 × 0.5 m risers over a 3 m run, 3 m wide, anchored at the floor.
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let step = 0; step < 6; step += 1) {
      shape.lineTo(step * 0.5, (step + 1) * 0.5);
      shape.lineTo((step + 1) * 0.5, (step + 1) * 0.5);
    }
    shape.lineTo(3, 0);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false });
    geometry.translate(-1.5, 0, -1.5);
    return geometry;
  }
  return new THREE.BoxGeometry(3, 0.3, 3);
}

export class TerrainViewport {
  private host: HTMLElement;
  private onExtraction?: (progress: TaskProgress | null, running: boolean) => void;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private radarSaved: {
    position: THREE.Vector3;
    target: THREE.Vector3;
    up: THREE.Vector3;
  } | null = null;
  private terrain: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private ambientLight: THREE.AmbientLight;
  private sunLight: THREE.DirectionalLight;
  private grid: THREE.GridHelper | null = null;
  private markerGroup = new THREE.Group();
  private buildGroup = new THREE.Group();
  private ghostGroup: THREE.Group | null = null;
  private dragGhost: DragGhost | null = null;
  private prefabGroup = new THREE.Group();
  private proxyGroup = new THREE.Group();
  private prefabTemplates = new Map<string, THREE.Group>();
  private loadingPrefabs = new Set<string>();
  private walkMode = false;
  private walkPosition = new THREE.Vector3();
  private walkVelocity = new THREE.Vector3();
  private walkYaw = 0;
  private walkPitch = 0;
  private walkGrounded = true;
  private walkKeys = new Set<string>();
  /** Touch overlay input, merged with the hardware key set. */
  private walkVirtual = new Set<string>();
  private walkTouch: { id: number; x: number; y: number } | null = null;
  private walkSavedCamera: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private buildPlan: {
    piece: BuildPiece;
    rotation: number;
    status: BuildPlanStatus | null;
  } | null = null;
  private buildGhost: THREE.Mesh | null = null;
  private buildGhostPiece: BuildPiece | null = null;
  private buildStructures: THREE.Mesh[] = [];
  private buildData: BuildStructure[] = [];
  private buildFootprint: THREE.LineLoop | null = null;
  private buildFootprintPiece: BuildPiece | null = null;
  private rebuildTimer: number | null = null;
  private caveSplineRef: RouteSpline[] | null = null;
  private caveEntriesCache: CaveEntry[] = [];
  private flashlight: THREE.SpotLight | null = null;
  private flashlightOn = false;
  private walkArc: THREE.Line | null = null;
  private walkArcPositions: Float32Array | null = null;
  private collisionMarker: THREE.Mesh | null = null;
  private walkCollisionId: string | null = null;
  private lastFrameTime = 0;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial;
  private uniforms: TerrainUniforms;
  private textures: THREE.Texture[] = [];
  private preview: TerrainPreview | null = null;
  private draft: WizardDraft | null = null;
  private settingsKey = "";
  private markerKey = "";
  private lightingKey = "";
  private underground = false;
  /** Placement currently being dragged across the terrain. */
  private moving: {
    id: string;
    pointerId: number;
    pointerX: number;
    pointerY: number;
    x: number;
    y: number;
    z: number;
    moved: boolean;
  } | null = null;
  private studioMode = false;
  private stepId = "";
  private painting = false;
  private raycastPointer = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private pendingGeometryUpdate = false;
  private renderQueued = true;
  private readonly quality = detectQualityProfile();
  private readonly segments = this.quality.terrainSegments;
  private onSculpt: (strokes: TerrainStroke[]) => void;
  private handlers: TerrainHandlers;
  private strokeBuffer: TerrainStroke[] = [];

  constructor(
    host: HTMLElement,
    onSculpt: (strokes: TerrainStroke[]) => void,
    onExtraction?: (progress: TaskProgress | null, running: boolean) => void,
    handlers: TerrainHandlers = {},
  ) {
    this.host = host;
    this.onExtraction = onExtraction;
    this.onSculpt = onSculpt;
    this.handlers = handlers;
    document.addEventListener("keydown", this.onGlobalKeyDown);
    this.host.dataset.quality = this.quality.tier;
    this.host.dataset.qualitySegments = String(this.quality.terrainSegments);
    this.host.dataset.qualityResolution = String(this.quality.previewResolution);
    this.host.dataset.qualityPixelRatio = String(this.quality.pixelRatio);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090a0c);
    this.scene.fog = new THREE.Fog(0x0b0e12, 1600, 5200);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 12000);
    this.camera.position.set(1100, 900, 1400);

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality.antialias,
      powerPreference: this.quality.tier === "low" ? "default" : "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.tabIndex = 0;
    this.host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = false;
    this.controls.target.set(0, 40, 0);
    this.controls.addEventListener("change", this.requestRender);

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.sunLight = new THREE.DirectionalLight(0xfff3df, 1.4);
    this.sunLight.position.set(500, 900, 400);
    this.scene.add(this.ambientLight, this.sunLight);
    this.scene.add(this.markerGroup, this.prefabGroup, this.proxyGroup, this.buildGroup);
    // The camera is in the graph so the flashlight can be parented to it.
    this.scene.add(this.camera);
    this.flashlight = new THREE.SpotLight(0xfff1d6, 0, 60, 0.5, 0.45, 1.1);
    this.flashlight.target.position.set(0, 0, -1);
    this.camera.add(this.flashlight, this.flashlight.target);

    // Walk-mode validation: jump parabola and capsule/proxy overlap outline.
    this.walkArcPositions = new Float32Array((JUMP_ARC_STEPS + 1) * 3);
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute("position", new THREE.BufferAttribute(this.walkArcPositions, 3));
    arcGeometry.setDrawRange(0, 0);
    this.walkArc = new THREE.Line(
      arcGeometry,
      new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.8 }),
    );
    this.walkArc.visible = false;
    this.walkArc.renderOrder = 5;
    this.scene.add(this.walkArc);

    this.collisionMarker = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xe05a5a,
        wireframe: true,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.collisionMarker.visible = false;
    this.scene.add(this.collisionMarker);

    this.uniforms = {
      uSplatA: { value: null },
      uSplatB: { value: null },
      uBiomeMap: { value: null },
      uAlphaMap: { value: null },
      uTopologyMap: { value: null },
      uSplatColors: { value: SPLAT_PALETTE.map((color) => new THREE.Vector3(...color)) },
      uBiomeColors: { value: BIOME_PALETTE.map((color) => new THREE.Vector3(...color)) },
      uSunDirection: { value: new THREE.Vector3(0.45, 0.8, 0.35).normalize() },
      uShowTopology: { value: 0 },
      uShowAlphaMask: { value: 0 },
      uWaterLevel: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms } as unknown as Record<string, THREE.IUniform>,
      vertexShader: terrainVertexShader,
      fragmentShader: terrainFragmentShader,
      side: THREE.FrontSide,
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.attachPointerHandlers();
    this.resize();
    this.requestRender();
  }

  setDraft(draft: WizardDraft): void {
    const previousSize = this.draft?.terrain.sizeMetres;
    this.draft = draft;
    const key = JSON.stringify({
      seed: draft.terrain.seed,
      preset: draft.terrain.preset,
      size: draft.terrain.sizeMetres,
      mountain: draft.terrain.mountainScale,
      water: draft.terrain.waterLevel,
      detail: draft.terrain.detail,
      biome: draft.terrain.biomeWeights,
      floorHeight: draft.terrain.floorHeight ?? null,
      floorSplat: draft.terrain.floorSplat ?? null,
      floorBiome: draft.terrain.floorBiome ?? null,
      placements: draft.placements.map((placement) => ({
        assetId: placement.assetId,
        x: placement.position.x,
        y: placement.position.y,
        z: placement.position.z,
        rotation: placement.rotationEuler,
        scale: placement.scale,
        radius: placement.flattenRadius,
        falloff: placement.flattenFalloff,
        flatten: placement.flatten,
      })),
      splines: draft.splines.map((spline) => ({
        kind: spline.kind,
        width: spline.width,
        closed: spline.closed,
        curve: spline.curve,
        tension: spline.tension,
        deformTerrain: spline.deformTerrain,
        paintSplat: spline.paintSplat,
        topologyFlag: spline.topologyFlag,
        nodes: spline.nodes,
      })),
      heightmap: draft.terrain.heightmap
        ? `${draft.terrain.heightmap.name}:${draft.terrain.heightmap.data.length}`
        : null,
      masks:
        draft.terrain.masks?.map((mask) => `${mask.name}:${mask.channel}:${mask.data.length}`) ?? [],
      // Layer order, visibility and opacity all change the replayed terrain.
      layers: (draft.terrain.layers ?? []).map((layer) => ({
        id: layer.id,
        visible: layer.visible,
        opacity: layer.opacity,
        count: layer.strokes.length,
        last: layer.strokes[layer.strokes.length - 1]?.id ?? null,
      })),
      legacyStrokes: draft.terrain.strokes?.length ?? 0,
      slopeTopology: draft.terrain.slopeTopology ?? [],
    });

    const terrainChanged = key !== this.settingsKey;
    if (terrainChanged) {
      this.settingsKey = key;
      // Geometry + texture rebuild is the expensive path; coalesce bursts
      // (stroke commits, opacity sliders, layer toggles) into one rebuild.
      this.scheduleRegenerate();
      if (previousSize === undefined || previousSize !== draft.terrain.sizeMetres) {
        if (savedCamera && savedCamera.size === draft.terrain.sizeMetres) {
          this.camera.position.set(...savedCamera.position);
          this.controls.target.set(...savedCamera.target);
          this.controls.update();
        } else {
          this.fitCamera(draft.terrain.sizeMetres);
        }
      }
    }

    if (this.walkMode !== draft.walkMode) this.setWalkMode(draft.walkMode);

    if (this.water) {
      this.water.position.y = draft.terrain.waterLevel;
    }
    if (this.grid) {
      this.grid.position.y = -60;
    }
    this.uniforms.uShowTopology.value = draft.studioMode ? 1 : 0.0;
    // Lighting is a viewport preference: it must not rebuild terrain geometry.
    const lightingKey = JSON.stringify(draft.lighting ?? null);
    if (lightingKey !== this.lightingKey) {
      this.lightingKey = lightingKey;
      this.applyEnvironment();
    }
    const markerKey = JSON.stringify({
      placements: draft.placements.map((placement) => ({
        id: placement.id,
        assetId: placement.assetId,
        position: placement.position,
        rotation: placement.rotationEuler,
        scale: placement.scale,
        radius: placement.flattenRadius,
        flatten: placement.flatten,
      })),
      selected: draft.selectedPlacementId,
      splines: draft.splines,
    });
    if (markerKey !== this.markerKey || terrainChanged) {
      this.markerKey = markerKey;
      this.updateMarkers(draft);
    }
    this.updateLod();
    this.requestRender();
  }

  setInteraction(stepId: string, studioMode: boolean): void {
    this.stepId = stepId;
    this.studioMode = studioMode;
    this.host.classList.toggle("is-sculpting", this.canSculpt());
  }

  private canSculpt(): boolean {
    return this.studioMode && this.stepId === "terrain" && this.draft?.branch === "world";
  }

  private scheduleRegenerate(): void {
    if (!this.preview) {
      // First build must be synchronous: the camera fit, walk spawn and marker
      // placement all sample the preview right after setDraft.
      this.regenerate();
      this.applyEnvironment();
      return;
    }
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      if (this.disposed || !this.draft) return;
      this.regenerate();
      this.applyEnvironment();
      this.updateMarkers(this.draft);
      this.requestRender();
    }, 120);
  }

  private regenerate(): void {
    if (!this.draft) return;
    const preview = buildTerrainPreview(this.draft, this.quality.previewResolution);
    this.preview = preview;
    this.uniforms.uWaterLevel.value = this.draft.terrain.waterLevel;
    this.buildGeometry(preview);
    this.buildTextures(preview);
    this.buildGrid(this.draft.terrain.sizeMetres);
    this.buildWater(this.draft.terrain.sizeMetres, this.draft.terrain.waterLevel);
  }

  private buildGeometry(preview: TerrainPreview): void {
    const size = this.draft?.terrain.sizeMetres ?? 4500;
    const resolution = preview.resolution;
    const vertexCount = this.segments + 1;
    const positions = new Float32Array(vertexCount * vertexCount * 3);
    const uvs = new Float32Array(vertexCount * vertexCount * 2);
    const indices: number[] = [];

    for (let row = 0; row < vertexCount; row += 1) {
      for (let column = 0; column < vertexCount; column += 1) {
        const index = row * vertexCount + column;
        const u = column / this.segments;
        const v = row / this.segments;
        const worldX = u * size - size / 2;
        const worldZ = v * size - size / 2;
        const gridX = Math.min(resolution - 1, Math.round(u * (resolution - 1)));
        const gridZ = Math.min(resolution - 1, Math.round(v * (resolution - 1)));
        const height = preview.heights[gridZ * resolution + gridX];
        positions[index * 3] = worldX;
        positions[index * 3 + 1] = height;
        positions[index * 3 + 2] = worldZ;
        uvs[index * 2] = u;
        uvs[index * 2 + 1] = v;
      }
    }

    for (let row = 0; row < this.segments; row += 1) {
      for (let column = 0; column < this.segments; column += 1) {
        const a = row * vertexCount + column;
        const b = a + 1;
        const c = a + vertexCount;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    if (this.terrain) {
      this.terrain.geometry.dispose();
      this.terrain.geometry = geometry;
    } else {
      this.terrain = new THREE.Mesh(geometry, this.material);
      this.terrain.frustumCulled = false;
      this.scene.add(this.terrain);
    }
    this.geometry = geometry;
  }

  private buildTextures(preview: TerrainPreview): void {
    for (const texture of this.textures) texture.dispose();
    this.textures = [];

    const texels = preview.resolution * preview.resolution;
    const splatA = new Uint8Array(texels * 4);
    const splatB = new Uint8Array(texels * 4);
    const biome = new Uint8Array(texels * 4);
    const topology = new Uint8Array(texels * 4);
    const alpha = new Uint8Array(texels);

    for (let index = 0; index < texels; index += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        splatA[index * 4 + channel] = preview.splat[index * 8 + channel];
        splatB[index * 4 + channel] = preview.splat[index * 8 + channel + 4];
        biome[index * 4 + channel] = preview.biome[index * 4 + channel];
      }
      const value = preview.topology[index] >>> 0;
      topology[index * 4] = value & 0xff;
      topology[index * 4 + 1] = (value >>> 8) & 0xff;
      topology[index * 4 + 2] = (value >>> 16) & 0xff;
      topology[index * 4 + 3] = (value >>> 24) & 0xff;
      alpha[index] = preview.alpha[index];
    }

    const make = (data: Uint8Array, width: number): THREE.DataTexture => {
      const texture = new THREE.DataTexture(data as unknown as BufferSource, width, width, THREE.RGBAFormat);
      texture.needsUpdate = true;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      return texture;
    };

    const alphaTexture = new THREE.DataTexture(
      alpha as unknown as BufferSource,
      preview.resolution,
      preview.resolution,
      THREE.RedFormat,
    );
    alphaTexture.needsUpdate = true;
    alphaTexture.magFilter = THREE.LinearFilter;
    alphaTexture.minFilter = THREE.LinearFilter;
    alphaTexture.generateMipmaps = false;
    alphaTexture.unpackAlignment = 1;

    this.uniforms.uSplatA.value = make(splatA, preview.resolution);
    this.uniforms.uSplatB.value = make(splatB, preview.resolution);
    this.uniforms.uBiomeMap.value = make(biome, preview.resolution);
    this.uniforms.uTopologyMap.value = make(topology, preview.resolution);
    this.uniforms.uAlphaMap.value = alphaTexture;
    this.textures.push(
      this.uniforms.uSplatA.value,
      this.uniforms.uSplatB.value,
      this.uniforms.uBiomeMap.value,
      this.uniforms.uTopologyMap.value,
      alphaTexture,
    );
  }

  private buildWater(size: number, level: number): void {
    const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x0f3b4f,
      transparent: true,
      opacity: 0.62,
      roughness: 0.18,
      metalness: 0.15,
    });
    if (this.water) {
      this.water.geometry.dispose();
      (this.water.material as THREE.Material).dispose();
      this.water.geometry = geometry;
      this.water.material = material;
      this.water.position.y = level;
      return;
    }
    this.water = new THREE.Mesh(geometry, material);
    this.water.position.y = level;
    this.water.renderOrder = 2;
    this.scene.add(this.water);
  }

  private buildGrid(size: number): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    this.grid = new THREE.GridHelper(size, 32, 0x2a323b, 0x171d24);
    this.grid.position.y = -60;
    this.scene.add(this.grid);
  }

  private fitCamera(size: number): void {
    const distance = size * 0.9;
    this.camera.position.set(distance * 0.62, distance * 0.55, distance * 0.72);
    this.controls.target.set(0, 30, 0);
    this.controls.update();
    this.requestRender();
    this.camera.near = Math.max(0.5, size / 4000);
    this.camera.far = size * 6;
    this.camera.updateProjectionMatrix();
  }

  private updateMarkers(draft: WizardDraft): void {
    while (this.markerGroup.children.length) {
      const child = this.markerGroup.children.pop();
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const material = child.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material.dispose();
      }
    }

    for (const placement of draft.placements) {
      this.addPlacementMarker(placement, placement.id === draft.selectedPlacementId);
    }
    for (const spline of draft.splines) {
      this.addSpline(spline);
    }
    this.rebuildPrefabs(draft);
  }

  private addPlacementMarker(placement: PrefabPlacement, selected: boolean): void {
    const baseHeight = this.preview
      ? samplePreviewHeight(
          this.preview,
          placement.position.x,
          placement.position.z,
          this.draft?.terrain.sizeMetres ?? 4500,
        )
      : 0;
    if (placement.flatten) {
      const radius = Math.max(10, placement.flattenRadius);
      const disk = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 48),
        new THREE.MeshBasicMaterial({
          color: 0x5ea8ff,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      disk.rotation.x = -Math.PI / 2;
      disk.position.set(placement.position.x, baseHeight + 0.6, placement.position.z);
      disk.userData.placementId = placement.id;
      this.markerGroup.add(disk);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius, radius + 3, 48),
        new THREE.MeshBasicMaterial({ color: 0x5ea8ff, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(placement.position.x, baseHeight + 0.8, placement.position.z);
      ring.userData.placementId = placement.id;
      this.markerGroup.add(ring);
    }

    if (selected) {
      const size = Math.max(6, collisionExtents(placement).reach || 8);
      const selection = new THREE.Mesh(
        new THREE.RingGeometry(size, size + 2.5, 4),
        new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      selection.rotation.x = -Math.PI / 2;
      selection.position.set(placement.position.x, baseHeight + 1.2, placement.position.z);
      selection.userData.placementId = placement.id;
      this.markerGroup.add(selection);
    }
  }

  private clearProxyGroup(): void {
    while (this.proxyGroup.children.length) {
      const child = this.proxyGroup.children.pop();
      if (!(child instanceof THREE.Mesh)) continue;
      child.geometry.dispose();
      const material = child.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    }
  }

  private clearInstancedGroup(): void {
    while (this.prefabGroup.children.length) {
      const child = this.prefabGroup.children.pop();
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
  }

  private placementMatrix(placement: PrefabPlacement): THREE.Matrix4 {
    const baseHeight = this.preview
      ? samplePreviewHeight(
          this.preview,
          placement.position.x,
          placement.position.z,
          this.draft?.terrain.sizeMetres ?? 4500,
        )
      : 0;
    const position = new THREE.Vector3(
      placement.position.x,
      baseHeight + placement.position.y,
      placement.position.z,
    );
    const rotation = new THREE.Euler(
      THREE.MathUtils.degToRad(placement.rotationEuler.x),
      THREE.MathUtils.degToRad(placement.rotationEuler.y),
      THREE.MathUtils.degToRad(placement.rotationEuler.z),
      "YXZ",
    );
    const scale = new THREE.Vector3(
      Math.max(0.001, placement.scale.x),
      Math.max(0.001, placement.scale.y),
      Math.max(0.001, placement.scale.z),
    );
    return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale);
  }

  private rebuildPrefabs(draft: WizardDraft): void {
    this.clearProxyGroup();
    this.clearInstancedGroup();
    const byAsset = new Map<string, PrefabPlacement[]>();
    for (const placement of draft.placements) {
      const list = byAsset.get(placement.assetId) ?? [];
      list.push(placement);
      byAsset.set(placement.assetId, list);
    }

    for (const placement of draft.placements) {
      // Draw the same extents validation uses: no extra clamping, because a
      // proxy smaller than the checked footprint would hide overhangs.
      const radius = Math.max(0.5, placement.collisionRadius || 0.5);
      const height = Math.max(0.5, placement.collisionHeight || 0.5);
      const category = placement.assetId.toLowerCase().includes("decor") ? "Decor" : "Monument";
      const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(radius * 2, height, radius * 2),
        new THREE.MeshBasicMaterial({
          color: CATEGORY_COLORS[category] ?? 0x8b93a1,
          transparent: true,
          opacity: 0.55,
          wireframe: true,
          depthWrite: false,
        }),
      );
      proxy.userData.placementId = placement.id;
      this.placementMatrix(placement).decompose(
        proxy.position,
        proxy.quaternion,
        proxy.scale,
      );
      proxy.position.y += (height * proxy.scale.y) / 2;
      this.proxyGroup.add(proxy);
    }

    for (const [assetId, placements] of byAsset) {
      const template = this.prefabTemplates.get(assetId);
      if (template) {
        this.addInstancedTemplate(template, placements);
      } else {
        void this.loadPrefabTemplate(assetId);
      }
    }
    this.updateLod();
  }

  private addInstancedTemplate(template: THREE.Group, placements: PrefabPlacement[]): void {
    template.updateMatrixWorld(true);
    let added = 0;
    template.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const batch = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length);
      const matrix = new THREE.Matrix4();
      placements.forEach((placement, index) => {
        matrix.multiplyMatrices(this.placementMatrix(placement), mesh.matrixWorld);
        batch.setMatrixAt(index, matrix);
      });
      batch.instanceMatrix.needsUpdate = true;
      batch.frustumCulled = false;
      this.prefabGroup.add(batch);
      added += 1;
    });
    if (!added) this.prefabGroup.visible = false;
  }

  private async loadPrefabTemplate(assetId: string): Promise<void> {
    if (this.loadingPrefabs.has(assetId)) return;
    this.loadingPrefabs.add(assetId);
    try {
      let bytes = await loadCachedMeshBytes(prefabThumbnailHash(assetId));
      if (!bytes && isTauri()) {
        // A placed prefab may never have appeared in the asset drawer. Pull
        // its real geometry on demand instead of leaving the proxy box.
        this.onExtraction?.(null, true);
        try {
          await extractPrefabGlb(assetId, undefined, (progress) => {
            this.onExtraction?.(progress, true);
          });
        } finally {
          this.onExtraction?.(null, false);
        }
        bytes = await loadCachedMeshBytes(prefabThumbnailHash(assetId));
      }
      if (!bytes || this.disposed) return;
      const result = await new GLTFLoader().parseAsync(bytes.slice().buffer, "");
      result.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        const material = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (material) material.side = THREE.DoubleSide;
      });
      this.prefabTemplates.set(assetId, result.scene);
      if (this.draft) this.rebuildPrefabs(this.draft);
    } catch {
      // No cached GLB yet: the category proxy remains in place.
    } finally {
      this.loadingPrefabs.delete(assetId);
    }
  }

  private updateLod(): void {
    const size = this.draft?.terrain.sizeMetres ?? 4500;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = distance <= size * 0.44;
    this.prefabGroup.visible = near && this.prefabGroup.children.length > 0;
    this.proxyGroup.visible = !this.prefabGroup.visible;
  }

  private addSpline(spline: RouteSpline): void {
    if (spline.nodes.length < 2) return;
    if (spline.kind === "cave") {
      this.addCaveTunnel(spline);
      return;
    }
    const sampled = sampleSplineNodes(
      spline.nodes,
      spline.closed,
      spline.curve ?? "catmull-rom",
      Math.max(8, Math.round(10 + (1 - (spline.tension ?? 0.5)) * 8)),
    );
    const points = sampled.map((point) => new THREE.Vector3(point.x, 0, point.z));
    for (const point of points) {
      point.y = this.preview
        ? samplePreviewHeight(this.preview, point.x, point.z, this.draft?.terrain.sizeMetres ?? 4500) + 2
        : 2;
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: SPLINE_COLORS[spline.kind] ?? 0xaaaaaa,
      transparent: true,
      opacity: 0.95,
    });
    this.markerGroup.add(new THREE.Line(geometry, material));
  }

  // -------------------------------------------------------------------------
  // Walk Mode build plan (temporary, never written to the project)
  // -------------------------------------------------------------------------

  private toggleBuildPlan(): void {
    if (this.buildPlan) {
      this.buildPlan = null;
      this.clearBuilds();
      this.handlers.onBuildStatus?.(null);
      return;
    }
    this.buildPlan = { piece: "foundation", rotation: 0, status: null };
    this.updateBuildGhost(true);
  }

  /** Public: HUD "Clear test builds" action. */
  clearTestBuilds(): void {
    this.clearBuilds();
  }

  private cycleBuildPiece(): void {
    if (!this.buildPlan) return;
    const index = BUILD_PIECES.indexOf(this.buildPlan.piece);
    this.buildPlan.piece = BUILD_PIECES[(index + 1) % BUILD_PIECES.length];
    this.updateBuildGhost(true);
  }

  private setFlashlight(on: boolean): void {
    this.flashlightOn = on;
    if (this.flashlight) this.flashlight.intensity = on ? 60 : 0;
    this.handlers.onFlashlight?.(on);
    this.requestRender();
  }

  /** X: remove the test piece closest to the aim point. */
  private demolishAimed(): void {
    if (!this.buildData.length) return;
    const aim = this.buildAim();
    const targetX = aim?.point.x ?? this.walkPosition.x;
    const targetZ = aim?.point.z ?? this.walkPosition.z;
    let best = -1;
    let bestDistance = 5;
    this.buildData.forEach((structure, index) => {
      const distance = Math.hypot(structure.x - targetX, structure.z - targetZ);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best < 0) return;
    const mesh = this.buildStructures[best];
    this.buildGroup.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.buildStructures.splice(best, 1);
    this.buildData.splice(best, 1);
    this.updateBuildGhost(true);
  }

  private clearBuilds(): void {
    for (const structure of this.buildStructures) {
      this.buildGroup.remove(structure);
      structure.geometry.dispose();
      (structure.material as THREE.Material).dispose();
    }
    this.buildStructures = [];
    this.buildData = [];
    if (this.buildFootprint) {
      this.buildGroup.remove(this.buildFootprint);
      this.buildFootprint.geometry.dispose();
      (this.buildFootprint.material as THREE.Material).dispose();
      this.buildFootprint = null;
      this.buildFootprintPiece = null;
    }
    if (this.buildGhost) {
      this.buildGroup.remove(this.buildGhost);
      this.buildGhost.geometry.dispose();
      (this.buildGhost.material as THREE.Material).dispose();
      this.buildGhost = null;
      this.buildGhostPiece = null;
    }
    if (this.buildPlan) {
      this.handlers.onBuildStatus?.({
        piece: this.buildPlan.piece,
        pieceLabel: BUILD_LABELS[this.buildPlan.piece],
        valid: false,
        reason: "Test builds cleared",
        placed: 0,
      });
    }
  }

  private updateBuildGhost(force = false): void {
    if (!this.buildPlan || !this.preview) return;
    if (!this.buildGhost) {
      this.buildGhost = new THREE.Mesh(
        buildGeometry(this.buildPlan.piece),
        new THREE.MeshBasicMaterial({
          color: 0x58c26a,
          transparent: true,
          opacity: 0.38,
          depthWrite: false,
        }),
      );
      this.buildGhost.renderOrder = 4;
      this.buildGhostPiece = this.buildPlan.piece;
      this.buildGroup.add(this.buildGhost);
    }
    if (force || this.buildGhostPiece !== this.buildPlan.piece) {
      this.buildGhost.geometry.dispose();
      this.buildGhost.geometry = buildGeometry(this.buildPlan.piece);
      this.buildGhostPiece = this.buildPlan.piece;
    }
    const aim = this.buildAim();
    if (!aim) {
      this.buildGhost.visible = false;
      if (this.buildFootprint) this.buildFootprint.visible = false;
      this.handlers.onBuildStatus?.(null);
      return;
    }
    this.buildGhost.visible = true;
    this.buildGhost.position.copy(aim.point);
    this.buildGhost.position.y += BUILD_LIFT[this.buildPlan.piece];
    this.buildGhost.rotation.set(
      this.buildPlan.piece === "stairs" ? -Math.PI / 9 : 0,
      aim.rotation,
      0,
    );
    (this.buildGhost.material as THREE.MeshBasicMaterial).color.setHex(aim.valid ? 0x58c26a : 0xe05a5a);
    this.updateBuildFootprint(this.buildPlan.piece, aim);
    const status: BuildPlanStatus = {
      piece: this.buildPlan.piece,
      pieceLabel: BUILD_LABELS[this.buildPlan.piece],
      valid: aim.valid,
      reason: aim.reason,
      placed: this.buildStructures.length,
    };
    this.buildPlan.status = status;
    this.handlers.onBuildStatus?.(status);
  }

  /**
   * Draw the exact footprint the validator samples (same corners, same
   * rotation), so the ghost never claims ground it will not occupy.
   */
  private updateBuildFootprint(
    piece: BuildPiece,
    aim: { point: THREE.Vector3; valid: boolean; rotation: number },
  ): void {
    // Tracked separately from `buildGhostPiece`: that field is already updated
    // to the new piece before this runs, so reusing it would leave the previous
    // piece's outline on screen when the wheel swaps to a triangle/square.
    if (!this.buildFootprint || this.buildFootprintPiece !== piece) {
      if (this.buildFootprint) {
        this.buildGroup.remove(this.buildFootprint);
        this.buildFootprint.geometry.dispose();
        (this.buildFootprint.material as THREE.Material).dispose();
      }
      const points = footprintCorners(piece, 0, 0, 0).map(
        (corner) => new THREE.Vector3(corner.x, 0, corner.z),
      );
      this.buildFootprint = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xdff5e3, transparent: true, opacity: 0.95 }),
      );
      this.buildFootprint.renderOrder = 5;
      this.buildGroup.add(this.buildFootprint);
      this.buildFootprintPiece = piece;
    }
    this.buildFootprint.visible = true;
    this.buildFootprint.position.set(aim.point.x, aim.point.y + 0.04, aim.point.z);
    this.buildFootprint.rotation.y = aim.rotation;
    (this.buildFootprint.material as THREE.LineBasicMaterial).color.setHex(
      aim.valid ? 0xdff5e3 : 0xffb3b3,
    );
  }

  /**
   * Rust-style placement test: 3 m grid, slope limit, no-build volumes, cave
   * voids and temporary-structure spacing. Every failure carries a plain
   * English reason for the HUD.
   */
  private buildAim(): {
    point: THREE.Vector3;
    valid: boolean;
    reason: string;
    rotation: number;
  } | null {
    if (!this.preview || !this.draft || !this.buildPlan) return null;
    const size = this.draft.terrain.sizeMetres;
    const half = size / 2;
    const piece = this.buildPlan.piece;
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const origin = this.camera.position.clone();
    const hit = this.terrain
      ? new THREE.Raycaster(origin, direction, 0.2, 45).intersectObject(this.terrain, false)[0]
      : undefined;
    let x: number;
    let z: number;
    if (hit) {
      x = hit.point.x;
      z = hit.point.z;
    } else {
      const flat = new THREE.Vector3(direction.x, 0, direction.z);
      if (flat.lengthSq() < 1e-4) return null;
      flat.normalize().multiplyScalar(4.5);
      x = origin.x + flat.x;
      z = origin.z + flat.z;
    }
    // A shallow look-down ray can travel to the far map edge (or hit terrain
    // from below); a build ghost belongs within arm's reach of the walker.
    if (this.walkMode) {
      const walker = this.walkPosition;
      if (Math.hypot(x - walker.x, z - walker.z) > 12) {
        const flat = new THREE.Vector3(direction.x, 0, direction.z);
        if (flat.lengthSq() > 1e-4) {
          flat.normalize().multiplyScalar(4.5);
          x = walker.x + flat.x;
          z = walker.z + flat.z;
        }
      }
    }
    x = Math.round(x / BUILD_GRID) * BUILD_GRID;
    z = Math.round(z / BUILD_GRID) * BUILD_GRID;

    // Edge sockets win over the free grid when a neighbouring edge is in reach.
    const snap = snapToSocket(piece, x, z, this.buildPlan.rotation, this.buildData);
    x = snap.x;
    z = snap.z;
    const rotation = snap.rotation;
    const parent = snap.socket
      ? (this.buildData.find((item) => item.id === snap.socket?.structureId) ?? null)
      : null;
    // Walls/floors/stairs socketed onto a piece adopt its top surface, so a
    // floor on a wall is a full storey up instead of on the ground.
    const elevated =
      parent !== null && (piece === "wall" || piece === "floor" || piece === "stairs");

    const corners = footprintCorners(piece, x, z, rotation);
    const cornerHeights = corners.map((corner) =>
      samplePreviewHeight(this.preview as TerrainPreview, corner.x, corner.z, size),
    );
    const lowest = Math.min(...cornerHeights);
    const baseY = elevated && parent ? socketHeight(piece, parent, lowest) : lowest;
    const point = new THREE.Vector3(x, baseY, z);
    const invalid = (reason: string) => ({ point, valid: false, reason, rotation });

    if (Math.abs(x) > half - 1 || Math.abs(z) > half - 1) return invalid("Outside the map");
    if (!elevated && lowest < this.draft.terrain.waterLevel) {
      return invalid("Below the water line");
    }

    // Corner-based embed and slope test (0.15–1.65 m, 35°); a piece mounted on
    // an existing structure is supported by it, not by the terrain.
    if (!elevated) {
      const foundation = foundationSample(piece, cornerHeights);
      if (foundation.reason) return invalid(foundation.reason);
    }

    const resolution = this.preview.resolution;
    const column = Math.min(
      resolution - 1,
      Math.max(0, Math.round(((x + half) / size) * (resolution - 1))),
    );
    const row = Math.min(
      resolution - 1,
      Math.max(0, Math.round(((z + half) / size) * (resolution - 1))),
    );
    if (this.preview.alpha[row * resolution + column] < 128) {
      return invalid("Blocked by cave void");
    }

    // Chamber cores disable PreventBuilding, so bases can be tested inside them.
    if (!this.insideChamber(x, z)) {
      for (const placement of this.draft.placements) {
        if (!placement.noBuildZone) continue;
        if (
          Math.hypot(placement.position.x - x, placement.position.z - z) <= placement.flattenRadius
        ) {
          return invalid(`Blocked by ${placement.name} no-build zone`);
        }
      }
    }

    for (const cave of this.caveEntries()) {
      for (const sample of cave.samples) {
        if (Math.abs(sample.y - baseY) > cave.height) continue;
        if (hitsCaveWall(Math.hypot(sample.x - x, sample.z - z), cave.width)) {
          return invalid("Blocked by Cave Wall / Rock");
        }
      }
    }

    for (const structure of this.buildData) {
      if (structure.id === parent?.id) continue;
      if (
        Math.hypot(structure.x - x, structure.z - z) < 0.5 &&
        Math.abs(structure.y - baseY) < 0.4
      ) {
        return invalid("Too close to another structure");
      }
    }
    return {
      point,
      valid: true,
      reason: snap.socket ? "Valid placement · snapped" : "Valid placement",
      rotation,
    };
  }

  /** True inside a buildable-chamber core, where PreventBuilding is disabled. */
  private insideChamber(x: number, z: number): boolean {
    for (const cave of this.draft?.splines ?? []) {
      if (cave.kind !== "cave" || cave.nodes.length < 2) continue;
      const preset = cavePreset(cave.cavePreset);
      if (!preset.chamber) continue;
      const ends = [cave.nodes[0], cave.nodes[cave.nodes.length - 1]];
      for (const end of ends) {
        if (Math.hypot(end.x - x, end.z - z) <= preset.chamberRadius) return true;
      }
    }
    return false;
  }

  private tryPlaceBuild(): void {
    if (!this.buildPlan) return;
    const aim = this.buildAim();
    if (!aim || !aim.valid) {
      this.updateBuildGhost();
      return;
    }
    const piece = this.buildPlan.piece;
    const structure = new THREE.Mesh(
      buildGeometry(piece),
      new THREE.MeshStandardMaterial({ color: 0x93a7bb, roughness: 0.82, metalness: 0.18 }),
    );
    structure.position.copy(aim.point);
    structure.position.y += BUILD_LIFT[piece];
    structure.rotation.set(piece === "stairs" ? -Math.PI / 9 : 0, aim.rotation, 0);
    this.buildGroup.add(structure);
    this.buildStructures.push(structure);
    this.buildData.push({
      id: `test-${this.buildData.length}-${Math.round(aim.point.x)}-${Math.round(aim.point.z)}`,
      piece,
      x: aim.point.x,
      y: aim.point.y,
      z: aim.point.z,
      rotation: aim.rotation,
    });
    this.updateBuildGhost(true);
  }

  // -------------------------------------------------------------------------
  // Cave tunnels
  // -------------------------------------------------------------------------

  private addCaveTunnel(spline: RouteSpline): void {
    const size = this.draft?.terrain.sizeMetres ?? 4500;
    const preset = cavePreset(spline.cavePreset);
    const surfaceAt = (x: number, z: number) =>
      this.preview ? samplePreviewHeight(this.preview, x, z, size) : 0;
    const points = spline.nodes.map((node) => new THREE.Vector3(node.x, node.y, node.z));
    // Centripetal Catmull-Rom (α = 0.5) keeps sharp turns from pinching.
    const curve = new THREE.CatmullRomCurve3(
      points,
      spline.closed,
      "centripetal",
      spline.tension ?? 0.5,
    );
    const length = curve.getLength();
    const radius = Math.max(1.2, preset.width * 0.5);
    const height = Math.max(1.5, preset.height);

    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.max(24, Math.round(length / 2)), radius, 12, spline.closed),
      new THREE.MeshBasicMaterial({
        color: 0xa8794f,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.markerGroup.add(tube);

    // Ribs on parallel-transport frames: no twist on vertical drops, spaced
    // every 4 m (or the preset's timber-arch spacing).
    const segments = Math.max(2, Math.round(length / 4));
    const frames = curve.computeFrenetFrames(segments, spline.closed);
    const ribGeometry = new THREE.TorusGeometry(radius, preset.supportEvery > 0 ? 0.2 : 0.14, 4, 18);
    const ribMaterial = new THREE.MeshBasicMaterial({
      color: preset.supportEvery > 0 ? 0xc79a63 : 0xd0a273,
      transparent: true,
      opacity: 0.55,
    });
    const basis = new THREE.Matrix4();
    for (let index = 0; index <= segments; index += 1) {
      if (preset.supportEvery === 0 && index % 3 !== 0) continue;
      const frameIndex = Math.min(index, frames.tangents.length - 1);
      const position = curve.getPointAt(Math.min(0.999, index / segments));
      basis.makeBasis(frames.normals[frameIndex], frames.binormals[frameIndex], frames.tangents[frameIndex]);
      const rib = new THREE.Mesh(ribGeometry, ribMaterial);
      rib.position.copy(position);
      rib.quaternion.setFromRotationMatrix(basis);
      // Natural rock gets ±12° deterministic roll jitter.
      if (preset.rollJitter > 0) {
        const jitter = Math.sin(index * 12.9898) * preset.rollJitter * (Math.PI / 180);
        rib.rotateOnAxis(frames.tangents[frameIndex].clone().normalize(), jitter);
      }
      this.markerGroup.add(rib);
    }

    // Industrial cage lamps every 12 m for mine shafts.
    if (preset.lampEvery > 0) {
      const lampGeometry = new THREE.SphereGeometry(0.22, 8, 6);
      const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
      const count = Math.max(1, Math.floor(length / preset.lampEvery));
      for (let index = 0; index < count; index += 1) {
        const lamp = new THREE.Mesh(lampGeometry, lampMaterial);
        lamp.position.copy(curve.getPointAt((index + 0.5) / count));
        lamp.position.y += height * 0.35;
        this.markerGroup.add(lamp);
      }
    }

    // Minecart track along the tunnel floor.
    if (preset.track) {
      const railPoints = curve.getSpacedPoints(Math.max(8, Math.round(length / 2)));
      const track = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(railPoints),
        new THREE.LineBasicMaterial({ color: 0xb9c0c8 }),
      );
      this.markerGroup.add(track);
    }

    // Sewer puddle: a flat plane just above the tunnel floor at the midpoint.
    if (preset.puddle) {
      const puddle = new THREE.Mesh(
        new THREE.CircleGeometry(radius * 0.9, 20),
        new THREE.MeshBasicMaterial({ color: 0x2f5f72, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      );
      puddle.rotation.x = -Math.PI / 2;
      puddle.position.copy(curve.getPointAt(0.5));
      puddle.position.y += 0.08;
      this.markerGroup.add(puddle);
    }

    // Buildable chamber stamp at both ends: a 12 m flat floor disc.
    if (preset.chamber) {
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(preset.width * 0.5, 32),
        new THREE.MeshBasicMaterial({ color: 0x6f7f8f, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      );
      floor.rotation.x = -Math.PI / 2;
      for (const node of [spline.nodes[0], spline.nodes[spline.nodes.length - 1]]) {
        const disc = floor.clone();
        disc.position.set(node.x, node.y + 0.15, node.z);
        this.markerGroup.add(disc);
      }
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
    }

    // Portal rings where the roof breaks the surface; the alpha hole itself is
    // carved by applyCavePortals so the render and the map agree.
    const samples = sampleSplineNodes(spline.nodes, spline.closed, spline.curve ?? "catmull-rom", 24);
    const portalRadius = preset.width * 0.65;
    const portalGeometry = new THREE.RingGeometry(portalRadius * 0.85, portalRadius, 24);
    const portalMaterial = new THREE.MeshBasicMaterial({
      color: 0xf2b56b,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    for (const sample of samples) {
      const surface = surfaceAt(sample.x, sample.z);
      if (sample.y + height * 0.5 < surface - 0.5) continue;
      const ring = new THREE.Mesh(portalGeometry, portalMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(sample.x, surface + 0.5, sample.z);
      this.markerGroup.add(ring);
    }
  }

  /** Cheap per-frame test: is the walker inside any cave tunnel volume? */
  /**
   * Cave axis samples, cached. Walk mode used to re-sample every spline on
   * every frame (and again for placement); the sample set only changes when
   * the spline array itself is replaced.
   */
  private caveEntries(): CaveEntry[] {
    const splines = this.draft?.splines ?? [];
    if (this.caveSplineRef === splines) return this.caveEntriesCache;
    this.caveSplineRef = splines;
    this.caveEntriesCache = splines
      .filter((spline) => spline.kind === "cave" && spline.nodes.length >= 2)
      .map((spline) => {
        const preset = cavePreset(spline.cavePreset);
        return {
          id: spline.id,
          width: preset.width,
          height: preset.height,
          samples: sampleSplineNodes(
            spline.nodes,
            spline.closed,
            spline.curve ?? "catmull-rom",
            18,
          ),
        };
      });
    return this.caveEntriesCache;
  }

  /** Nearest tunnel section under a point, or null outside every tunnel. */
  private walkKey(code: string): boolean {
    return this.walkKeys.has(code) || this.walkVirtual.has(code);
  }

  /** Straight-down orthographic-feeling radar view, restored afterwards. */
  setRadarCamera(): void {
    if (!this.radarSaved) {
      this.radarSaved = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        up: this.camera.up.clone(),
      };
    }
    const target = this.controls.target.clone();
    const height = Math.max(500, this.camera.position.distanceTo(target) * 1.6);
    this.camera.up.set(0, 0, -1);
    this.camera.position.set(target.x, target.y + height, target.z + 0.01);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.controls.update();
    this.host.dataset.camera = "radar";
    this.requestRender();
  }

  restoreRadarCamera(): void {
    const saved = this.radarSaved;
    if (!saved) return;
    this.radarSaved = null;
    this.camera.up.copy(saved.up);
    this.camera.position.copy(saved.position);
    this.controls.target.copy(saved.target);
    this.camera.lookAt(saved.target);
    this.controls.update();
    delete this.host.dataset.camera;
    this.requestRender();
  }

  /** Theme backdrop only; camera, build and walk state are untouched. */
  setBackdrop(theme: "dark" | "light"): void {
    const color = new THREE.Color(theme === "light" ? 0xe9ecef : 0x090a0c);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(color);
    } else {
      this.scene.background = color;
    }
    this.requestRender();
  }

  /** Renders the current view without UI helpers and copies it to a 2D canvas. */
  captureFrame(): HTMLCanvasElement | null {
    if (!this.renderer) return null;
    const grid = this.grid;
    const gridVisible = grid?.visible ?? false;
    if (grid) grid.visible = false;
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const output = document.createElement("canvas");
    output.width = source.width;
    output.height = source.height;
    output.getContext("2d")?.drawImage(source, 0, 0);
    if (grid) grid.visible = gridVisible;
    this.requestRender();
    return output;
  }

  /**
   * Records a camera tour to WebM. Each shot orbits its own focus; the caller
   * draws the watermark into `draw` so the recording matches the preview.
   */
  async recordTour(options: {
    shots: { x: number; z: number; radius: number; seconds: number }[];
    draw?: (ctx: CanvasRenderingContext2D, width: number, height: number, progress: number) => void;
    onProgress?: (progress: number) => void;
    audio?: TourAudio | null;
  }): Promise<Blob | null> {
    if (!this.renderer || !options.shots.length) return null;
    const source = this.renderer.domElement;
    const output = document.createElement("canvas");
    output.width = source.width;
    output.height = source.height;
    const ctx = output.getContext("2d");
    const canRecord =
      typeof MediaRecorder !== "undefined" &&
      typeof (output as HTMLCanvasElement & { captureStream?: unknown }).captureStream === "function";
    if (!ctx || !canRecord) return null;

    const grid = this.grid;
    const gridVisible = grid?.visible ?? false;
    if (grid) grid.visible = false;
    const savedPosition = this.camera.position.clone();
    const savedTarget = this.controls.target.clone();
    const savedControls = this.controls.enabled;
    this.controls.enabled = false;

    const mime =
      typeof MediaRecorder.isTypeSupported === "function"
        ? ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) =>
            MediaRecorder.isTypeSupported(type),
          )
        : undefined;
    const stream = output.captureStream(60);
    const total = options.shots.reduce((sum, shot) => sum + shot.seconds, 0);
    let audioContext: AudioContext | null = null;
    if (options.audio) {
      try {
        const context = new AudioContext();
        audioContext = context;
        void context.resume().catch(() => {});
        const mix = context.createMediaStreamDestination();
        const gain = context.createGain();
        const playback = Math.min(
          total,
          Math.max(0.2, options.audio.trimEnd - options.audio.trimStart),
        );
        const volume = Math.min(1, Math.max(0, options.audio.volume));
        const fadeIn = Math.max(0, Math.min(options.audio.fadeIn, playback / 2));
        const fadeOut = Math.max(0, Math.min(options.audio.fadeOut, playback - fadeIn));
        const now = context.currentTime;
        gain.gain.setValueAtTime(fadeIn > 0 ? 0 : volume, now);
        if (fadeIn > 0) gain.gain.linearRampToValueAtTime(volume, now + fadeIn);
        gain.gain.setValueAtTime(volume, now + Math.max(fadeIn, playback - fadeOut));
        gain.gain.linearRampToValueAtTime(0, now + playback);
        const track = context.createBufferSource();
        track.buffer = options.audio.buffer;
        track.loop = playback > Math.max(0.1, options.audio.trimEnd - options.audio.trimStart);
        track.connect(gain);
        gain.connect(mix);
        const offset = Math.min(
          Math.max(0, options.audio.trimStart),
          Math.max(0, options.audio.buffer.duration - 0.1),
        );
        track.start(now, offset, playback);
        mix.stream.getAudioTracks().forEach((audioTrack) => stream.addTrack(audioTrack));
      } catch {
        audioContext = null;
      }
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined,
      );
    } catch {
      // Fallback: let the browser choose its default container.
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        stream.getTracks().forEach((track) => track.stop());
        if (audioContext) void audioContext.close();
        this.camera.position.copy(savedPosition);
        this.controls.target.copy(savedTarget);
        this.controls.enabled = savedControls;
        if (grid) grid.visible = gridVisible;
        this.requestRender();
        return null;
      }
    }
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });
    recorder.start(250);

    const unit = new THREE.Vector3();
    await new Promise<void>((resolve) => {
      const started = performance.now();
      const tick = () => {
        const elapsed = (performance.now() - started) / 1000;
        let remaining = elapsed;
        let shot = options.shots[0];
        for (const candidate of options.shots) {
          if (remaining <= candidate.seconds) {
            shot = candidate;
            break;
          }
          remaining -= candidate.seconds;
          shot = candidate;
        }
        const focus = new THREE.Vector3(shot.x, this.controls.target.y, shot.z);
        const angle = (remaining / Math.max(0.001, shot.seconds)) * Math.PI * 2;
        unit.set(Math.sin(angle), 0.42, Math.cos(angle)).normalize();
        this.camera.position.copy(focus).add(unit.multiplyScalar(Math.max(40, shot.radius)));
        this.camera.lookAt(focus);
        this.renderer.render(this.scene, this.camera);
        ctx.drawImage(source, 0, 0);
        const progress = Math.min(1, total === 0 ? 1 : elapsed / total);
        options.draw?.(ctx, output.width, output.height, progress);
        options.onProgress?.(progress);
        if (elapsed >= total) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });

    recorder.stop();
    const blob = await finished;
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext) void audioContext.close();
    this.camera.position.copy(savedPosition);
    this.controls.target.copy(savedTarget);
    this.controls.enabled = savedControls;
    if (grid) grid.visible = gridVisible;
    this.requestRender();
    return blob;
  }

  /** Smoothly frame a point; used while a prompt build drops monuments. */
  focusOn(x: number, z: number, radius: number): void {
    if (this.walkMode) return;
    const fromPosition = this.camera.position.clone();
    const fromTarget = this.controls.target.clone();
    const target = new THREE.Vector3(x, fromTarget.y, z);
    const direction = fromPosition.clone().sub(fromTarget).normalize();
    const distance = Math.max(90, Math.min(1400, radius * 1.8));
    const toPosition = target.clone().add(direction.multiplyScalar(distance));
    const start = performance.now();
    const animate = () => {
      const progress = Math.min(1, (performance.now() - start) / 520);
      const eased = progress * progress * (3 - 2 * progress);
      this.camera.position.lerpVectors(fromPosition, toPosition, eased);
      this.controls.target.lerpVectors(fromTarget, target, eased);
      this.controls.update();
      this.requestRender();
      if (progress < 1) requestAnimationFrame(animate);
    };
    animate();
  }

  /** Touch thumbstick/action input from the shell overlay. */
  setWalkInput(input: {
    forward?: number;
    strafe?: number;
    jump?: boolean;
    sprint?: boolean;
  }): void {
    this.walkVirtual.clear();
    if ((input.forward ?? 0) > 0.1) this.walkVirtual.add("KeyW");
    if ((input.forward ?? 0) < -0.1) this.walkVirtual.add("KeyS");
    if ((input.strafe ?? 0) > 0.1) this.walkVirtual.add("KeyD");
    if ((input.strafe ?? 0) < -0.1) this.walkVirtual.add("KeyA");
    if (input.sprint) this.walkVirtual.add("ShiftLeft");
    if (input.jump) this.walkVirtual.add("Space");
    this.requestRender();
  }

  private caveWalkAt(x: number, z: number) {
    return caveSectionAt(this.caveEntries(), x, z);
  }

  private alphaAt(x: number, z: number): number {
    if (!this.preview || !this.draft) return 255;
    const resolution = this.preview.resolution;
    const size = this.draft.terrain.sizeMetres;
    const half = size / 2;
    const column = Math.min(
      resolution - 1,
      Math.max(0, Math.round(((x + half) / size) * (resolution - 1))),
    );
    const row = Math.min(
      resolution - 1,
      Math.max(0, Math.round(((z + half) / size) * (resolution - 1))),
    );
    return this.preview.alpha[row * resolution + column];
  }

  private isInsideCave(): boolean {
    const { x, y, z } = this.walkPosition;
    for (const cave of this.caveEntries()) {
      for (const sample of cave.samples) {
        if (Math.hypot(sample.x - x, sample.z - z) > cave.width * 0.6 + 2) continue;
        if (y >= sample.y - 2 && y <= sample.y + cave.height) return true;
      }
    }
    return false;
  }

  private rememberCamera(): void {
    if (!this.walkMode && this.draft) {
      savedCamera = {
        size: this.draft.terrain.sizeMetres,
        position: this.camera.position.toArray() as [number, number, number],
        target: this.controls.target.toArray() as [number, number, number],
      };
    }
  }

  /** Browser drops pointer lock (Esc, tab switch) -> tell the app to leave walk mode. */
  private onPointerLockChange = (): void => {
    if (!this.walkMode) return;
    if (document.pointerLockElement !== this.renderer.domElement) {
      this.handlers.onExitWalk?.();
    }
  };

  private setWalkMode(enabled: boolean): void {
    if (enabled === this.walkMode) return;
    this.walkMode = enabled;
    this.host.classList.toggle("is-walking", enabled);
    if (enabled) {
      this.walkSavedCamera = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
      };
      this.controls.enabled = false;
      const selected = this.draft?.placements.find(
        (placement) => placement.id === this.draft?.selectedPlacementId,
      );
      const spawnX = selected?.position.x ?? 0;
      const spawnZ = selected?.position.z ?? 0;
      const ground = this.preview
        ? samplePreviewHeight(this.preview, spawnX, spawnZ, this.draft?.terrain.sizeMetres ?? 4500)
        : 0;
      this.walkPosition.set(spawnX, ground, spawnZ);
      this.walkVelocity.set(0, 0, 0);
      this.walkYaw = 0;
      this.walkPitch = -0.06;
      this.walkGrounded = true;
      document.addEventListener("keydown", this.onWalkKeyDown);
      document.addEventListener("keyup", this.onWalkKeyUp);
      document.addEventListener("mousemove", this.onWalkMouseMove);
      document.addEventListener("pointerlockchange", this.onPointerLockChange);
      this.lastFrameTime = performance.now();
      this.renderer.domElement.focus();
          } else {
      this.buildPlan = null;
      this.clearBuilds();
      this.handlers.onBuildStatus?.(null);
      this.setFlashlight(false);
      if (this.walkArc) this.walkArc.visible = false;
      if (this.collisionMarker) this.collisionMarker.visible = false;
      if (this.walkCollisionId) {
        this.walkCollisionId = null;
        this.handlers.onWalkCollision?.(null);
      }
      this.underground = false;
      this.applyEnvironment();
      this.controls.enabled = true;
      document.removeEventListener("keydown", this.onWalkKeyDown);
      document.removeEventListener("keyup", this.onWalkKeyUp);
      document.removeEventListener("mousemove", this.onWalkMouseMove);
      document.removeEventListener("pointerlockchange", this.onPointerLockChange);
      this.walkKeys.clear();
      if (document.pointerLockElement === this.renderer.domElement) {
        void document.exitPointerLock();
      }
      if (this.walkSavedCamera) {
        this.camera.position.copy(this.walkSavedCamera.position);
        this.controls.target.copy(this.walkSavedCamera.target);
        this.controls.update();
        this.walkSavedCamera = null;
      }
    }
    this.requestRender();
  }

  private onWalkKeyDown = (event: KeyboardEvent): void => {
    if (!this.walkMode) return;
    if (event.code === "KeyB") {
      event.preventDefault();
      this.toggleBuildPlan();
      return;
    }
    if (event.code === "KeyF") {
      event.preventDefault();
      this.setFlashlight(!this.flashlightOn);
      return;
    }
    if (event.code === "Escape") {
      if (this.buildPlan) {
        this.toggleBuildPlan();
        return;
      }
      this.handlers.onExitWalk?.();
      return;
    }
    if (this.buildPlan) {
      // Keyboard placement works before the pointer is locked, and while it is.
      if (event.code === "KeyE") {
        event.preventDefault();
        this.tryPlaceBuild();
        return;
      }
      if (event.code === "KeyX") {
        event.preventDefault();
        this.demolishAimed();
        return;
      }
      if (event.code === "KeyR") {
        event.preventDefault();
        this.buildPlan.rotation += rotationStep(this.buildPlan.piece);
        this.updateBuildGhost();
        return;
      }
      if (/^Digit[1-5]$/.test(event.code)) {
        event.preventDefault();
        const piece = BUILD_PIECES[Number(event.code.slice(5)) - 1];
        if (piece) {
          this.buildPlan.piece = piece;
          this.updateBuildGhost(true);
        }
        return;
      }
    }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ControlLeft", "Space"].includes(event.code)) {
      event.preventDefault();
      this.walkKeys.add(event.code);
    }
  };

  private onWalkKeyUp = (event: KeyboardEvent): void => {
    this.walkKeys.delete(event.code);
  };

  private onWalkMouseMove = (event: MouseEvent): void => {
    if (!this.walkMode || document.pointerLockElement !== this.renderer.domElement) return;
    this.walkYaw -= event.movementX * 0.0022;
    this.walkPitch = THREE.MathUtils.clamp(
      this.walkPitch - event.movementY * 0.0022,
      -1.35,
      1.35,
    );
  };

  private stepWalk(delta: number): void {
    if (!this.preview || !this.draft) return;
    const forward = Number(this.walkKey("KeyW")) - Number(this.walkKey("KeyS"));
    const strafe = Number(this.walkKey("KeyD")) - Number(this.walkKey("KeyA"));
    const crouched = this.walkKey("ControlLeft");
    const sprinting = this.walkKey("ShiftLeft") && !crouched;
    const speed = crouched ? 2.1 : sprinting ? 8.1 : 4.5;
    const length = Math.hypot(forward, strafe) || 1;
    const sin = Math.sin(this.walkYaw);
    const cos = Math.cos(this.walkYaw);
    const moveX = ((-sin * forward + cos * strafe) / length) * speed;
    const moveZ = ((-cos * forward - sin * strafe) / length) * speed;
    const half = this.draft.terrain.sizeMetres / 2 - 1;
    this.walkPosition.x = THREE.MathUtils.clamp(this.walkPosition.x + moveX * delta, -half, half);
    this.walkPosition.z = THREE.MathUtils.clamp(this.walkPosition.z + moveZ * delta, -half, half);

    const terrainGround = samplePreviewHeight(
      this.preview,
      this.walkPosition.x,
      this.walkPosition.z,
      this.draft.terrain.sizeMetres,
    );

    // Caves are enterable: standing over a carved portal drops the walker onto
    // the tunnel floor, and once below the surface the tunnel wall and roof
    // constrain movement instead of the heightfield.
    const surface = caveWalkSurface({
      cave: this.caveWalkAt(this.walkPosition.x, this.walkPosition.z),
      x: this.walkPosition.x,
      z: this.walkPosition.z,
      terrainGround,
      currentY: this.walkPosition.y,
      overPortal: this.alphaAt(this.walkPosition.x, this.walkPosition.z) < 128,
    });
    this.walkPosition.x = surface.x;
    this.walkPosition.z = surface.z;
    const { ground, ceiling, inTunnel } = surface;

    this.walkVelocity.y -= 22 * delta;
    this.walkPosition.y += this.walkVelocity.y * delta;
    if (this.walkPosition.y <= ground) {
      this.walkPosition.y = ground;
      this.walkVelocity.y = 0;
      this.walkGrounded = true;
    } else {
      this.walkGrounded = false;
    }
    if (inTunnel || ceiling < Number.POSITIVE_INFINITY) {
      // Head clearance: no jumping through a rock roof.
      this.walkPosition.y = Math.min(
        this.walkPosition.y,
        ceiling - (crouched ? 0.9 : 1.75),
      );
      if (this.walkPosition.y < ground) this.walkPosition.y = ground;
    }
    if (this.walkGrounded && this.walkKey("Space")) {
      this.walkVelocity.y = 8.12;
      this.walkGrounded = false;
    }

    if (this.buildPlan) this.updateBuildGhost();
    const insideCave = this.isInsideCave();
    if (insideCave !== this.underground) {
      this.underground = insideCave;
      this.applyEnvironment();
    }

    this.updateWalkArc(moveX, moveZ, crouched);
    this.updateWalkCollision(crouched);

    const eye = crouched ? 0.9 : 1.72;
    this.camera.position.set(
      this.walkPosition.x,
      this.walkPosition.y + eye,
      this.walkPosition.z,
    );
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.walkYaw;
    this.camera.rotation.x = this.walkPitch;
    this.camera.rotation.z = 0;
  }

  /** Jump parabola from the walker's feet using Rust's jump numbers. */
  private updateWalkArc(velocityX: number, velocityZ: number, crouched: boolean): void {
    if (!this.walkArc || !this.walkArcPositions || !this.preview || !this.draft) return;
    if (!this.walkGrounded) {
      // Freeze the take-off parabola while airborne so the jump reads clearly.
      const geometry = this.walkArc.geometry as THREE.BufferGeometry;
      if (geometry.drawRange.count > 1) this.walkArc.visible = true;
      return;
    }
    const size = this.draft.terrain.sizeMetres;
    const points = jumpArc(
      this.walkPosition,
      velocityX,
      velocityZ,
      (x, z) => samplePreviewHeight(this.preview as TerrainPreview, x, z, size),
      JUMP_ARC_STEPS,
      crouched ? 6.5 : undefined,
    );
    points.forEach((point, index) => {
      this.walkArcPositions![index * 3] = point.x;
      this.walkArcPositions![index * 3 + 1] = point.y + 0.12;
      this.walkArcPositions![index * 3 + 2] = point.z;
    });
    const geometry = this.walkArc.geometry as THREE.BufferGeometry;
    geometry.setDrawRange(0, points.length);
    (geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    geometry.computeBoundingSphere();
    this.walkArc.visible = true;
  }

  /** Capsule vs collision proxies: outline the closest box the walker overlaps. */
  private updateWalkCollision(crouched: boolean): void {
    if (!this.collisionMarker || !this.draft) return;
    const height = crouched ? CROUCH_CAPSULE_HEIGHT : CAPSULE_HEIGHT;
    const hits = capsuleHits(
      {
        x: this.walkPosition.x,
        y: this.walkPosition.y,
        z: this.walkPosition.z,
        radius: CAPSULE_RADIUS,
        height,
      },
      this.draft.placements,
    );
    const hit = hits[0];
    if (!hit) {
      this.collisionMarker.visible = false;
      if (this.walkCollisionId) {
        this.walkCollisionId = null;
        this.handlers.onWalkCollision?.(null);
      }
      return;
    }
    const placement = this.draft.placements.find((item) => item.id === hit.placementId);
    if (!placement) return;
    const extents = collisionExtents(placement);
    this.collisionMarker.visible = true;
    this.collisionMarker.scale.set(
      Math.max(0.2, extents.halfX * 2),
      Math.max(0.2, extents.height),
      Math.max(0.2, extents.halfZ * 2),
    );
    this.collisionMarker.position.set(
      placement.position.x,
      placement.position.y + extents.height / 2,
      placement.position.z,
    );
    if (this.walkCollisionId !== hit.placementId) {
      this.walkCollisionId = hit.placementId;
      this.handlers.onWalkCollision?.(hit.name);
    }
  }

  private attachPointerHandlers(): void {
    const element = this.renderer.domElement;
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerUp);
    element.addEventListener("pointerleave", this.onPointerUp);
    element.addEventListener("contextmenu", this.onContextMenu);
    element.addEventListener("dblclick", this.onDoubleClick);
  }

  /** Map → Monument: double-click a placed prefab to edit it in isolation. */
  private onDoubleClick = (event: MouseEvent): void => {
    if (!this.draft || this.walkMode) return;
    const picked = this.pickPlacement(event);
    if (picked) this.handlers.onOpenPlacement?.(picked);
  };

  private onContextMenu = (event: MouseEvent): void => {
    if (this.walkMode && this.buildPlan) event.preventDefault();
  };

  /** `[` / `]` scrub time in the orbit viewport as well as in Walk Mode. */
  private onGlobalKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.code !== "BracketLeft" && event.code !== "BracketRight") return;
    event.preventDefault();
    this.handlers.onScrubTime?.(event.code === "BracketLeft" ? -60 : 60);
  };

  private hitTerrain(event: PointerEvent): THREE.Intersection | null {
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycastPointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.raycastPointer, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain, false);
    return hits[0] ?? null;
  }

  /** Project a screen point onto the terrain (drag-and-drop placement). */
  pickGround(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.raycastPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.raycastPointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  /** Ground position, preview height and slope under a screen point. */
  groundInfo(
    clientX: number,
    clientY: number,
  ): { x: number; z: number; height: number; slope: number } | null {
    const hit = this.pickGround(clientX, clientY);
    if (!hit || !this.preview) return null;
    const size = this.draft?.terrain.sizeMetres ?? 4500;
    const height = samplePreviewHeight(this.preview, hit.x, hit.z, size);
    // 4 m baseline: a footpath reads flat, a hillside reads steep.
    const dx = samplePreviewHeight(this.preview, hit.x + 4, hit.z, size) - height;
    const dz = samplePreviewHeight(this.preview, hit.x, hit.z + 4, size) - height;
    const slope = (Math.atan(Math.hypot(dx, dz) / 4) * 180) / Math.PI;
    return { ...hit, height, slope };
  }

  /** The prefab marker under the pointer, if any (click-to-select on the map). */
  private pickPlacement(event: { clientX: number; clientY: number }): string | null {
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.raycastPointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.raycastPointer, this.camera);
    // Pads and selection rings are the primary targets; the proxy boxes catch
    // placements whose flatten pad is disabled and has no marker.
    const hits = this.raycaster.intersectObjects(
      [...this.markerGroup.children, ...this.proxyGroup.children],
      false,
    );
    for (const hit of hits) {
      const id = (hit.object.userData as { placementId?: string }).placementId;
      if (typeof id === "string" && id) return id;
    }
    return null;
  }

  /**
   * Show (or clear) the conforming footprint under the dragged prefab. This is
   * a preview only: the flatten pad is still computed from the placement, so
   * what is drawn here is exactly what the pad will use after the drop.
   */
  setDragGhost(ghost: DragGhost | null): void {
    if (!ghost) {
      this.dragGhost = null;
      this.disposeGhost();
      this.requestRender();
      return;
    }
    const previous = this.dragGhost;
    if (
      previous &&
      Math.abs(previous.x - ghost.x) < 0.5 &&
      Math.abs(previous.z - ghost.z) < 0.5 &&
      Math.abs(previous.radius - ghost.radius) < 0.5 &&
      previous.steep === ghost.steep
    ) {
      return;
    }
    this.dragGhost = ghost;
    this.rebuildGhost(ghost);
    this.requestRender();
  }

  private disposeGhost(): void {
    const group = this.ghostGroup;
    if (!group) return;
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    }
    group.clear();
    this.scene.remove(group);
    this.ghostGroup = null;
  }

  private rebuildGhost(ghost: DragGhost): void {
    this.disposeGhost();
    const size = this.draft?.terrain.sizeMetres ?? 4500;
    const height = this.preview
      ? samplePreviewHeight(this.preview, ghost.x, ghost.z, size)
      : 0;
    const radius = Math.max(6, ghost.radius);
    const outer = radius + Math.max(0, ghost.falloff);
    const color = ghost.steep ? 0xe3b341 : 0x58c26a;
    const group = new THREE.Group();
    group.position.set(ghost.x, height, ghost.z);

    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 64),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.7;
    group.add(pad);

    const footprint = new THREE.Mesh(
      new THREE.RingGeometry(radius, radius + 1.6, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    footprint.rotation.x = -Math.PI / 2;
    footprint.position.y = 0.9;
    group.add(footprint);

    const blend = new THREE.Mesh(
      new THREE.RingGeometry(outer, outer + 1.2, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    blend.rotation.x = -Math.PI / 2;
    blend.position.y = 0.9;
    group.add(blend);

    this.ghostGroup = group;
    this.scene.add(group);
  }

  /**
   * Sky, fog and lights are the floor palette blended with the sun/weather
   * state, so the 24-hour slider changes mood without a terrain rebuild.
   */
  private applyEnvironment(): void {
    const terrain = this.draft?.terrain;
    if (!terrain) return;
    const underwater =
      typeof terrain.floorHeight === "number" && terrain.floorHeight <= terrain.waterLevel;
    const key = underwater ? "water" : terrain.floorSplat ?? "grass";
    const schemes: Record<string, { sky: number; fog: number; sun: number; ambient: number }> = {
      water: { sky: 0x08131c, fog: 0x0b1c2a, sun: 1.05, ambient: 0.6 },
      snow: { sky: 0x121a22, fog: 0x223040, sun: 1.3, ambient: 0.8 },
      sand: { sky: 0x14110c, fog: 0x3a3226, sun: 1.45, ambient: 0.65 },
      rock: { sky: 0x0c0f12, fog: 0x1b2026, sun: 1.2, ambient: 0.5 },
      forest: { sky: 0x0a120d, fog: 0x121d16, sun: 1.15, ambient: 0.5 },
      grass: { sky: 0x0b0e12, fog: 0x0b0e12, sun: 1.4, ambient: 0.5 },
      dirt: { sky: 0x110f0c, fog: 0x241f18, sun: 1.35, ambient: 0.55 },
      gravel: { sky: 0x0d1013, fog: 0x1a2027, sun: 1.35, ambient: 0.55 },
      stones: { sky: 0x0b0e11, fog: 0x171c21, sun: 1.3, ambient: 0.5 },
    };
    const scheme = schemes[key] ?? schemes.grass;
    const lighting = lightingState(
      this.draft?.lighting?.timeOfDay ?? 630,
      this.draft?.lighting?.weather ?? "clear",
    );
    const size = terrain.sizeMetres;
    const underground = this.underground;

    const background = this.scene.background;
    if (background instanceof THREE.Color) {
      background.setHex(
        underground ? UNDERGROUND_LIGHTING.fogColor : blendHex(scheme.sky, lighting.skyColor, 0.6),
      );
    }
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.setHex(
        underground ? UNDERGROUND_LIGHTING.fogColor : blendHex(scheme.fog, lighting.fogColor, 0.55),
      );
      const scale = size / 4500;
      this.scene.fog.near = underground ? UNDERGROUND_LIGHTING.fogNear : lighting.fogNear * scale;
      this.scene.fog.far = underground ? UNDERGROUND_LIGHTING.fogFar : lighting.fogFar * scale;
    }

    const radius = Math.max(600, size * 0.5);
    const elevation = Math.max(4, lighting.elevation);
    this.sunLight.position.set(
      Math.cos(lighting.azimuth) * radius,
      Math.max(20, Math.sin((elevation * Math.PI) / 180) * radius),
      Math.sin(lighting.azimuth) * radius,
    );
    this.sunLight.color.setHex(lighting.sunColor);
    this.sunLight.intensity = underground
      ? UNDERGROUND_LIGHTING.sunIntensity
      : lighting.sunIntensity * (scheme.sun / 1.4);
    this.ambientLight.color.setHex(
      underground ? UNDERGROUND_LIGHTING.ambientColor : lighting.ambientColor,
    );
    this.ambientLight.intensity = underground
      ? UNDERGROUND_LIGHTING.ambientIntensity
      : lighting.ambientIntensity * (scheme.ambient / 0.5);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.walkMode && event.pointerType === "touch") {
      // Touch has no pointer lock: dragging the canvas looks around instead.
      this.walkTouch = { id: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    if (this.walkMode) {
      // Right click cycles the piece wheel; left click places once captured.
      if (this.buildPlan && event.button === 2) {
        event.preventDefault();
        this.cycleBuildPiece();
        return;
      }
      // With the build plan equipped a captured click places a piece; the first
      // click still captures the mouse so the view can be aimed.
      if (this.buildPlan && document.pointerLockElement === this.renderer.domElement) {
        this.tryPlaceBuild();
        return;
      }
      this.requestCameraLock();
      return;
    }
    if (!event.shiftKey) {
      const picked = this.pickPlacement(event);
      if (picked) {
        this.handlers.onSelectPlacement?.(picked);
        this.beginPlacementDrag(picked, event);
        return;
      }
    }
    if (!this.canSculpt() || !event.shiftKey) return;
    const hit = this.hitTerrain(event);
    if (!hit) return;
    this.painting = true;
    this.applyBrush(hit.point.x, hit.point.z, this.pointerPressure(event));
  };

  /**
   * Pointer lock is only valid on a visible document: requesting it from a
   * hidden/throttled tab throws WrongDocumentError and can surface as an
   * uncaught exception. Fail quietly and keep keyboard walking usable.
   */
  private requestCameraLock(): void {
    const element = this.renderer.domElement;
    if (document.visibilityState !== "visible") return;
    if (document.pointerLockElement === element) return;
    try {
      const request = element.requestPointerLock() as unknown as Promise<void> | undefined;
      if (request && typeof request.catch === "function") request.catch(() => undefined);
    } catch {
      // A browser without pointer lock, or an element that is not in the
      // active document; walk mode still works through the keyboard.
    }
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.walkTouch && event.pointerId === this.walkTouch.id) {
      const dx = event.clientX - this.walkTouch.x;
      const dy = event.clientY - this.walkTouch.y;
      this.walkTouch.x = event.clientX;
      this.walkTouch.y = event.clientY;
      this.walkYaw -= dx * 0.004;
      this.walkPitch = THREE.MathUtils.clamp(this.walkPitch - dy * 0.004, -1.2, 1.2);
      this.requestRender();
      return;
    }
    if (this.moving) {
      const hit = this.pickGround(event.clientX, event.clientY);
      if (!hit) return;
      const moved =
        Math.hypot(event.clientX - this.moving.pointerX, event.clientY - this.moving.pointerY) > 3;
      if (moved) this.moving.moved = true;
      this.moving.x = hit.x;
      this.moving.z = hit.z;
      const placement = this.draft?.placements.find((item) => item.id === this.moving?.id);
      this.setDragGhost({
        x: hit.x,
        z: hit.z,
        radius: this.ghostRadius(placement),
        falloff: placement?.flatten ? placement.flattenFalloff : 0,
        steep: this.slopeAt(hit.x, hit.z) > 18,
      });
      return;
    }
    if (!this.painting) return;
    const hit = this.hitTerrain(event);
    if (hit) this.applyBrush(hit.point.x, hit.point.z, this.pointerPressure(event));
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.walkTouch && event.pointerId === this.walkTouch.id) this.walkTouch = null;
    // A pointerup commits the move; leaving the canvas cancels it so the
    // prefab never jumps to wherever the cursor exited.
    if (this.moving) this.endPlacementDrag(event.type === "pointerup");
    if (!this.painting) return;
    this.painting = false;
    if (this.preview) this.updateHeights();
    this.updateTextures();
    this.requestRender();
    const strokes = this.strokeBuffer;
    this.strokeBuffer = [];
    this.onSculpt(strokes);
  };

  /** Pick a prefab up off the map; the terrain pads only recompute on drop. */
  private beginPlacementDrag(id: string, event: PointerEvent): void {
    const placement = this.draft?.placements.find((item) => item.id === id);
    if (!placement || placement.locked) return;
    this.moving = {
      id,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: placement.position.x,
      y: placement.position.y,
      z: placement.position.z,
      moved: false,
    };
    // OrbitControls listens on the same canvas; disabling it here (it checks
    // `enabled` on every move) keeps the camera still while a prefab moves.
    this.controls.enabled = false;
    const element = this.renderer.domElement;
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers (tests, remote input) have no active pointer to capture.
    }
    element.style.cursor = "grabbing";
    this.setDragGhost({
      x: placement.position.x,
      z: placement.position.z,
      radius: this.ghostRadius(placement),
      falloff: placement.flatten ? placement.flattenFalloff : 0,
      steep: this.slopeAt(placement.position.x, placement.position.z) > 18,
    });
  }

  private endPlacementDrag(commit: boolean): void {
    const moving = this.moving;
    if (!moving) return;
    this.moving = null;
    this.setDragGhost(null);
    this.controls.enabled = true;
    const element = this.renderer.domElement;
    if (element.hasPointerCapture?.(moving.pointerId)) {
      element.releasePointerCapture(moving.pointerId);
    }
    element.style.cursor = "";
    if (!commit || !moving.moved) return;
    this.handlers.onMovePlacement?.(moving.id, { x: moving.x, y: moving.y, z: moving.z });
  }

  private ghostRadius(placement: PrefabPlacement | undefined): number {
    if (!placement) return 12;
    return Math.max(8, placement.flatten ? placement.flattenRadius : collisionExtents(placement).reach);
  }

  /** Terrain slope in degrees at a world position, used to tint the drag ghost. */
  private slopeAt(x: number, z: number): number {
    if (!this.preview) return 0;
    const size = this.draft?.terrain.sizeMetres ?? 4500;
    const height = samplePreviewHeight(this.preview, x, z, size);
    const dx = samplePreviewHeight(this.preview, x + 4, z, size) - height;
    const dz = samplePreviewHeight(this.preview, x, z + 4, size) - height;
    return (Math.atan(Math.hypot(dx, dz) / 4) * 180) / Math.PI;
  }

  /** Pen pressure scales strength and radius; mice and fingers stay at 1. */
  private pointerPressure(event: PointerEvent): number {
    if (event.pointerType !== "pen") return 1;
    return Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : 1;
  }

  private applyBrush(worldX: number, worldZ: number, pressure = 1): void {
    if (!this.preview || !this.draft) return;
    const pressured = Number.isFinite(pressure) && pressure < 0.98;
    const strength = pressured ? Math.max(0.05, pressure) : 1;
    const terrain = pressured
      ? {
          ...this.draft.terrain,
          brush: {
            ...this.draft.terrain.brush,
            strength: this.draft.terrain.brush.strength * strength,
            radius: Math.max(0.5, this.draft.terrain.brush.radius * (0.55 + 0.45 * strength)),
          },
        }
      : this.draft.terrain;
    if (applyBrushToPreview(this.preview, terrain, worldX, worldZ)) {
      const brush = brushSnapshot(terrain.brush);
      const previous = this.strokeBuffer[this.strokeBuffer.length - 1];
      const spacing = Math.max(0.75, brush.radius * 0.12);
      const denseEnough =
        previous &&
        previous.mode === brush.mode &&
        Math.hypot(previous.x - worldX, previous.z - worldZ) < spacing;
      if (!denseEnough) {
        this.strokeBuffer.push({
          ...brush,
          id: `live-${Date.now()}-${this.strokeBuffer.length}`,
          x: worldX,
          z: worldZ,
        });
      }
      this.pendingGeometryUpdate = true;
      this.updateHeights();
      this.updateTextures();
      this.requestRender();
    }
  }

  private updateHeights(): void {
    if (!this.preview || !this.geometry) return;
    const positions = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const size = this.draft?.terrain.sizeMetres ?? 4500;
    const resolution = this.preview.resolution;
    for (let row = 0; row <= this.segments; row += 1) {
      for (let column = 0; column <= this.segments; column += 1) {
        const u = column / this.segments;
        const v = row / this.segments;
        const gridX = Math.min(resolution - 1, Math.round(u * (resolution - 1)));
        const gridZ = Math.min(resolution - 1, Math.round(v * (resolution - 1)));
        const index = row * (this.segments + 1) + column;
        positions.setY(index, this.preview.heights[gridZ * resolution + gridX]);
      }
    }
    positions.needsUpdate = true;
    this.geometry.computeVertexNormals();
    void size;
  }

  private updateTextures(): void {
    if (!this.preview) return;
    const { uSplatA, uSplatB, uBiomeMap, uTopologyMap, uAlphaMap } = this.uniforms;
    const splatA = uSplatA.value;
    const splatB = uSplatB.value;
    const topology = uTopologyMap.value;
    const alpha = uAlphaMap.value;
    if (!(splatA instanceof THREE.DataTexture) || !(splatB instanceof THREE.DataTexture)) return;
    if (!(topology instanceof THREE.DataTexture) || !(alpha instanceof THREE.DataTexture)) return;
    const biome = uBiomeMap.value;
    if (!(biome instanceof THREE.DataTexture)) return;
    const dataBiome = biome.image.data as Uint8Array;

    const resolution = this.preview.resolution;
    const texels = resolution * resolution;
    const dataA = splatA.image.data as Uint8Array;
    const dataB = splatB.image.data as Uint8Array;
    const dataTopology = topology.image.data as Uint8Array;
    const dataAlpha = alpha.image.data as Uint8Array;

    for (let index = 0; index < texels; index += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        dataA[index * 4 + channel] = this.preview.splat[index * 8 + channel];
        dataB[index * 4 + channel] = this.preview.splat[index * 8 + channel + 4];
        dataBiome[index * 4 + channel] = this.preview.biome[index * 4 + channel];
      }
      const value = this.preview.topology[index] >>> 0;
      dataTopology[index * 4] = value & 0xff;
      dataTopology[index * 4 + 1] = (value >>> 8) & 0xff;
      dataTopology[index * 4 + 2] = (value >>> 16) & 0xff;
      dataTopology[index * 4 + 3] = (value >>> 24) & 0xff;
      dataAlpha[index] = this.preview.alpha[index];
    }

    splatA.needsUpdate = true;
    splatB.needsUpdate = true;
    biome.needsUpdate = true;
    topology.needsUpdate = true;
    alpha.needsUpdate = true;
    this.pendingGeometryUpdate = false;
  }

  private resize(): void {
    const width = this.host.clientWidth || 1;
    const height = this.host.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private requestRender = (): void => {
    if (this.disposed) return;
    this.renderQueued = true;
    if (!this.frame) this.frame = requestAnimationFrame(this.loop);
  };

  /** Render only while the camera is moving or the scene changed. */
  private loop = (): void => {
    this.frame = 0;
    if (this.disposed) return;
    this.renderQueued = false;
    if (this.walkMode) {
      const now = performance.now();
      const delta = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;
      this.stepWalk(delta);
      this.updateLod();
      this.renderer.render(this.scene, this.camera);
      this.requestRender();
      return;
    }
    const damping = this.controls.update();
    this.rememberCamera();
    this.updateLod();
    this.renderer.render(this.scene, this.camera);
    if (damping || this.renderQueued) this.requestRender();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    if (this.rebuildTimer !== null) {
      window.clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.setWalkMode(false);
    this.resizeObserver.disconnect();
    const element = this.renderer.domElement;
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    element.removeEventListener("pointerup", this.onPointerUp);
    element.removeEventListener("pointercancel", this.onPointerUp);
    element.removeEventListener("pointerleave", this.onPointerUp);
    element.removeEventListener("contextmenu", this.onContextMenu);
    element.removeEventListener("dblclick", this.onDoubleClick);
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.dispose();
    document.removeEventListener("keydown", this.onWalkKeyDown);
    document.removeEventListener("keyup", this.onWalkKeyUp);
    document.removeEventListener("mousemove", this.onWalkMouseMove);
    document.removeEventListener("keydown", this.onGlobalKeyDown);
    this.clearProxyGroup();
    this.clearInstancedGroup();
    this.disposeGhost();
    if (this.walkArc) {
      this.scene.remove(this.walkArc);
      this.walkArc.geometry.dispose();
      (this.walkArc.material as THREE.Material).dispose();
      this.walkArc = null;
    }
    if (this.collisionMarker) {
      this.scene.remove(this.collisionMarker);
      this.collisionMarker.geometry.dispose();
      (this.collisionMarker.material as THREE.Material).dispose();
      this.collisionMarker = null;
    }
    for (const template of this.prefabTemplates.values()) {
      template.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose();
      });
    }
    this.prefabTemplates.clear();
    for (const texture of this.textures) texture.dispose();
    this.geometry?.dispose();
    this.material.dispose();
    if (this.water) {
      this.water.geometry.dispose();
      (this.water.material as THREE.Material).dispose();
    }
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    this.renderer.dispose();
    if (element.parentElement === this.host) this.host.removeChild(element);
  }
}
