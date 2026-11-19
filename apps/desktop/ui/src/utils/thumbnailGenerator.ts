import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../lib/ipc";

export interface MonumentChildTransform {
  prefabHash: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface SkinTextureSet {
  albedoUrl?: string | null;
  normalUrl?: string | null;
  metallicUrl?: string | null;
  emissionUrl?: string | null;
  emissiveIntensity?: number;
}

export interface ProxyBounds {
  min: [number, number, number];
  max: [number, number, number];
}

const NEUTRAL = 0x8b93a1;

function safeId(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 150);
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(entry)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      entry.dispose();
    }
  });
}

function applyNeutralMaterial(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const current = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (current?.map) return;
    current?.dispose();
    mesh.material = new THREE.MeshStandardMaterial({
      color: NEUTRAL,
      roughness: 0.68,
      metalness: 0.14,
      side: THREE.DoubleSide,
    });
  });
}

function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(1);
  renderer.setSize(128, 128, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

function studioScene(renderer: THREE.WebGLRenderer): THREE.Scene {
  const scene = new THREE.Scene();
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const key = new THREE.DirectionalLight(0xfff4e2, 2.4);
  key.position.set(3.2, 4.5, 2.7);
  const rim = new THREE.DirectionalLight(0x8fb6e8, 1.5);
  rim.position.set(-3.5, 2.2, -3.1);
  const fill = new THREE.HemisphereLight(0xb9d0e8, 0x171b20, 0.55);
  scene.add(ambient, key, rim, fill);
  renderer.toneMappingExposure = 1.08;
  return scene;
}

function frameObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: {
    yawDegrees: number;
    elevationDegrees: number;
    padding: number;
  },
): void {
  const { yawDegrees, elevationDegrees, padding } = options;
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    camera.position.set(2.2, 1.7, 2.2);
    camera.lookAt(0, 0, 0);
    return;
  }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center;
  object.position.sub(center);
  object.updateMatrixWorld(true);
  const radius = Math.max(sphere.radius, 0.0001);
  const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
  const distance = (radius / Math.sin(vertical)) * padding;
  const yaw = THREE.MathUtils.degToRad(yawDegrees);
  const elevation = THREE.MathUtils.degToRad(elevationDegrees);
  camera.position.set(
    Math.sin(yaw) * Math.cos(elevation) * distance,
    Math.sin(elevation) * distance,
    Math.cos(yaw) * Math.cos(elevation) * distance,
  );
  camera.near = Math.max(0.001, distance / 100);
  camera.far = distance * 20;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

async function parseGlb(bytes: Uint8Array): Promise<THREE.Group> {
  const copy = bytes.slice();
  const result = await new GLTFLoader().parseAsync(copy.buffer, "");
  return result.scene;
}

export class OffscreenThumbnailGenerator {
  private readonly canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 128;
    this.canvas.height = 128;
    this.canvas.style.width = "128px";
    this.canvas.style.height = "128px";
    this.canvas.style.position = "fixed";
    this.canvas.style.left = "-10000px";
    this.canvas.style.top = "-10000px";
    this.canvas.dataset.kobaThumbnailCanvas = "true";
    document.body.appendChild(this.canvas);
  }

  private async save(key: string, dataUrl: string): Promise<string> {
    if (!isTauri()) return dataUrl;
    await invoke<string>("save_prefab_thumbnail", {
      prefabHash: safeId(key),
      pngBase64: dataUrl,
    });
    // Return the data URL, not the disk path: the Assets drawer renders it
    // directly and the cache copy is read through get_thumbnail_data later.
    return dataUrl;
  }

  async generatePrefabThumbnail(
    prefabHash: string,
    glbBytes: Uint8Array,
  ): Promise<string> {
    const renderer = makeRenderer(this.canvas);
    const scene = studioScene(renderer);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 1000);
    const group = await parseGlb(glbBytes);
    applyNeutralMaterial(group);
    scene.add(group);
    frameObject(camera, group, {
      yawDegrees: 45,
      elevationDegrees: 30,
      padding: 1.22,
    });
    renderer.render(scene, camera);
    const data = this.canvas.toDataURL("image/png");
    scene.remove(group);
    disposeObject(group);
    renderer.dispose();
    return this.save(prefabHash, data);
  }

  async generateProxyThumbnail(
    prefabHash: string,
    bounds: ProxyBounds,
    category = "Other",
  ): Promise<string> {
    const renderer = makeRenderer(this.canvas);
    const scene = studioScene(renderer);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 1000);
    const width = Math.max(0.5, bounds.max[0] - bounds.min[0]);
    const height = Math.max(0.5, bounds.max[1] - bounds.min[1]);
    const depth = Math.max(0.5, bounds.max[2] - bounds.min[2]);
    const colors: Record<string, number> = {
      Monument: 0xd9a45b,
      Decor: 0x5f8f5a,
      Building: 0x8b93a1,
      Vehicle: 0x9a6fbf,
      Entity: 0x55a3c9,
      Terrain: 0x6f9461,
      Other: 0x7c8794,
    };
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({
        color: colors[category] ?? colors.Other,
        roughness: 0.62,
        metalness: 0.18,
      }),
    );
    group.add(body);
    scene.add(group);
    frameObject(camera, group, {
      yawDegrees: 45,
      elevationDegrees: 30,
      padding: 1.25,
    });
    renderer.render(scene, camera);
    const data = this.canvas.toDataURL("image/png");
    scene.remove(group);
    disposeObject(group);
    renderer.dispose();
    // Proxies are intentionally not written to the thumbnail cache: when the
    // real GLB becomes available the card upgrades to actual geometry.
    return data;
  }

  async generateMonumentThumbnail(
    monumentId: string,
    children: MonumentChildTransform[],
    loadMeshBytes: (prefabHash: string) => Promise<Uint8Array>,
  ): Promise<string> {
    const renderer = makeRenderer(this.canvas);
    const scene = studioScene(renderer);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 10000);
    const group = new THREE.Group();
    const cache = new Map<string, THREE.Group>();
    try {
      for (const child of children) {
        let template = cache.get(child.prefabHash);
        if (!template) {
          const bytes = await loadMeshBytes(child.prefabHash);
          template = await parseGlb(bytes);
          applyNeutralMaterial(template);
          cache.set(child.prefabHash, template);
        }
        const copy = template.clone(true);
        copy.position.set(...child.position);
        copy.rotation.set(
          THREE.MathUtils.degToRad(child.rotation[0]),
          THREE.MathUtils.degToRad(child.rotation[1]),
          THREE.MathUtils.degToRad(child.rotation[2]),
        );
        copy.scale.set(...child.scale);
        group.add(copy);
      }
      if (!group.children.length) throw new Error("monument has no child meshes");
      scene.add(group);
      frameObject(camera, group, {
        yawDegrees: 45,
        elevationDegrees: 55,
        padding: 1.3,
      });
      renderer.render(scene, camera);
      const data = this.canvas.toDataURL("image/png");
      return this.save(`monument_${monumentId}`, data);
    } finally {
      scene.remove(group);
      disposeObject(group);
      for (const template of cache.values()) disposeObject(template);
      renderer.dispose();
    }
  }

  async generateSkinThumbnail(
    skinId: string,
    baseItemGlbBytes: Uint8Array,
    textures: SkinTextureSet,
  ): Promise<string> {
    const renderer = makeRenderer(this.canvas);
    const scene = studioScene(renderer);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 1000);
    const group = await parseGlb(baseItemGlbBytes);
    const loader = new THREE.TextureLoader();
    const load = async (url?: string | null, srgb = false) => {
      if (!url) return null;
      const texture = await loader.loadAsync(url);
      texture.flipY = false;
      texture.needsUpdate = true;
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const [albedo, normal, metallic, emission] = await Promise.all([
      load(textures.albedoUrl, true),
      load(textures.normalUrl),
      load(textures.metallicUrl),
      load(textures.emissionUrl, true),
    ]);

    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const current = mesh.material as THREE.MeshStandardMaterial | undefined;
      current?.dispose();
      mesh.material = new THREE.MeshStandardMaterial({
        map: albedo,
        normalMap: normal,
        metalnessMap: metallic,
        roughnessMap: metallic,
        metalness: metallic ? 1 : 0.55,
        roughness: metallic ? 1 : 0.42,
        emissiveMap: emission,
        emissive: emission ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
        emissiveIntensity: textures.emissiveIntensity ?? 1.2,
        side: THREE.DoubleSide,
      });
    });

    scene.add(group);
    frameObject(camera, group, {
      yawDegrees: 20,
      elevationDegrees: 12,
      padding: 1.15,
    });
    renderer.render(scene, camera);
    const data = this.canvas.toDataURL("image/png");
    scene.remove(group);
    disposeObject(group);
    for (const texture of [albedo, normal, metallic, emission]) texture?.dispose();
    renderer.dispose();
    // ``skinId`` is already the stable cache key from ``skinThumbnailKey``.
    return this.save(skinId, data);
  }
}
