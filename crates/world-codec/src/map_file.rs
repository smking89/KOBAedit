//! `.map` / `.prefab` container reading and writing.
//!
//! Header: `u32 version` (9 or 10), `i64 timestamp`, then an LZ4 legacy stream
//! containing protobuf `WorldData`.

use std::path::Path;

use crate::error::{CodecError, Result};
use crate::lz4::{compress_legacy_store, decompress_legacy};
use crate::protobuf::{iter_fields, Value, Writer};
use crate::world::{PathInstance, PrefabInstance, Vector3, WorldDocument};

pub const HEADER_SIZE: usize = 12;
pub const CURRENT_VERSION: u32 = 10;
pub const SUPPORTED_VERSIONS: [u32; 2] = [9, 10];

pub fn parse(bytes: &[u8]) -> Result<WorldDocument> {
    if bytes.len() < HEADER_SIZE {
        return Err(CodecError::Format("file is shorter than its header".into()));
    }
    let version = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    if !SUPPORTED_VERSIONS.contains(&version) {
        return Err(CodecError::UnsupportedVersion(version));
    }
    let timestamp = i64::from_le_bytes(bytes[4..12].try_into().unwrap());

    let payload = match decompress_legacy(&bytes[HEADER_SIZE..]) {
        Ok(payload) if !payload.is_empty() => payload,
        _ => decompress_legacy(&bytes[4..])
            .map_err(|_| CodecError::Format("could not decompress map payload".into()))?,
    };

    let mut document = parse_world_data(&payload)?;
    document.version = version;
    document.timestamp = timestamp;
    Ok(document)
}

pub fn parse_file(path: impl AsRef<Path>) -> Result<WorldDocument> {
    parse(&std::fs::read(path)?)
}

pub fn build(document: &WorldDocument) -> Vec<u8> {
    let payload = build_world_data(document);
    let mut out = Vec::with_capacity(payload.len() + 64);
    out.extend_from_slice(&CURRENT_VERSION.to_le_bytes());
    let timestamp = if document.timestamp != 0 {
        document.timestamp
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0)
    };
    out.extend_from_slice(&timestamp.to_le_bytes());
    out.extend_from_slice(&compress_legacy_store(&payload, 4 * 1024 * 1024));
    out
}

pub fn write_file(path: impl AsRef<Path>, document: &WorldDocument) -> Result<()> {
    let bytes = build(document);
    if let Some(parent) = path.as_ref().parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

fn parse_world_data(payload: &[u8]) -> Result<WorldDocument> {
    let mut document = WorldDocument::default();
    for field in iter_fields(payload)? {
        match (field.number, field.value) {
            (1, Value::Varint(size)) => document.size = size as u32,
            (2, Value::Bytes(buf)) => {
                let (name, data) = parse_map_data(buf)?;
                if !name.is_empty() {
                    document.put_layer(&name, data.to_vec());
                }
            }
            (3, Value::Bytes(buf)) => document.prefabs.push(parse_prefab(buf)?),
            (4, Value::Bytes(buf)) => document.paths.push(parse_path(buf)?),
            _ => {}
        }
    }
    if document.size == 0 {
        return Err(CodecError::Format("WorldData has no terrain size".into()));
    }
    Ok(document)
}

fn parse_map_data(buf: &[u8]) -> Result<(String, &[u8])> {
    let mut name = String::new();
    let mut data: &[u8] = &[];
    for field in iter_fields(buf)? {
        match (field.number, field.value) {
            (1, Value::Bytes(bytes)) => {
                name = String::from_utf8_lossy(bytes).into_owned();
            }
            (2, Value::Bytes(bytes)) => data = bytes,
            _ => {}
        }
    }
    Ok((name, data))
}

fn parse_vector(buf: &[u8]) -> Result<Vector3> {
    let mut vector = Vector3::default();
    for field in iter_fields(buf)? {
        if let Value::Fixed32(value) = field.value {
            match field.number {
                1 => vector.x = value,
                2 => vector.y = value,
                3 => vector.z = value,
                _ => {}
            }
        }
    }
    Ok(vector)
}

fn parse_prefab(buf: &[u8]) -> Result<PrefabInstance> {
    let mut prefab = PrefabInstance {
        scale: Vector3::one(),
        ..Default::default()
    };
    for field in iter_fields(buf)? {
        match (field.number, field.value) {
            (1, Value::Bytes(bytes)) => prefab.category = String::from_utf8_lossy(bytes).into_owned(),
            (2, Value::Varint(id)) => prefab.prefab_id = id as u32,
            (3, Value::Bytes(bytes)) => prefab.position = parse_vector(bytes)?,
            (4, Value::Bytes(bytes)) => prefab.rotation = parse_vector(bytes)?,
            (5, Value::Bytes(bytes)) => prefab.scale = parse_vector(bytes)?,
            _ => {}
        }
    }
    Ok(prefab)
}

fn parse_path(buf: &[u8]) -> Result<PathInstance> {
    let mut path = PathInstance {
        spline: true,
        width: 6.0,
        ..Default::default()
    };
    for field in iter_fields(buf)? {
        match (field.number, field.value) {
            (1, Value::Bytes(bytes)) => path.name = String::from_utf8_lossy(bytes).into_owned(),
            (2, Value::Varint(value)) => path.spline = value != 0,
            (3, Value::Varint(value)) => path.start = value != 0,
            (4, Value::Varint(value)) => path.end = value != 0,
            (5, Value::Fixed32(value)) => path.width = value,
            (6, Value::Fixed32(value)) => path.inner_padding = value,
            (7, Value::Fixed32(value)) => path.outer_padding = value,
            (8, Value::Fixed32(value)) => path.inner_fade = value,
            (9, Value::Fixed32(value)) => path.outer_fade = value,
            (10, Value::Fixed32(value)) => path.random_scale = value,
            (11, Value::Fixed32(value)) => path.mesh_offset = value,
            (12, Value::Fixed32(value)) => path.terrain_offset = value,
            (13, Value::Varint(value)) => path.splat = value as i32,
            (14, Value::Varint(value)) => path.topology = value as i32,
            (15, Value::Bytes(bytes)) => path.nodes.push(parse_vector(bytes)?),
            _ => {}
        }
    }
    Ok(path)
}

fn vector_message(vector: &Vector3) -> Writer {
    let mut writer = Writer::new();
    writer
        .float32(1, vector.x)
        .float32(2, vector.y)
        .float32(3, vector.z);
    writer
}

fn build_world_data(document: &WorldDocument) -> Vec<u8> {
    let mut world = Writer::new();
    world.varint(1, u64::from(document.size.max(1)));

    for layer in &document.layers {
        if layer.data.is_empty() {
            continue;
        }
        let mut message = Writer::new();
        message.string(1, &layer.name).bytes(2, &layer.data);
        world.message(2, &message);
    }

    for prefab in &document.prefabs {
        let mut message = Writer::new();
        message
            .string(1, &prefab.category)
            .varint(2, u64::from(prefab.prefab_id))
            .message(3, &vector_message(&prefab.position))
            .message(4, &vector_message(&prefab.rotation))
            .message(5, &vector_message(&prefab.scale));
        world.message(3, &message);
    }

    for path in &document.paths {
        let mut message = Writer::new();
        message
            .string(1, &path.name)
            .boolean(2, path.spline)
            .boolean(3, path.start)
            .boolean(4, path.end)
            .float32(5, path.width)
            .float32(6, path.inner_padding)
            .float32(7, path.outer_padding)
            .float32(8, path.inner_fade)
            .float32(9, path.outer_fade)
            .float32(10, path.random_scale)
            .float32(11, path.mesh_offset)
            .float32(12, path.terrain_offset)
            .varint(13, path.splat as u64)
            .varint(14, path.topology as u64);
        for node in &path.nodes {
            message.message(15, &vector_message(node));
        }
        world.message(4, &message);
    }

    world.buf
}
