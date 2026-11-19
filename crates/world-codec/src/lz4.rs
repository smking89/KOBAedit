//! LZ4 block decompression and the K4os/lz4net *legacy* stream framing used by
//! Rust map files.
//!
//! Writing uses uncompressed legacy chunks (flag 0), which every Rust/K4os
//! reader accepts. The resulting file is larger than a game-authored map but
//! byte-for-byte valid; block compression can be enabled later without touching
//! the container logic.

use crate::error::{CodecError, Result};

const MIN_MATCH: usize = 4;

pub fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *buf
            .get(*pos)
            .ok_or_else(|| CodecError::Lz4("truncated varint".into()))?;
        *pos += 1;
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift > 63 {
            return Err(CodecError::Lz4("varint overflow".into()));
        }
    }
}

pub fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

pub fn decompress_block(src: &[u8], expected_size: Option<usize>) -> Result<Vec<u8>> {
    if src.is_empty() {
        return Ok(Vec::new());
    }
    let mut dst: Vec<u8> = Vec::with_capacity(expected_size.unwrap_or(src.len() * 4));
    let mut pos = 0usize;

    while pos < src.len() {
        let token = src[pos];
        pos += 1;

        let mut literal_len = usize::from(token >> 4);
        if literal_len == 15 {
            loop {
                let extra = *src
                    .get(pos)
                    .ok_or_else(|| CodecError::Lz4("truncated literal length".into()))?;
                pos += 1;
                literal_len += usize::from(extra);
                if extra != 255 {
                    break;
                }
            }
        }

        let literal_end = pos
            .checked_add(literal_len)
            .ok_or_else(|| CodecError::Lz4("literal length overflow".into()))?;
        if literal_end > src.len() {
            return Err(CodecError::Lz4("literal run past end of block".into()));
        }
        dst.extend_from_slice(&src[pos..literal_end]);
        pos = literal_end;

        if pos >= src.len() {
            break;
        }
        if pos + 2 > src.len() {
            return Err(CodecError::Lz4("truncated match offset".into()));
        }
        let offset = usize::from(src[pos]) | (usize::from(src[pos + 1]) << 8);
        pos += 2;
        if offset == 0 || offset > dst.len() {
            return Err(CodecError::Lz4(format!("invalid match offset {offset}")));
        }

        let mut match_len = usize::from(token & 0x0f);
        if match_len == 15 {
            loop {
                let extra = *src
                    .get(pos)
                    .ok_or_else(|| CodecError::Lz4("truncated match length".into()))?;
                pos += 1;
                match_len += usize::from(extra);
                if extra != 255 {
                    break;
                }
            }
        }
        match_len += MIN_MATCH;

        let start = dst.len() - offset;
        for index in 0..match_len {
            let byte = dst[start + index];
            dst.push(byte);
        }
    }

    if let Some(expected) = expected_size {
        if dst.len() != expected {
            return Err(CodecError::Lz4(format!(
                "decoded {} bytes, expected {expected}",
                dst.len()
            )));
        }
    }
    Ok(dst)
}

pub fn decompress_legacy(data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < data.len() {
        let flags = read_varint(data, &mut pos)?;
        let original = read_varint(data, &mut pos)? as usize;
        let compressed = flags & 1 == 1;
        let payload_len = if compressed {
            read_varint(data, &mut pos)? as usize
        } else {
            original
        };

        let end = pos
            .checked_add(payload_len)
            .ok_or_else(|| CodecError::Lz4("chunk length overflow".into()))?;
        if end > data.len() {
            return Err(CodecError::Lz4("chunk extends past end of stream".into()));
        }
        let payload = &data[pos..end];
        pos = end;

        if compressed {
            out.extend_from_slice(&decompress_block(payload, Some(original))?);
        } else {
            if payload.len() != original {
                return Err(CodecError::Lz4("raw chunk length mismatch".into()));
            }
            out.extend_from_slice(payload);
        }
    }
    Ok(out)
}

/// Encode a legacy stream using stored (uncompressed) chunks.
pub fn compress_legacy_store(data: &[u8], chunk_size: usize) -> Vec<u8> {
    let chunk_size = chunk_size.max(1024);
    let mut out = Vec::with_capacity(data.len() + data.len() / chunk_size * 8 + 8);
    for chunk in data.chunks(chunk_size) {
        write_varint(&mut out, 0);
        write_varint(&mut out, chunk.len() as u64);
        out.extend_from_slice(chunk);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_store_roundtrip() {
        let payload: Vec<u8> = (0..100_000u32).map(|value| (value % 251) as u8).collect();
        let packed = compress_legacy_store(&payload, 8192);
        assert_eq!(decompress_legacy(&packed).unwrap(), payload);
    }

    #[test]
    fn block_decodes_simple_literals() {
        // token: 4 literals, no match
        let block = [0x40u8, b'a', b'b', b'c', b'd'];
        assert_eq!(decompress_block(&block, Some(4)).unwrap(), b"abcd");
    }

    #[test]
    fn rejects_bad_offset() {
        // token: 0 literals, then a zero offset
        let block = [0x00u8, 0x00, 0x00];
        assert!(decompress_block(&block, None).is_err());
    }
}
