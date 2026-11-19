import type {
  TerrainHeightImport,
  TerrainMaskImport,
  TerrainSettings,
} from "../wizard/types";
import type { TerrainPreview } from "./procedural";
import { SPLAT_INDEX, TOPOLOGY_BITS } from "./procedural";

const HEIGHT_METRES = 1000;
/** Native Rust map grids are 2049² or 4097²; keep them intact end to end. */
export const MAX_IMPORT_RESOLUTION = 4097;

function assertNativeResolution(resolution: number, label: string): void {
  if (resolution > MAX_IMPORT_RESOLUTION) {
    throw new Error(
      `${label} is ${resolution}². Native Rust maps support up to ${MAX_IMPORT_RESOLUTION}² without downsampling.`,
    );
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function uint16Bytes(values: Uint16Array | number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setUint16(index * 2, values[index] & 0xffff, true);
  }
  return bytes;
}

function squareRoot(value: number): number {
  const root = Math.round(Math.sqrt(value));
  return root * root === value ? root : 0;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This WebKit build cannot inflate PNG data. Import a RAW16 heightmap instead.");
  }
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Read 16-bit grayscale/RGB PNG without losing bits through an 8-bit canvas. */
async function decodePng16(buffer: ArrayBuffer): Promise<{
  width: number;
  height: number;
  values: Uint16Array;
}> {
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => bytes[index] !== value)) {
    throw new Error("Not a PNG file.");
  }
  const view = new DataView(buffer);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = view.getUint32(offset - length - 12 + 8);
      height = view.getUint32(offset - length - 12 + 12);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height) throw new Error("PNG has no IHDR dimensions.");
  assertNativeResolution(Math.max(width, height), "PNG grid");
  if (interlace) throw new Error("Interlaced PNGs are not supported; export a non-interlaced heightmap.");
  if (depth !== 8 && depth !== 16) throw new Error("Heightmap PNG must be 8 or 16 bit.");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error("Heightmap PNG must be grayscale or RGB.");
  const joined = new Uint8Array(idat.reduce((total, chunk) => total + chunk.length, 0));
  let cursor = 0;
  for (const chunk of idat) {
    joined.set(chunk, cursor);
    cursor += chunk.length;
  }
  const raw = await inflate(joined);
  const bytesPerSample = depth / 8;
  const stride = width * channels * bytesPerSample;
  const output = new Uint8Array(stride * height);
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[source];
    source += 1;
    const rowStart = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[source + index] ?? 0;
      const left = index >= channels * bytesPerSample ? output[rowStart + index - channels * bytesPerSample] : 0;
      const up = row > 0 ? output[rowStart - stride + index] : 0;
      const upLeft = row > 0 && index >= channels * bytesPerSample ? output[rowStart - stride + index - channels * bytesPerSample] : 0;
      let decoded = value;
      if (filter === 1) decoded += left;
      else if (filter === 2) decoded += up;
      else if (filter === 3) decoded += Math.floor((left + up) / 2);
      else if (filter === 4) decoded += paeth(left, up, upLeft);
      output[rowStart + index] = decoded & 0xff;
    }
    source += stride;
  }
  const values = new Uint16Array(width * height);
  const pixelBytes = channels * bytesPerSample;
  for (let index = 0; index < values.length; index += 1) {
    if (depth === 16) {
      const sample = output[index * pixelBytes] * 256 + output[index * pixelBytes + 1];
      values[index] = sample;
    } else {
      values[index] = output[index * pixelBytes] * 257;
    }
  }
  return { width, height, values };
}

export async function readHeightmapFile(file: File): Promise<TerrainHeightImport> {
  const lower = file.name.toLowerCase();
  let width: number;
  let height: number;
  let values: Uint16Array;
  let encoding: TerrainHeightImport["encoding"];
  if (lower.endsWith(".png")) {
    const decoded = await decodePng16(await file.arrayBuffer());
    width = decoded.width;
    height = decoded.height;
    values = decoded.values;
    encoding = "png16";
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const count = Math.floor(bytes.length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    values = new Uint16Array(count);
    for (let index = 0; index < count; index += 1) values[index] = view.getUint16(index * 2, true);
    const root = squareRoot(count);
    if (!root) throw new Error("RAW16 heightmap must contain a square uint16 grid.");
    width = root;
    height = root;
    encoding = "raw16";
  }
  if (width !== height) throw new Error("Heightmap must be square.");
  if (width < 2) throw new Error("Heightmap is empty.");
  assertNativeResolution(width, "Heightmap");
  let minimum = 65535;
  let maximum = 0;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return {
    name: file.name,
    resolution: width,
    encoding,
    data: bytesToBase64(uint16Bytes(values)),
    minHeight: (minimum / 65535) * HEIGHT_METRES,
    maxHeight: (maximum / 65535) * HEIGHT_METRES,
    verticalScale: 1,
  };
}

export async function readMaskFile(
  file: File,
  kind: TerrainMaskImport["kind"],
  channel: number,
): Promise<TerrainMaskImport> {
  const lower = file.name.toLowerCase();
  let width: number;
  let height: number;
  let data: Uint8Array;
  if (lower.endsWith(".png")) {
    const decoded = await decodePng16(await file.arrayBuffer());
    width = decoded.width;
    height = decoded.height;
    data = new Uint8Array(decoded.values.length);
    for (let index = 0; index < decoded.values.length; index += 1) {
      data[index] = decoded.values[index] >>> 8;
    }
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const root = squareRoot(bytes.length);
    if (!root) throw new Error("RAW8 mask must contain a square byte grid.");
    width = root;
    height = root;
    data = bytes;
  }
  if (width !== height) throw new Error("Mask must be square.");
  if (width < 2) throw new Error("Mask is empty.");
  assertNativeResolution(width, "Mask");
  return {
    id: `mask-${Math.random().toString(36).slice(2, 9)}`,
    name: file.name,
    kind,
    channel,
    resolution: width,
    data: bytesToBase64(data),
  };
}

export function decodeHeightmap(imported: TerrainHeightImport): Float32Array {
  const bytes = base64ToBytes(imported.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(imported.resolution * imported.resolution);
  for (let index = 0; index < values.length; index += 1) {
    const raw = view.getUint16(index * 2, true) / 65535;
    values[index] = raw * HEIGHT_METRES * imported.verticalScale;
  }
  return values;
}

function sampleGrid(
  values: Float32Array | Uint8Array,
  sourceResolution: number,
  u: number,
  v: number,
): number {
  const gx = Math.max(0, Math.min(sourceResolution - 1, u * (sourceResolution - 1)));
  const gz = Math.max(0, Math.min(sourceResolution - 1, v * (sourceResolution - 1)));
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(sourceResolution - 1, x0 + 1);
  const z1 = Math.min(sourceResolution - 1, z0 + 1);
  const tx = gx - x0;
  const tz = gz - z0;
  const top = values[z0 * sourceResolution + x0] * (1 - tx) + values[z0 * sourceResolution + x1] * tx;
  const bottom = values[z1 * sourceResolution + x0] * (1 - tx) + values[z1 * sourceResolution + x1] * tx;
  return top * (1 - tz) + bottom * tz;
}

export function applyHeightmapToPreview(preview: TerrainPreview, imported: TerrainHeightImport): void {
  const source = decodeHeightmap(imported);
  for (let z = 0; z < preview.resolution; z += 1) {
    for (let x = 0; x < preview.resolution; x += 1) {
      preview.heights[z * preview.resolution + x] = sampleGrid(
        source,
        imported.resolution,
        x / (preview.resolution - 1),
        z / (preview.resolution - 1),
      );
    }
  }
  preview.minHeight = imported.minHeight * imported.verticalScale;
  preview.maxHeight = imported.maxHeight * imported.verticalScale;
}

export function applyMasksToPreview(preview: TerrainPreview, settings: TerrainSettings): void {
  for (const mask of settings.masks ?? []) {
    const bytes = base64ToBytes(mask.data);
    const resolution = preview.resolution;
    for (let z = 0; z < resolution; z += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const value = sampleGrid(
          bytes,
          mask.resolution,
          x / (resolution - 1),
          z / (resolution - 1),
        ) / 255;
        if (value <= 0) continue;
        const index = z * resolution + x;
        if (mask.kind === "alpha") {
          preview.alpha[index] = Math.min(preview.alpha[index], Math.round(255 * (1 - value)));
        } else if (mask.kind === "splat") {
          const channel = SPLAT_INDEX[Object.keys(SPLAT_INDEX)[mask.channel] ?? "grass"] ?? 4;
          const offset = index * 8;
          const current = preview.splat[offset + channel];
          preview.splat[offset + channel] = Math.min(255, Math.round(current + (255 - current) * value));
          let total = 0;
          for (let other = 0; other < 8; other += 1) total += preview.splat[offset + other];
          if (total > 0) {
            for (let other = 0; other < 8; other += 1) {
              preview.splat[offset + other] = Math.round((preview.splat[offset + other] * 255) / total);
            }
          }
        } else if (mask.kind === "biome") {
          for (let other = 0; other < 4; other += 1) {
            const offset = index * 4 + other;
            preview.biome[offset] =
              other === mask.channel
                ? Math.min(255, Math.round(preview.biome[offset] + (255 - preview.biome[offset]) * value))
                : Math.round(preview.biome[offset] * (1 - value * 0.85));
          }
        } else {
          const bits = Object.values(TOPOLOGY_BITS);
          const bit = bits[Math.max(0, Math.min(bits.length - 1, mask.channel))] ?? TOPOLOGY_BITS.path_clear;
          preview.topology[index] |= bit;
        }
      }
    }
  }
}
