"""LZ4 codec for Rust's WorldSerialization container.

Two layers are needed:

``decompress_block`` / ``compress_block``
    The raw LZ4 block format (sequences of literals and back-references).

``decompress_stream`` / ``compress_stream``
    The *legacy* LZ4 stream framing produced by ``K4os.Compression.LZ4.Legacy``
    (originally lz4net) and consumed by Rust, RustEdit and every map tool. Each
    chunk is framed as::

        varint flags          # bit 0: payload is LZ4-compressed
        varint original_size
        varint compressed_size  # only when flags & 1
        <payload>

    There is no stream magic and no end marker: decoding stops at EOF.

The block codec is implemented in pure Python so the engine has no hard native
dependency; if the ``lz4`` package is installed it is used for speed.
"""

from __future__ import annotations

import struct

try:  # optional speedup only
    import lz4.block as _lz4_block
except Exception:  # pragma: no cover - exercised only without the wheel
    _lz4_block = None


class Lz4Error(ValueError):
    """Raised when an LZ4 block or stream is malformed."""


MIN_MATCH = 4
LAST_LITERALS = 5
MF_LIMIT = 12
MAX_OFFSET = 0xFFFF


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise Lz4Error("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise Lz4Error("varint overflow")


def _write_varint(value: int) -> bytes:
    if value < 0:
        raise Lz4Error("negative varint")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def decompress_block(src: bytes, uncompressed_size: int | None = None) -> bytes:
    """Decode one LZ4 block."""
    if uncompressed_size == 0:
        return b""
    if _lz4_block is not None and uncompressed_size is not None:
        try:
            return _lz4_block.decompress(src, uncompressed_size=uncompressed_size)
        except Exception as exc:  # fall back to the portable decoder
            raise Lz4Error(f"lz4 block decode failed: {exc}") from exc

    dst = bytearray()
    pos = 0
    size = len(src)
    if size == 0:
        return b""

    while pos < size:
        token = src[pos]
        pos += 1

        literal_len = token >> 4
        if literal_len == 15:
            while True:
                if pos >= size:
                    raise Lz4Error("truncated literal length")
                extra = src[pos]
                pos += 1
                literal_len += extra
                if extra != 255:
                    break
        end = pos + literal_len
        if end > size:
            raise Lz4Error("literal run past end of block")
        dst += src[pos:end]
        pos = end

        if pos >= size:
            break  # final sequence carries literals only

        if pos + 2 > size:
            raise Lz4Error("truncated match offset")
        offset = src[pos] | (src[pos + 1] << 8)
        pos += 2
        if offset == 0 or offset > len(dst):
            raise Lz4Error(f"invalid match offset {offset}")

        match_len = token & 0x0F
        if match_len == 15:
            while True:
                if pos >= size:
                    raise Lz4Error("truncated match length")
                extra = src[pos]
                pos += 1
                match_len += extra
                if extra != 255:
                    break
        match_len += MIN_MATCH

        start = len(dst) - offset
        # Byte-by-byte copy is required: LZ4 matches may overlap.
        for index in range(match_len):
            dst.append(dst[start + index])

    if uncompressed_size is not None and len(dst) != uncompressed_size:
        raise Lz4Error(
            f"block decoded to {len(dst)} bytes, expected {uncompressed_size}"
        )
    return bytes(dst)


def compress_block(src: bytes) -> bytes:
    """Encode one LZ4 block (greedy hash-chain matcher)."""
    length = len(src)
    if length == 0:
        return b""
    if _lz4_block is not None:
        return _lz4_block.compress(src, store_size=False)

    out = bytearray()
    table: dict[int, int] = {}
    anchor = 0
    index = 0
    limit = length - MF_LIMIT

    while index < limit:
        key = int.from_bytes(src[index : index + 4], "little")
        candidate = table.get(key, -1)
        table[key] = index

        if candidate >= 0 and candidate < index and index - candidate <= MAX_OFFSET:
            max_match = length - LAST_LITERALS - index
            matched = MIN_MATCH
            while matched < max_match and src[candidate + matched] == src[index + matched]:
                matched += 1

            literal_len = index - anchor
            token_pos = len(out)
            out.append(0)
            token = (15 if literal_len >= 15 else literal_len) << 4
            if literal_len >= 15:
                remaining = literal_len - 15
                while remaining >= 255:
                    out.append(255)
                    remaining -= 255
                out.append(remaining)
            out += src[anchor:index]

            offset = index - candidate
            out += bytes((offset & 0xFF, offset >> 8))

            match_code = matched - MIN_MATCH
            if match_code >= 15:
                token |= 15
                remaining = match_code - 15
                ext = bytearray()
                while remaining >= 255:
                    ext.append(255)
                    remaining -= 255
                ext.append(remaining)
            else:
                token |= match_code
                ext = bytearray()
            out[token_pos] = token
            out += ext

            index += matched
            anchor = index
            if index < limit:
                table[int.from_bytes(src[index : index + 4], "little")] = index
            continue

        index += 1

    literal_len = length - anchor
    out.append(min(literal_len, 15) << 4)
    if literal_len >= 15:
        remaining = literal_len - 15
        while remaining >= 255:
            out.append(255)
            remaining -= 255
        out.append(remaining)
    out += src[anchor:]
    return bytes(out)


def decompress_stream(data: bytes) -> bytes:
    """Decode a K4os/lz4net legacy chunked stream."""
    out = bytearray()
    pos = 0
    while pos < len(data):
        flags, pos = _read_varint(data, pos)
        original_len, pos = _read_varint(data, pos)
        compressed = bool(flags & 1)
        if compressed:
            compressed_len, pos = _read_varint(data, pos)
        else:
            compressed_len = original_len

        end = pos + compressed_len
        if end > len(data):
            raise Lz4Error("chunk extends past end of stream")
        payload = data[pos:end]
        pos = end

        if compressed:
            out += decompress_block(payload, original_len)
        else:
            if len(payload) != original_len:
                raise Lz4Error("raw chunk length mismatch")
            out += payload
    return bytes(out)


# Without the native wheel the pure-Python matcher runs at a few MB/s. A
# 16000 m map is ~2.6 GiB of layers, so attempting compression would look like
# a hang; legacy streams allow stored chunks, so large payloads skip it.
STORED_STREAM_THRESHOLD = 64 * 1024 * 1024


def compress_stream(data: bytes, chunk_size: int = 4 * 1024 * 1024) -> bytes:
    """Encode a K4os/lz4net legacy chunked stream (used when writing maps)."""
    if chunk_size <= 0:
        raise Lz4Error("chunk_size must be positive")
    out = bytearray()
    attempt_compression = (
        _lz4_block is not None or len(data) <= STORED_STREAM_THRESHOLD
    )
    for start in range(0, len(data), chunk_size):
        chunk = data[start : start + chunk_size]
        if attempt_compression:
            packed = compress_block(chunk)
            if len(packed) < len(chunk):
                out += _write_varint(1)
                out += _write_varint(len(chunk))
                out += _write_varint(len(packed))
                out += packed
                continue
        out += _write_varint(0)
        out += _write_varint(len(chunk))
        out += chunk
    return bytes(out)


def is_lz4_block_available() -> bool:
    """True when the native ``lz4`` wheel is installed."""
    return _lz4_block is not None


def block_header(data: bytes, pos: int = 0) -> tuple[int, int]:
    """Decode the first two varints of a legacy chunk (flags, original size)."""
    flags, pos = _read_varint(data, pos)
    size, pos = _read_varint(data, pos)
    return flags, size


__all__ = [
    "Lz4Error",
    "block_header",
    "compress_block",
    "compress_stream",
    "decompress_block",
    "decompress_stream",
    "is_lz4_block_available",
]
