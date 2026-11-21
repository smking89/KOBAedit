/**
 * Terrain shader.
 *
 * - 8 ground weights from two RGBA textures (splatA = channels 0-3, splatB = 4-7)
 * - biome tint from a 4-channel climax map
 * - alpha map holes (discard) and a red mask preview in Studio Mode
 * - 32-bit topology sampled as packed RGBA; the editor overlay byte (bits 24-30)
 *   drives the no-build / monument pad / foliage / path / loot / NPC / safe-zone
 *   colour overlay without disturbing the game's lower bits
 * - contour lines every 25 m for scale reading
 */

export const terrainVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vHeight;

void main() {
  vUv = uv;
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vHeight = position.y;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const terrainFragmentShader = /* glsl */ `
uniform sampler2D uSplatA;
uniform sampler2D uSplatB;
uniform sampler2D uBiomeMap;
uniform sampler2D uAlphaMap;
uniform sampler2D uTopologyMap;

uniform vec3 uSplatColors[8];
uniform vec3 uBiomeColors[4];
uniform vec3 uSunDirection;
uniform float uShowTopology;
uniform float uShowAlphaMask;
uniform float uWaterLevel;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vHeight;

float overlayBit(float flags, float divisor) {
  return mod(floor(flags / divisor), 2.0);
}

void main() {
  vec4 splatA = texture2D(uSplatA, vUv);
  vec4 splatB = texture2D(uSplatB, vUv);

  float weightSum =
    splatA.r + splatA.g + splatA.b + splatA.a +
    splatB.r + splatB.g + splatB.b + splatB.a;
  weightSum = max(weightSum, 0.001);

  vec3 ground =
    uSplatColors[0] * splatA.r +
    uSplatColors[1] * splatA.g +
    uSplatColors[2] * splatA.b +
    uSplatColors[3] * splatA.a +
    uSplatColors[4] * splatB.r +
    uSplatColors[5] * splatB.g +
    uSplatColors[6] * splatB.b +
    uSplatColors[7] * splatB.a;
  ground /= weightSum;

  vec4 biome = texture2D(uBiomeMap, vUv);
  float biomeSum = max(biome.r + biome.g + biome.b + biome.a, 0.001);
  vec3 biomeTint =
    (uBiomeColors[0] * biome.r +
     uBiomeColors[1] * biome.g +
     uBiomeColors[2] * biome.b +
     uBiomeColors[3] * biome.a) / biomeSum;
  vec3 albedo = mix(ground, ground * (0.7 + biomeTint * 0.55), 0.32);

  float alpha = texture2D(uAlphaMap, vUv).r;
  if (alpha < 0.35) {
    if (uShowAlphaMask > 0.5) {
      gl_FragColor = vec4(0.85, 0.18, 0.16, 1.0);
      return;
    }
    discard;
  }

  vec4 topology = texture2D(uTopologyMap, vUv);
  float editorFlags = floor(topology.a * 255.0 + 0.5);
  vec3 overlay = vec3(0.0);
  float overlayWeight = 0.0;
  if (overlayBit(editorFlags, 1.0) > 0.5) { overlay += vec3(0.92, 0.22, 0.18); overlayWeight += 1.0; }
  if (overlayBit(editorFlags, 2.0) > 0.5) { overlay += vec3(0.25, 0.55, 1.0); overlayWeight += 1.0; }
  if (overlayBit(editorFlags, 4.0) > 0.5) { overlay += vec3(0.32, 0.82, 0.4); overlayWeight += 1.0; }
  if (overlayBit(editorFlags, 8.0) > 0.5) { overlay += vec3(0.95, 0.74, 0.24); overlayWeight += 1.0; }
  if (overlayBit(editorFlags, 16.0) > 0.5) { overlay += vec3(0.82, 0.36, 0.85); overlayWeight += 1.0; }
  if (overlayWeight > 0.0) {
    vec3 overlayColor = overlay / overlayWeight;
    albedo = mix(albedo, overlayColor, 0.62 * uShowTopology);
  }

  float contour = smoothstep(0.9, 1.0, fract(vHeight / 25.0));
  albedo *= 1.0 - contour * 0.09;

  vec3 normal = normalize(vWorldNormal);
  vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
  float diffuse = max(dot(normal, normalize(uSunDirection)), 0.0);
  float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 2.5);
  float ambient = 0.34 + 0.12 * normal.y;

  vec3 color = albedo * (ambient + diffuse * 0.8) + vec3(0.07, 0.12, 0.16) * rim;

  if (vHeight < uWaterLevel) {
    float depth = clamp((uWaterLevel - vHeight) / 25.0, 0.0, 1.0);
    color = mix(color, vec3(0.025, 0.12, 0.19), 0.25 + depth * 0.4);
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

export const SPLAT_PALETTE: [number, number, number][] = [
  [0.51, 0.42, 0.29], // dirt
  [0.85, 0.89, 0.92], // snow
  [0.79, 0.7, 0.42], // sand
  [0.45, 0.41, 0.38], // rock
  [0.37, 0.52, 0.25], // grass
  [0.2, 0.34, 0.17], // forest
  [0.59, 0.55, 0.51], // stones
  [0.49, 0.46, 0.42], // gravel
];

export const BIOME_PALETTE: [number, number, number][] = [
  [1.0, 0.82, 0.56], // arid
  [0.72, 0.9, 0.62], // temperate
  [0.62, 0.78, 0.85], // tundra
  [0.86, 0.94, 1.0], // arctic
];
