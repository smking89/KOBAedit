/**
 * LZMA1 decoder for UnityFS blocks.
 *
 * Unity's LZMA blocks carry the 5-byte LZMA properties, often followed by the
 * 8-byte uncompressed size (the "alone" framing). The block table already
 * provides the output size, so both framings are accepted here.
 */

const PROB_INIT = 1024;

class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  private offset = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array, offset = 0) {
    this.data = data;
    this.offset = offset;
    if (data.length < offset + 5 || data[offset] !== 0) {
      throw new Error("LZMA stream has no valid range coder header");
    }
    for (let index = 0; index < 4; index += 1) {
      this.code = ((this.code << 8) | data[offset + 1 + index]!) >>> 0;
    }
    this.offset = offset + 5;
  }

  bit(probs: Uint16Array, index: number): number {
    const prob = probs[index]!;
    const bound = (this.range >>> 11) * prob;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = prob + ((2048 - prob) >> 5);
      bit = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[index] = prob - (prob >> 5);
      bit = 1;
    }
    if (this.range < 0x01000000) {
      this.range = (this.range * 256) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
    return bit;
  }

  directBits(count: number): number {
    let result = 0;
    for (let index = 0; index < count; index += 1) {
      this.range >>>= 1;
      const bit = this.code >= this.range ? 1 : 0;
      if (bit) this.code = (this.code - this.range) >>> 0;
      result = (result << 1) | bit;
      if (this.range < 0x01000000) {
        this.range = (this.range * 256) >>> 0;
        this.code = ((this.code << 8) | this.byte()) >>> 0;
      }
    }
    return result >>> 0;
  }

  private byte(): number {
    return this.offset < this.data.length ? this.data[this.offset++]! : 0;
  }
}

function initProbs(size: number): Uint16Array {
  const probs = new Uint16Array(size);
  probs.fill(PROB_INIT);
  return probs;
}

function bitTree(decoder: RangeDecoder, probs: Uint16Array, offset: number, bits: number): number {
  let value = 1;
  for (let index = 0; index < bits; index += 1) {
    value = (value << 1) | decoder.bit(probs, offset + value);
  }
  return value - (1 << bits);
}

function reverseBitTree(
  decoder: RangeDecoder,
  probs: Uint16Array,
  offset: number,
  bits: number,
): number {
  let value = 1;
  let result = 0;
  for (let index = 0; index < bits; index += 1) {
    const bit = decoder.bit(probs, offset + value);
    value = (value << 1) | bit;
    result |= bit << index;
  }
  return result;
}

const STATE_CHAR = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 4, 5];
const STATE_MATCH = [7, 7, 7, 7, 7, 7, 7, 10, 10, 10, 10, 10];
const STATE_REP = [8, 8, 8, 8, 8, 8, 8, 11, 11, 11, 11, 11];
const STATE_SHORT_REP = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 11];

class LengthDecoder {
  choice = initProbs(2);
  low = initProbs(16 * 8);
  mid = initProbs(16 * 8);
  high = initProbs(256);

  decode(decoder: RangeDecoder, posState: number): number {
    if (decoder.bit(this.choice, 0) === 0) {
      return bitTree(decoder, this.low, posState * 8, 3);
    }
    if (decoder.bit(this.choice, 1) === 0) {
      return 8 + bitTree(decoder, this.mid, posState * 8, 3);
    }
    return 16 + bitTree(decoder, this.high, 0, 8);
  }
}

/** Parses LZMA properties and returns the stream offset plus decoder settings. */
function readProperties(source: Uint8Array, outputSize: number): {
  offset: number;
  lc: number;
  lp: number;
  pb: number;
  outputSize: number;
} {
  if (source.length < 5) throw new Error("LZMA block is truncated");
  const props = source[0]!;
  if (props > 224) throw new Error("LZMA block has invalid properties");
  if (outputSize <= 0) throw new Error("LZMA block has no output size");
  // 13-byte "alone" header: 5 properties bytes, 8-byte little-endian size.
  if (source.length >= 13) {
    let declared = 0;
    for (let index = 0; index < 8; index += 1) {
      declared += source[5 + index]! * 2 ** (8 * index);
    }
    if (declared === outputSize || declared === 2 ** 64 - 1) {
      return {
        offset: 13,
        lc: props % 9,
        lp: Math.floor(props / 9) % 5,
        pb: Math.floor(props / 45),
        outputSize,
      };
    }
  }
  return {
    offset: 5,
    lc: props % 9,
    lp: Math.floor(props / 9) % 5,
    pb: Math.floor(props / 45),
    outputSize,
  };
}

export function lzmaDecompress(source: Uint8Array, outputSize: number): Uint8Array {
  const { offset, lc, lp, pb, outputSize: size } = readProperties(source, outputSize);
  if (lc + lp > 4) throw new Error("LZMA properties are out of range");

  const decoder = new RangeDecoder(source, offset);
  const output = new Uint8Array(size);
  let outPos = 0;
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;

  const literalProbs = initProbs(0x300 << (lc + lp));
  const isMatch = initProbs(12 * 16);
  const isRep = initProbs(12);
  const isRepG0 = initProbs(12);
  const isRepG1 = initProbs(12);
  const isRepG2 = initProbs(12);
  const isRep0Long = initProbs(12 * 16);
  const posSlot = initProbs(4 * 64);
  const posDecoders = initProbs(114);
  const align = initProbs(16);
  const matchLen = new LengthDecoder();
  const repLen = new LengthDecoder();

  const copyMatch = (distance: number, length: number): void => {
    if (distance >= outPos) throw new Error("LZMA block refers before the output start");
    if (outPos + length > output.length) throw new Error("LZMA block overruns its output");
    for (let index = 0; index < length; index += 1) {
      output[outPos] = output[outPos - distance - 1]!;
      outPos += 1;
    }
  };

  while (outPos < output.length) {
    const posState = outPos & ((1 << pb) - 1);
    if (decoder.bit(isMatch, state * 16 + posState) === 0) {
      const prev = outPos > 0 ? output[outPos - 1]! : 0;
      const literalState = ((outPos & ((1 << lp) - 1)) << lc) + (prev >> (8 - lc));
      let symbol = 1;
      if (state < 7) {
        while (symbol < 0x100) {
          symbol = (symbol << 1) | decoder.bit(literalProbs, 0x300 * literalState + symbol);
        }
      } else {
        if (rep0 >= outPos) throw new Error("LZMA literal match distance is invalid");
        let matchByte = output[outPos - rep0 - 1]!;
        while (symbol < 0x100) {
          const matchBit = (matchByte >> 7) & 1;
          matchByte = (matchByte << 1) & 0xff;
          const bit = decoder.bit(
            literalProbs,
            0x300 * literalState + ((1 + matchBit) << 8) + symbol,
          );
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) {
            while (symbol < 0x100) {
              symbol = (symbol << 1) | decoder.bit(literalProbs, 0x300 * literalState + symbol);
            }
            break;
          }
        }
      }
      output[outPos++] = symbol & 0xff;
      state = STATE_CHAR[state]!;
      continue;
    }

    let length: number;
    if (decoder.bit(isRep, state) === 0) {
      length = matchLen.decode(decoder, posState) + 2;
      state = STATE_MATCH[state]!;
      const lenState = Math.min(length - 2, 3);
      const slot = bitTree(decoder, posSlot, lenState * 64, 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const directBits = (slot >> 1) - 1;
        rep0 = ((2 | (slot & 1)) << directBits) >>> 0;
        if (slot < 14) {
          rep0 += reverseBitTree(decoder, posDecoders, rep0 - slot, directBits);
        } else {
          rep0 += (decoder.directBits(directBits - 4) << 4) >>> 0;
          rep0 += reverseBitTree(decoder, align, 0, 4);
        }
      }
      if (rep0 === 0xffffffff) break;
      copyMatch(rep0, length);
      continue;
    }

    if (decoder.bit(isRepG0, state) === 0) {
      if (decoder.bit(isRep0Long, state * 16 + posState) === 0) {
        state = STATE_SHORT_REP[state]!;
        if (rep0 >= outPos) throw new Error("LZMA repeat distance is invalid");
        output[outPos] = output[outPos - rep0 - 1]!;
        outPos += 1;
        continue;
      }
    } else {
      let distance: number;
      if (decoder.bit(isRepG1, state) === 0) {
        distance = rep1;
      } else {
        if (decoder.bit(isRepG2, state) === 0) {
          distance = rep2;
        } else {
          distance = rep3;
          rep3 = rep2;
        }
        rep2 = rep1;
      }
      rep1 = rep0;
      rep0 = distance;
    }
    length = repLen.decode(decoder, posState) + 2;
    state = STATE_REP[state]!;
    copyMatch(rep0, length);
  }

  if (outPos !== output.length) throw new Error("LZMA block output size mismatch");
  return output;
}
