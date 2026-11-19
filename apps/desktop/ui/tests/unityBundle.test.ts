import assert from "node:assert/strict";
import test from "node:test";

import { lz4Decompress, parseUnityBundle } from "../src/lib/unityBundle.ts";
import { readAttachment } from "../src/koba/attachments.ts";

const encoder = new TextEncoder();

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
