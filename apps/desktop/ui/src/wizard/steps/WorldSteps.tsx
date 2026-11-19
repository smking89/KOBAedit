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
import { exportProject, listPrefabs } from "../../lib/ipc";
import { useWizard } from "../context";
import { STEP_META, createPlacement, validateDraft } from "../machine";
import type {
  BrushMode,
  PrefabAsset,
  SplatChannel,
  SplineKind,
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
const TOPOLOGY_FLAGS: TopologyFlag[] = ["no_build", "monument_pad", "foliage_cleared", "path_clear"];

export function TerrainStep() {
  const { state, dispatch } = useWizard();
  const terrain = state.draft.terrain;
  const studio = state.draft.studioMode;

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
          <p className="hint-block">
            Drag on the terrain to apply the active brush. Strokes: {terrain.sculptStrokes}. Flatten uses the average
            height under the cursor, matching the engine kernel.
          </p>
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

          {terrain.brush.mode === "splat" && (
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

          {terrain.brush.mode === "topology" && (
            <div className="check-list">
              {TOPOLOGY_FLAGS.map((flag) => (
                <label key={flag} className="check-row">
                  <input
                    type="checkbox"
                    checked={terrain.brush.topologyFlags.includes(flag)}
                    onChange={(event) => {
                      const flags = event.target.checked
                        ? [...terrain.brush.topologyFlags, flag]
                        : terrain.brush.topologyFlags.filter((value) => value !== flag);
                      dispatch({
                        type: "patchTerrain",
                        patch: { brush: { ...terrain.brush, topologyFlags: flags } },
                      });
                    }}
                  />
                  <span>{flag.replace(/_/g, " ")}</span>
                </label>
              ))}
            </div>
          )}
        </StudioSection>
      )}
    </div>
  );
}

export function MonumentsStep() {
  const { state, dispatch } = useWizard();
  const [catalog, setCatalog] = useState<PrefabAsset[]>([]);
  const [filter, setFilter] = useState<string>("All");
  const [query, setQuery] = useState("");
  const studio = state.draft.studioMode;
  const selected = state.draft.placements.find((placement) => placement.id === state.draft.selectedPlacementId) ?? null;

  useEffect(() => {
    listPrefabs()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(catalog.map((asset) => asset.category)))],
    [catalog],
  );
  const visible = catalog.filter(
    (asset) =>
      (filter === "All" || asset.category === filter) &&
      (!query || asset.name.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <div className="stack">
      <Panel title="Prefab library" subtitle={`${catalog.length} prefabs in the local index`}>
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
            </button>
          ))}
        </div>
        <div className="asset-grid">
          {visible.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className="asset-card"
              onClick={() => dispatch({ type: "addPlacement", asset })}
              title={`Place ${asset.name}`}
            >
              <span className="asset-thumb">
                <span className="asset-thumb-axis" />
                <span className="asset-thumb-label">{asset.category.slice(0, 3).toUpperCase()}</span>
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
  { id: "apc", label: "APC route" },
  { id: "cargo", label: "Cargo path" },
  { id: "powerline", label: "Powerline" },
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

const TIERS = [
  { id: 1 as const, label: "Tier 1", body: "Low value crates, no card puzzles, light NPC presence." },
  { id: 2 as const, label: "Tier 2", body: "Standard monument loot, green/blue cards, moderate NPCs." },
  { id: 3 as const, label: "Tier 3", body: "Elite crates, full card puzzle chain, heavy NPC coverage." },
];

export function LootStep() {
  const { state, dispatch } = useWizard();
  const loot = state.draft.loot;
  const studio = state.draft.studioMode;
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
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = state.exportReport;

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
            description="Serializes a lock into the RustEdit metadata; requires a password."
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
