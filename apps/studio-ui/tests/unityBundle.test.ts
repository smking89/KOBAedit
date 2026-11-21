import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { lz4Decompress, parseUnityBundle } from "../src/lib/unityBundle.ts";
import { lzmaDecompress } from "../src/lib/lzma.ts";
import { readAttachment } from "../src/koba/attachments.ts";

const encoder = new TextEncoder();

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function cstr(text: string): number[] {
  return [...encoder.encode(text), 0];
}

/** Builds an uncompressed UnityFS bundle with one prefab asset. */
function sampleBundle(): { bytes: Uint8Array; payload: Uint8Array } {
  const payload = encoder.encode("PREFAB-CONTENT");
  const path = "assets/bundled/prefabs/autospawn/monument/harbor.prefab";
  const info: number[] = [
    ...new Array(16).fill(0),
    0, 0, 0, 1, // block count
    0, 0, 0, payload.length, // uncompressed
    0, 0, 0, payload.length, // compressed
    0, 0, // flags: none
    0, 0, 0, 1, // node count
    0, 0, 0, 0, 0, 0, 0, 0, // offset
    0, 0, 0, 0, 0, 0, 0, payload.length, // size
    0, 0, 0, 0, // flags
    ...cstr(path),
  ];
  const header: number[] = [
    ...cstr("UnityFS").slice(0, 8),
    0, 0, 0, 7,
    ...cstr("5.1.0"),
    ...cstr("2019.4.0f1"),
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, info.length,
    0, 0, 0, info.length,
    0, 0, 0, 0,
  ];
  return { bytes: Uint8Array.from([...header, ...info, ...payload]), payload };
}

/** Literal-only LZ4 block encoder, enough to exercise the decoder path. */
function lz4Literals(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  if (data.length < 15) {
    out.push(data.length << 4);
  } else {
    out.push(0xf0);
    let remaining = data.length - 15;
    while (remaining >= 255) {
      out.push(255);
      remaining -= 255;
    }
    out.push(remaining);
  }
  out.push(...data);
  return Uint8Array.from(out);
}

/** Real LZ4 data block; the block table stays raw so sizes are explicit. */
function sampleLz4Bundle(): Uint8Array {
  const payload = encoder.encode("LZ4-PREFAB-CONTENT");
  const path = "assets/bundled/prefabs/autospawn/monument/harbor.prefab";
  const block = lz4Literals(payload);
  const info = Uint8Array.from([
    ...new Array(16).fill(0),
    0, 0, 0, 1,
    0, 0, 0, payload.length,
    0, 0, 0, block.length,
    0, 2, // data block: LZ4
    0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, payload.length,
    0, 0, 0, 0,
    ...cstr(path),
  ]);
  const header = Uint8Array.from([
    85, 110, 105, 116, 121, 70, 83, 0,
    0, 0, 0, 7,
    ...cstr("5.1.0"),
    ...cstr("2019.4.0f1"),
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, info.length,
    0, 0, 0, info.length,
    0, 0, 0, 0, // blocks info: uncompressed
  ]);
  return Uint8Array.from([...header, ...info, ...block]);
}

test("parses LZ4-compressed bundles end to end", async () => {
  const bytes = sampleLz4Bundle();
  const bundle = parseUnityBundle(bytes);
  assert.ok(bundle.compression.includes("LZ4"), bundle.compression);
  assert.equal(new TextDecoder().decode(bundle.entries[0]!.bytes), "LZ4-PREFAB-CONTENT");
  const file = new File([bytes], "lz4.bundle", { type: "application/octet-stream" });
  const attachment = await readAttachment(file);
  assert.ok(attachment.unity?.compression.includes("LZ4"));
  assert.deepEqual(attachment.zip?.prefabFiles, [
    "assets/bundled/prefabs/autospawn/monument/harbor.prefab",
  ]);
});

test("parses an uncompressed UnityFS bundle", () => {
  const { bytes, payload } = sampleBundle();
  const bundle = parseUnityBundle(bytes);
  assert.equal(bundle.format, "UnityFS");
  assert.equal(bundle.compression, "none");
  assert.deepEqual(bundle.entries.map((entry) => entry.path), [
    "assets/bundled/prefabs/autospawn/monument/harbor.prefab",
  ]);
  assert.equal(new TextDecoder().decode(bundle.entries[0]!.bytes), "PREFAB-CONTENT");
  assert.equal(payload.length, 14);
});

test("LZ4 block decompression round-trips literals", () => {
  // token: 4 literals, match length 4, offset 1
  const encoded = Uint8Array.from([0x40, 0x41, 0x42, 0x43, 0x44, 0x04, 0x00]);
  const output = lz4Decompress(encoded, 8);
  assert.equal(new TextDecoder().decode(output), "ABCDABCD");
});

test("attachments expose unpacked bundle assets", async () => {
  const { bytes } = sampleBundle();
  const file = new File([bytes], "harbor.bundle", { type: "application/octet-stream" });
  const attachment = await readAttachment(file);
  assert.equal(attachment.unity?.format, "UnityFS");
  assert.equal(attachment.unity?.compression, "none");
  assert.equal(attachment.zip?.entries, 1);
  assert.deepEqual(attachment.zip?.prefabFiles, [
    "assets/bundled/prefabs/autospawn/monument/harbor.prefab",
  ]);
});


/** Real LZMA-alone stream produced by `xz --format=lzma`. */
const lzmaRaw = new Uint8Array(readFileSync(new URL("./fixtures/lzma-payload.raw", import.meta.url)));
const lzmaStream = new Uint8Array(readFileSync(new URL("./fixtures/lzma-payload.bin", import.meta.url)));

test("decodes a real LZMA stream", () => {
  const output = lzmaDecompress(lzmaStream, lzmaRaw.length);
  assert.deepEqual(Buffer.from(output), Buffer.from(lzmaRaw));
});

test("parses an LZMA-compressed bundle end to end", () => {
  const path = "assets/bundled/prefabs/autospawn/monument/harbor.prefab";
  const info = Uint8Array.from([
    ...new Array(16).fill(0),
    0, 0, 0, 1,
    ...u32(lzmaRaw.length),
    ...u32(lzmaStream.length),
    0, 1, // data block: LZMA
    0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, ...u32(lzmaRaw.length),
    0, 0, 0, 0,
    ...cstr(path),
  ]);
  const bytes = Uint8Array.from([
    85, 110, 105, 116, 121, 70, 83, 0,
    0, 0, 0, 7,
    ...cstr("5.1.0"),
    ...cstr("2019.4.0f1"),
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, info.length,
    0, 0, 0, info.length,
    0, 0, 0, 0,
    ...info,
    ...lzmaStream,
  ]);
  const bundle = parseUnityBundle(bytes);
  assert.ok(bundle.compression.includes("LZMA"));
  assert.equal(bundle.entries[0]?.path, path);
  assert.deepEqual(Buffer.from(bundle.entries[0]!.bytes), Buffer.from(lzmaRaw));
});
