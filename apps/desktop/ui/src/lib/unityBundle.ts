/**
 * Minimal Unity AssetBundle (UnityFS) reader.
 *
 * Parses the header, the block table and the asset directory, decompresses
 * uncompressed/LZ4 blocks and returns each node's raw bytes. LZMA-compressed
 * bundles are not decoded here (many Rust bundles use LZ4); callers get a
 * specific error so the UI can explain the limitation.
 */

export interface BundleEntry {
  path: string;
  bytes: Uint8Array;
}

export interface UnityBundle {
  format: string;
  version: number;
  unityVersion: string;
  compression: string;
  entries: BundleEntry[];
}

const MAX_OUTPUT = 512 * 1024 * 1024;

class Reader {
  private view: DataView;
  private data: Uint8Array;
  offset = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(): number {
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  i32(): number {
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  i64(): number {
    const high = this.view.getInt32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return high * 4294967296 + low;
  }

  cstr(): string {
    let end = this.offset;
    while (end < this.data.length && this.data[end] !== 0) end += 1;
    const text = new TextDecoder().decode(this.data.subarray(this.offset, end));
    this.offset = end + 1;
    return text;
  }

  bytes(length: number): Uint8Array {
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}

/** LZ4 block decompressor (the framing Unity uses inside blocks). */
export function lz4Decompress(source: Uint8Array, outputSize: number): Uint8Array {
  if (outputSize > MAX_OUTPUT) throw new Error("bundle block is too large");
  const output = new Uint8Array(outputSize);
  let ip = 0;
  let op = 0;
  while (ip < source.length) {
    const token = source[ip++]!;
    let literals = token >> 4;
    if (literals === 15) {
      let extra = 255;
      while (extra === 255) {
        extra = source[ip++]!;
        literals += extra;
      }
    }
    if (op + literals > output.length) throw new Error("bundle block overflow");
    output.set(source.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;
    if (ip >= source.length) break;
    const offset = source[ip]! | (source[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error("bundle block is corrupt");
    let match = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let extra = 255;
      while (extra === 255) {
        extra = source[ip++]!;
        match += extra;
      }
    }
    if (op + match > output.length) throw new Error("bundle block overflow");
    for (let index = 0; index < match; index += 1) {
      output[op + index] = output[op - offset + index]!;
    }
    op += match;
  }
  return output;
}

function decompress(data: Uint8Array, mode: number, outputSize: number): Uint8Array {
  if (mode === 0) return data.slice(0, outputSize);
  if (mode === 2 || mode === 3) return lz4Decompress(data, outputSize);
  if (mode === 1) throw new Error("LZMA-compressed Unity bundles are not supported yet");
  throw new Error(`unknown Unity bundle compression ${mode}`);
}

export function parseUnityBundle(data: Uint8Array): UnityBundle {
  const magic = new TextDecoder().decode(data.subarray(0, 8)).replace(/\0+$/, "");
  if (!/^Unity(FS|Web|Raw)$/.test(magic)) {
    throw new Error(`${magic || "file"} is not a Unity AssetBundle`);
  }
  const reader = new Reader(data);
  reader.bytes(8);
  const version = reader.u32();
  const unityVersion = reader.cstr();
  const unityRevision = reader.cstr();
  const totalSize = reader.i64();
  const compressedInfoSize = reader.u32();
  const uncompressedInfoSize = reader.u32();
  const flags = reader.u32();
  const infoMode = flags & 0x3f;
  const infoAtEnd = (flags & 0x80) !== 0;

  const infoStart = infoAtEnd ? data.length - compressedInfoSize : reader.offset;
  const infoRaw = data.subarray(infoStart, infoStart + compressedInfoSize);
  if (infoRaw.length !== compressedInfoSize) throw new Error("bundle header is truncated");
  const info = decompress(infoRaw, infoMode, uncompressedInfoSize);

  const infoReader = new Reader(info);
  infoReader.bytes(16);
  const blockCount = infoReader.i32();
  const blocks: { uncompressed: number; compressed: number; mode: number }[] = [];
  for (let index = 0; index < blockCount; index += 1) {
    blocks.push({
      uncompressed: infoReader.u32(),
      compressed: infoReader.u32(),
      mode: infoReader.u16() & 0x3f,
    });
  }
  const nodeCount = infoReader.i32();
  const nodes: { offset: number; size: number; path: string }[] = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const offset = infoReader.i64();
    const size = infoReader.i64();
    infoReader.u32();
    nodes.push({ offset, size, path: infoReader.cstr() });
  }

  // Data blocks follow the info (or start at the header when info is at the end).
  let dataOffset = infoAtEnd ? reader.offset : infoStart + compressedInfoSize;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const block of blocks) {
    if (total + block.uncompressed > MAX_OUTPUT) throw new Error("bundle is too large");
    const source = data.subarray(dataOffset, dataOffset + block.compressed);
    dataOffset += block.compressed;
    if (source.length !== block.compressed) throw new Error("bundle is truncated");
    const chunk = decompress(source, block.mode, block.uncompressed);
    chunks.push(chunk);
    total += chunk.length;
  }
  const flat = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    flat.set(chunk, cursor);
    cursor += chunk.length;
  }

  const entries = nodes.map((node) => {
    if (node.offset < 0 || node.offset + node.size > flat.length) {
      throw new Error(`bundle asset ${node.path} is outside the data stream`);
    }
    return { path: node.path, bytes: flat.slice(node.offset, node.offset + node.size) };
  });

  return {
    format: magic,
    version,
    unityVersion: unityRevision || unityVersion,
    compression: ["none", "LZMA", "LZ4", "LZ4HC"][infoMode] ?? `mode ${infoMode}`,
    entries,
  };
}
