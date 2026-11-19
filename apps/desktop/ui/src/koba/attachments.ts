import { unzipSync } from "fflate";

import type { WizardDraft } from "../wizard/types";
import type { ImageProfile, KobaAttachment } from "./types";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1200;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `koba-${Math.random().toString(36).slice(2)}`;
}

function suffixOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function mimeFor(name: string): string {
  switch (suffixOf(name)) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function bucketKey(r: number, g: number, b: number): string {
  return `${r >> 4}-${g >> 4}-${b >> 4}`;
}

/** Downsample an image and derive a dominant/accent palette. */
export async function profileImage(blob: Blob): Promise<ImageProfile> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("The image could not be decoded. Use PNG, JPEG, WebP or GIF.");
  }
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const canvas = document.createElement("canvas");
  const width = 36;
  const height = Math.max(1, Math.round((sourceHeight / Math.max(1, sourceWidth)) * width));
  canvas.width = width;
  canvas.height = Math.min(48, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("The browser could not read image pixels.");
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let luminance = 0;
  let sampled = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 48) continue;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sampled += 1;
    const key = bucketKey(r, g, b);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      count: bucket.count,
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
    }))
    .sort((a, b) => b.count - a.count);
  const dominant = ranked[0] ?? { r: 120, g: 130, b: 140, count: 1 };
  const accent =
    [...ranked]
      .slice(0, 12)
      .sort((a, b) => {
        const satA = (Math.max(a.r, a.g, a.b) - Math.min(a.r, a.g, a.b)) / 255;
        const satB = (Math.max(b.r, b.g, b.b) - Math.min(b.r, b.g, b.b)) / 255;
        return satB * b.count - satA * a.count;
      })[0] ?? dominant;
  const colors = ranked.slice(0, 5).map((color) => `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`);

  bitmap.close();
  return {
    width: sourceWidth,
    height: sourceHeight,
    dominant: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
    accent: `#${hex(accent.r)}${hex(accent.g)}${hex(accent.b)}`,
    luminance: sampled ? luminance / sampled / 255 : 0.5,
    colors,
  };
}

function isWizardDraft(value: unknown): value is WizardDraft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WizardDraft>;
  return (
    (candidate.projectKind === "map" ||
      candidate.projectKind === "monument" ||
      candidate.projectKind === "skin") &&
    Boolean(candidate.terrain) &&
    Boolean(candidate.skin) &&
    Boolean(candidate.export)
  );
}

function extractDraft(text: string): WizardDraft | null {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const direct = parsed.draft ?? (parsed.state as Record<string, unknown> | undefined)?.draft ?? parsed;
    return isWizardDraft(direct) ? direct : null;
  } catch {
    return null;
  }
}

export async function readAttachment(file: File): Promise<KobaAttachment> {
  const suffix = suffixOf(file.name);
  const isImage = file.type.startsWith("image/") || IMAGE_SUFFIXES.includes(suffix);
  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`${file.name} is larger than 25 MB.`);
    }
    const previewUrl = URL.createObjectURL(file);
    try {
      const image = await profileImage(file);
      return {
        id: uid(),
        name: file.name,
        kind: "image",
        bytes: file.size,
        previewUrl,
        image,
      };
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      throw error;
    }
  }

  if (suffix !== ".zip" && file.type !== "application/zip") {
    throw new Error(`${file.name} is not supported. Attach a .zip project or a PNG/JPEG/WebP image.`);
  }
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error(`${file.name} is larger than 40 MB.`);
  }

  let files: Record<string, Uint8Array>;
  let unpacked = 0;
  try {
    files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (entry) => {
        if (entry.originalSize > MAX_ENTRY_BYTES) return false;
        unpacked += entry.originalSize;
        return unpacked <= MAX_UNPACKED_BYTES;
      },
    });
  } catch {
    throw new Error(`${file.name} could not be opened as a ZIP archive.`);
  }
  const names = Object.keys(files);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`${file.name} contains more than ${MAX_ZIP_ENTRIES} files.`);
  }

  const decoder = new TextDecoder();
  let projectDraft: WizardDraft | null = null;
  const jsonCandidates = names.filter((name) => /(^|\/)(project|draft)\.json$/i.test(name));
  for (const name of jsonCandidates) {
    const bytes = files[name];
    if (!bytes || bytes.byteLength > 4 * 1024 * 1024) continue;
    projectDraft = extractDraft(decoder.decode(bytes));
    if (projectDraft) break;
  }

  const imageName = names.find((name) => IMAGE_SUFFIXES.includes(suffixOf(name)));
  let image: ImageProfile | undefined;
  let previewUrl: string | undefined;
  if (imageName) {
    const bytes = files[imageName];
    if (bytes && bytes.byteLength <= MAX_ENTRY_BYTES) {
      const buffer = new Uint8Array(bytes).buffer;
      const blob = new Blob([buffer], { type: mimeFor(imageName) });
      previewUrl = URL.createObjectURL(blob);
      try {
        image = await profileImage(blob);
      } catch {
        image = undefined;
      }
    }
  }

  return {
    id: uid(),
    name: file.name,
    kind: "zip",
    bytes: file.size,
    previewUrl,
    image,
    zip: {
      entries: names.length,
      names: names.slice(0, 80),
      mapFiles: names.filter((name) => name.toLowerCase().endsWith(".map")),
      prefabFiles: names.filter((name) => name.toLowerCase().endsWith(".prefab")),
      projectDraft,
    },
  };
}

export function revokeAttachment(attachment: KobaAttachment): void {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}
