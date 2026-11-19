import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  applyBrushToPreview,
  applyPlacementPads,
  generateTerrainPreview,
  samplePreviewHeight,
  type TerrainPreview,
} from "../lib/procedural";
import { detectQualityProfile } from "../lib/quality";
import type { PrefabPlacement, RouteSpline, SplineKind, WizardDraft } from "../wizard/types";
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
  powerline: 0xc9b16a,
};

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

export class TerrainViewport {
  private host: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private terrain: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private grid: THREE.GridHelper | null = null;
  private markerGroup = new THREE.Group();
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial;
  private uniforms: TerrainUniforms;
  private textures: THREE.Texture[] = [];
  private preview: TerrainPreview | null = null;
  private draft: WizardDraft | null = null;
  private settingsKey = "";
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
  private onSculpt: () => void;

  constructor(host: HTMLElement, onSculpt: () => void) {
    this.host = host;
    this.onSculpt = onSculpt;
    this.host.dataset.quality = this.quality.tier;
    this.host.dataset.qualitySegments = String(this.quality.terrainSegments);
    this.host.dataset.qualityResolution = String(this.quality.previewResolution);
    this.host.dataset.qualityPixelRatio = String(this.quality.pixelRatio);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e12);
    this.scene.fog = new THREE.Fog(0x0b0e12, 1600, 5200);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 12000);
    this.camera.position.set(1100, 900, 1400);

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality.antialias,
      powerPreference: this.quality.tier === "low" ? "default" : "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = false;
    this.controls.target.set(0, 40, 0);
    this.controls.addEventListener("change", this.requestRender);

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const sun = new THREE.DirectionalLight(0xfff3df, 1.4);
    sun.position.set(500, 900, 400);
    this.scene.add(ambient, sun);
    this.scene.add(this.markerGroup);

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
      placements: draft.placements.map((placement) => ({
        x: placement.position.x,
        z: placement.position.z,
        radius: placement.flattenRadius,
        falloff: placement.flattenFalloff,
        flatten: placement.flatten,
      })),
    });

    if (key !== this.settingsKey) {
      this.settingsKey = key;
      this.regenerate();
      if (previousSize === undefined || previousSize !== draft.terrain.sizeMetres) {
        this.fitCamera(draft.terrain.sizeMetres);
      }
    }

    if (this.water) {
      this.water.position.y = draft.terrain.waterLevel;
    }
    if (this.grid) {
      this.grid.position.y = -60;
    }
    this.uniforms.uShowTopology.value = draft.studioMode ? 1 : 0.0;
    this.updateMarkers(draft);
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

  private regenerate(): void {
    if (!this.draft) return;
    const preview = generateTerrainPreview(this.draft.terrain, this.quality.previewResolution);
    applyPlacementPads(preview, this.draft.placements, this.draft.terrain.sizeMetres);
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
  }

  private addPlacementMarker(placement: PrefabPlacement, selected: boolean): void {
    const asset = placement.assetId;
    const baseHeight = this.preview
      ? samplePreviewHeight(
          this.preview,
          placement.position.x,
          placement.position.z,
          this.draft?.terrain.sizeMetres ?? 4500,
        )
      : 0;
    const size = Math.max(8, Math.min(80, 20 * Math.max(1, placement.scale.x)));
    const color = CATEGORY_COLORS[asset.includes("decor") ? "Decor" : "Monument"] ?? 0x8b93a1;

    const geometry = new THREE.BoxGeometry(size, size * 0.7, size);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.2,
      emissive: selected ? 0x2a4a72 : 0x000000,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      placement.position.x,
      baseHeight + placement.position.y + size * 0.35,
      placement.position.z,
    );
    mesh.rotation.y = THREE.MathUtils.degToRad(placement.rotationEuler.y);
    this.markerGroup.add(mesh);

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
      this.markerGroup.add(disk);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius, radius + 3, 48),
        new THREE.MeshBasicMaterial({ color: 0x5ea8ff, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(placement.position.x, baseHeight + 0.8, placement.position.z);
      this.markerGroup.add(ring);
    }
  }

  private addSpline(spline: RouteSpline): void {
    if (spline.nodes.length < 2) return;
    const points = spline.nodes.map((node) => new THREE.Vector3(node.x, 0, node.z));
    const curve = new THREE.CatmullRomCurve3(points, spline.closed, "centripetal");
    const samples = curve.getPoints(Math.max(32, spline.nodes.length * 12));
    for (const point of samples) {
      point.y = this.preview
        ? samplePreviewHeight(this.preview, point.x, point.z, this.draft?.terrain.sizeMetres ?? 4500) + 2
        : 2;
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(samples);
    const material = new THREE.LineBasicMaterial({
      color: SPLINE_COLORS[spline.kind] ?? 0xaaaaaa,
      transparent: true,
      opacity: 0.95,
    });
    this.markerGroup.add(new THREE.Line(geometry, material));
  }

  private attachPointerHandlers(): void {
    const element = this.renderer.domElement;
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointerleave", this.onPointerUp);
  }

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

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.canSculpt() || !event.shiftKey) return;
    const hit = this.hitTerrain(event);
    if (!hit) return;
    this.painting = true;
    this.applyBrush(hit.point.x, hit.point.z);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.painting) return;
    const hit = this.hitTerrain(event);
    if (hit) this.applyBrush(hit.point.x, hit.point.z);
  };

  private onPointerUp = (): void => {
    if (!this.painting) return;
    this.painting = false;
    if (this.preview) this.updateHeights();
    this.updateTextures();
    this.requestRender();
    this.onSculpt();
  };

  private applyBrush(worldX: number, worldZ: number): void {
    if (!this.preview || !this.draft) return;
    if (applyBrushToPreview(this.preview, this.draft.terrain, worldX, worldZ)) {
      this.pendingGeometryUpdate = true;
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
    const { uSplatA, uSplatB, uTopologyMap, uAlphaMap } = this.uniforms;
    const splatA = uSplatA.value;
    const splatB = uSplatB.value;
    const topology = uTopologyMap.value;
    const alpha = uAlphaMap.value;
    if (!(splatA instanceof THREE.DataTexture) || !(splatB instanceof THREE.DataTexture)) return;
    if (!(topology instanceof THREE.DataTexture) || !(alpha instanceof THREE.DataTexture)) return;

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
    const damping = this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (damping || this.renderQueued) this.requestRender();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const element = this.renderer.domElement;
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    element.removeEventListener("pointerup", this.onPointerUp);
    element.removeEventListener("pointerleave", this.onPointerUp);
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.dispose();
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
