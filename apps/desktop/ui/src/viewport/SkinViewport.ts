import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

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
  private flashLight: THREE.PointLight;
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
    this.scene.background = new THREE.Color(0x0c0f13);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200);
    this.camera.position.set(1.55, 0.95, 1.75);

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality.antialias,
      powerPreference: this.quality.tier === "low" ? "default" : "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
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
    this.controls.addEventListener("change", this.requestRender);

    this.envGenerator = new THREE.PMREMGenerator(this.renderer);
    this.environment = this.envGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.environment;

    this.keyLight = new THREE.DirectionalLight(0xfff4e2, 2.4);
    this.keyLight.position.set(2.4, 3.2, 2);
    this.fillLight = new THREE.HemisphereLight(0xa8c4dc, 0x1a1d20, 0.55);
    this.flashLight = new THREE.PointLight(0xfff0cf, 0, 8, 2);
    this.scene.add(this.keyLight, this.fillLight, this.flashLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3.4, 64),
      new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 0.9, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.32;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(3.4, 20, 0x232a33, 0x171d24);
    grid.position.y = -0.315;
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
    this.applyLayers(draft.skin.layers, draft.skin.wear);
    this.applyDecals(draft.skin.decals, draft.skin.wear);
    this.requestRender();
  }

  setInteraction(stepId: string, studioMode: boolean): void {
    this.stepId = stepId;
    this.studioMode = studioMode;
    this.host.classList.toggle("is-painting", stepId === "paint" && studioMode);
  }

  private buildDemoItem(): void {
    const group = new THREE.Group();
    const bodyColor = new THREE.Color("#3f4a52");

    const add = (
      geometry: THREE.BufferGeometry,
      position: [number, number, number],
      rotation: [number, number, number] = [0, 0, 0],
      color = bodyColor,
      metalness = 0.8,
      roughness = 0.42,
    ) => {
      const material = new THREE.MeshStandardMaterial({ color, metalness, roughness });
      const uniforms = createSkinUniforms();
      injectSkinShading(material, uniforms);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      mesh.castShadow = true;
      group.add(mesh);
      this.parts.push({ mesh, material, uniforms });
    };

    add(new THREE.BoxGeometry(0.92, 0.17, 0.12), [0, 0, 0]);
    add(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 20), [-0.78, 0.02, 0], [0, 0, Math.PI / 2], new THREE.Color("#24282c"), 0.92, 0.3);
    add(new THREE.BoxGeometry(0.34, 0.15, 0.09), [0.6, -0.02, 0], [0, 0, -0.06], new THREE.Color("#5b4630"), 0.05, 0.65);
    add(new THREE.BoxGeometry(0.1, 0.3, 0.06), [0.06, -0.22, 0], [0, 0, 0.06], new THREE.Color("#2c3238"), 0.55, 0.5);
    add(new THREE.BoxGeometry(0.085, 0.2, 0.07), [0.3, -0.14, 0], [0, 0, 0.28], new THREE.Color("#22262b"), 0.1, 0.8);
    add(new THREE.BoxGeometry(0.2, 0.05, 0.06), [-0.05, 0.13, 0], [0, 0, 0], new THREE.Color("#1c2024"), 0.9, 0.25);

    group.rotation.y = -0.35;
    this.scene.add(group);
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
      this.scene.background = new THREE.Color(0x0c0f13);
    } else if (preset === "dusk") {
      this.keyLight.color.set(0xffb27a);
      this.keyLight.intensity = 1.9;
      this.fillLight.intensity = 0.3;
      this.renderer.toneMappingExposure = 1.0;
      this.scene.background = new THREE.Color(0x15100f);
    } else if (preset === "flashlight") {
      this.keyLight.color.set(0xdfe9ff);
      this.keyLight.intensity = 0.45;
      this.fillLight.intensity = 0.08;
      this.renderer.toneMappingExposure = 1.25;
      this.scene.background = new THREE.Color(0x06080a);
    } else {
      this.keyLight.color.set(0x6f8cff);
      this.keyLight.intensity = 0.25;
      this.fillLight.intensity = 0.06;
      this.renderer.toneMappingExposure = 1.35;
      this.scene.background = new THREE.Color(0x040507);
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
    this.flashLight.position.copy(this.camera.position);
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
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.dispose();
    for (const part of this.parts) {
      part.mesh.geometry.dispose();
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
