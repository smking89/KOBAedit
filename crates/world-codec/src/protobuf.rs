//! Minimal protobuf wire-format support for Rust's `WorldData`.

use crate::error::{CodecError, Result};

pub const WIRE_VARINT: u8 = 0;
pub const WIRE_64BIT: u8 = 1;
pub const WIRE_BYTES: u8 = 2;
pub const WIRE_32BIT: u8 = 5;

#[derive(Debug, Clone, Copy)]
pub enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed32(f32),
    Fixed64(&'a [u8]),
}

#[derive(Debug, Clone, Copy)]
pub struct Field<'a> {
    pub number: u32,
    pub value: Value<'a>,
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *buf
            .get(*pos)
            .ok_or_else(|| CodecError::Protobuf("truncated varint".into()))?;
        *pos += 1;
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift > 63 {
            return Err(CodecError::Protobuf("varint overflow".into()));
        }
    }
}

pub fn iter_fields(buf: &[u8]) -> Result<Vec<Field<'_>>> {
    let mut fields = Vec::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos)? as u32;
        let number = tag >> 3;
        let wire = (tag & 0x7) as u8;
        let value = match wire {
            WIRE_VARINT => Value::Varint(read_varint(buf, &mut pos)?),
            WIRE_BYTES => {
                let length = read_varint(buf, &mut pos)? as usize;
                let end = pos
                    .checked_add(length)
                    .ok_or_else(|| CodecError::Protobuf("field length overflow".into()))?;
                if end > buf.len() {
                    return Err(CodecError::Protobuf(
                        "length-delimited field past end".into(),
                    ));
                }
                let slice = &buf[pos..end];
                pos = end;
                Value::Bytes(slice)
            }
            WIRE_32BIT => {
                if pos + 4 > buf.len() {
                    return Err(CodecError::Protobuf("truncated fixed32".into()));
                }
                let value = f32::from_le_bytes(buf[pos..pos + 4].try_into().unwrap());
                pos += 4;
                Value::Fixed32(value)
            }
            WIRE_64BIT => {
                if pos + 8 > buf.len() {
                    return Err(CodecError::Protobuf("truncated fixed64".into()));
                }
                let slice = &buf[pos..pos + 8];
                pos += 8;
                Value::Fixed64(slice)
            }
            other => {
                return Err(CodecError::Protobuf(format!(
                    "unsupported wire type {other}"
                )))
            }
        };
        fields.push(Field { number, value });
    }
    Ok(fields)
}

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn tag(&mut self, field: u32, wire: u8) {
        let value = (u64::from(field) << 3) | u64::from(wire);
        crate::lz4::write_varint(&mut self.buf, value);
    }

    pub fn varint(&mut self, field: u32, value: u64) -> &mut Self {
        self.tag(field, WIRE_VARINT);
        crate::lz4::write_varint(&mut self.buf, value);
        self
    }

    pub fn boolean(&mut self, field: u32, value: bool) -> &mut Self {
        self.varint(field, u64::from(value))
    }

    pub fn float32(&mut self, field: u32, value: f32) -> &mut Self {
        self.tag(field, WIRE_32BIT);
        self.buf.extend_from_slice(&value.to_le_bytes());
        self
    }

    pub fn bytes(&mut self, field: u32, payload: &[u8]) -> &mut Self {
        self.tag(field, WIRE_BYTES);
        crate::lz4::write_varint(&mut self.buf, payload.len() as u64);
        self.buf.extend_from_slice(payload);
        self
    }

    pub fn string(&mut self, field: u32, value: &str) -> &mut Self {
        self.bytes(field, value.as_bytes())
    }

    pub fn message(&mut self, field: u32, child: &Writer) -> &mut Self {
        self.bytes(field, &child.buf)
    }
}
