"""Minimal protobuf wire-format reader/writer.

Rust stores ``WorldData`` as protobuf. We only need the wire format, not the
generated schema classes, so this module provides a cursor-based reader and a
small message writer with no third-party dependency. Unknown fields are skipped
by the reader and can be captured when forward-compatibility matters.
"""

from __future__ import annotations

import struct
from typing import Iterator

WIRE_VARINT = 0
WIRE_64BIT = 1
WIRE_BYTES = 2
WIRE_32BIT = 5

VARINT = WIRE_VARINT
LENGTH_DELIMITED = WIRE_BYTES
FIXED32 = WIRE_32BIT
FIXED64 = WIRE_64BIT


class ProtobufError(ValueError):
    """Raised on malformed protobuf data."""


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ProtobufError("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise ProtobufError("varint overflow")


def encode_varint(value: int) -> bytes:
    if value < 0:
        value += 1 << 64
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def iter_fields(buf: bytes) -> Iterator[tuple[int, int, int | bytes | float]]:
    """Yield ``(field_number, wire_type, value)`` for each field in ``buf``.

    Varints become int, length-delimited fields become bytes, fixed32 becomes
    float and fixed64 is returned as raw bytes.
    """
    pos = 0
    total = len(buf)
    while pos < total:
        tag, pos = read_varint(buf, pos)
        field = tag >> 3
        wire = tag & 0x07

        if wire == WIRE_VARINT:
            value, pos = read_varint(buf, pos)
            yield field, wire, value
        elif wire == WIRE_BYTES:
            length, pos = read_varint(buf, pos)
            end = pos + length
            if end > total:
                raise ProtobufError("length-delimited field past end of buffer")
            yield field, wire, buf[pos:end]
            pos = end
        elif wire == WIRE_32BIT:
            if pos + 4 > total:
                raise ProtobufError("truncated fixed32")
            yield field, wire, struct.unpack_from("<f", buf, pos)[0]
            pos += 4
        elif wire == WIRE_64BIT:
            if pos + 8 > total:
                raise ProtobufError("truncated fixed64")
            yield field, wire, buf[pos : pos + 8]
            pos += 8
        else:
            raise ProtobufError(f"unsupported wire type {wire}")


class MessageWriter:
    """Accumulates protobuf fields."""

    __slots__ = ("buf",)

    def __init__(self) -> None:
        self.buf = bytearray()

    def __len__(self) -> int:
        return len(self.buf)

    def _tag(self, field: int, wire: int) -> None:
        self.buf += encode_varint((field << 3) | wire)

    def varint(self, field: int, value: int) -> "MessageWriter":
        if value is not None:
            self._tag(field, WIRE_VARINT)
            self.buf += encode_varint(int(value))
        return self

    def boolean(self, field: int, value: bool) -> "MessageWriter":
        return self.varint(field, 1 if value else 0)

    def integer(self, field: int, value: int) -> "MessageWriter":
        return self.varint(field, value)

    def float32(self, field: int, value: float) -> "MessageWriter":
        self._tag(field, WIRE_32BIT)
        self.buf += struct.pack("<f", float(value))
        return self

    def bytes_field(self, field: int, payload: bytes) -> "MessageWriter":
        self._tag(field, WIRE_BYTES)
        self.buf += encode_varint(len(payload))
        self.buf += payload
        return self

    def string(self, field: int, value: str) -> "MessageWriter":
        return self.bytes_field(field, value.encode("utf-8"))

    def message(self, field: int, writer: "MessageWriter") -> "MessageWriter":
        return self.bytes_field(field, bytes(writer.buf))

    def raw(self, payload: bytes) -> "MessageWriter":
        self.buf += payload
        return self

    def finish(self) -> bytes:
        return bytes(self.buf)


__all__ = [
    "FIXED32",
    "FIXED64",
    "LENGTH_DELIMITED",
    "MessageWriter",
    "ProtobufError",
    "VARINT",
    "encode_varint",
    "iter_fields",
    "read_varint",
]
