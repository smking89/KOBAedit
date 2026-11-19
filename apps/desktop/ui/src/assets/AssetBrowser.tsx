import { useEffect, useMemo, useRef, useState } from "react";

import {
  browsePrefabs,
  cancelBundleScan,
  demoMode,
  findRustInstall,
  getBaseMeshThumbnail,
  getThumbnailData,
  indexStats,
  linkedBundleRoot,
  listBaseMeshes,
  loadLinkedBundleRoot,
  pickBundleFolder,
  renderMonumentPreviews,
  scanRustBundles,
  setLinkedBundleRoot,
  type TaskProgress,
} from "../lib/ipc";
import type { BaseMeshAsset } from "../lib/demoAssets";
import { flattenRadiusFromBounds } from "../wizard/machine";
import type { PrefabAsset, ProjectKind } from "../wizard/types";
import {
  prefabThumbnailHash,
  prefabThumbnailItem,
  runBackgroundThumbnailBatch,
  skinThumbnailKey,
} from "../utils/thumbnailQueue";
import { AssetTurntable, SkinTurntable } from "./AssetTurntable";
import { previewPlaceholder } from "./previewPlaceholder";
import { PREFAB_MIME, endPrefabDrag, startPrefabDrag } from "../lib/prefabDrag";

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

export function AssetBrowser({
  open,
  onClose,
  mode = "map",
}: {
  open: boolean;
  onClose: () => void;
  /** Workspace tab: the tray opens on the asset type that mode uses. */
  mode?: ProjectKind;
}) {
  const defaultTab = (kind: ProjectKind) =>
    kind === "skin" ? "skins" : kind === "monument" ? "monuments" : "prefabs";
  const [tab, setTab] = useState<"prefabs" | "monuments" | "skins">(defaultTab(mode));
  const [prefabs, setPrefabs] = useState<PrefabAsset[]>([]);
  const [meshes, setMeshes] = useState<BaseMeshAsset[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [pageTotal, setPageTotal] = useState(0);
  const [bounded, setBounded] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(false);

  // Keep the tray aligned with the active workspace tab.
  useEffect(() => {
    setTab(defaultTab(mode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  const [error, setError] = useState<string | null>(null);
  const [indexed, setIndexed] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [unavailable, setUnavailable] = useState<Record<string, boolean>>({});
  const [bundleRoot, setBundleRoot] = useState(() => linkedBundleRoot());
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<TaskProgress | null>(null);
  const [bundleMessage, setBundleMessage] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
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
    const timer = window.setTimeout(() => setSearchTerm(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // The shell persists the linked folder in the project database; the webview
    // may start without its localStorage copy (fresh install, cleared profile).
    void loadLinkedBundleRoot().then((root) => {
      if (!cancelled && root) setBundleRoot(root);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([listBaseMeshes(), indexStats()])
      .then(([meshRows, stats]) => {
        if (cancelled) return;
        setMeshes(meshRows);
        setIndexed(stats.indexed);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshTick]);

  // One filtered page from SQLite instead of the whole 17.5k-row catalogue.
  // "Load more" advances the offset so the catalogue is browsable, not just
  // searchable: the header counts every indexed prefab.
  const filterKey = `${tab}|${category}|${searchTerm}|${refreshTick}`;
  const [paging, setPaging] = useState({ key: filterKey, pages: 1 });
  const pages = paging.key === filterKey ? paging.pages : 1;

  useEffect(() => {
    if (!open || tab === "skins") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const requested =
      tab === "monuments" ? "Monument" : category === "All" ? undefined : category;
    browsePrefabs({
      category: requested,
      query: searchTerm,
      limit: PAGE_SIZE,
      offset: (pages - 1) * PAGE_SIZE,
    })
      .then((page) => {
        if (cancelled) return;
        setPrefabs((current) => {
          if (pages === 1) return page.rows;
          const seen = new Set(current.map((row) => row.id));
          return [...current, ...page.rows.filter((row) => !seen.has(row.id))];
        });
        setCounts(page.counts);
        setPageTotal(page.total);
        setBounded(page.bounded);
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
  }, [open, tab, category, searchTerm, refreshTick, pages]);

  const catalogueTotal = useMemo(
    () => Object.values(counts).reduce((sum, value) => sum + value, 0),
    [counts],
  );
  const monumentCount = counts.Monument ?? 0;

  const filteredMeshes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return meshes;
    return meshes.filter((mesh) =>
      `${mesh.name} ${mesh.id} ${mesh.itemKind} ${mesh.materialSlots.join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  }, [meshes, query]);

  const activePrefabs = prefabs;
  const rows = tab === "skins" ? filteredMeshes.slice(0, pages * PAGE_SIZE) : activePrefabs;
  const total = tab === "skins" ? filteredMeshes.length : pageTotal;

  useEffect(() => {
    if (!open || tab === "skins" || !activePrefabs.length) return;
    let cancelled = false;
    const start = Math.max(0, (pages - 1) * PAGE_SIZE);
    const visible = activePrefabs.slice(start, start + PAGE_SIZE).map(prefabThumbnailItem);
    void runBackgroundThumbnailBatch(visible, {
      cancelled: () => cancelled,
      // Monument scenes ship no extractable mesh in these bundles, so skip the
      // expensive auto pass; "Render real preview" still tries on demand.
      maxExtract: tab === "monuments" ? 0 : 6,
      onThumbnail: (hash, dataUrl) => {
        if (cancelled) return;
        setThumbnails((current) =>
          current[hash] === dataUrl ? current : { ...current, [hash]: dataUrl },
        );
      },
      onExtractionFailed: (hash) => {
        if (cancelled) return;
        setUnavailable((current) => (current[hash] ? current : { ...current, [hash]: true }));
      },
    });
    return () => {
      cancelled = true;
    };
  }, [open, tab, pages, activePrefabs]);

  useEffect(() => {
    if (!open || tab !== "skins" || !meshes.length) return;
    let cancelled = false;
    for (const mesh of meshes.slice(0, PAGE_SIZE)) {
      const key = skinThumbnailKey(mesh.id);
      void getThumbnailData(key)
        .then((data) => data ?? getBaseMeshThumbnail(mesh.id))
        .then((data) => {
          if (cancelled || !data) return;
          setThumbnails((current) =>
            current[key] === data ? current : { ...current, [key]: data },
          );
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [open, tab, meshes]);

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
            Prefabs <span>{catalogueTotal}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "monuments"}
            className={tab === "monuments" ? "is-active" : ""}
            onClick={() => setTab("monuments")}
          >
            Monuments <span>{monumentCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "skins"}
            className={tab === "skins" ? "is-active" : ""}
            onClick={() => setTab("skins")}
          >
            Skin bases <span>{meshes.length}</span>
          </button>
        </div>

        <div className="asset-bundles">
          <div className="asset-bundles-row">
            <span className={`asset-bundles-dot${bundleRoot ? " is-linked" : ""}`} aria-hidden="true" />
            <code title={bundleRoot || "No Bundles folder linked"}>
              {bundleRoot || "No Bundles folder linked"}
            </code>
          </div>
          <div className="asset-bundles-actions">
            <button
              type="button"
              className="asset-refresh"
              onClick={() => {
                void pickBundleFolder()
                  .then((path) => {
                    if (!path) return;
                    setBundleRoot(path);
                    setLinkedBundleRoot(path);
                    setBundleMessage("Bundles linked. Scan to index monuments and render real previews.");
                  })
                  .catch((cause) =>
                    setBundleMessage(cause instanceof Error ? cause.message : String(cause)),
                  );
              }}
            >
              Browse…
            </button>
            <button
              type="button"
              className="asset-refresh"
              disabled={!bundleRoot || scanning}
              onClick={() => {
                if (!bundleRoot) return;
                setScanning(true);
                setScanProgress(null);
                setBundleMessage(null);
                void (async () => {
                  const install = await findRustInstall(bundleRoot);
                  if (!install.found) {
                    throw new Error("No .bundle files were found in that folder.");
                  }
                  setLinkedBundleRoot(install.root);
                  setBundleRoot(install.root);
                  const report = await scanRustBundles(install.root, (last) =>
                    setScanProgress(last),
                  );
                  setThumbnails({});
                  setUnavailable({});
                  const previews = await renderMonumentPreviews(install.root).catch(() => null);
                  setRefreshTick((value) => value + 1);
                  setBundleMessage(
                    `Indexed ${report.prefabs} prefabs and ${report.assets} assets from ${report.bundles} bundles.` +
                      (previews
                        ? ` Rendered ${previews.rendered} of ${previews.monuments} monument previews.`
                        : ""),
                  );
                })()
                  .catch((cause) =>
                    setBundleMessage(cause instanceof Error ? cause.message : String(cause)),
                  )
                  .finally(() => {
                    setScanning(false);
                    setScanProgress(null);
                  });
              }}
            >
              {scanning ? "Scanning…" : "Link & scan"}
            </button>
            <button
              type="button"
              className="asset-refresh"
              disabled={!bundleRoot || scanning}
              title="Render each monument's terrain height map into the preview cache"
              onClick={() => {
                if (!bundleRoot) return;
                setBundleMessage("Rendering monument previews from terrain masks…");
                void renderMonumentPreviews(bundleRoot)
                  .then((report) => {
                    setThumbnails({});
                    setRefreshTick((value) => value + 1);
                    setBundleMessage(
                      `Rendered ${report.rendered} of ${report.monuments} monument previews.`,
                    );
                  })
                  .catch((cause) =>
                    setBundleMessage(cause instanceof Error ? cause.message : String(cause)),
                  );
              }}
            >
              Monument previews
            </button>
            {scanning && (
              <button type="button" className="asset-refresh" onClick={() => void cancelBundleScan()}>
                Cancel
              </button>
            )}
          </div>
          {(bundleMessage || scanProgress) && (
            <p className="asset-bundles-status">
              {scanProgress
                ? `${scanProgress.stage}: ${scanProgress.message}${
                    scanProgress.total > 0 ? ` (${scanProgress.current}/${scanProgress.total})` : ""
                  }`
                : bundleMessage}
            </p>
          )}
        </div>

        <div className="asset-filters">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "skins" ? "Search mesh, kind or material" : "Search prefab name or path"}
            aria-label="Search indexed assets"
          />
          {tab !== "skins" && (
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
            {" "}{total} matches{tab !== "skins" ? ` / ${bounded} with bounds` : ""}
          </p>
          <button type="button" className="asset-refresh" onClick={() => setRefreshTick((value) => value + 1)}>
            Refresh bounds
          </button>
        </div>

        <div className="asset-list" role="tabpanel">
          {loading && <p className="asset-state">Loading local index...</p>}
          {error && <p className="asset-state is-error">{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="asset-state">No assets match this filter.</p>
          )}
          {!loading && tab !== "skins" &&
            (rows as PrefabAsset[]).map((prefab) => {
              const pad = padRadius(prefab);
              const hash = prefabThumbnailHash(prefab.id);
              return (
              <article
                className="asset-card"
                key={prefab.id}
                draggable
                title={`Drag ${prefab.name} onto the terrain`}
                onDragStart={(event) => {
                  startPrefabDrag(prefab);
                  event.dataTransfer.setData(PREFAB_MIME, prefab.id);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={endPrefabDrag}
                onMouseEnter={() => setHovered(prefab.id)}
                onMouseLeave={() => setHovered((current) => (current === prefab.id ? null : current))}
              >
                {thumbnails[hash] ? (
                  <img className="asset-thumb-img" src={thumbnails[hash]} alt="" loading="lazy" />
                ) : (
                  <img
                    className="asset-thumb-img is-placeholder"
                    src={previewPlaceholder(prefab.category, prefab.bounds)}
                    alt=""
                    aria-hidden="true"
                  />
                )}
                <div className="asset-body">
                  <div className="asset-title">
                    <strong>{prefab.name}</strong>
                    <span>{prefab.category}</span>
                  </div>
                  <code>{prefab.id}</code>
                  <div className="asset-meta">
                    <span>{boundsLabel(prefab)}</span>
                    <span className={boundsLabel(prefab) === "Bounds not indexed" ? "is-proxy" : "is-native"}>
                      {boundsLabel(prefab) === "Bounds not indexed" ? "Proxy bounds" : "Native bounds"}
                    </span>
                    {pad > 0 && <span>pad {Math.round(pad)} m</span>}
                    {prefab.hasLoot && <span>loot</span>}
                    {prefab.hasIO && <span>IO</span>}
                    {prefab.hasNpc && <span>NPC</span>}
                    {unavailable[hash] && <span className="is-proxy">no extractable geometry</span>}
                  </div>
                </div>
                {hovered === prefab.id && <AssetTurntable prefab={prefab} />}
              </article>
              );
            })}
          {!loading && tab === "skins" &&
            (rows as BaseMeshAsset[]).map((mesh) => (
              <article
                className="asset-card"
                key={mesh.id}
                onMouseEnter={() => setHovered(mesh.id)}
                onMouseLeave={() => setHovered((current) => (current === mesh.id ? null : current))}
              >
                {thumbnails[skinThumbnailKey(mesh.id)] ? (
                  <img
                    className="asset-thumb-img"
                    src={thumbnails[skinThumbnailKey(mesh.id)]}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <img
                    className="asset-thumb-img is-placeholder"
                    src={previewPlaceholder("Entity", { min: [-1, -0.4, -0.2], max: [1, 0.4, 0.2] })}
                    alt=""
                    aria-hidden="true"
                  />
                )}
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
                {hovered === mesh.id && <SkinTurntable mesh={mesh} />}
              </article>
            ))}
        </div>

        <footer className="asset-foot">
          {tab !== "skins" && prefabs.length < pageTotal && (
            <button
              type="button"
              className="asset-refresh"
              disabled={loading}
              onClick={() => setPaging({ key: filterKey, pages: pages + 1 })}
            >
              {loading ? "Loading…" : `Load ${Math.min(PAGE_SIZE, pageTotal - prefabs.length)} more`}
            </button>
          )}
          <span>
            {rows.length < total
              ? `Showing ${rows.length} of ${total}. Drag a card onto the terrain to place it.`
              : "Drag a card onto the terrain to place it. Read-only view of the local index."}
          </span>
        </footer>
      </aside>
    </>
  );
}
