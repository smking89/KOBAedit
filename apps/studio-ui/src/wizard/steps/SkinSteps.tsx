import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  browseMeshGroups,
  exportProject,
  getThumbnailData,
  isTauri,
  listGroupParts,
  loadLocalMeshBytes,
} from "../../lib/ipc";
import type { MeshGroupAsset, MeshPart } from "../../lib/ipc";
import { sharedThumbnailGenerator } from "../../utils/thumbnailGenerator";
import { skinThumbnailKey } from "../../utils/thumbnailQueue";
import { useWizard } from "../context";
import { createMaterialLayer } from "../machine";
import type { DecalStamp, DecalStroke, MaterialLayer, PaintMode, WearSettings } from "../types";

const RESOLUTIONS = [
  { id: 1024 as const, label: "1024", body: "Fast iteration, works on all items" },
  { id: 2048 as const, label: "2048", body: "Workshop standard for weapons and attire" },
];

function uid(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function BaseItemStep() {
  const { state, dispatch } = useWizard();
  const skin = state.draft.skin;
  const [groups, setGroups] = useState<MeshGroupAsset[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [parts, setParts] = useState<Record<string, MeshPart[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "weapon" | "attire" | "deployable">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      browseMeshGroups({ query, kind: filter, limit: 50 })
        .then((page) => {
          if (!live) return;
          setGroups(page.rows);
          setTotal(page.total);
          setExpanded(new Set());
          setParts({});
        })
        .catch((cause) => {
          if (!live) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setGroups([]);
          setTotal(0);
        })
        .finally(() => live && setLoading(false));
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, filter]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const page = await browseMeshGroups({
        query,
        kind: filter,
        limit: 50,
        offset: groups.length,
      });
      setGroups((current) => [...current, ...page.rows]);
      setTotal(page.total);
    } finally {
      setLoading(false);
    }
  };

  const generatingThumbs = useRef(new Set<string>());

  const generateThumb = useCallback(async (group: MeshGroupAsset) => {
    const stableKey = group.groupKey || group.id;
    if (generatingThumbs.current.has(stableKey)) return;
    generatingThumbs.current.add(stableKey);
    const grouped = group.partCount > 1;
    const key = skinThumbnailKey(grouped ? stableKey : group.previewPath);
    try {
      let data = await getThumbnailData(key, group.previewPath);
      if (!data && isTauri()) {
        const paths = grouped
          ? (await listGroupParts(stableKey)).map((part) => part.assetPath)
          : [group.previewPath];
        const loaded = await Promise.all(paths.slice(0, 12).map((path) => loadLocalMeshBytes(path)));
        const bytes = loaded.filter((entry): entry is Uint8Array => Boolean(entry));
        if (bytes.length) {
          const generator = sharedThumbnailGenerator();
          data = grouped
            ? await generator.generateGroupThumbnail(key, bytes)
            : await generator.generateSkinThumbnail(key, bytes[0], {});
        }
      }
      if (data) {
        setThumbnails((current) => (current[stableKey] === data ? current : { ...current, [stableKey]: data }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      generatingThumbs.current.delete(stableKey);
    }
  }, []);

  // Only render previews for cards that are near the visible list. Scrolling a
  // catalogue of ~20k groups must not queue thousands of GLB loads at once.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).dataset.thumbGroup;
          const group = groups.find((item) => item.id === id);
          if (group) {
            observer.unobserve(entry.target);
            void generateThumb(group);
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    document.querySelectorAll<HTMLElement>("[data-thumb-group]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [groups, generateThumb]);

  const loadParts = async (group: MeshGroupAsset): Promise<MeshPart[]> => {
    const stableKey = group.groupKey || group.id;
    if (parts[stableKey]) return parts[stableKey];
    try {
      const rows = await listGroupParts(stableKey);
      setParts((current) => ({ ...current, [stableKey]: rows }));
      return rows;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return [];
    }
  };

  const toggleGroup = async (group: MeshGroupAsset) => {
    const stableKey = group.groupKey || group.id;
    const next = new Set(expanded);
    if (next.has(stableKey)) next.delete(stableKey);
    else {
      next.add(stableKey);
      await loadParts(group);
    }
    setExpanded(next);
  };

  const selectGroup = async (group: MeshGroupAsset) => {
    const rows = group.partCount > 1 ? await loadParts(group) : [];
    const paths = rows.map((part) => part.assetPath);
    dispatch({
      type: "patchSkin",
      patch: {
        // A single mesh has no part list, so its id must be the loadable GLB
        // path; `group:<key>` ids are catalogue keys, not files.
        baseMeshId: paths.length ? group.id : group.previewPath || group.id,
        baseMeshName: group.name,
        baseMeshParts: paths.length ? paths : undefined,
        uvChannels: group.uvChannels,
      },
    });
    dispatch({
      type: "patch",
      patch: {
        export: { ...state.draft.export, fileName: slug(group.name) || state.draft.export.fileName },
      },
    });
  };

  const selectPart = (group: MeshGroupAsset, part: MeshPart) => {
    dispatch({
      type: "patchSkin",
      patch: {
        baseMeshId: part.assetPath,
        baseMeshName: part.name,
        baseMeshParts: [part.assetPath],
        uvChannels: group.uvChannels,
      },
    });
    dispatch({
      type: "patch",
      patch: {
        export: { ...state.draft.export, fileName: slug(part.name) || state.draft.export.fileName },
      },
    });
  };

  // Single-mesh groups are stored as their GLB path, multi-part ones as the
  // catalogue id, so both forms have to count as "this group is selected".
  const isChosen = (group: MeshGroupAsset) =>
    group.id === skin.baseMeshId || group.previewPath === skin.baseMeshId;
  const selected = groups.find(isChosen) ?? null;

  return (
    <div className="stack">
      <Panel title="Base item" subtitle={`${total.toLocaleString()} meshes in the local index`}>
        <TextInput value={query} onChange={setQuery} placeholder="Search weapons, attire, deployables" />
        <div className="chip-row">
          {(["all", "weapon", "attire", "deployable"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`chip${filter === kind ? " is-active" : ""}`}
              onClick={() => setFilter(kind)}
            >
              {kind}
            </button>
          ))}
        </div>
        {error && <p className="error-block">{error}</p>}
        <ul className="mesh-list">
          {groups.map((group) => {
            const stableKey = group.groupKey || group.id;
            const isOpen = expanded.has(stableKey);
            const children = parts[stableKey] ?? [];
            return (
              <li key={group.id} data-thumb-group={group.id}>
                <div className={`mesh-row${isChosen(group) ? " is-active" : ""}`}>
                  <button type="button" className="mesh-row-main" onClick={() => void selectGroup(group)}>
                    <img
                      className="mesh-row-thumb"
                      src={thumbnails[stableKey] ?? "/branding/koba-studios-icon.png"}
                      alt=""
                      loading="lazy"
                    />
                    <span>
                      <span className="placement-name">{group.name}</span>
                      <span className="placement-meta">
                        {group.itemKind} / {group.triangles.toLocaleString()} tris /{" "}
                        {group.partCount > 1 ? `${group.partCount} parts` : "single mesh"}
                      </span>
                    </span>
                    {isChosen(group) && <Badge tone="accent">Selected</Badge>}
                  </button>
                  {group.partCount > 1 && (
                    <button
                      type="button"
                      className="mesh-row-expand"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.name} parts`}
                      onClick={() => void toggleGroup(group)}
                    >
                      {isOpen ? "−" : "+"}
                    </button>
                  )}
                </div>
                {isOpen && children.length > 0 && (
                  <ul className="mesh-part-list">
                    {children.map((part) => (
                      <li key={part.assetPath}>
                        <button
                          type="button"
                          className={`mesh-row mesh-part-row${part.assetPath === skin.baseMeshId ? " is-active" : ""}`}
                          onClick={() => selectPart(group, part)}
                        >
                          <span>
                            <span className="placement-name">{part.name}</span>
                            <span className="placement-meta">part {part.partIndex + 1}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {groups.length < total && (
          <Button type="button" variant="ghost" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : `Load more (${(total - groups.length).toLocaleString()} left)`}
          </Button>
        )}
      </Panel>

      {selected && (
        <Panel title="UV layout" subtitle="Projection ignores seam placement; UVs still matter for textures.">
          <div className="stats-grid">
            <Stat label="UV channels" value={selected.uvChannels} />
            <Stat label="Triangles" value={selected.triangles.toLocaleString()} />
            <Stat label="Tangents" value={selected.hasTangents ? "Present" : "Generated"} />
            <Stat label="Material slots" value={selected.materialSlots.join(", ")} />
          </div>
          <Field label="Texture resolution" hint="Rust accepts 1024 and 2048 only">
            <SegmentedControl
              options={RESOLUTIONS.map((resolution) => ({ value: String(resolution.id), label: resolution.label }))}
              value={String(skin.resolution)}
              onChange={(value) =>
                dispatch({ type: "patchSkin", patch: { resolution: Number(value) as 1024 | 2048 } })
              }
            />
          </Field>
          {state.draft.studioMode && (
            <StudioSection title="Mesh diagnostics">
              <p className="hint-block">
                Source: {selected.id}. Tangents are generated on import when missing; UV seams are masked by
                world-space projection.
              </p>
            </StudioSection>
          )}
        </Panel>
      )}
    </div>
  );
}

const MATERIAL_PRESETS: { id: MaterialLayer["preset"]; label: string }[] = [
  { id: "metal", label: "Metal" },
  { id: "polymer", label: "Polymer" },
  { id: "wood", label: "Wood" },
  { id: "carbon", label: "Carbon fiber" },
  { id: "custom", label: "Custom" },
];

export function MaterialsStep() {
  const { state, dispatch } = useWizard();
  const skin = state.draft.skin;
  const studio = state.draft.studioMode;

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= skin.layers.length) return;
    const layers = [...skin.layers];
    const [layer] = layers.splice(index, 1);
    layers.splice(target, 0, layer);
    dispatch({ type: "patchSkin", patch: { layers } });
  };

  return (
    <div className="stack">
      <Panel title="Smart materials" subtitle="Procedural PBR layers applied in stack order.">
        <div className="chip-row">
          {MATERIAL_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="chip chip-add"
              onClick={() => dispatch({ type: "addMaterialLayer", preset: preset.id })}
            >
              + {preset.label}
            </button>
          ))}
        </div>

        {skin.layers.length === 0 ? (
          <EmptyState
            title="No material layers"
            body="Start with a base material such as painted metal, then add wear or polymer overlays. Edge wear and grunge are separate procedural inputs."
          />
        ) : (
          <ul className="layer-list">
            {skin.layers.map((layer, index) => (
              <li key={layer.id} className="layer-card">
                <div className="layer-head">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={layer.enabled}
                      onChange={(event) =>
                        dispatch({
                          type: "updateMaterialLayer",
                          id: layer.id,
                          patch: { enabled: event.target.checked },
                        })
                      }
                    />
                    <span>{layer.name}</span>
                  </label>
                  <div className="layer-actions">
                    <button type="button" className="icon-button" onClick={() => move(index, -1)} disabled={index === 0}>
                      Up
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => move(index, 1)}
                      disabled={index === skin.layers.length - 1}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => dispatch({ type: "removeMaterialLayer", id: layer.id })}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="layer-grid">
                  <Field label="Base color">
                    <div className="color-row">
                      <input
                        type="color"
                        value={layer.baseColor}
                        onChange={(event) =>
                          dispatch({
                            type: "updateMaterialLayer",
                            id: layer.id,
                            patch: { baseColor: event.target.value },
                          })
                        }
                      />
                      <span className="mono-line">{layer.baseColor}</span>
                    </div>
                  </Field>
                  <Field label="Texture" hint="Optional albedo override">
                    <input
                      className="file-input"
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          dispatch({
                            type: "updateMaterialLayer",
                            id: layer.id,
                            patch: { textureName: file.name },
                          });
                        }
                      }}
                    />
                  </Field>
                </div>
                <Slider
                  label="Metallic"
                  value={layer.metallic}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(metallic) =>
                    dispatch({ type: "updateMaterialLayer", id: layer.id, patch: { metallic } })
                  }
                  format={(value) => value.toFixed(2)}
                />
                <Slider
                  label="Smoothness"
                  value={layer.smoothness}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(smoothness) =>
                    dispatch({ type: "updateMaterialLayer", id: layer.id, patch: { smoothness } })
                  }
                  format={(value) => value.toFixed(2)}
                />
                {studio && (
                  <StudioSection title="Layer blending">
                    <Field label="Blend mode">
                      <select
                        className="select-input"
                        value={layer.blend}
                        onChange={(event) =>
                          dispatch({
                            type: "updateMaterialLayer",
                            id: layer.id,
                            patch: { blend: event.target.value as MaterialLayer["blend"] },
                          })
                        }
                      >
                        <option value="normal">Normal</option>
                        <option value="multiply">Multiply</option>
                        <option value="overlay">Overlay</option>
                      </select>
                    </Field>
                    <Slider
                      label="Projection scale"
                      value={layer.scale}
                      min={0.25}
                      max={4}
                      step={0.05}
                      onChange={(scale) =>
                        dispatch({ type: "updateMaterialLayer", id: layer.id, patch: { scale } })
                      }
                      format={(value) => `${value.toFixed(2)}x`}
                    />
                  </StudioSection>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

const STAMPS: { id: DecalStamp; label: string }[] = [
  { id: "stripe", label: "Stripe" },
  { id: "hazard", label: "Hazard" },
  { id: "circle", label: "Roundel" },
  { id: "number", label: "Number" },
  { id: "scratch", label: "Scratch" },
];

const PAINT_MODES: PaintMode[] = ["projected", "brush2d", "brush3d"];

export function PaintStep() {
  const { state, dispatch } = useWizard();
  const skin = state.draft.skin;
  const studio = state.draft.studioMode;
  const [stamp, setStamp] = useState<DecalStamp>("hazard");
  const [mode, setMode] = useState<PaintMode>("projected");
  const [color, setColor] = useState("#d7dde5");
  const [size, setSize] = useState(120);
  const [opacity, setOpacity] = useState(0.8);
  const [rotation, setRotation] = useState(0);

  const addDecal = () => {
    const decal: DecalStroke = {
      id: uid("decal"),
      stamp,
      mode,
      color,
      size,
      opacity,
      rotation,
      uvAnchor: mode === "brush2d" ? [0.5, 0.5] : null,
    };
    dispatch({ type: "addDecal", decal });
    dispatch({ type: "registerPaintStroke" });
  };

  return (
    <div className="stack">
      <Panel title="Projection paint" subtitle="World-space projection is independent of UV seams.">
        <SectionLabel>Stencil</SectionLabel>
        <div className="stamp-grid">
          {STAMPS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`stamp-card${stamp === item.id ? " is-active" : ""}`}
              onClick={() => setStamp(item.id)}
            >
              <span className={`stamp-preview stamp-${item.id}`} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="chip-row">
          {PAINT_MODES.map((paintMode) => (
            <button
              key={paintMode}
              type="button"
              className={`chip${mode === paintMode ? " is-active" : ""}`}
              onClick={() => setMode(paintMode)}
            >
              {paintMode === "brush2d" ? "2D brush" : paintMode === "brush3d" ? "3D brush" : "Projected"}
            </button>
          ))}
        </div>

        <div className="inline-row">
          <Field label="Color">
            <div className="color-row">
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              <span className="mono-line">{color}</span>
            </div>
          </Field>
          <Field label="Rotation" hint="Degrees">
            <NumberInput value={rotation} step={5} onChange={setRotation} />
          </Field>
        </div>
        <Slider label="Size" value={size} min={8} max={512} onChange={setSize} format={(value) => `${value} px`} />
        <Slider
          label="Opacity"
          value={opacity}
          min={0.05}
          max={1}
          step={0.05}
          onChange={setOpacity}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <Button variant="primary" full onClick={addDecal}>
          Add stencil stroke
        </Button>
        <p className="hint-block">
          Projected strokes capture the current camera orientation into a decal matrix. The mesh shader projects the
          stamp in world space and fades grazing angles, so UV stretches do not smear the stencil.
        </p>
      </Panel>

      <Panel title="Stroke history" subtitle={`${skin.decals.length} stencils / ${skin.paintStrokes} painted stamps`}>
        {skin.decals.length === 0 ? (
          <EmptyState title="Nothing painted yet" body="Add a stencil, then paint directly on the model in the viewport." />
        ) : (
          <ul className="decal-list">
            {skin.decals.map((decal) => (
              <li key={decal.id}>
                <span className="decal-swatch" style={{ background: decal.color }} />
                <span className="decal-copy">
                  <strong>{decal.stamp}</strong>
                  <em>
                    {decal.mode} / {decal.size}px / {Math.round(decal.opacity * 100)}%
                  </em>
                </span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => dispatch({ type: "removeDecal", id: decal.id })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {studio && (
        <StudioSection title="Projection options">
          <Toggle
            label="Smart seam masking"
            description="Fade projected stamps where the surface normal is perpendicular to the projector."
            checked={skin.smartProjection}
            onChange={(smartProjection) => dispatch({ type: "patchSkin", patch: { smartProjection } })}
          />
        </StudioSection>
      )}
    </div>
  );
}

const LIGHTING: { id: WearSettings["lighting"]; label: string; body: string }[] = [
  { id: "day", label: "Day", body: "Neutral sun, 6500 K" },
  { id: "dusk", label: "Dusk", body: "Warm rim, low angle" },
  { id: "flashlight", label: "Flashlight", body: "Point light at camera" },
  { id: "night", label: "Night", body: "Emission visibility check" },
];

export function WearStep() {
  const { state, dispatch } = useWizard();
  const skin = state.draft.skin;
  const wear = skin.wear;
  const patchWear = (patch: Partial<WearSettings>) => dispatch({ type: "patchSkinWear", patch });

  return (
    <div className="stack">
      <Panel title="Surface wear" subtitle="Procedurally masked, baked into the exported channels.">
        <Slider
          label="Edge wear"
          value={wear.edgeWear}
          min={0}
          max={1}
          step={0.01}
          onChange={(edgeWear) => patchWear({ edgeWear })}
          format={(value) => `${Math.round(value * 100)}%`}
          hint="Uses curvature and cavity approximations; no baked UV mask required."
        />
        <Slider
          label="Grunge"
          value={wear.grunge}
          min={0}
          max={1}
          step={0.01}
          onChange={(grunge) => patchWear({ grunge })}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <Slider
          label="Dirt"
          value={wear.dirt}
          min={0}
          max={1}
          step={0.01}
          onChange={(dirt) => patchWear({ dirt })}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <Slider
          label="Scratches"
          value={wear.scratches}
          min={0}
          max={1}
          step={0.01}
          onChange={(scratches) => patchWear({ scratches })}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <Slider
          label="Emission strength"
          value={wear.emissionStrength}
          min={0}
          max={4}
          step={0.05}
          onChange={(emissionStrength) => patchWear({ emissionStrength })}
          format={(value) => value.toFixed(2)}
          hint="Feeds the emission channel; visible in the night preset."
        />
      </Panel>

      <Panel title="Lighting checks" subtitle="Preview only; exports are unlit textures.">
        <div className="lighting-grid">
          {LIGHTING.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`lighting-card${wear.lighting === preset.id ? " is-active" : ""}`}
              onClick={() => patchWear({ lighting: preset.id })}
            >
              <strong>{preset.label}</strong>
              <em>{preset.body}</em>
            </button>
          ))}
        </div>
      </Panel>

      {state.draft.studioMode && (
        <StudioSection title="Diagnostics">
          <Toggle
            label="Show UV seams"
            description="Overlay seam lines to inspect distortion without projection."
            checked={wear.showSeams}
            onChange={(showSeams) => patchWear({ showSeams })}
          />
          <p className="hint-block">
            Wear is evaluated on world position and normal, so it stays consistent across UV islands. Night lighting
            multiplies emission by this mask.
          </p>
        </StudioSection>
      )}
    </div>
  );
}

const CHANNELS = [
  { id: "diffuse", suffix: "_diffuse.png", body: "Albedo plus baked wear and decals" },
  { id: "normal", suffix: "_normal.png", body: "Tangent space, OpenGL +Y" },
  { id: "specular", suffix: "_specular.png", body: "Smoothness in alpha" },
  { id: "emission", suffix: "_emission.png", body: "Emissive glow mask" },
];

export function WorkshopStep() {
  const { state, dispatch } = useWizard();
  const skin = state.draft.skin;
  const draft = state.draft;
  const studio = draft.studioMode;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const report = state.exportReport;

  const ready = useMemo(() => Boolean(skin.baseMeshId) && skin.layers.length > 0, [skin.baseMeshId, skin.layers.length]);

  const run = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const result = await exportProject(draft);
      dispatch({ type: "markSaved", at: new Date().toISOString(), report: result });
    } catch (exportError) {
      setExportError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="stack">
      <Panel title="Texture set" subtitle="Rust item skins export as square PNG channel files.">
        <div className="resolution-grid">
          {RESOLUTIONS.map((resolution) => (
            <button
              key={resolution.id}
              type="button"
              className={`resolution-card${skin.resolution === resolution.id ? " is-active" : ""}`}
              onClick={() => dispatch({ type: "patchSkin", patch: { resolution: resolution.id } })}
            >
              <strong>{resolution.label} px</strong>
              <em>{resolution.body}</em>
            </button>
          ))}
        </div>
        <ul className="channel-list">
          {CHANNELS.map((channel) => (
            <li key={channel.id}>
              <span className="channel-name">{channel.id}</span>
              <span className="mono-line">
                {draft.export.fileName || "skin"}
                {channel.suffix}
              </span>
              <span className="channel-body">{channel.body}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Workshop metadata">
        <Field label="Export name" hint="Used as the PNG prefix">
          <TextInput
            value={draft.export.fileName}
            onChange={(fileName) => dispatch({ type: "patch", patch: { export: { ...draft.export, fileName } } })}
            mono
          />
        </Field>
        <Field label="Tags" hint="Comma separated">
          <TextInput
            value={draft.export.workshopTags.join(", ")}
            onChange={(value) =>
              dispatch({
                type: "patch",
                patch: {
                  export: {
                    ...draft.export,
                    workshopTags: value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  },
                },
              })
            }
          />
        </Field>
        <Toggle
          label="Include emission channel"
          description="Required for any glowing skin detail."
          checked={draft.export.includeEmission}
          onChange={(includeEmission) =>
            dispatch({ type: "patch", patch: { export: { ...draft.export, includeEmission } } })
          }
        />
        <div className="export-summary">
          <Stat label="Base item" value={skin.baseMeshName || "Not selected"} />
          <Stat label="Layers" value={skin.layers.length} />
          <Stat label="Stencils" value={skin.decals.length} />
          <Stat label="Resolution" value={`${skin.resolution} x ${skin.resolution}`} />
        </div>
        <Button variant="primary" full onClick={run} disabled={exporting || !ready}>
          {exporting ? "Packing textures" : "Export Workshop set"}
        </Button>
        {!ready && <p className="hint-block">Pick a base item and at least one material layer first.</p>}
        {exportError && <p className="error-block">{exportError}</p>}
        {report && (
          <div className="report-block">
            <Badge tone="ok">Export complete</Badge>
            <p className="mono-line">{report.path}</p>
            <p className="hint-block">
              {report.channels?.join(", ")} / {Math.round(report.bytes / 1024)} KiB
            </p>
          </div>
        )}
      </Panel>

      {studio && (
        <StudioSection title="Channel packing">
          <p className="hint-block">
            Diffuse carries baked decals. Specular stores smoothness in alpha; the preview shader reads it directly.
            Normal maps are generated from height detail when no custom normal is supplied.
          </p>
          <Field label="Output folder">
            <TextInput
              value={draft.export.outputDir}
              onChange={(outputDir) => dispatch({ type: "patch", patch: { export: { ...draft.export, outputDir } } })}
              placeholder="data/exports"
              mono
            />
          </Field>
        </StudioSection>
      )}
    </div>
  );
}
