//! Native Rust reader/writer for Rust's `WorldSerialization` container.
//!
//! This crate is the Tauri shell's fast path for inspecting and writing `.map`
//! and `.prefab` files. It mirrors `engine/rust_studio_engine/world` so both the
//! Rust shell and the Python sidecar can open the same files.

pub mod error;
pub mod lz4;
pub mod map_file;
pub mod protobuf;
pub mod world;

pub use error::{CodecError, Result};
pub use map_file::{build, parse, parse_file, write_file};
pub use world::{
    Layer, PathInstance, PrefabInstance, Vector3, WorldDocument, WorldSummary, STUDIO_META_LAYER,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_document() -> WorldDocument {
        let mut document = WorldDocument {
            version: 10,
            timestamp: 1_760_000_000,
            size: 64,
            ..Default::default()
        };
        document.put_layer("terrain", vec![0x34, 0x12].repeat(65 * 65));
        document.put_layer("splat", vec![0xff].repeat(32 * 32 * 8));
        document.put_layer("topology", vec![0x00].repeat(32 * 32 * 4));
        document.put_layer("alpha", vec![0xff].repeat(32 * 32));
        document.prefabs.push(PrefabInstance {
            category: "Monument".into(),
            prefab_id: 0xdead_beef,
            position: Vector3::new(10.5, 12.25, -40.75),
            rotation: Vector3::new(0.0, 90.0, 0.0),
            scale: Vector3::one(),
        });
        document.paths.push(PathInstance {
            name: "Road 0".into(),
            width: 9.5,
            splat: 4,
            topology: 16,
            nodes: vec![
                Vector3::new(-100.0, 5.0, -100.0),
                Vector3::new(0.0, 6.5, 0.0),
                Vector3::new(100.0, 8.0, 100.0),
            ],
            ..Default::default()
        });
        document
    }

    #[test]
    fn roundtrip_map_container() {
        let original = sample_document();
        let bytes = build(&original);
        let restored = parse(&bytes).expect("parse");

        assert_eq!(restored.size, 64);
        assert_eq!(restored.version, 10);
        assert_eq!(restored.timestamp, original.timestamp);
        assert_eq!(restored.layer("terrain").unwrap().len(), 65 * 65 * 2);
        assert_eq!(restored.prefabs.len(), 1);
        assert_eq!(restored.prefabs[0].prefab_id, 0xdead_beef);
        assert_eq!(restored.prefabs[0].position.z, -40.75);
        assert_eq!(restored.paths.len(), 1);
        assert_eq!(restored.paths[0].nodes.len(), 3);
        assert_eq!(restored.paths[0].name, "Road 0");
    }

    #[test]
    fn summary_reports_resolutions() {
        let document = sample_document();
        let summary = document.summary();
        assert_eq!(summary.height_resolution, Some(65));
        assert_eq!(summary.splat_resolution, Some(32));
        assert_eq!(summary.prefab_count, 1);
        assert_eq!(summary.kind, "map");
    }

    #[test]
    fn rejects_unknown_version() {
        let mut bytes = vec![0u8; 32];
        bytes[0..4].copy_from_slice(&11u32.to_le_bytes());
        assert!(matches!(
            parse(&bytes),
            Err(CodecError::UnsupportedVersion(11))
        ));
    }

    #[test]
    fn validates_layout_sizes() {
        let mut document = sample_document();
        assert!(document.validate_layout().is_ok());
        document.put_layer("terrain", vec![0u8; 16]);
        assert!(document.validate_layout().is_err());
    }
}
