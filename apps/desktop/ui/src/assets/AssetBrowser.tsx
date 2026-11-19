import { useEffect, useMemo, useRef, useState } from "react";

import { demoMode, indexStats, listBaseMeshes, listPrefabs } from "../lib/ipc";
import type { BaseMeshAsset } from "../lib/demoAssets";
import { flattenRadiusFromBounds } from "../wizard/machine";
import type { PrefabAsset } from "../wizard/types";

const PAGE_SIZE = 200;
const CATEGORIES = ["All", "Monument", "Building", "Decor", "Vehicle", "Entity", "Other"] as const;

function boundsLabel(prefab: PrefabAsset): string {
  const [minX, minY, minZ] = prefab.bounds.min;
  const [maxX, maxY, maxZ] = prefab.bounds.max;
  const width = maxX - minX;
  const height = maxY - minY;
  const depth = maxZ - minZ;
  if (width <= 0 && height <= 0 && depth <= 0) return "Bounds not indexed";
  return `${Math.round(width)} x ${Math.round(height)} x ${Math.round(depth)} m`;
}

function padRadius(prefab: PrefabAsset): number {
  return prefab.flattenRadius || flattenRadiusFromBounds(prefab.bounds, 0);
}

export function AssetBrowser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"prefabs" | "meshes">("prefabs");
  const [prefabs, setPrefabs] = useState<PrefabAsset[]>([]);
  const [meshes, setMeshes] = useState<BaseMeshAsset[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexed, setIndexed] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const demo = useMemo(() => demoMode(), []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 120);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listPrefabs(), listBaseMeshes(), indexStats()])
      .then(([prefabRows, meshRows, stats]) => {
        if (cancelled) return;
        setPrefabs(prefabRows);
        setMeshes(meshRows);
        setIndexed(stats.indexed);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filteredPrefabs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return prefabs.filter((prefab) => {
      if (category !== "All" && prefab.category !== category) return false;
      if (!needle) return true;
      return `${prefab.name} ${prefab.id}`.toLowerCase().includes(needle);
    });
  }, [prefabs, query, category]);

  const filteredMeshes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return meshes;
    return meshes.filter((mesh) =>
      `${mesh.name} ${mesh.id} ${mesh.itemKind} ${mesh.materialSlots.join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  }, [meshes, query]);

  const rows = tab === "prefabs" ? filteredPrefabs.slice(0, PAGE_SIZE) : filteredMeshes.slice(0, PAGE_SIZE);
  const total = tab === "prefabs" ? filteredPrefabs.length : filteredMeshes.length;
  const bounded = prefabs.filter((prefab) => boundsLabel(prefab) !== "Bounds not indexed").length;

  return (
    <>
      {open && <div className="asset-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside
        className={`asset-panel${open ? " is-open" : ""}`}
        aria-label="Indexed asset browser"
        aria-hidden={!open}
      >
        <header className="asset-head">
          <div>
            <p className="asset-eyebrow">Local asset index</p>
            <h2>Assets</h2>
          </div>
          <button type="button" className="asset-close" onClick={onClose} aria-label="Close asset browser">
            Close
          </button>
        </header>

        <div className="asset-tabs" role="tablist" aria-label="Asset kinds">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "prefabs"}
            className={tab === "prefabs" ? "is-active" : ""}
            onClick={() => setTab("prefabs")}
          >
            Prefabs <span>{prefabs.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "meshes"}
            className={tab === "meshes" ? "is-active" : ""}
            onClick={() => setTab("meshes")}
          >
            Base meshes <span>{meshes.length}</span>
          </button>
        </div>

        <div className="asset-filters">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "prefabs" ? "Search prefab name or path" : "Search mesh, kind or material"}
            aria-label="Search indexed assets"
          />
          {tab === "prefabs" && (
            <div className="asset-chips" aria-label="Prefab category">
              {CATEGORIES.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={category === entry ? "is-active" : ""}
                  onClick={() => setCategory(entry)}
                >
                  {entry}
                </button>
              ))}
            </div>
          )}
          <p className="asset-summary">
            {demo ? "Demo catalogue" : indexed ? "SQLite index" : "Index is empty; demo catalogue shown"} /
            {" "}{total} matches{tab === "prefabs" ? ` / ${bounded} with bounds` : ""}
          </p>
        </div>

        <div className="asset-list" role="tabpanel">
          {loading && <p className="asset-state">Loading local index...</p>}
          {error && <p className="asset-state is-error">{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="asset-state">No assets match this filter.</p>
          )}
          {!loading && tab === "prefabs" &&
            (rows as PrefabAsset[]).map((prefab) => {
              const pad = padRadius(prefab);
              return (
              <article className="asset-card" key={prefab.id}>
                <span className={`asset-mark is-${prefab.category.toLowerCase()}`} aria-hidden="true">
                  {prefab.category.slice(0, 1)}
                </span>
                <div className="asset-body">
                  <div className="asset-title">
                    <strong>{prefab.name}</strong>
                    <span>{prefab.category}</span>
                  </div>
                  <code>{prefab.id}</code>
                  <div className="asset-meta">
                    <span>{boundsLabel(prefab)}</span>
                    {pad > 0 && <span>pad {Math.round(pad)} m</span>}
                    {prefab.hasLoot && <span>loot</span>}
                    {prefab.hasIO && <span>IO</span>}
                    {prefab.hasNpc && <span>NPC</span>}
                  </div>
                </div>
              </article>
              );
            })}
          {!loading && tab === "meshes" &&
            (rows as BaseMeshAsset[]).map((mesh) => (
              <article className="asset-card" key={mesh.id}>
                <span className="asset-mark is-mesh" aria-hidden="true">
                  M
                </span>
                <div className="asset-body">
                  <div className="asset-title">
                    <strong>{mesh.name}</strong>
                    <span>{mesh.itemKind}</span>
                  </div>
                  <code>{mesh.id}</code>
                  <div className="asset-meta">
                    <span>{mesh.triangles.toLocaleString()} tris</span>
                    <span>{mesh.uvChannels} UV</span>
                    <span>{mesh.hasTangents ? "tangents" : "no tangents"}</span>
                    {mesh.materialSlots.slice(0, 2).map((slot) => (
                      <span key={slot}>{slot}</span>
                    ))}
                  </div>
                </div>
              </article>
            ))}
        </div>

        <footer className="asset-foot">
          {total > PAGE_SIZE ? `Showing ${PAGE_SIZE} of ${total}. Narrow the search to see more.` : "Read-only view of the local index."}
        </footer>
      </aside>
    </>
  );
}
