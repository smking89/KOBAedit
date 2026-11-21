import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { extractPrefabGlb, isTauri, loadCachedMeshBytes, loadLocalMeshBytes } from "../lib/ipc";
import type { PrefabAsset } from "../wizard/types";
import type { BaseMeshAsset } from "../lib/demoAssets";
import { prefabThumbnailHash } from "../utils/thumbnailQueue";

const CATEGORY_COLORS: Record<string, number> = {
  Monument: 0xd9a45b,
  Decor: 0x5f8f5a,
  Building: 0x8b93a1,
  Vehicle: 0x9a6fbf,
  Entity: 0x55a3c9,
  Terrain: 0x6f9461,
  Other: 0x7c8794,
};

export function AssetTurntable({ prefab }: { prefab: PrefabAsset }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "proxy">("loading");
  const [reload, setReload] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 4 / 3, 0.01, 100);
    camera.position.set(2.2, 1.7, 2.6);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(240, 180, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xfff4e2, 2.4);
    key.position.set(3, 4, 3);
    const rim = new THREE.DirectionalLight(0x8fb6e8, 1.3);
    rim.position.set(-3, 2, -3);
    scene.add(key, rim);

    const group = new THREE.Group();
    scene.add(group);
    let frame = 0;

    const addProxy = () => {
      const width = Math.max(0.2, prefab.bounds.max[0] - prefab.bounds.min[0]);
      const height = Math.max(0.2, prefab.bounds.max[1] - prefab.bounds.min[1]);
      const depth = Math.max(0.2, prefab.bounds.max[2] - prefab.bounds.min[2]);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, depth),
        new THREE.MeshStandardMaterial({
          color: CATEGORY_COLORS[prefab.category] ?? CATEGORY_COLORS.Other,
          roughness: 0.6,
          metalness: 0.2,
        }),
      );
      group.add(mesh);
      setState("proxy");
    };

    const normalize = () => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      group.position.sub(sphere.center);
      const scale = 1.35 / Math.max(sphere.radius, 0.001);
      group.scale.setScalar(scale);
    };

    const animate = () => {
      if (disposed) return;
      group.rotation.y += 0.012;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };

    loadCachedMeshBytes(prefabThumbnailHash(prefab.id))
      .then(async (bytes) => {
        if (disposed) return;
        if (!bytes) {
          addProxy();
          return;
        }
        const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, "");
        if (disposed) return;
        group.add(gltf.scene);
        group.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.material = new THREE.MeshStandardMaterial({
            color: 0x9aa3ad,
            roughness: 0.58,
            metalness: 0.25,
            side: THREE.DoubleSide,
          });
        });
        normalize();
        setState("ready");
      })
      .catch(() => {
        if (!disposed) addProxy();
      });

    animate();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [prefab, reload]);

  const renderRealPreview = async () => {
    setExtracting(true);
    setMessage(null);
    try {
      const extracted = await extractPrefabGlb(prefab.id);
      const bytes = extracted
        ? await loadCachedMeshBytes(prefabThumbnailHash(prefab.id))
        : null;
      if (bytes) {
        setReload((value) => value + 1);
        return;
      }
      setMessage("No extractable geometry in the linked Bundles folder.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="asset-turntable" aria-label={`3D preview of ${prefab.name}`}>
      <div ref={hostRef} />
      {state === "loading" && <span>Loading mesh</span>}
      {state === "proxy" && <span>Proxy preview</span>}
      {state !== "ready" && (
        <button
          type="button"
          className="asset-turntable-action"
          disabled={extracting}
          onClick={() => void renderRealPreview()}
        >
          {extracting ? "Extracting…" : "Render real preview"}
        </button>
      )}
      {message && <em className="asset-turntable-note">{message}</em>}
    </div>
  );
}

/** Hover preview for a skin base mesh. Falls back to a clean proxy cube. */
export function SkinTurntable({ mesh }: { mesh: BaseMeshAsset }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "proxy">("loading");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 4 / 3, 0.01, 100);
    camera.position.set(2.2, 1.5, 2.6);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(240, 180, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xfff4e2, 2.2);
    key.position.set(3, 4, 3);
    const rim = new THREE.DirectionalLight(0x8fb6e8, 1.2);
    rim.position.set(-3, 2, -3);
    scene.add(key, rim);
    const group = new THREE.Group();
    scene.add(group);
    let frame = 0;
    const animate = () => {
      if (disposed) return;
      group.rotation.y += 0.012;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    const normalize = () => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      group.position.sub(sphere.center);
      group.scale.setScalar(1.35 / Math.max(sphere.radius, 0.001));
    };
    const addProxy = () => {
      group.add(
        new THREE.Mesh(
          new THREE.BoxGeometry(1.8, 0.7, 0.36),
          new THREE.MeshStandardMaterial({ color: 0x8b93a1, roughness: 0.42, metalness: 0.7 }),
        ),
      );
      normalize();
      setState("proxy");
    };
    loadCachedMeshBytes(prefabThumbnailHash(mesh.id))
      .then(async (cached) => {
        if (disposed) return;
        let bytes = cached;
        if (!bytes && isTauri()) bytes = await loadLocalMeshBytes(mesh.id);
        if (!bytes) {
          addProxy();
          return;
        }
        const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, "");
        if (disposed) return;
        group.add(gltf.scene);
        normalize();
        setState("ready");
      })
      .catch(() => {
        if (!disposed) addProxy();
      });
    animate();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      group.traverse((object) => {
        const entry = object as THREE.Mesh;
        entry.geometry?.dispose();
        const material = entry.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [mesh]);

  return (
    <div className="asset-turntable" aria-label={`3D preview of ${mesh.name}`}>
      <div ref={hostRef} />
      {state === "loading" && <span>Loading mesh</span>}
      {state === "proxy" && <span>Proxy preview</span>}
    </div>
  );
}
