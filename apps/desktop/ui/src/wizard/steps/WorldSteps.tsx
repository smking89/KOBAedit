import { useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  EmptyState,
  Field,
  NumberInput,
  Panel,
  SectionLabel,
  SegmentedControl,
  Slider,
  Stat,
  StudioSection,
  TextInput,
  Toggle,
} from "../../components/ui";
import {
  exportProject,
  browsePrefabs,
  queueProjectDelta,
  syncPull,
  syncPush,
  syncResolve,
  type SyncPullResult,
  type SyncPushResult,
} from "../../lib/ipc";
import { CAVE_PRESETS, cavePreset } from "../../lib/cave";
import { LAYER_KINDS, activeLayer } from "../../lib/layers";
import { buildTerrainPreview } from "../../lib/preview";
import { samplePreviewHeight } from "../../lib/procedural";
import { scatterSpacing, scatterSpots } from "../../lib/scatter";
import { PREFAB_MIME, endPrefabDrag, startPrefabDrag } from "../../lib/prefabDrag";
import { nextProjectDelta } from "../../lib/diffSync";
import { readHeightmapFile, readMaskFile } from "../../lib/terrainImport";
import { previewPlaceholder } from "../../assets/previewPlaceholder";
import { useWizard } from "../context";
import { MONUMENT_FLOORS, matchesStarter } from "../mapPresets";
import { STEP_META, createPlacement, validateDraft } from "../machine";
import type {
  BrushMode,
  BrushSync,
  CavePresetId,
  IOLink,
  IONode,
  PrefabAsset,
  SplatChannel,
  SplineKind,
  TerrainMaskImport,
  TerrainPreset,
  TopologyFlag,
} from "../types";

const PRESETS: { id: TerrainPreset; label: string; body: string }[] = [
  { id: "islands", label: "Islands", body: "Coastal ring, central landmass" },
  { id: "mountains", label: "Mountains", body: "High ridges, narrow valleys" },
  { id: "valley", label: "Valley", body: "Open basin with a river line" },
  { id: "flat", label: "Flat", body: "Build-heavy, minimal relief" },
  { id: "archipelago", label: "Archipelago", body: "Scattered islands, shallow sea" },
];

const BRUSHES: BrushMode[] = ["raise", "lower", "smooth", "flatten", "splat", "topology", "alpha"];
const SPLAT_CHANNELS: SplatChannel[] = ["dirt", "snow", "sand", "rock", "grass", "forest", "stones", "gravel"];
const TOPOLOGY_FLAGS: TopologyFlag[] = [
  "no_build",
  "monument_pad",
  "foliage_cleared",
  "path_clear",
  "loot_zone",
  "npc_zone",
  "safe_zone",
];
const BIOME_CHANNELS = ["arid", "temperate", "tundra", "arctic"] as const;
const SYNC_LAYERS: { id: keyof BrushSync; label: string }[] = [
  { id: "height", label: "Height" },
  { id: "splat", label: "Splat" },
  { id: "biome", label: "Biome" },
  { id: "topology", label: "Topology" },
  { id: "alpha", label: "Alpha holes" },
];

export function TerrainStep() {
  const { state, dispatch } = useWizard();
  const terrain = state.draft.terrain;
  const studio = state.draft.studioMode;
  const activeTerrainLayer = activeLayer(terrain);
  const [maskKind, setMaskKind] = useState<TerrainMaskImport["kind"]>("splat");
  const [maskChannel, setMaskChannel] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const patchBrush = (patch: Partial<typeof terrain.brush>) =>
    dispatch({ type: "patchTerrain", patch: { brush: { ...terrain.brush, ...patch } } });

  const applyPreset = (preset: "cliff" | "road" | "forest" | "pad") => {
    if (preset === "cliff") {
      patchBrush({
        mode: "raise",
        splatChannel: "rock",
        biomeChannel: "tundra",
        topologyFlags: ["no_build"],
        topologyClearFlags: ["foliage_cleared"],
        sync: { height: true, splat: true, biome: true, topology: true, alpha: false },
      });
    } else if (preset === "road") {
      patchBrush({
        mode: "flatten",
        splatChannel: "gravel",
        biomeChannel: "temperate",
        topologyFlags: ["path_clear"],
        topologyClearFlags: ["foliage_cleared"],
        sync: { height: true, splat: true, biome: false, topology: true, alpha: false },
      });
    } else if (preset === "forest") {
      patchBrush({
        mode: "splat",
        splatChannel: "forest",
        biomeChannel: "temperate",
        topologyFlags: ["foliage_cleared"],
        topologyClearFlags: [],
        sync: { height: false, splat: true, biome: true, topology: true, alpha: false },
      });
    } else {
      patchBrush({
        mode: "flatten",
        splatChannel: "gravel",
        biomeChannel: "temperate",
        topologyFlags: ["no_build", "monument_pad"],
        topologyClearFlags: ["foliage_cleared"],
        sync: { height: true, splat: true, biome: true, topology: true, alpha: false },
      });
    }
  };

  const importHeightmap = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const heightmap = await readHeightmapFile(file);
      // Native grids define a native world size; keep the preview, validation
      // and exporter on the same grid instead of carrying a stale 4500 m size.
      dispatch({
        type: "patchTerrain",
        patch: {
          heightmap,
          sizeMetres: heightmap.resolution >= 1025 ? heightmap.resolution - 1 : terrain.sizeMetres,
        },
      });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const importMask = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const mask = await readMaskFile(file, maskKind, maskChannel);
      dispatch({ type: "patchTerrain", patch: { masks: [...(terrain.masks ?? []), mask] } });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const setWeight = (index: number, value: number) => {
    const next = [...terrain.biomeWeights] as [number, number, number, number];
    next[index] = value;
    dispatch({ type: "patchTerrain", patch: { biomeWeights: next } });
  };

  return (
    <div className="stack">
      <Panel title="Generator preset" subtitle="Seed plus preset defines the exported layers.">
        <div className="preset-grid">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`preset-card${terrain.preset === preset.id ? " is-active" : ""}`}
              onClick={() => dispatch({ type: "patchTerrain", patch: { preset: preset.id } })}
            >
              <span>{preset.label}</span>
              <em>{preset.body}</em>
            </button>
          ))}
        </div>

        <div className="inline-row">
          <Field label="Seed" hint="Reproducible at export">
            <NumberInput
              value={terrain.seed}
              onChange={(seed) => dispatch({ type: "patchTerrain", patch: { seed: Math.round(seed) } })}
            />
          </Field>
          <Button
            variant="ghost"
            onClick={() =>
              dispatch({ type: "patchTerrain", patch: { seed: Math.floor(Math.random() * 2_000_000_000) } })
            }
          >
            Randomize seed
          </Button>
        </div>
      </Panel>

      <Panel title="Terrain shape">
        <Slider
          label="Map size"
          value={terrain.sizeMetres}
          min={1000}
          max={6000}
          step={250}
          onChange={(sizeMetres) => dispatch({ type: "patchTerrain", patch: { sizeMetres } })}
          format={(value) => `${value} m`}
          hint="Rust maps are typically 3000-4500 m. Heightmap resolution follows size + 1."
        />
        <Slider
          label="Mountain scale"
          value={terrain.mountainScale}
          min={0.1}
          max={2.5}
          step={0.05}
          onChange={(mountainScale) => dispatch({ type: "patchTerrain", patch: { mountainScale } })}
          format={(value) => `${value.toFixed(2)}x`}
        />
        <Slider
          label="Water level"
          value={terrain.waterLevel}
          min={-100}
          max={120}
          step={1}
          onChange={(waterLevel) => dispatch({ type: "patchTerrain", patch: { waterLevel } })}
          format={(value) => `${value} m`}
        />
        <Slider
          label="Detail noise"
          value={terrain.detail}
          min={0}
          max={1}
          step={0.01}
          onChange={(detail) => dispatch({ type: "patchTerrain", patch: { detail } })}
          format={(value) => value.toFixed(2)}
        />
        <Slider
          label="Tree density"
          value={terrain.treeDensity}
          min={0}
          max={1}
          step={0.01}
          onChange={(treeDensity) => dispatch({ type: "patchTerrain", patch: { treeDensity } })}
          format={(value) => `${Math.round(value * 100)}%`}
        />
      </Panel>

      <Panel title="Biome weights" subtitle="Automated splat painting uses these proportions.">
        {(["Arid", "Temperate", "Tundra", "Arctic"] as const).map((label, index) => (
          <Slider
            key={label}
            label={label}
            value={terrain.biomeWeights[index]}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => setWeight(index, value)}
            format={(value) => `${Math.round(value * 100)}%`}
          />
        ))}
        <p className="hint-block">Weights are normalized during export; splat channels are written sum-to-255.</p>
      </Panel>

      {studio && (
        <StudioSection title="Sculpt and paint">
          <div className="layer-panel">
            <SectionLabel>Layers</SectionLabel>
            <p className="hint-block">
              Every stroke lands in the active layer. Hidden layers stay in the project but skip replay, and opacity
              scales the stamp on replay and on the live brush.
            </p>
            {terrain.layers.length === 0 ? (
              <p className="hint-block">No layers yet — the next stroke creates one for its channel.</p>
            ) : (
              <div className="check-list">
                {terrain.layers.map((layer, index) => {
                  const isActive = layer.id === activeTerrainLayer?.id;
                  return (
                    <div key={layer.id} className={`layer-row${isActive ? " is-active" : ""}`}>
                      <input
                        type="checkbox"
                        checked={layer.visible}
                        aria-label={`${layer.name} visible`}
                        onChange={(event) =>
                          dispatch({
                            type: "updateLayer",
                            id: layer.id,
                            patch: { visible: event.target.checked },
                          })
                        }
                      />
                      <button
                        type="button"
                        className="layer-name"
                        onClick={() => dispatch({ type: "setActiveLayer", id: layer.id })}
                      >
                        <span>{layer.name}</span>
                        <span className="layer-kind">
                          {layer.kind} · {layer.strokes.length}
                        </span>
                      </button>
                      <span className="layer-order">
                        <button
                          type="button"
                          className="chip"
                          disabled={index === 0}
                          aria-label={`Move ${layer.name} down in replay order`}
                          onClick={() => dispatch({ type: "moveLayer", id: layer.id, direction: -1 })}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="chip"
                          disabled={index === terrain.layers.length - 1}
                          aria-label={`Move ${layer.name} up in replay order`}
                          onClick={() => dispatch({ type: "moveLayer", id: layer.id, direction: 1 })}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="chip"
                          aria-label={`Delete ${layer.name}`}
                          onClick={() => dispatch({ type: "removeLayer", id: layer.id })}
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {activeTerrainLayer && (
              <Slider
                label={`${activeTerrainLayer.name} opacity`}
                value={activeTerrainLayer.opacity}
                min={0}
                max={1}
                step={0.05}
                onChange={(opacity) =>
                  dispatch({
                    type: "updateLayer",
                    id: activeTerrainLayer.id,
                    patch: { opacity },
                  })
                }
                format={(value) => `${Math.round(value * 100)}%`}
              />
            )}
            <div className="chip-row">
              {LAYER_KINDS.map((kind) => (
                <button
                  key={kind.id}
                  type="button"
                  className="chip chip-add"
                  onClick={() => dispatch({ type: "addLayer", kind: kind.id })}
                >
                  + {kind.label}
                </button>
              ))}
            </div>
          </div>
          <div className="chip-row">
            {BRUSHES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`chip${terrain.brush.mode === mode ? " is-active" : ""}`}
                onClick={() =>
                  dispatch({ type: "patchTerrain", patch: { brush: { ...terrain.brush, mode } } })
                }
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="chip-row">
            {([
              ["cliff", "Cliff"],
              ["road", "Road cut"],
              ["forest", "Forest clearing"],
              ["pad", "Monument pad"],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" className="chip chip-add" onClick={() => applyPreset(id)}>
                {label}
              </button>
            ))}
          </div>
          <p className="hint-block">
            Drag on the terrain to apply the active brush. Strokes: {terrain.sculptStrokes}. Synced layers stamp
            height, splat, biome, topology and alpha in one pass; every stroke is replayed by the exporter.
          </p>
          <div className="check-list">
            {SYNC_LAYERS.map((layer) => (
              <label key={layer.id} className="check-row">
                <input
                  type="checkbox"
                  checked={terrain.brush.sync[layer.id]}
                  onChange={(event) =>
                    patchBrush({ sync: { ...terrain.brush.sync, [layer.id]: event.target.checked } })
                  }
                />
                <span>Sync {layer.label}</span>
              </label>
            ))}
          </div>
          <Slider
            label="Brush radius"
            value={terrain.brush.radius}
            min={4}
            max={400}
            step={1}
            onChange={(radius) =>
              dispatch({ type: "patchTerrain", patch: { brush: { ...terrain.brush, radius } } })
            }
            format={(value) => `${value} m`}
          />
          <Slider
            label="Strength"
            value={terrain.brush.strength}
            min={0.1}
            max={20}
            step={0.1}
            onChange={(strength) =>
              dispatch({ type: "patchTerrain", patch: { brush: { ...terrain.brush, strength } } })
            }
            format={(value) => value.toFixed(1)}
          />
          <Slider
            label="Falloff"
            value={terrain.brush.falloff}
            min={0.5}
            max={4}
            step={0.1}
            onChange={(falloff) =>
              dispatch({ type: "patchTerrain", patch: { brush: { ...terrain.brush, falloff } } })
            }
            format={(value) => value.toFixed(1)}
          />

          {(terrain.brush.mode === "splat" || terrain.brush.sync.splat) && (
            <Field label="Splat channel">
              <select
                className="select-input"
                value={terrain.brush.splatChannel}
                onChange={(event) =>
                  dispatch({
                    type: "patchTerrain",
                    patch: { brush: { ...terrain.brush, splatChannel: event.target.value as SplatChannel } },
                  })
                }
              >
                {SPLAT_CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {terrain.brush.sync.biome && (
            <Field label="Biome channel">
              <select
                className="select-input"
                value={terrain.brush.biomeChannel}
                onChange={(event) => patchBrush({ biomeChannel: event.target.value as typeof terrain.brush.biomeChannel })}
              >
                {BIOME_CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {(terrain.brush.mode === "topology" || terrain.brush.sync.topology) && (
            <>
              <SectionLabel>Topology set</SectionLabel>
              <div className="check-list">
                {TOPOLOGY_FLAGS.map((flag) => (
                  <label key={flag} className="check-row">
                    <input
                      type="checkbox"
                      checked={terrain.brush.topologyFlags.includes(flag)}
                      onChange={(event) =>
                        patchBrush({
                          topologyFlags: event.target.checked
                            ? [...terrain.brush.topologyFlags, flag]
                            : terrain.brush.topologyFlags.filter((value) => value !== flag),
                        })
                      }
                    />
                    <span>{flag.replace(/_/g, " ")}</span>
                  </label>
                ))}
              </div>
              <SectionLabel>Topology clear</SectionLabel>
              <div className="check-list">
                {TOPOLOGY_FLAGS.map((flag) => (
                  <label key={`clear-${flag}`} className="check-row">
                    <input
                      type="checkbox"
                      checked={terrain.brush.topologyClearFlags.includes(flag)}
                      onChange={(event) =>
                        patchBrush({
                          topologyClearFlags: event.target.checked
                            ? [...terrain.brush.topologyClearFlags, flag]
                            : terrain.brush.topologyClearFlags.filter((value) => value !== flag),
                        })
                      }
                    />
                    <span>clear {flag.replace(/_/g, " ")}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </StudioSection>
      )}

      {studio && (
        <StudioSection title="Heightmap and mask imports">
          <p className="hint-block">
            Native 2049² and 4097² grids are kept as-is instead of being downsampled. A native import also sets the
            exported map size to resolution − 1 metres; larger grids are rejected before decoding.
          </p>
          <Field label="16-bit heightmap" hint="PNG or RAW16, square grid">
            <input
              type="file"
              accept=".png,.raw,.r16,.raw16"
              disabled={importing}
              onChange={(event) => void importHeightmap(event.target.files?.[0])}
            />
          </Field>
          {terrain.heightmap && (
            <div className="inline-row">
              <span className="hint-block">
                {terrain.heightmap.name} / {terrain.heightmap.resolution}² / {Math.round(terrain.heightmap.minHeight)} to{" "}
                {Math.round(terrain.heightmap.maxHeight)} m / ~
                {Math.round((terrain.heightmap.resolution ** 2 * 2) / (1024 * 1024))} MiB height layer
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  dispatch({ type: "patchTerrain", patch: { heightmap: undefined } })
                }
              >
                Remove
              </Button>
            </div>
          )}
          <div className="inline-row">
            <Field label="Mask kind">
              <select
                className="select-input"
                value={maskKind}
                onChange={(event) => setMaskKind(event.target.value as TerrainMaskImport["kind"])}
              >
                <option value="splat">Splat</option>
                <option value="biome">Biome</option>
                <option value="topology">Topology</option>
                <option value="alpha">Alpha / holes</option>
              </select>
            </Field>
            <Field label="Channel">
              <NumberInput value={maskChannel} min={0} max={7} onChange={setMaskChannel} />
            </Field>
          </div>
          <Field label="External mask" hint="PNG or RAW8, square grid">
            <input
              type="file"
              accept=".png,.raw,.r8,.raw8"
              disabled={importing}
              onChange={(event) => void importMask(event.target.files?.[0])}
            />
          </Field>
          {(terrain.masks ?? []).length > 0 && (
            <ul className="plain-list">
              {(terrain.masks ?? []).map((mask) => (
                <li key={mask.id}>
                  <strong>{mask.name}</strong>
                  <span>{mask.kind} / channel {mask.channel} / {mask.resolution}²</span>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      dispatch({
                        type: "patchTerrain",
                        patch: { masks: terrain.masks.filter((item) => item.id !== mask.id) },
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {importing && <p className="hint-block">Reading local layer data…</p>}
          {importError && <p className="error-block">{importError}</p>}
        </StudioSection>
      )}
    </div>
  );
}

export function MonumentsStep() {
  const { state, dispatch } = useWizard();
  const [catalog, setCatalog] = useState<PrefabAsset[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>("All");
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [scatterAssetId, setScatterAssetId] = useState("");
  const [scatterCount, setScatterCount] = useState(12);
  const [scatterRadius, setScatterRadius] = useState(220);
  const [scatterSeed, setScatterSeed] = useState(state.draft.terrain.seed);
  const [scatterRotation, setScatterRotation] = useState(180);
  const [scatterScale, setScatterScale] = useState(0.15);
  const [scatterNote, setScatterNote] = useState<string | null>(null);
  const studio = state.draft.studioMode;
  const selected = state.draft.placements.find((placement) => placement.id === state.draft.selectedPlacementId) ?? null;
  const scatterAsset =
    catalog.find((asset) => asset.id === scatterAssetId) ?? catalog[0] ?? null;

  const runScatter = () => {
    if (!scatterAsset) return;
    const draft = state.draft;
    const preview = buildTerrainPreview(draft, 96);
    const spots = scatterSpots({
      seed: scatterSeed,
      count: scatterCount,
      centre: { x: 0, z: 0 },
      radius: scatterRadius,
      minSpacing: scatterSpacing(scatterAsset.bounds),
      rotationJitter: scatterRotation,
      scaleJitter: scatterScale,
      mapHalf: draft.terrain.sizeMetres / 2,
      waterLevel: draft.terrain.waterLevel,
      heightAt: (x, z) =>
        samplePreviewHeight(preview, x, z, draft.terrain.sizeMetres),
      blocked: draft.placements.map((placement) => ({
        x: placement.position.x,
        z: placement.position.z,
        radius: Math.max(6, placement.flattenRadius * 0.5),
      })),
    });
    setScatterNote(
      spots.length
        ? `${spots.length} of ${scatterCount} copies placed — water, map edge, overlap and existing footprints rejected the rest.`
        : `No valid spot in ${scatterRadius} m: widen the radius, lower the count or move away from water.`,
    );
    if (!spots.length) return;
    const base = draft.placements.length;
    const placements = spots.map((spot, index) => {
      const placement = createPlacement(scatterAsset, base + index, {
        x: spot.x,
        z: spot.z,
      });
      return {
        ...placement,
        name: `${scatterAsset.name} ${base + index + 1}`,
        position: { x: Math.round(spot.x * 10) / 10, y: spot.y, z: Math.round(spot.z * 10) / 10 },
        rotationEuler: { x: 0, y: spot.rotation, z: 0 },
        scale: { x: spot.scale, y: spot.scale, z: spot.scale },
        // Scattered decor should not flatten the ground or seed no-build zones.
        flatten: false,
        noBuildZone: false,
        clearFoliage: true,
      };
    });
    dispatch({ type: "addPlacements", placements });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    browsePrefabs({
      category: filter === "All" ? undefined : filter,
      query: searchTerm,
      limit: 120,
    })
      .then((page) => {
        if (cancelled) return;
        setCatalog(page.rows);
        setCounts(page.counts);
        setTotal(page.total);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, searchTerm]);

  const categories = useMemo(
    () => ["All", ...Object.keys(counts).sort()],
    [counts],
  );
  const visible = catalog;

  return (
    <div className="stack">
      {state.draft.projectKind === "monument" && (
        <Panel title="Testing stage" subtitle="Ground plane, sky and fog for reviewing the prefab in context.">
          <div className="chip-row">
            {MONUMENT_FLOORS.map((floor) => (
              <button
                key={floor.id}
                type="button"
                className={`chip${matchesStarter(state.draft.terrain, floor.patch) ? " is-active" : ""}`}
                title={floor.body}
                onClick={() => dispatch({ type: "patchTerrain", patch: floor.patch })}
              >
                {floor.title}
              </button>
            ))}
          </div>
          <p className="hint-block">
            The stage is a flat floor at a fixed elevation with matching splat, biome, lighting and fog. Dropped
            prefabs still flatten, blend and clear foliage on top of it.
          </p>
        </Panel>
      )}

      <Panel
        title="Scatter stamp"
        subtitle="Seeded placement scatter over the prefab library, proxy-aware."
      >
        <Field label="Stamp prefab">
          <select
            className="select-input"
            value={scatterAsset?.id ?? ""}
            onChange={(event) => setScatterAssetId(event.target.value)}
          >
            {catalog.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </Field>
        <Slider
          label="Copies"
          value={scatterCount}
          min={1}
          max={60}
          step={1}
          onChange={setScatterCount}
          format={(value) => `${value}`}
        />
        <Slider
          label="Scatter radius"
          value={scatterRadius}
          min={20}
          max={900}
          step={10}
          onChange={setScatterRadius}
          format={(value) => `${value} m`}
        />
        <Slider
          label="Rotation jitter"
          value={scatterRotation}
          min={0}
          max={180}
          step={5}
          onChange={setScatterRotation}
          format={(value) => `±${value}°`}
        />
        <Slider
          label="Scale jitter"
          value={scatterScale}
          min={0}
          max={0.5}
          step={0.01}
          onChange={setScatterScale}
          format={(value) => `±${Math.round(value * 100)}%`}
        />
        <Field label="Seed">
          <NumberInput value={scatterSeed} onChange={setScatterSeed} />
        </Field>
        <p className="hint-block">
          Rejection sampling skips water, map edges, existing footprints and overlap. Copies use the shared prefab
          entry, so their bounds come from the editor proxies — interior geometry is not analysed.
        </p>
        <Button variant="primary" onClick={runScatter} disabled={!scatterAsset}>
          Scatter {scatterCount} copies
        </Button>
        {scatterNote && <p className="hint-block">{scatterNote}</p>}
      </Panel>

      <Panel title="Prefab library" subtitle={`${total} prefabs match this filter`}>
        <TextInput value={query} onChange={setQuery} placeholder="Search monuments, decor, buildings" />
        <div className="chip-row">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              className={`chip${filter === category ? " is-active" : ""}`}
              onClick={() => setFilter(category)}
            >
              {category}
              {category !== "All" && counts[category] ? ` ${counts[category]}` : ""}
            </button>
          ))}
        </div>
        <div className="asset-grid">
          {visible.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className="asset-card"
              draggable
              onDragStart={(event) => {
                startPrefabDrag(asset);
                event.dataTransfer.setData(PREFAB_MIME, asset.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onDragEnd={endPrefabDrag}
              onClick={() => dispatch({ type: "addPlacement", asset })}
              title={`Drag ${asset.name} onto the terrain, or click to place`}
            >
              <span className="asset-thumb">
                <img
                  className="asset-thumb-art"
                  src={previewPlaceholder(asset.category, asset.bounds)}
                  alt=""
                  aria-hidden="true"
                />
              </span>
              <span className="asset-name">{asset.name}</span>
              <span className="asset-meta">
                {Math.round(asset.bounds.max[0] - asset.bounds.min[0])} x{" "}
                {Math.round(asset.bounds.max[2] - asset.bounds.min[2])} m
              </span>
              <span className="asset-flags">
                {asset.hasLoot && <em>Loot</em>}
                {asset.hasIO && <em>IO</em>}
                {asset.hasNpc && <em>NPC</em>}
              </span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel
        title="Placed prefabs"
        subtitle={`${state.draft.placements.length} placed`}
        actions={
          state.draft.placements.length > 0 ? (
            <Button variant="ghost" onClick={() => dispatch({ type: "selectPlacement", id: null })}>
              Clear selection
            </Button>
          ) : undefined
        }
      >
        {state.draft.placements.length === 0 ? (
          <EmptyState
            title="No prefabs placed"
            body="Pick a monument from the library. Terrain under it is flattened with a falloff blend and foliage is cleared in the topology layer."
          />
        ) : (
          <ul className="placement-list">
            {state.draft.placements.map((placement) => (
              <li key={placement.id}>
                <button
                  type="button"
                  className={`placement-row${placement.id === state.draft.selectedPlacementId ? " is-active" : ""}`}
                  onClick={() => dispatch({ type: "selectPlacement", id: placement.id })}
                >
                  <span>
                    <span className="placement-name">{placement.name}</span>
                    <span className="placement-meta">
                      {placement.position.x}, {placement.position.z}
                      {placement.flatten ? " / flattened" : ""}
                    </span>
                  </span>
                  <span className="placement-badges">
                    {placement.noBuildZone && <Badge tone="neutral">No-build</Badge>}
                    {placement.clearFoliage && <Badge tone="neutral">Foliage</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selected && (
        <Panel title={selected.name} subtitle="Placement settings">
          <Field label="Display name">
            <TextInput
              value={selected.name}
              onChange={(name) => dispatch({ type: "updatePlacement", id: selected.id, patch: { name } })}
            />
          </Field>
          <Toggle
            label="Flatten terrain"
            description="Cut a pad and blend the edge with the falloff width."
            checked={selected.flatten}
            onChange={(flatten) => dispatch({ type: "updatePlacement", id: selected.id, patch: { flatten } })}
          />
          <Slider
            label="Flatten radius"
            value={selected.flattenRadius ?? 40}
            min={4}
            max={320}
            step={1}
            onChange={(flattenRadius) =>
              dispatch({ type: "updatePlacement", id: selected.id, patch: { flattenRadius } })
            }
            format={(value) => `${value} m`}
            disabled={!selected.flatten}
          />
          <Slider
            label="Edge falloff"
            value={selected.flattenFalloff}
            min={4}
            max={80}
            step={1}
            onChange={(flattenFalloff) =>
              dispatch({ type: "updatePlacement", id: selected.id, patch: { flattenFalloff } })
            }
            format={(value) => `${value} m`}
            disabled={!selected.flatten}
          />
          <div className="inline-row">
            <Button
              variant="ghost"
              onClick={() => dispatch({ type: "connectPlacement", placementId: selected.id })}
            >
              Connect to nearest road
            </Button>
          </div>
          <p className="hint-block">
            Draws a road spline from this prefab's entrance to the nearest point on the closest ordinary road, or to
            the nearest map edge when there is no road yet. Rivers, rails and other prefabs' connectors are ignored,
            and no stub is added when the prefab already touches a road. The corridor is flattened and gravel-painted
            by the same pass the Paths step uses; move or delete the spline later like any other road.
          </p>
          <Slider
            label="Collision radius"
            value={selected.collisionRadius ?? 12}
            min={2}
            max={160}
            step={1}
            onChange={(collisionRadius) =>
              dispatch({ type: "updatePlacement", id: selected.id, patch: { collisionRadius } })
            }
            format={(value) => `${value} m`}
          />
          <Slider
            label="Collision height"
            value={selected.collisionHeight ?? 8}
            min={2}
            max={200}
            step={1}
            onChange={(collisionHeight) =>
              dispatch({ type: "updatePlacement", id: selected.id, patch: { collisionHeight } })
            }
            format={(value) => `${value} m`}
          />
          <p className="hint-block">
            The wireframe proxy uses these bounds, and the same values drive map-edge and overlap validation. Placement scale and yaw are applied first, so a scaled-up prefab needs a larger map margin.
          </p>
          <Toggle
            label="Clear foliage"
            description="Marks the footprint in the topology layer so trees and decor do not spawn."
            checked={selected.clearFoliage}
            onChange={(clearFoliage) =>
              dispatch({ type: "updatePlacement", id: selected.id, patch: { clearFoliage } })
            }
          />
          <Toggle
            label="No-build zone"
            description="Adds a protected volume around the monument."
            checked={selected.noBuildZone}
            onChange={(noBuildZone) =>
              dispatch({ type: "updatePlacement", id: selected.id, patch: { noBuildZone } })
            }
          />
          <Field label="Loot tier">
            <select
              className="select-input"
              value={selected.lootTier}
              onChange={(event) =>
                dispatch({
                  type: "updatePlacement",
                  id: selected.id,
                  patch: { lootTier: Number(event.target.value) as 1 | 2 | 3 },
                })
              }
            >
              <option value={1}>Tier 1 - low</option>
              <option value={2}>Tier 2 - medium</option>
              <option value={3}>Tier 3 - high</option>
            </select>
          </Field>

          {studio && (
            <StudioSection title="Transform and hierarchy">
              <div className="triple-grid">
                {(["x", "y", "z"] as const).map((axis) => (
                  <Field key={axis} label={`Position ${axis.toUpperCase()}`}>
                    <NumberInput
                      value={selected.position[axis]}
                      step={1}
                      onChange={(value) =>
                        dispatch({
                          type: "updatePlacement",
                          id: selected.id,
                          patch: { position: { ...selected.position, [axis]: value } },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
              <div className="triple-grid">
                {(["x", "y", "z"] as const).map((axis) => (
                  <Field key={axis} label={`Scale ${axis.toUpperCase()}`}>
                    <NumberInput
                      value={selected.scale[axis]}
                      step={0.05}
                      onChange={(value) =>
                        dispatch({
                          type: "updatePlacement",
                          id: selected.id,
                          patch: { scale: { ...selected.scale, [axis]: value } },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
              <Field label="Rotation Y" hint="Degrees">
                <NumberInput
                  value={selected.rotationEuler.y}
                  step={5}
                  onChange={(value) =>
                    dispatch({
                      type: "updatePlacement",
                      id: selected.id,
                      patch: { rotationEuler: { ...selected.rotationEuler, y: value } },
                    })
                  }
                />
              </Field>
              <Field label="NPC count">
                <NumberInput
                  value={selected.npcCount}
                  min={0}
                  onChange={(npcCount) =>
                    dispatch({ type: "updatePlacement", id: selected.id, patch: { npcCount } })
                  }
                />
              </Field>
              <Field label="IO wiring" hint="Serialized with the entity">
                <TextInput
                  value={selected.ioWiring}
                  onChange={(ioWiring) =>
                    dispatch({ type: "updatePlacement", id: selected.id, patch: { ioWiring } })
                  }
                  placeholder="switch -> door, timer -> light"
                  mono
                />
              </Field>
              <Toggle
                label="Lock transform"
                checked={selected.locked}
                onChange={(locked) => dispatch({ type: "updatePlacement", id: selected.id, patch: { locked } })}
              />
              <Button variant="danger" onClick={() => dispatch({ type: "removePlacement", id: selected.id })}>
                Remove placement
              </Button>
            </StudioSection>
          )}
        </Panel>
      )}
    </div>
  );
}

const SPLINE_KINDS: { id: SplineKind; label: string }[] = [
  { id: "road", label: "Road" },
  { id: "river", label: "River" },
  { id: "rail", label: "Train rail" },
  { id: "apc", label: "Bradley APC route" },
  { id: "cargo", label: "Cargo ship path" },
  { id: "chinook", label: "Chinook route" },
  { id: "powerline", label: "Powerline" },
  { id: "cave", label: "Cave tunnel" },
];

export function PathsStep() {
  const { state, dispatch } = useWizard();
  const studio = state.draft.studioMode;
  const [openId, setOpenId] = useState<string | null>(state.draft.splines[0]?.id ?? null);
  const open = state.draft.splines.find((spline) => spline.id === openId) ?? state.draft.splines[0] ?? null;

  useEffect(() => {
    if (!openId && state.draft.splines[0]) setOpenId(state.draft.splines[0].id);
  }, [state.draft.splines, openId]);

  const updateNodes = (nodes: { x: number; y: number; z: number }[]) => {
    if (!open) return;
    dispatch({ type: "updateSpline", id: open.id, patch: { nodes } });
  };

  return (
    <div className="stack">
      <Panel title="Auto-routed splines" subtitle="Splines extrude into terrain-conforming ribbons on export.">
        <div className="chip-row">
          {SPLINE_KINDS.map((kind) => (
            <button
              key={kind.id}
              type="button"
              className="chip chip-add"
              onClick={() => dispatch({ type: "addSpline", kind: kind.id })}
            >
              + {kind.label}
            </button>
          ))}
        </div>
        {state.draft.splines.length === 0 ? (
          <EmptyState
            title="No routes"
            body="Add a road or river. Auto-routing follows the terrain gradient between nodes; node editing is available in Studio Mode."
          />
        ) : (
          <ul className="spline-list">
            {state.draft.splines.map((spline) => (
              <li key={spline.id}>
                <button
                  type="button"
                  className={`placement-row${spline.id === open?.id ? " is-active" : ""}`}
                  onClick={() => setOpenId(spline.id)}
                >
                  <span>
                    <span className="placement-name">{spline.name}</span>
                    <span className="placement-meta">
                      {spline.kind} / {spline.nodes.length} nodes / {spline.width} m
                    </span>
                  </span>
                  <span className="placement-badges">
                    {spline.autoRoute && <Badge tone="accent">Auto</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {open && (
        <Panel title={open.name} subtitle="Spline settings">
          <Field label="Name">
            <TextInput
              value={open.name}
              onChange={(name) => dispatch({ type: "updateSpline", id: open.id, patch: { name } })}
            />
          </Field>
          <Slider
            label="Width"
            value={open.width}
            min={1}
            max={80}
            step={0.5}
            onChange={(width) => dispatch({ type: "updateSpline", id: open.id, patch: { width } })}
            format={(value) => `${value.toFixed(1)} m`}
          />
          {open.kind === "cave" ? (
            <>
              <Field label="Tunnel preset">
                <select
                  className="select-input"
                  value={open.cavePreset ?? "natural"}
                  onChange={(event) => {
                    const preset = cavePreset(event.target.value as CavePresetId);
                    dispatch({
                      type: "updateSpline",
                      id: open.id,
                      patch: {
                        cavePreset: preset.id,
                        width: preset.width,
                        ceilingHeight: preset.height,
                        roughness: preset.id === "natural" ? 0.35 : 0.1,
                      },
                    });
                  }}
                >
                  {CAVE_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Slider
                label="Tunnel height"
                value={open.ceilingHeight ?? 7}
                min={3}
                max={20}
                step={0.5}
                onChange={(ceilingHeight) =>
                  dispatch({ type: "updateSpline", id: open.id, patch: { ceilingHeight } })
                }
                format={(value) => `${value} m`}
              />
              <Slider
                label="Rock roughness"
                value={open.roughness ?? 0.35}
                min={0}
                max={1}
                step={0.05}
                onChange={(roughness) =>
                  dispatch({ type: "updateSpline", id: open.id, patch: { roughness } })
                }
                format={(value) => value.toFixed(2)}
              />
              <p className="hint-block">
                Node elevation is the tunnel floor, so points below the surface stay buried and points that
                break it cut an alpha portal (and its Walk Mode hole) automatically. The 3D view draws the
                tunnel shell, support ribs and portal rings.
              </p>
            </>
          ) : null}
          <Toggle
            label="Auto-route"
            description="Recompute intermediate nodes from terrain and existing obstacles."
            checked={open.autoRoute}
            onChange={(autoRoute) => dispatch({ type: "updateSpline", id: open.id, patch: { autoRoute } })}
          />
          <Toggle
            label="Closed loop"
            checked={open.closed}
            onChange={(closed) => dispatch({ type: "updateSpline", id: open.id, patch: { closed } })}
          />
          <Field label="Curve type">
            <select
              className="select-input"
              value={open.curve}
              onChange={(event) =>
                dispatch({
                  type: "updateSpline",
                  id: open.id,
                  patch: { curve: event.target.value as typeof open.curve },
                })
              }
            >
              <option value="catmull-rom">Catmull-Rom</option>
              <option value="bezier">Bezier</option>
            </select>
          </Field>
          <Slider
            label="Tension"
            value={open.tension}
            min={0}
            max={1}
            step={0.05}
            onChange={(tension) => dispatch({ type: "updateSpline", id: open.id, patch: { tension } })}
            format={(value) => value.toFixed(2)}
          />
          <Toggle
            label="Deform terrain"
            description="Cuts a flat corridor under the route and blends the shoulders."
            checked={open.deformTerrain}
            onChange={(deformTerrain) =>
              dispatch({ type: "updateSpline", id: open.id, patch: { deformTerrain } })
            }
          />
          <Toggle
            label="Paint route splat"
            description="Paints gravel for roads, sand for rivers and stones for rails."
            checked={open.paintSplat}
            onChange={(paintSplat) =>
              dispatch({ type: "updateSpline", id: open.id, patch: { paintSplat } })
            }
          />
          <Field label="Path topology">
            <select
              className="select-input"
              value={open.topologyFlag ?? ""}
              onChange={(event) =>
                dispatch({
                  type: "updateSpline",
                  id: open.id,
                  patch: { topologyFlag: (event.target.value || null) as typeof open.topologyFlag },
                })
              }
            >
              <option value="">None</option>
              <option value="path_clear">Path clear</option>
              <option value="no_build">No build</option>
              <option value="npc_zone">NPC / patrol zone</option>
            </select>
          </Field>

          {studio && (
            <StudioSection title="Node outliner">
              <div className="node-table">
                {open.nodes.map((node, index) => (
                  <div className="node-row" key={`${open.id}-${index}`}>
                    <span className="node-index">{String(index + 1).padStart(2, "0")}</span>
                    <NumberInput
                      value={node.x}
                      onChange={(x) => updateNodes(open.nodes.map((value, i) => (i === index ? { ...value, x } : value)))}
                    />
                    <NumberInput
                      value={node.z}
                      onChange={(z) => updateNodes(open.nodes.map((value, i) => (i === index ? { ...value, z } : value)))}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => updateNodes(open.nodes.filter((_, i) => i !== index))}
                      aria-label="Delete node"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="inline-form">
                <Button
                  variant="ghost"
                  onClick={() => updateNodes([...open.nodes, { x: 0, y: 0, z: 0 }])}
                  disabled={open.nodes.length >= 128}
                >
                  Add node
                </Button>
                <Button variant="danger" onClick={() => dispatch({ type: "removeSpline", id: open.id })}>
                  Delete spline
                </Button>
              </div>
            </StudioSection>
          )}
        </Panel>
      )}
    </div>
  );
}

function IoWiringGraph({
  nodes,
  links,
  selected,
  onSelect,
  size,
}: {
  nodes: IONode[];
  links: IOLink[];
  selected: string | null;
  onSelect: (id: string) => void;
  size: number;
}) {
  const half = Math.max(1, size / 2);
  const project = (node: IONode): [number, number] => [
    Math.max(3, Math.min(97, ((node.x + half) / size) * 100)),
    Math.max(3, Math.min(97, ((node.z + half) / size) * 100)),
  ];
  return (
    <div className="io-graph-wrap">
    <svg className="io-graph" viewBox="0 0 100 100" role="img" aria-label="IO wiring graph">
      {links.map((link) => {
        const from = nodes.find((node) => node.id === link.from);
        const to = nodes.find((node) => node.id === link.to);
        if (!from || !to) return null;
        const [x1, y1] = project(from);
        const [x2, y2] = project(to);
        return (
          <line
            key={link.id}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            className={`io-wire${link.cardLevel ? ` is-${link.cardLevel}` : ""}`}
          />
        );
      })}
      {nodes.map((node) => {
        const [x, y] = project(node);
        return (
          <g
            key={node.id}
            className={`io-node${selected === node.id ? " is-selected" : ""}`}
            onClick={() => onSelect(node.id)}
            role="button"
            tabIndex={0}
            aria-label={node.name}
          >
            <circle cx={x} cy={y} r={4.5} />
            <text x={x} y={y + 1.2} textAnchor="middle">
              {node.kind === "card_reader" ? "CARD" : node.kind.slice(0, 3).toUpperCase()}
            </text>
            <title>{node.name}</title>
          </g>
        );
      })}
    </svg>
    </div>
  );
}

const TIERS = [
  { id: 1 as const, label: "Tier 1", body: "Low value crates, no card puzzles, light NPC presence." },
  { id: 2 as const, label: "Tier 2", body: "Standard monument loot, green/blue cards, moderate NPCs." },
  { id: 3 as const, label: "Tier 3", body: "Elite crates, full card puzzle chain, heavy NPC coverage." },
];

export function LootStep() {
  const { state, dispatch } = useWizard();
  const draft = state.draft;
  const loot = draft.loot;
  const studio = draft.studioMode;
  const [ioSelected, setIoSelected] = useState<string | null>(null);
  const patch = (value: Partial<typeof loot>) => dispatch({ type: "patchLoot", patch: value });

  return (
    <div className="stack">
      <Panel title="Difficulty tier" subtitle="Applies loot profiles to every placed monument.">
        <div className="tier-list">
          {TIERS.map((tier) => (
            <button
              key={tier.id}
              type="button"
              className={`tier-card${loot.tier === tier.id ? " is-active" : ""}`}
              onClick={() =>
                patch({
                  tier: tier.id,
                  crateCount: tier.id === 1 ? 14 : tier.id === 2 ? 24 : 36,
                  vendingMachines: tier.id === 1 ? 3 : tier.id === 2 ? 6 : 9,
                  cardPuzzles: tier.id === 1 ? 0 : tier.id === 2 ? 2 : 4,
                  npcSpawners: tier.id === 1 ? 4 : tier.id === 2 ? 8 : 14,
                })
              }
            >
              <span className="tier-head">
                <strong>{tier.label}</strong>
                {loot.tier === tier.id && <Badge tone="accent">Active</Badge>}
              </span>
              <p>{tier.body}</p>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Spawn budgets">
        <Slider
          label="Loot crates"
          value={loot.crateCount}
          min={0}
          max={200}
          onChange={(crateCount) => patch({ crateCount })}
          format={(value) => `${value}`}
        />
        <Slider
          label="Vending machines"
          value={loot.vendingMachines}
          min={0}
          max={80}
          onChange={(vendingMachines) => patch({ vendingMachines })}
          format={(value) => `${value}`}
        />
        <Slider
          label="Card puzzles"
          value={loot.cardPuzzles}
          min={0}
          max={30}
          onChange={(cardPuzzles) => patch({ cardPuzzles })}
          format={(value) => `${value}`}
        />
        <Slider
          label="NPC spawners"
          value={loot.npcSpawners}
          min={0}
          max={120}
          onChange={(npcSpawners) => patch({ npcSpawners })}
          format={(value) => `${value}`}
        />
        <Slider
          label="Loot density"
          value={loot.lootDensity}
          min={0.2}
          max={2}
          step={0.05}
          onChange={(lootDensity) => patch({ lootDensity })}
          format={(value) => `${value.toFixed(2)}x`}
        />
      </Panel>

      <Panel title="Card levels" subtitle="Fuse and keycard progression written to entity data.">
        {(["Green card", "Blue card", "Red card"] as const).map((label, index) => (
          <Toggle
            key={label}
            label={label}
            checked={loot.cardLevels[index]}
            onChange={(value) => {
              const next: [boolean, boolean, boolean] = [...loot.cardLevels];
              next[index] = value;
              patch({ cardLevels: next });
            }}
          />
        ))}
      </Panel>

      {studio && (
        <StudioSection title="Visual IO and puzzle wiring">
          <div className="chip-row">
            {(["switch", "card_reader", "door", "generator", "timer", "light", "vending_machine"] as const).map(
              (kind) => (
                <button
                  key={kind}
                  type="button"
                  className="chip chip-add"
                  onClick={() => dispatch({ type: "addIONode", kind })}
                >
                  + {kind.replace(/_/g, " ")}
                </button>
              ),
            )}
          </div>
          {state.draft.io.nodes.length === 0 ? (
            <EmptyState
              title="No IO components"
              body="Add a switch, card reader, generator or door, then click two nodes to draw a wire. Wires are exported in the RustEdit metadata layer."
            />
          ) : (
            <>
              <IoWiringGraph
                nodes={state.draft.io.nodes}
                links={state.draft.io.links}
                selected={ioSelected}
                onSelect={(id) => {
                  if (!ioSelected) {
                    setIoSelected(id);
                    return;
                  }
                  if (ioSelected !== id) dispatch({ type: "addIOLink", from: ioSelected, to: id });
                  setIoSelected(null);
                }}
                size={draft.terrain.sizeMetres}
              />
              <p className="hint-block">
                {ioSelected ? "Select the target component to draw a wire." : "Click a component to start a wire."}
              </p>
              <ul className="plain-list">
                {state.draft.io.nodes.map((node) => (
                  <li key={node.id}>
                    <strong>{node.name}</strong>
                    <span>{node.kind.replace(/_/g, " ")}</span>
                    <Field label="Card level">
                      <select
                        className="select-input"
                        value={node.cardLevel ?? ""}
                        onChange={(event) =>
                          dispatch({
                            type: "updateIONode",
                            id: node.id,
                            patch: { cardLevel: (event.target.value || null) as typeof node.cardLevel },
                          })
                        }
                      >
                        <option value="">None</option>
                        <option value="green">Green</option>
                        <option value="blue">Blue</option>
                        <option value="red">Red</option>
                      </select>
                    </Field>
                    <Button variant="ghost" onClick={() => dispatch({ type: "removeIONode", id: node.id })}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              <ul className="plain-list">
                {state.draft.io.links.map((link) => {
                  const from = state.draft.io.nodes.find((node) => node.id === link.from);
                  const to = state.draft.io.nodes.find((node) => node.id === link.to);
                  return (
                    <li key={link.id}>
                      <strong>{from?.name ?? "?"} → {to?.name ?? "?"}</strong>
                      <span>{link.cardLevel ?? "unkeyed"}</span>
                      <Button variant="danger" onClick={() => dispatch({ type: "removeIOLink", id: link.id })}>
                        Cut wire
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {state.draft.placements.some((placement) => /vending/i.test(placement.assetId)) && (
            <>
              <SectionLabel>Vending overrides</SectionLabel>
              {state.draft.io.vendingOverrides.map((override) => (
                <div className="triple-grid" key={override.id}>
                  <Field label="Profile">
                    <TextInput
                      value={override.profile}
                      onChange={(profile) =>
                        dispatch({ type: "updateVendingOverride", id: override.id, patch: { profile } })
                      }
                    />
                  </Field>
                  <Field label="Stock">
                    <NumberInput
                      value={override.stock}
                      min={0}
                      onChange={(stock) =>
                        dispatch({ type: "updateVendingOverride", id: override.id, patch: { stock } })
                      }
                    />
                  </Field>
                  <Field label="Price x">
                    <NumberInput
                      value={override.priceMultiplier}
                      step={0.05}
                      onChange={(priceMultiplier) =>
                        dispatch({ type: "updateVendingOverride", id: override.id, patch: { priceMultiplier } })
                      }
                    />
                  </Field>
                </div>
              ))}
              <Button
                variant="ghost"
                onClick={() => {
                  const target = state.draft.placements.find((placement) => /vending/i.test(placement.assetId));
                  if (target) dispatch({ type: "addVendingOverride", placementId: target.id });
                }}
              >
                Add vending override
              </Button>
            </>
          )}
        </StudioSection>
      )}

      {studio && (
        <StudioSection title="Entity overrides">
          <div className="triple-grid">
            <Field label="Radiation zones">
              <NumberInput
                value={loot.radiationZones}
                min={0}
                onChange={(radiationZones) => patch({ radiationZones })}
              />
            </Field>
            <Field label="No-build zones">
              <NumberInput
                value={loot.noBuildZones}
                min={0}
                onChange={(noBuildZones) => patch({ noBuildZones })}
              />
            </Field>
          </div>
          <p className="hint-block">
            Per-entity wiring is edited on each placement in the Monuments step. IO entities and vending profiles are
            serialized into the RustEdit data layer, not the vanilla map.
          </p>
          <ul className="plain-list">
            {state.draft.placements
              .filter((placement) => placement.ioWiring || placement.npcCount > 0)
              .map((placement) => (
                <li key={placement.id}>
                  <strong>{placement.name}</strong>
                  <span>{placement.ioWiring || "no wiring"} / {placement.npcCount} NPCs</span>
                </li>
              ))}
          </ul>
        </StudioSection>
      )}
    </div>
  );
}

export function ValidateStep() {
  const { state, dispatch } = useWizard();
  const draft = state.draft;
  const studio = draft.studioMode;
  const issues = validateDraft(draft);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const padCoverage =
    draft.placements.reduce(
      (total, placement) => total + Math.PI * placement.flattenRadius * placement.flattenRadius,
      0,
    ) / Math.max(1, draft.terrain.sizeMetres * draft.terrain.sizeMetres);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delta, setDelta] = useState<{ path: string; bytes: number; operations: number } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [conflict, setConflict] = useState<SyncPushResult | SyncPullResult | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const report = state.exportReport;

  const push = async () => {
    setSyncBusy(true);
    setSyncNote(null);
    try {
      const result = await syncPush(draft.projectId, draft);
      if (result.conflict) {
        setConflict(result);
      } else {
        setSyncNote(`Pushed revision ${result.revision ?? "?"}.`);
        setConflict(null);
      }
    } catch (syncError) {
      setSyncNote(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setSyncBusy(false);
    }
  };

  const pull = async () => {
    setSyncBusy(true);
    setSyncNote(null);
    try {
      const result = await syncPull(draft.projectId);
      if (result.decision === "conflict") {
        setConflict(result);
      } else if (result.draft) {
        dispatch({ type: "applyGenerated", draft: result.draft, step: "validate" });
        setSyncNote(`Pulled revision ${result.revision ?? "?"}.`);
      } else {
        setSyncNote(result.message);
      }
    } catch (syncError) {
      setSyncNote(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setSyncBusy(false);
    }
  };

  const resolve = async (choice: "local" | "remote") => {
    setSyncBusy(true);
    try {
      const result = await syncResolve(draft.projectId, choice);
      if (result.action === "push") {
        setConflict(null);
        await push();
      } else if (result.draft) {
        dispatch({ type: "applyGenerated", draft: result.draft, step: "validate" });
        setConflict(null);
        setSyncNote("Applied the remote revision.");
      }
    } catch (syncError) {
      setSyncNote(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setSyncBusy(false);
    }
  };

  const run = async () => {
    setExporting(true);
    setError(null);
    try {
      const result = await exportProject(draft);
      dispatch({ type: "markSaved", at: new Date().toISOString(), report: result });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="stack">
      <Panel title="Map health" subtitle="Live checks; nothing is uploaded to run them.">
        <div className="triple-grid">
          <Stat label="Prefabs" value={draft.placements.length} />
          <Stat label="Splines" value={draft.splines.length} />
          <Stat label="Pad coverage" value={`${Math.round(padCoverage * 100)}%`} />
          <Stat label="Blockers" value={errorCount} />
          <Stat label="Warnings" value={warningCount} />
          <Stat label="IO nodes" value={draft.io.nodes.length} />
        </div>
      </Panel>

      <Panel title="Validation report" subtitle={`${issues.filter((issue) => issue.severity === "error").length} blockers`}>
        {issues.length === 0 ? (
          <EmptyState title="No issues found" body="Layers, splines, placements and export settings pass validation." />
        ) : (
          <ul className="issue-list">
            {issues.map((issue) => (
              <li key={issue.id} className={`issue issue-${issue.severity}`}>
                <span className="issue-severity">{issue.severity}</span>
                <div>
                  <p>{issue.message}</p>
                  <span className="issue-step">{STEP_META[issue.step].label}</span>
                  {issue.detail && <p className="issue-detail">{issue.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Offline delta sync" subtitle="Queue only changed JSON records; the full map stays local.">
        <p className="hint-block">
          Brush strokes, prefab transforms, spline nodes, IO wires and project settings are diffed against the last
          queued snapshot. Binary .map compilation never leaves this machine.
        </p>
        <div className="inline-row">
          <Button
            variant="ghost"
            onClick={() => {
              const next = nextProjectDelta(draft);
              void queueProjectDelta(next)
                .then(setDelta)
                .catch((syncError) =>
                  setError(syncError instanceof Error ? syncError.message : String(syncError)),
                );
            }}
          >
            Queue sync delta
          </Button>
          <Button variant="ghost" disabled={syncBusy} onClick={() => void push()}>
            Push
          </Button>
          <Button variant="ghost" disabled={syncBusy} onClick={() => void pull()}>
            Pull
          </Button>
        </div>
        {delta && (
          <p className="hint-block">
            Queued {delta.operations} operation(s), {Math.round(delta.bytes / 1024)} KiB → {delta.path}
          </p>
        )}
        {syncNote && <p className="hint-block">{syncNote}</p>}
        {conflict && (
          <div className="report-block">
            <Badge tone="warn">Revision conflict</Badge>
            <p className="hint-block">
              Both this machine and the remote have newer edits. Revisions are compared deterministically: keep the
              full local draft, or replace it with the remote one. No automatic field-level merge is applied.
            </p>
            <div className="inline-row">
              <Button variant="ghost" disabled={syncBusy} onClick={() => void resolve("local")}>
                Keep local and push
              </Button>
              <Button variant="ghost" disabled={syncBusy} onClick={() => void resolve("remote")}>
                Accept remote
              </Button>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Export" subtitle="Writes a server-ready file through the local engine.">
        <Field label="File name">
          <TextInput
            value={draft.export.fileName}
            onChange={(fileName) => dispatch({ type: "patch", patch: { export: { ...draft.export, fileName } } })}
            mono
          />
        </Field>
        <Field label="Output folder" hint="Empty uses the workspace export folder">
          <TextInput
            value={draft.export.outputDir}
            onChange={(outputDir) => dispatch({ type: "patch", patch: { export: { ...draft.export, outputDir } } })}
            placeholder="/home/user/rust-maps"
            mono
          />
        </Field>
        <Toggle
          label="Strip editor data"
          description="Removes RustEdit and Rust Studio metadata from the vanilla layer."
          checked={draft.export.stripEditorData}
          onChange={(stripEditorData) =>
            dispatch({ type: "patch", patch: { export: { ...draft.export, stripEditorData } } })
          }
        />
        <div className="export-summary">
          <Stat label="Layers" value="terrain, water, splat, biome, topology, alpha" />
          <Stat label="Prefabs" value={draft.placements.length} />
          <Stat label="Splines" value={draft.splines.length} />
          <Stat label="Target" value={draft.projectKind === "monument" ? ".prefab" : ".map"} />
        </div>
        <Button variant="primary" full onClick={run} disabled={exporting || issues.some((issue) => issue.severity === "error")}>
          {exporting ? "Exporting" : draft.projectKind === "monument" ? "Export prefab" : "Export map"}
        </Button>
        {error && <p className="error-block">{error}</p>}
        {report && (
          <div className="report-block">
            <Badge tone="ok">Exported</Badge>
            <p className="mono-line">{report.path}</p>
            <p className="hint-block">{Math.round(report.bytes / 1024)} KiB / {new Date(report.createdAt).toLocaleString()}</p>
          </div>
        )}
      </Panel>

      {studio && (
        <StudioSection title="Map lock and metadata">
          <Toggle
            label="Map lock"
            description="Writes a PBKDF2 lock envelope and .map.lock sidecar; requires a password."
            checked={draft.export.mapLock}
            onChange={(mapLock) => dispatch({ type: "patch", patch: { export: { ...draft.export, mapLock } } })}
          />
          <Field label="Map password" hint="Stored offline, never synced in plain text">
            <TextInput
              value={draft.export.mapPassword}
              onChange={(mapPassword) =>
                dispatch({ type: "patch", patch: { export: { ...draft.export, mapPassword } } })
              }
              mono
              password
            />
          </Field>
          <p className="hint-block">
            Topology overlay bit layout: bit 24 no-build, 25 monument pad, 26 foliage cleared, 27 path clear, 28 loot
            zone, 29 NPC zone, 30 safe zone. The low bits are preserved untouched.
          </p>
        </StudioSection>
      )}
    </div>
  );
}
