import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import cubeFixtureUrl from "../../tests/fixtures/fixture-cube.glb?url";
import { isTauri, loadCachedMeshBytes } from "../lib/ipc";
import { prefabThumbnailHash } from "../utils/thumbnailQueue";
import { attachLocalTexture, attachLocalTextureByName, instantiateLocalScene } from "./localSceneCache";

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (!child.userData.kobaSharedGeometry) child.geometry.dispose();
    const material = child.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material.dispose();
  });
}

import { lightingState } from "../lib/lighting";
import { detectQualityProfile } from "../lib/quality";
import type { DecalStroke, MaterialLayer, WearSettings, WizardDraft } from "../wizard/types";
import {
  createSkinUniforms,
  createStampTexture,
  injectSkinShading,
  projectorMatrixFromHit,
  type SkinShaderUniforms,
} from "./shaders/skin";

interface SkinPart {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  uniforms: SkinShaderUniforms;
}

export class SkinViewport {
  private host: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private parts: SkinPart[] = [];
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.HemisphereLight;
  private rimLight: THREE.DirectionalLight;
  private flashLight: THREE.PointLight;
  private subject: THREE.Group | null = null;
  private previewMode = "weapon";
  private loadedAssetId: string | null = null;
  private loading = false;
  private loadToken = 0;
  private environment: THREE.Texture | null = null;
  private envGenerator: THREE.PMREMGenerator;
  private stampTextures = new Map<string, THREE.CanvasTexture>();
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private renderQueued = true;
  private disposed = false;
  private readonly quality = detectQualityProfile();
  private painting = false;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private decalMatrix = new THREE.Matrix4();
  private decalId: string | null = null;
  private onPaint: () => void;
  private draft: WizardDraft | null = null;
  private stepId = "";
  private studioMode = false;

  constructor(host: HTMLElement, onPaint: () => void) {
    this.host = host;
    this.onPaint = onPaint;
    this.host.dataset.quality = this.quality.tier;
    this.host.dataset.qualityResolution = String(this.quality.previewResolution);
    this.host.dataset.qualityPixelRatio = String(this.quality.pixelRatio);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121316);
    this.scene.fog = new THREE.FogExp2(0x121316, 0.12);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200);
    this.camera.position.set(1.55, 0.95, 1.75);

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality.antialias,
      powerPreference: this.quality.tier === "low" ? "default" : "high-performance",
    });
    // 1.5x is the perceptual ceiling for this studio view; higher DPR only
    // burns fill rate while the user is clicking through material slots.
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio, 1.5),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 6;
    this.controls.target.set(0, -0.03, 0);
    this.controls.addEventListener("change", this.onControlsChange);

    this.envGenerator = new THREE.PMREMGenerator(this.renderer);
    this.environment = this.envGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.environment;

    this.keyLight = new THREE.DirectionalLight(0xffe8d2, 2.6);
    this.keyLight.position.set(2.4, 3.2, 2);
    this.rimLight = new THREE.DirectionalLight(0x9fc2e8, 1.45);
    this.rimLight.position.set(-3, 1.9, -2.6);
    this.fillLight = new THREE.HemisphereLight(0x39424c, 0x111316, 0.35);
    this.flashLight = new THREE.PointLight(0xfff0cf, 0, 8, 2);
    this.scene.add(this.keyLight, this.rimLight, this.fillLight, this.flashLight);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.42, metalness: 0.35 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.32;
    this.scene.add(floor);

    const gridMaterial = new THREE.LineBasicMaterial({ color: 0x2b2f36, transparent: true, opacity: 0.28 });
    const grid = new THREE.GridHelper(90, 90, 0x343941, 0x22262c);
    grid.material = gridMaterial;
    grid.position.y = -0.314;
    this.scene.add(grid);

    this.buildDemoItem();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.attachPointerHandlers();
    this.resize();
    this.requestRender();
  }

  setDraft(draft: WizardDraft): void {
    this.draft = draft;
    this.applyLighting(draft.skin.wear);
    this.applyTimeOfDay(draft);
    this.applyLayers(draft.skin.layers, draft.skin.wear);
    this.applyDecals(draft.skin.decals, draft.skin.wear);
    void this.loadCachedSubject(draft);
    this.requestRender();
  }

  setInteraction(stepId: string, studioMode: boolean): void {
    this.stepId = stepId;
    this.studioMode = studioMode;
    this.host.classList.toggle("is-painting", stepId === "paint" && studioMode);
  }

  private buildDemoItem(): void {
    if (this.subject) {
      this.scene.remove(this.subject);
      this.subject.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    }
    this.parts = [];
    const group = new THREE.Group();
    const add = (
      geometry: THREE.BufferGeometry,
      position: [number, number, number],
      rotation: [number, number, number] = [0, 0, 0],
      color = 0x24272b,
      metalness = 0.85,
      roughness = 0.36,
    ) => {
      const material = new THREE.MeshStandardMaterial({ color, metalness, roughness });
      const uniforms = createSkinUniforms();
      injectSkinShading(material, uniforms);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      this.parts.push({ mesh, material, uniforms });
    };

    const gunmetal = 0x1e2125;
    const steel = 0x34383d;
    const polymer = 0x181b1e;
    const wood = 0x6a4a2b;

    // Receiver, rail and ejection port.
    add(new THREE.BoxGeometry(0.9, 0.15, 0.11), [0, 0, 0], [0, 0, 0], gunmetal, 0.9, 0.32);
    add(new THREE.BoxGeometry(0.62, 0.03, 0.06), [0.02, 0.09, 0], [0, 0, 0], steel, 0.95, 0.28);
    add(new THREE.BoxGeometry(0.18, 0.05, 0.115), [0.18, -0.03, 0], [0, 0, 0], steel, 0.9, 0.38);
    // Handguard with vent slots, barrel and muzzle brake.
    add(new THREE.BoxGeometry(0.42, 0.11, 0.1), [-0.6, 0.01, 0], [0, 0, 0], polymer, 0.35, 0.55);
    for (let index = 0; index < 4; index += 1) {
      add(new THREE.BoxGeometry(0.03, 0.05, 0.105), [-0.72 + index * 0.09, 0.015, 0], [0, 0, 0], 0x101214, 0.4, 0.6);
    }
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 20), [-1.02, 0.02, 0], [0, 0, Math.PI / 2], steel, 0.95, 0.24);
    add(new THREE.CylinderGeometry(0.028, 0.03, 0.1, 20), [-1.3, 0.02, 0], [0, 0, Math.PI / 2], 0x14161a, 0.9, 0.34);
    // Stock, cheek riser and butt pad.
    add(new THREE.BoxGeometry(0.34, 0.12, 0.08), [0.66, -0.01, 0], [0, 0, -0.08], wood, 0.08, 0.62);
    add(new THREE.BoxGeometry(0.2, 0.03, 0.075), [0.62, 0.07, 0], [0, 0, -0.08], 0x7a5532, 0.08, 0.6);
    add(new THREE.BoxGeometry(0.04, 0.15, 0.09), [0.84, -0.02, 0], [0, 0, 0], 0x101214, 0.2, 0.7);
    // Pistol grip with trigger guard.
    add(new THREE.BoxGeometry(0.075, 0.24, 0.07), [0.08, -0.19, 0], [0, 0, 0.24], polymer, 0.25, 0.65);
    add(new THREE.TorusGeometry(0.055, 0.01, 8, 16, Math.PI), [0.2, -0.1, 0], [0, 0, Math.PI / 2], steel, 0.8, 0.4);
    // Curved magazine and baseplate.
    add(new THREE.BoxGeometry(0.08, 0.24, 0.1), [0.26, -0.2, 0], [0, 0, 0.3], 0x22262a, 0.55, 0.5);
    add(new THREE.BoxGeometry(0.09, 0.03, 0.11), [0.3, -0.33, 0], [0, 0, 0.3], 0x101214, 0.8, 0.4);
    // Iron sights and optic.
    add(new THREE.BoxGeometry(0.02, 0.07, 0.05), [-0.95, 0.08, 0], [0, 0, 0], steel, 0.9, 0.35);
    add(new THREE.BoxGeometry(0.03, 0.06, 0.06), [0.35, 0.09, 0], [0, 0, 0], steel, 0.9, 0.35);
    add(new THREE.CylinderGeometry(0.035, 0.04, 0.16, 18), [0.04, 0.15, 0], [0, 0, Math.PI / 2], 0x14171b, 0.85, 0.3);
    add(new THREE.CylinderGeometry(0.028, 0.028, 0.006, 18), [0.12, 0.15, 0], [0, 0, Math.PI / 2], 0x7d3a2a, 0.2, 0.2);

    if (this.previewMode === "character") {
      // Blocky but readable armored player silhouette for clothing skin checks.
      add(new THREE.CapsuleGeometry(0.28, 0.62, 6, 14), [0, 0.95, 0], [0, 0, 0], 0x2c3138, 0.25, 0.7);
      add(new THREE.SphereGeometry(0.19, 20, 16), [0, 1.62, 0], [0, 0, 0], 0x6e5847, 0.05, 0.65);
      add(new THREE.BoxGeometry(0.5, 0.16, 0.28), [0, 1.38, 0], [0, 0, 0], 0x30353c, 0.3, 0.6);
      add(new THREE.CapsuleGeometry(0.11, 0.5, 4, 12), [-0.36, 0.95, 0], [0, 0, 0.14], 0x2c3138, 0.25, 0.7);
      add(new THREE.CapsuleGeometry(0.11, 0.5, 4, 12), [0.36, 0.95, 0], [0, 0, -0.14], 0x2c3138, 0.25, 0.7);
      add(new THREE.CapsuleGeometry(0.14, 0.55, 4, 12), [-0.16, 0.28, 0], [0, 0, 0], 0x22262b, 0.2, 0.75);
      add(new THREE.CapsuleGeometry(0.14, 0.55, 4, 12), [0.16, 0.28, 0], [0, 0, 0], 0x22262b, 0.2, 0.75);
      add(new THREE.BoxGeometry(0.22, 0.12, 0.34), [-0.16, -0.06, 0.06], [0, 0, 0], 0x14171a, 0.15, 0.8);
      add(new THREE.BoxGeometry(0.22, 0.12, 0.34), [0.16, -0.06, 0.06], [0, 0, 0], 0x14171a, 0.15, 0.8);
      group.position.y = -0.25;
      group.rotation.y = -0.5;
    } else if (this.previewMode === "arms") {
      add(new THREE.CapsuleGeometry(0.09, 0.42, 4, 12), [0.46, -0.18, 0.1], [0, 0, -0.5], 0x6e5847, 0.05, 0.65);
      add(new THREE.CapsuleGeometry(0.09, 0.35, 4, 12), [-0.38, -0.22, 0.1], [0, 0, 0.4], 0x6e5847, 0.05, 0.65);
      add(new THREE.BoxGeometry(0.16, 0.1, 0.16), [0.5, -0.34, 0.14], [0, 0, 0], 0x1b1d21, 0.2, 0.7);
      add(new THREE.BoxGeometry(0.16, 0.1, 0.16), [-0.48, -0.34, 0.14], [0, 0, 0], 0x1b1d21, 0.2, 0.7);
      group.rotation.set(0.1, -0.2, 0);
    } else {
      group.rotation.y = -0.35;
    }

    this.subject = group;
    this.host.dataset.subject = "proxy";
    this.scene.add(group);
  }

  /**
   * Prefer the real cached .glb for the selected base mesh; keep the procedural
   * proxy when the asset has not been indexed or decoded yet.
   */
  private async loadCachedSubject(draft: WizardDraft): Promise<void> {
    const assetId = draft.skin.baseMeshId;
    const assetIds = draft.skin.baseMeshParts?.length
      ? draft.skin.baseMeshParts
      : assetId
        ? [assetId]
        : [];
    const signature = assetIds.join("\n");
    if (!assetId || !assetIds.length || signature === this.loadedAssetId) return;
    const token = ++this.loadToken;
    this.loading = true;
    try {
      const group = new THREE.Group();
      for (const path of assetIds) {
        let scene: THREE.Group | null = null;
        // Unity prefab caches are only keyed by hash; KOBAedit GLBs are loaded
        // through the shared parse cache so parts reuse geometry and textures.
        const cachedBytes =
          assetIds.length === 1 ? await loadCachedMeshBytes(prefabThumbnailHash(path)) : null;
        if (cachedBytes) {
          scene = (await new GLTFLoader().parseAsync(cachedBytes.slice().buffer, "")).scene;
        }
        if (!scene && isTauri()) scene = await instantiateLocalScene(path);
        if (!scene && !isTauri() && path.endsWith("/ak47.glb")) {
          // Browser preview fallback: a clearly-labelled cube fixture stands in
          // for the native cached mesh. Other meshes keep the procedural proxy.
          const response = await fetch(cubeFixtureUrl);
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            scene = (await new GLTFLoader().parseAsync(bytes.buffer, "")).scene;
          }
        }
        if (!scene || this.disposed || token !== this.loadToken) {
          disposeObject(group);
          return;
        }
        scene.traverse((child) => {
          child.userData.assetPath = path;
        });
        group.add(scene);
      }
      if (this.subject) {
        this.scene.remove(this.subject);
        this.subject.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            if (!child.userData.kobaSharedGeometry) child.geometry.dispose();
            const material = child.material as THREE.Material | THREE.Material[];
            if (Array.isArray(material)) material.forEach((item) => item.dispose());
            else material.dispose();
          }
        });
      }
      this.parts = [];
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z) || 1;
      const scale = 1.8 / longest;
      group.scale.setScalar(scale);
      const center = box.getCenter(new THREE.Vector3());
      group.position.set(-center.x * scale, -center.y * scale - 0.15, -center.z * scale);
      group.rotation.y = -0.35;
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = true;
        child.receiveShadow = true;
        const entries = Array.isArray(child.material) ? child.material : [child.material];
        for (const entry of entries) {
          if (!(entry instanceof THREE.MeshStandardMaterial)) continue;
          const uniforms = createSkinUniforms();
          injectSkinShading(entry, uniforms);
          this.parts.push({ mesh: child, material: entry, uniforms });
          // Texture2D files are indexed beside Mesh. Materials that ship
          // without an embedded map resolve by name and share one GPU texture.
          void attachLocalTexture(entry).then((applied) => {
            if (applied) this.requestRender();
          });
        }
      });
      this.subject = group;
      this.loadedAssetId = signature;
      this.host.dataset.subject = "glb";
      this.scene.add(group);
      this.requestRender();
    } catch {
      // Fall back to the procedural proxy; never blank the viewport.
    } finally {
      this.loading = false;
    }
  }

  setSubjectVisible(visible: boolean): void {
    if (this.subject) this.subject.visible = visible;
    this.requestRender();
  }

  /** Outliner child eyes: hide one part without hiding its sibling meshes. */
  setHiddenParts(paths: string[]): void {
    const hidden = new Set(paths);
    this.subject?.traverse((child) => {
      const path = child.userData.assetPath as string | undefined;
      if (path) child.visible = !hidden.has(path);
    });
    this.requestRender();
  }

  setPreviewMode(mode: string): void {
    if (mode === this.previewMode) return;
    this.previewMode = mode;
    // A cached GLB is authored geometry; don't replace it with the proxy.
    if (this.loadedAssetId) return;
    this.buildDemoItem();
    this.requestRender();
  }

  /**
   * The day preset follows the shared 24-hour scrubber so emissive skin work
   * can be checked at noon and midnight. Dusk/flashlight/night presets keep
   * their authored look.
   */
  private applyTimeOfDay(draft: WizardDraft): void {
    if ((draft.skin.wear.lighting ?? "day") !== "day") return;
    const state = lightingState(draft.lighting?.timeOfDay ?? 630, draft.lighting?.weather ?? "clear");
    this.keyLight.color.setHex(state.sunColor);
    this.keyLight.intensity = 0.35 + state.daylight * 2.15;
    this.fillLight.intensity = 0.08 + state.daylight * 0.5;
    this.scene.background = new THREE.Color(0x121316);
    this.renderer.toneMappingExposure = 0.9 + state.daylight * 0.18;
  }

  private applyLighting(wear: WearSettings): void {
    const preset = wear.lighting;
    this.flashLight.intensity = preset === "flashlight" ? 26 : 0;
    this.flashLight.position.copy(this.camera.position);
    this.scene.environment = this.environment;

    if (preset === "day") {
      this.keyLight.color.set(0xfff4e2);
      this.keyLight.intensity = 2.4;
      this.fillLight.intensity = 0.55;
      this.renderer.toneMappingExposure = 1.05;
      this.scene.background = new THREE.Color(0x121316);
    } else if (preset === "dusk") {
      this.keyLight.color.set(0xffb27a);
      this.keyLight.intensity = 1.9;
      this.fillLight.intensity = 0.3;
      this.renderer.toneMappingExposure = 1.0;
      this.scene.background = new THREE.Color(0x121316);
    } else if (preset === "flashlight") {
      this.keyLight.color.set(0xdfe9ff);
      this.keyLight.intensity = 0.45;
      this.fillLight.intensity = 0.08;
      this.renderer.toneMappingExposure = 1.25;
      this.scene.background = new THREE.Color(0x121316);
    } else {
      this.keyLight.color.set(0x6f8cff);
      this.keyLight.intensity = 0.25;
      this.fillLight.intensity = 0.06;
      this.renderer.toneMappingExposure = 1.35;
      this.scene.background = new THREE.Color(0x121316);
    }

    for (const part of this.parts) {
      part.uniforms.uEmission.value = wear.emissionStrength;
      part.material.emissiveIntensity = preset === "night" ? wear.emissionStrength : wear.emissionStrength * 0.4;
      if (preset === "night" && wear.emissionStrength > 0) {
        part.material.emissive = new THREE.Color("#7fb8ff");
      } else {
        part.material.emissive = new THREE.Color(0x000000);
      }
    }
  }

  private applyLayers(layers: MaterialLayer[], wear: WearSettings): void {
    const active = layers.filter((layer) => layer.enabled);
    const top = active[active.length - 1] ?? null;
    const accent = active[0] ?? null;

    this.parts.forEach((part, index) => {
      const layer = index === 0 ? top ?? accent : accent ?? top;
      if (layer) {
        part.material.color.set(layer.baseColor);
        part.material.metalness = layer.metallic;
        part.material.roughness = 1 - layer.smoothness;
        if (layer.textureName) {
          void attachLocalTextureByName(part.material, layer.textureName).then((applied) => {
            if (applied) this.requestRender();
          });
        }
      }
      part.uniforms.uWear.value.set(wear.edgeWear, wear.grunge, wear.dirt, wear.scratches);
      part.uniforms.uEmission.value = wear.emissionStrength;
    });

    if (this.studioMode) {
      this.host.dataset.layerCount = String(active.length);
    }
  }

  private applyDecals(decals: DecalStroke[], wear: WearSettings): void {
    const latest = decals[decals.length - 1];
    if (!latest) {
      this.decalId = null;
      for (const part of this.parts) {
        part.uniforms.uUseDecal.value = 0;
        part.uniforms.uDecalOpacity.value = 0;
      }
      return;
    }

    const textureKey = `${latest.id}-${latest.stamp}-${latest.color}`;
    let texture = this.stampTextures.get(textureKey);
    if (!texture) {
      texture = createStampTexture(latest.stamp, latest.color, 512);
      this.stampTextures.set(textureKey, texture);
    }

    if (this.decalId !== latest.id) {
      this.decalId = latest.id;
      this.camera.updateMatrixWorld(true);
      this.decalMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    }

    for (const part of this.parts) {
      part.uniforms.uDecalMap.value = texture;
      part.uniforms.uDecalMatrix.value.copy(this.decalMatrix);
      part.uniforms.uDecalOpacity.value = latest.opacity;
      part.uniforms.uDecalTint.value.set(0xffffff);
      part.uniforms.uUseDecal.value = 1;
      void wear;
    }
  }

  private attachPointerHandlers(): void {
    const element = this.renderer.domElement;
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.studioMode || this.stepId !== "paint") return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = this.parts.map((part) => part.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit || !hit.face) return;

    const decal = this.draft?.skin.decals[this.draft.skin.decals.length - 1];
    if (!decal) return;

    const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const size = Math.max(0.08, (decal.size / 512) * 0.9);
    this.decalMatrix = projectorMatrixFromHit(hit.point, worldNormal, size);
    const texture = this.stampTextures.get(`${decal.id}-${decal.stamp}-${decal.color}`);

    for (const part of this.parts) {
      if (texture) part.uniforms.uDecalMap.value = texture;
      part.uniforms.uDecalMatrix.value.copy(this.decalMatrix);
      part.uniforms.uDecalOpacity.value = decal.opacity;
      part.uniforms.uUseDecal.value = 1;
    }
    this.requestRender();
    this.onPaint();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 1 || !this.studioMode || this.stepId !== "paint") return;
    this.painting = true;
  };

  private resize(): void {
    const width = this.host.clientWidth || 1;
    const height = this.host.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Last rendered camera transform; stops the loop once damping settles. */
  private lastCameraMatrix = new THREE.Matrix4();
  private looping = false;

  /** `change` is dispatched from inside update(); never re-queue from there. */
  private onControlsChange = (): void => {
    if (!this.looping) this.requestRender();
  };

  /** True when the camera actually moved; damping residue below 1e-6 is noise. */
  private cameraChanged(): boolean {
    const current = this.camera.matrixWorld.elements;
    const previous = this.lastCameraMatrix.elements;
    for (let index = 0; index < 16; index += 1) {
      if (Math.abs(current[index] - previous[index]) > 1e-6) {
        this.lastCameraMatrix.copy(this.camera.matrixWorld);
        return true;
      }
    }
    return false;
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
    this.looping = true;
    this.controls.update();
    this.camera.updateMatrixWorld();
    // Damping keeps reporting movement from float residue; only a real camera
    // change should schedule another frame.
    const moved = this.cameraChanged();
    this.flashLight.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.looping = false;
    if (moved || this.renderQueued) this.requestRender();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const element = this.renderer.domElement;
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    this.controls.removeEventListener("change", this.onControlsChange);
    this.controls.dispose();
    for (const part of this.parts) {
      if (!part.mesh.userData.kobaSharedGeometry) part.mesh.geometry.dispose();
      part.material.dispose();
    }
    for (const texture of this.stampTextures.values()) texture.dispose();
    this.stampTextures.clear();
    this.environment?.dispose();
    this.envGenerator.dispose();
    this.renderer.dispose();
    if (element.parentElement === this.host) this.host.removeChild(element);
  }
}
