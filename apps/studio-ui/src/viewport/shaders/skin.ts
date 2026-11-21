import * as THREE from "three";

/**
 * Shader injections for the skin preview.
 *
 * Decals are projected in world space: the fragment computes the stamp UV from
 * a projector matrix captured when the stroke was dropped, so UV seams and
 * stretching never smear the stencil. A grazing-angle fade avoids the classic
 * "sticker wrap" look on hard edges.
 *
 * Wear is procedural (world-space noise + fresnel edge mask) and modifies albedo
 * and roughness, which is what the exported diffuse/specular channels bake.
 */

export interface SkinShaderUniforms {
  uDecalMap: THREE.IUniform<THREE.Texture | null>;
  uDecalMatrix: THREE.IUniform<THREE.Matrix4>;
  uDecalOpacity: THREE.IUniform<number>;
  uDecalTint: THREE.IUniform<THREE.Color>;
  uUseDecal: THREE.IUniform<number>;
  uWear: THREE.IUniform<THREE.Vector4>;
  uEmission: THREE.IUniform<number>;
}

export function createSkinUniforms(): SkinShaderUniforms {
  return {
    uDecalMap: { value: null },
    uDecalMatrix: { value: new THREE.Matrix4() },
    uDecalOpacity: { value: 0 },
    uDecalTint: { value: new THREE.Color(0xffffff) },
    uUseDecal: { value: 0 },
    uWear: { value: new THREE.Vector4(0.35, 0.2, 0.15, 0.25) },
    uEmission: { value: 0 },
  };
}

export function injectSkinShading(
  material: THREE.MeshStandardMaterial,
  uniforms: SkinShaderUniforms,
): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vSkinWorldPosition;
        varying vec3 vSkinWorldNormal;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vSkinWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSkinWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uDecalMap;
        uniform mat4 uDecalMatrix;
        uniform float uDecalOpacity;
        uniform vec3 uDecalTint;
        uniform float uUseDecal;
        uniform vec4 uWear;
        uniform float uEmission;
        varying vec3 vSkinWorldPosition;
        varying vec3 vSkinWorldNormal;

        float skinHash(vec3 position) {
          return fract(sin(dot(floor(position * 9.0), vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        }`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec3 skinViewDirection = normalize(cameraPosition - vSkinWorldPosition);
        float skinFresnel = pow(1.0 - abs(dot(normalize(vSkinWorldNormal), skinViewDirection)), 2.2);
        float skinGrain = skinHash(vSkinWorldPosition);

        // Procedural grime and edge wear.
        float wearMask = clamp(skinFresnel * uWear.x * 1.6 + skinGrain * uWear.y * 0.35, 0.0, 1.0);
        vec3 wearColor = vec3(0.58, 0.59, 0.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, wearColor, wearMask * 0.55);

        float dirtBand = smoothstep(0.35, 0.0, vSkinWorldPosition.y) * uWear.z;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.19, 0.15), dirtBand * 0.45);

        // Stencil projection.
        if (uUseDecal > 0.5 && uDecalOpacity > 0.001) {
          vec4 projectorSpace = uDecalMatrix * vec4(vSkinWorldPosition, 1.0);
          vec2 stampUv = projectorSpace.xy / max(0.0001, projectorSpace.w) * 0.5 + 0.5;
          vec3 projectorDir = normalize((uDecalMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
          float facing = clamp(dot(normalize(vSkinWorldNormal), -projectorDir) * 1.7 - 0.35, 0.0, 1.0);
          if (stampUv.x >= 0.0 && stampUv.x <= 1.0 && stampUv.y >= 0.0 && stampUv.y <= 1.0) {
            vec4 stamp = texture2D(uDecalMap, stampUv);
            float amount = stamp.a * uDecalOpacity * facing;
            diffuseColor.rgb = mix(diffuseColor.rgb, stamp.rgb * uDecalTint, amount);
          }
        }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(
          roughnessFactor + skinFresnel * uWear.x * 0.25 + skinGrain * uWear.w * 0.2,
          0.03,
          1.0
        );`,
      );
  };

  material.customProgramCacheKey = () => "rust-studio-skin-v1";
  material.needsUpdate = true;
}

/** Build a canvas stamp texture for a decal stroke. */
export function createStampTexture(
  stamp: "stripe" | "hazard" | "circle" | "number" | "scratch" | "custom",
  color: string,
  size = 512,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  ctx.clearRect(0, 0, size, size);

  if (stamp === "stripe") {
    ctx.fillStyle = color;
    ctx.fillRect(size * 0.1, size * 0.42, size * 0.8, size * 0.16);
  } else if (stamp === "hazard") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(size * 0.08, size * 0.28, size * 0.84, size * 0.44);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(size * 0.08, size * 0.28, size * 0.84, size * 0.44);
    ctx.strokeStyle = "rgba(16,16,16,0.78)";
    ctx.lineWidth = size * 0.06;
    for (let x = -size; x < size * 2; x += size * 0.14) {
      ctx.beginPath();
      ctx.moveTo(x, size);
      ctx.lineTo(x + size * 0.5, 0);
      ctx.stroke();
    }
    ctx.restore();
  } else if (stamp === "circle") {
    ctx.strokeStyle = color;
    ctx.lineWidth = size * 0.08;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.33, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = size * 0.03;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.22, 0, Math.PI * 2);
    ctx.stroke();
  } else if (stamp === "number") {
    ctx.fillStyle = color;
    ctx.font = `bold ${size * 0.62}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("07", size / 2, size * 0.53);
  } else if (stamp === "scratch") {
    ctx.strokeStyle = color;
    ctx.lineWidth = size * 0.012;
    for (let index = 0; index < 16; index += 1) {
      const y = size * (0.18 + Math.random() * 0.64);
      const x = size * (0.12 + Math.random() * 0.4);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + size * (0.18 + Math.random() * 0.35), y + (Math.random() - 0.5) * size * 0.03);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Projector matrix from a hit point aligned to the surface normal. */
export function projectorMatrixFromHit(point: THREE.Vector3, normal: THREE.Vector3, size: number): THREE.Matrix4 {
  const camera = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0.01, Math.max(4, size * 2));
  const offset = normal.clone().normalize().multiplyScalar(Math.max(0.2, size * 0.5));
  camera.position.copy(point).add(offset);
  camera.lookAt(point);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}
