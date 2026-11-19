//! WorldSerialization document model shared by the Tauri commands.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{CodecError, Result};

pub const STUDIO_META_LAYER: &str = "RustStudioData";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct Vector3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vector3 {
    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    pub fn one() -> Self {
        Self::new(1.0, 1.0, 1.0)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Layer {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefabInstance {
    pub category: String,
    pub prefab_id: u32,
    pub position: Vector3,
    pub rotation: Vector3,
    pub scale: Vector3,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInstance {
    pub name: String,
    pub spline: bool,
    pub start: bool,
    pub end: bool,
    pub width: f32,
    pub inner_padding: f32,
    pub outer_padding: f32,
    pub inner_fade: f32,
    pub outer_fade: f32,
    pub random_scale: f32,
    pub mesh_offset: f32,
    pub terrain_offset: f32,
    pub splat: i32,
    pub topology: i32,
    pub nodes: Vec<Vector3>,
}

#[derive(Debug, Clone, Default)]
pub struct WorldDocument {
    pub version: u32,
    pub timestamp: i64,
    pub size: u32,
    pub layers: Vec<Layer>,
    pub prefabs: Vec<PrefabInstance>,
    pub paths: Vec<PathInstance>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSummary {
    pub version: u32,
    pub timestamp: i64,
    pub size: u32,
    pub kind: &'static str,
    pub layers: BTreeMap<String, usize>,
    pub prefab_count: usize,
    pub path_count: usize,
    pub height_resolution: Option<usize>,
    pub splat_resolution: Option<usize>,
    pub water_level: f32,
    pub path_names: Vec<String>,
}

impl WorldDocument {
    pub fn is_prefab(&self) -> bool {
        self.layers.is_empty()
    }

    pub fn layer(&self, name: &str) -> Option<&[u8]> {
        self.layers
            .iter()
            .find(|layer| layer.name == name)
            .map(|layer| layer.data.as_slice())
    }

    pub fn put_layer(&mut self, name: &str, data: Vec<u8>) {
        if let Some(layer) = self.layers.iter_mut().find(|layer| layer.name == name) {
            layer.data = data;
        } else {
            self.layers.push(Layer {
                name: name.to_string(),
                data,
            });
        }
    }

    pub fn remove_layer(&mut self, name: &str) {
        self.layers.retain(|layer| layer.name != name);
    }

    pub fn height_resolution(&self) -> Option<usize> {
        let blob = self.layer("terrain").or_else(|| self.layer("height"))?;
        square_root(blob.len() / 2)
    }

    pub fn splat_resolution(&self) -> Option<usize> {
        square_root(self.layer("splat")?.len() / 8)
    }

    pub fn water_level(&self) -> f32 {
        let Some(blob) = self.layer("water") else {
            return 0.0;
        };
        let samples: Vec<u16> = blob
            .chunks_exact(2)
            .take(8192)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .filter(|value| *value > 0)
            .collect();
        if samples.is_empty() {
            return 0.0;
        }
        let average = samples.iter().map(|value| f64::from(*value)).sum::<f64>() / samples.len() as f64;
        (-500.0 + average / 65535.0 * 1000.0) as f32
    }

    pub fn summary(&self) -> WorldSummary {
        WorldSummary {
            version: self.version,
            timestamp: self.timestamp,
            size: self.size,
            kind: if self.is_prefab() { "prefab" } else { "map" },
            layers: self
                .layers
                .iter()
                .map(|layer| (layer.name.clone(), layer.data.len()))
                .collect(),
            prefab_count: self.prefabs.len(),
            path_count: self.paths.len(),
            height_resolution: self.height_resolution(),
            splat_resolution: self.splat_resolution(),
            water_level: self.water_level(),
            path_names: self.paths.iter().take(64).map(|path| path.name.clone()).collect(),
        }
    }

    /// Check that terrain layer byte counts match the declared map size.
    pub fn validate_layout(&self) -> Result<()> {
        let height_res = self.size as usize + 1;
        let mut splat_res = 1usize;
        while splat_res < (self.size as usize).saturating_div(2).max(1) {
            splat_res <<= 1;
        }
        if let Some(terrain) = self.layer("terrain") {
            if terrain.len() != height_res * height_res * 2 {
                return Err(CodecError::Format(format!(
                    "terrain layer is {} bytes, expected {}",
                    terrain.len(),
                    height_res * height_res * 2
                )));
            }
        }
        if let Some(splat) = self.layer("splat") {
            if splat.len() % (splat_res * splat_res * 8) != 0 {
                return Err(CodecError::Format(
                    "splat layer size does not match the map resolution".into(),
                ));
            }
        }
        Ok(())
    }
}

fn square_root(texels: usize) -> Option<usize> {
    if texels == 0 {
        return None;
    }
    let root = (texels as f64).sqrt().round() as usize;
    if root * root == texels {
        Some(root)
    } else {
        None
    }
}
