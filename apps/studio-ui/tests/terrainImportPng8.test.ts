import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { readHeightmapFile } from "../src/lib/terrainImport.ts";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A filter-0, non-interlaced 8-bit grayscale PNG, which is what DCC tools emit. */
function grayscale8(size: number, samples: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // non-interlaced

  const raw = new Uint8Array(size * (size + 1));
  for (let row = 0; row < size; row += 1) {
    raw[row * (size + 1)] = 0;
    raw.set(samples.subarray(row * size, row * size + size), row * (size + 1) + 1);
  }

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** The import stores a base64 little-endian uint16 grid. */
function heights(imported: { data: string }): number[] {
  const bytes = Buffer.from(imported.data, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 2 }, (_, index) => view.getUint16(index * 2, true));
}

test("8-bit greyscale PNG import scales every sample to uint16", async () => {
  const size = 9;
  const samples = new Uint8Array(size * size);
  for (let index = 0; index < samples.length; index += 1) samples[index] = (index * 37) % 256;

  const png = grayscale8(size, samples);
  const imported = await readHeightmapFile(
    new File([png], "heights-8bit.png", { type: "image/png" }),
  );

  assert.equal(imported.resolution, size);
  assert.equal(imported.encoding, "png16");
  assert.deepEqual(
    heights(imported),
    Array.from(samples, (value) => value * 257),
  );
  // Heights are world metres (0 = -500 m), derived from the scaled uint16 payload.
  assert.equal(imported.minHeight, ((Math.min(...samples) * 257) / 65535) * 1000 - 500);
  assert.equal(imported.maxHeight, ((Math.max(...samples) * 257) / 65535) * 1000 - 500);
});

test("an 8-bit PNG reaches the same uint16 payload as the same 16-bit heights", async () => {
  const size = 9;
  const samples = new Uint8Array(size * size);
  for (let index = 0; index < samples.length; index += 1) samples[index] = (index * 11) % 256;

  const imported = await readHeightmapFile(
    new File([grayscale8(size, samples)], "heights-8bit.png", { type: "image/png" }),
  );
  const wide = new Uint8Array(size * size * 2);
  for (let index = 0; index < samples.length; index += 1) {
    wide[index * 2] = samples[index];
    wide[index * 2 + 1] = samples[index];
  }
  const raw = await readHeightmapFile(
    new File([wide], "heights.raw", { type: "application/octet-stream" }),
  );

  assert.deepEqual(heights(imported), heights(raw));
  assert.equal(imported.data, raw.data);
});
