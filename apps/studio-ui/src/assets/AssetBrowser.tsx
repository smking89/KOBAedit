import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import {
  browseMeshGroups,
  browsePlaceableMeshes,
  browsePrefabs,
  cancelBundleScan,
  demoMode,
  findRustInstall,
  getBaseMeshThumbnail,
  getThumbnailData,
  indexStats,
  isTauri,
  linkedBundleRoot,
  listGroupParts,
  loadLinkedBundleRoot,
  loadLocalMeshBytes,
  renderMonumentPreviews,
  scanRustBundles,
  setLinkedBundleRoot,
  type TaskProgress,
} from "../lib/ipc";
import type { BaseMeshAsset } from "../lib/demoAssets";
import type { MeshGroupAsset, MeshPart } from "../lib/ipc";
import { flattenRadiusFromBounds } from "../wizard/machine";
import type { PrefabAsset, ProjectKind } from "../wizard/types";
import {
  prefabThumbnailHash,
  prefabThumbnailItem,
  runBackgroundThumbnailBatch,
  skinThumbnailKey,
} from "../utils/thumbnailQueue";
import { sharedThumbnailGenerator, type OffscreenThumbnailGenerator } from "../utils/thumbnailGenerator";
import { requestThumbnail } from "../utils/thumbnailRequests";
import { runThumbnailQueue } from "../utils/thumbnailQueueRunner";
import { previewPlaceholder } from "./previewPlaceholder";

/**
 * The card and the generator must agree on one preview key. Multi-part groups
 * are keyed by their catalogue group, single meshes by the GLB the card
 * renders; keying them differently leaves every single-mesh card blank.
 */
function groupThumbnailKey(group: MeshGroupAsset): string {
  const stable = group.groupKey || group.id;
  return skinThumbnailKey(group.partCount > 1 ? stable : group.previewPath || stable);
}
import { FolderPicker } from "../components/FolderPicker";
import {
  LOCAL_MESH_MIME,
  PREFAB_MIME,
  endLocalMeshDrag,
  endPrefabDrag,
  startLocalMeshDrag,
  startPrefabDrag,
} from "../lib/prefabDrag";

const PAGE_SIZE = 50;
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
  onPlaceLocal,
  mode = "map",
}: {
  open: boolean;
  onClose: () => void;
  /** Click-to-place fallback for local GLBs (the prefab cards already have one). */
  onPlaceLocal?: (mesh: BaseMeshAsset) => void;
  /** Workspace tab: the tray opens on the asset type that mode uses. */
  mode?: ProjectKind;
}) {
  const defaultTab = (kind: ProjectKind) =>
    kind === "skin" ? "skins" : kind === "monument" ? "monuments" : "prefabs";
  const [tab, setTab] = useState<"prefabs" | "monuments" | "skins" | "local">(defaultTab(mode));
  const [prefabs, setPrefabs] = useState<PrefabAsset[]>([]);
  const [meshGroups, setMeshGroups] = useState<MeshGroupAsset[]>([]);
  const [meshTotal, setMeshTotal] = useState(0);
  const [meshPages, setMeshPages] = useState(1);
  const [meshParts, setMeshParts] = useState<Record<string, MeshPart[]>>({});
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
  const [refreshTick, setRefreshTick] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [localRows, setLocalRows] = useState<BaseMeshAsset[]>([]);
  const [localTotal, setLocalTotal] = useState(0);
  const [localCursor, setLocalCursor] = useState<number | null>(0);
  const [localLoading, setLocalLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
    void loadLinkedBundleRoot()
      .then((root) => {
        if (!cancelled && root) setBundleRoot(root);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    indexStats()
      .then((stats) => {
        if (!cancelled) setIndexed(stats.indexed);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshTick]);

  // Grouping and paging happen in SQLite. Only one page of groups reaches the
  // webview, so a 30k-mesh catalogue never becomes 30k React elements.
  useEffect(() => {
    if (!open || tab !== "skins") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    browseMeshGroups({ query: searchTerm, limit: 50, offset: (meshPages - 1) * 50 })
      .then((page) => {
        if (cancelled) return;
        setMeshGroups((current) => {
          if (meshPages === 1) return page.rows;
          const seen = new Set(current.map((row) => row.id));
          return [...current, ...page.rows.filter((row) => !seen.has(row.id))];
        });
        setMeshTotal(page.total);
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
  }, [open, tab, searchTerm, refreshTick, meshPages]);

  useEffect(() => {
    setMeshPages(1);
  }, [searchTerm, refreshTick]);

  // One filtered page from SQLite instead of the whole 17.5k-row catalogue.
  // "Load more" advances the offset so the catalogue is browsable, not just
  // searchable: the header counts every indexed prefab.
  const filterKey = `${tab}|${category}|${searchTerm}|${refreshTick}`;
  const [paging, setPaging] = useState({ key: filterKey, pages: 1 });
  const pages = paging.key === filterKey ? paging.pages : 1;

  useEffect(() => {
    if (!open || tab === "skins" || tab === "local") return;
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

  const activePrefabs = prefabs;
  const rows = activePrefabs;
  const visibleGroups = meshGroups;
  const shownCount = tab === "skins" ? visibleGroups.length : rows.length;
  const total = tab === "skins" ? meshTotal : pageTotal;

  useEffect(() => {
    if (!open || tab !== "local") return;
    let live = true;
    setLocalLoading(true);
    browsePlaceableMeshes({ query: searchTerm, limit: 50 })
      .then((page) => {
        if (!live) return;
        setLocalRows(page.rows);
        setLocalTotal(page.total);
        setLocalCursor(page.nextCursor);
      })
      .catch((cause) => {
        if (!live) return;
        setLocalRows([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => live && setLocalLoading(false));
    return () => {
      live = false;
    };
  }, [open, tab, searchTerm, refreshTick]);

  const loadMoreLocal = async () => {
    if (localCursor == null) return;
    setLocalLoading(true);
    try {
      const page = await browsePlaceableMeshes({ query: searchTerm, cursor: localCursor, limit: 50 });
      setLocalRows((current) => [...current, ...page.rows]);
      setLocalCursor(page.nextCursor);
    } finally {
      setLocalLoading(false);
    }
  };

  const loadGroupParts = async (group: MeshGroupAsset) => {
    const key = group.groupKey || group.id;
    if (meshParts[key]) return;
    try {
      const rows = await listGroupParts(key);
      setMeshParts((current) => ({ ...current, [key]: rows }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Previews are built for the page of rows that is loaded, never for the whole
  // catalogue, so opening Assets cannot queue 20k GLB reads.
  useEffect(() => {
    if (!open) return;
    const root = listRef.current;
    if (!root) return;
    let cancelled = false;
    let generator: OffscreenThumbnailGenerator;
    try {
      generator = sharedThumbnailGenerator();
    } catch {
      return;
    }
    const groupByKey = new Map(
      meshGroups.map((group) => [group.groupKey || group.id, group]),
    );
    // Previews are requested for the rows of the page that is actually loaded,
    // two at a time. WebKit stops delivering IntersectionObserver callbacks for
    // this scroll container after the first few pages, which left every later
    // card blank with no error anywhere.
    const loadThumbnailFor = async (node: HTMLElement): Promise<void> => {
      if (cancelled) return;
      const prefabHash = node.dataset.thumbPrefab;
      const groupKey = node.dataset.thumbGroup;
      const localPath = node.dataset.thumbLocal;
      if (prefabHash) {
        const prefab = prefabs.find((item) => prefabThumbnailHash(item.id) === prefabHash);
        if (!prefab) return;
        await requestThumbnail(prefabHash, async () => {
          const cached = await getThumbnailData(prefabHash);
          if (cached) return cached;
          if (!isTauri()) return null;
          let rendered: string | null = null;
          await runBackgroundThumbnailBatch([prefabThumbnailItem(prefab)], {
            maxExtract: tab === "monuments" ? 0 : 1,
            cancelled: () => cancelled,
            onThumbnail: (_hash, dataUrl) => {
              rendered = dataUrl;
            },
            onExtractionFailed: () =>
              setUnavailable((current) =>
                current[prefabHash] ? current : { ...current, [prefabHash]: true },
              ),
          });
          return rendered;
        }).then((data) => {
          if (!cancelled && data) {
            setThumbnails((current) =>
              current[prefabHash] === data ? current : { ...current, [prefabHash]: data },
            );
          }
        });
        return;
      }
      if (groupKey) {
        const group = groupByKey.get(groupKey);
        if (!group) return;
        const thumbKey = groupThumbnailKey(group);
        await requestThumbnail(thumbKey, async () => {
          const cached = await getThumbnailData(thumbKey, group.previewPath);
          if (cached) return cached;
          if (!isTauri() || !group.previewPath) return null;
          if (group.partCount > 1) {
            const parts = await listGroupParts(groupKey);
            const loaded = await Promise.all(
              parts.slice(0, 24).map((part) => loadLocalMeshBytes(part.assetPath)),
            );
            const bytes = loaded.filter((item): item is Uint8Array => Boolean(item));
            if (!bytes.length) return null;
            return generator.generateGroupThumbnail(thumbKey, bytes);
          }
          // Render local single meshes with the same generator the Local
          // meshes tab uses; the bundle thumbnail path yields empty frames
          // for AssetRipper GLBs that have no prefab row behind them.
          const bytes = await loadLocalMeshBytes(group.previewPath);
          if (bytes) return generator.generateSkinThumbnail(thumbKey, bytes, {});
          return getBaseMeshThumbnail(group.previewPath);
        }).then((data) => {
          if (!cancelled && data) {
            setThumbnails((current) =>
              current[thumbKey] === data ? current : { ...current, [thumbKey]: data },
            );
          }
        });
        return;
      }
      if (localPath) {
        const thumbKey = skinThumbnailKey(localPath);
        await requestThumbnail(thumbKey, async () => {
          if (!isTauri()) return null;
          const bytes = await loadLocalMeshBytes(localPath);
          if (!bytes) return null;
          return generator.generateSkinThumbnail(thumbKey, bytes, {});
        }).then((data) => {
          if (!cancelled && data) {
            setThumbnails((current) =>
              current[thumbKey] === data ? current : { ...current, [thumbKey]: data },
            );
          }
        });
      }
    };

    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(
        "[data-thumb-prefab],[data-thumb-group],[data-thumb-local]",
      ),
    );
    void runThumbnailQueue(nodes, loadThumbnailFor, {
      concurrency: 2,
      cancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [open, tab, prefabs, meshGroups, localRows, searchTerm]);

  const renderMeshCard = (mesh: BaseMeshAsset) => (
    <article
      className="asset-card"
      key={mesh.id}
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
    </article>
  );

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
            Skin bases <span>{meshTotal}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "local"}
            className={tab === "local" ? "is-active" : ""}
            onClick={() => setTab("local")}
          >
            Local meshes
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
              onClick={() => setFolderPickerOpen(true)}
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
              title="Re-read bundles and populate missing prefab AABBs"
              onClick={() => {
                if (!bundleRoot) return;
                setScanning(true);
                setBundleMessage("Indexing prefab bounds…");
                void scanRustBundles(bundleRoot, (last) => setScanProgress(last), true)
                  .then((report) => {
                    setThumbnails({});
                    setRefreshTick((value) => value + 1);
                    setBundleMessage(`Indexed ${report.prefabs.toLocaleString()} prefabs with bounds.`);
                  })
                  .catch((cause) =>
                    setBundleMessage(cause instanceof Error ? cause.message : String(cause)),
                  )
                  .finally(() => {
                    setScanning(false);
                    setScanProgress(null);
                  });
              }}
            >
              Index bounds
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
            placeholder={
              tab === "skins" ? "Search mesh, kind or material" : tab === "local" ? "Search local GLBs" : "Search prefab name or path"
            }
            aria-label="Search indexed assets"
          />
          {tab !== "skins" && tab !== "local" && (
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
            {" "}{tab === "local" ? localTotal : total} matches{tab !== "skins" && tab !== "local" ? ` / ${bounded} with bounds` : ""}
          </p>
          <button type="button" className="asset-refresh" onClick={() => setRefreshTick((value) => value + 1)}>
            Refresh bounds
          </button>
        </div>

        <div className="asset-list" role="tabpanel" ref={listRef}>
          {loading && <p className="asset-state">Loading local index...</p>}
          {error && <p className="asset-state is-error">{error}</p>}
          {!loading && !error && tab === "local" && localRows.length === 0 && (
            <p className="asset-state">{localLoading ? "Loading local meshes..." : "No local meshes match this filter."}</p>
          )}
          {!loading && !error && tab !== "local" && shownCount === 0 && (
            <p className="asset-state">No assets match this filter.</p>
          )}
          {!loading && tab !== "skins" && tab !== "local" &&
            (rows as PrefabAsset[]).map((prefab) => {
              const pad = padRadius(prefab);
              const hash = prefabThumbnailHash(prefab.id);
              return (
              <article
                className="asset-card"
                key={prefab.id}
                data-thumb-prefab={hash}
                draggable
                title={`Drag ${prefab.name} onto the terrain`}
                onDragStart={(event) => {
                  startPrefabDrag(prefab);
                  event.dataTransfer.setData(PREFAB_MIME, prefab.id);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={endPrefabDrag}
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
              </article>
              );
            })}
          {!loading && tab === "local" &&
            localRows.map((mesh) => (
              <article
                className="asset-card"
                key={mesh.id}
                data-thumb-local={mesh.id}
                draggable
                onDragStart={(event) => {
                  startLocalMeshDrag(mesh);
                  event.dataTransfer.setData(
                    LOCAL_MESH_MIME,
                    JSON.stringify({ assetId: mesh.id, kind: "local-mesh" }),
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={endLocalMeshDrag}
                onClick={() => onPlaceLocal?.(mesh)}
                title={
                  onPlaceLocal
                    ? `Drag ${mesh.name} onto the terrain, or click to place`
                    : `Drag ${mesh.name} onto the terrain`
                }
              >
                {thumbnails[skinThumbnailKey(mesh.id)] ? (
                  <img className="asset-thumb-img" src={thumbnails[skinThumbnailKey(mesh.id)]} alt="" loading="lazy" />
                ) : (
                  <img
                    className="asset-thumb-img is-placeholder"
                    src={previewPlaceholder("Other", { min: [-1, -1, -1], max: [1, 1, 1] })}
                    alt=""
                    aria-hidden="true"
                  />
                )}
                <div className="asset-body">
                  <div className="asset-title">
                    <strong>{mesh.name}</strong>
                    <span>local GLB</span>
                  </div>
                  <code>{mesh.id}</code>
                  <div className="asset-meta">
                    <span>
                      {onPlaceLocal ? "Drag to Map or Monument, or click to place" : "Drag to Map or Monument"}
                    </span>
                  </div>
                </div>
                        </article>
            ))}

          {!loading && tab === "skins" &&
            visibleGroups.map((group) => {
              const expansionKey = group.groupKey || group.id;
              const expanded = expandedGroups.has(expansionKey);
              const partRows = meshParts[expansionKey] ?? [];
              const previewKey = groupThumbnailKey(group);
              const toggle = () => {
                if (group.partCount === 1) return;
                setExpandedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(expansionKey)) next.delete(expansionKey);
                  else next.add(expansionKey);
                  return next;
                });
                if (!expanded) void loadGroupParts(group);
              };
              return (
                <Fragment key={expansionKey}>
                  <article
                    className={`asset-card${group.partCount > 1 ? " asset-group" : ""}`}
                    data-thumb-group={expansionKey}
                    role={group.partCount > 1 ? "button" : undefined}
                    tabIndex={group.partCount > 1 ? 0 : undefined}
                    aria-expanded={group.partCount > 1 ? expanded : undefined}
                    onClick={toggle}
                    onKeyDown={(event) => {
                      if (group.partCount < 2) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggle();
                      }
                    }}
                  >
                    {thumbnails[previewKey] ? (
                      <img className="asset-thumb-img" src={thumbnails[previewKey]} alt="" loading="lazy" />
                    ) : (
                      <div className="asset-thumb-group">
                        <strong>{group.partCount}</strong>
                        <span>{group.partCount === 1 ? "mesh" : "parts"}</span>
                      </div>
                    )}
                    <div className="asset-body">
                      <div className="asset-title">
                        <strong>{group.name}</strong>
                        <span>{group.partCount > 1 ? "group" : "mesh"}</span>
                      </div>
                      <code>{group.partCount > 1 ? (expanded ? "Collapse parts" : "Expand parts") : group.previewPath}</code>
                      <div className="asset-meta">
                        <span>{group.partCount} sub-meshes</span>
                        {group.triangles > 0 && <span>{group.triangles.toLocaleString()} tris</span>}
                      </div>
                    </div>
                  </article>
                  {expanded && partRows.map((part) => {
                    const mesh: BaseMeshAsset = {
                      id: part.assetPath,
                      name: part.name,
                      itemKind: group.itemKind as BaseMeshAsset["itemKind"],
                      uvChannels: 0,
                      triangles: 0,
                      hasTangents: false,
                      materialSlots: [],
                    };
                    return renderMeshCard(mesh);
                  })}
                </Fragment>
              );
            })}
        </div>

        <footer className="asset-foot">
          {tab === "local" && localCursor != null && (
            <button type="button" className="asset-refresh" disabled={localLoading} onClick={() => void loadMoreLocal()}>
              {localLoading ? "Loading…" : "Load 50 more"}
            </button>
          )}
          {tab === "skins" && meshGroups.length < meshTotal && (
            <button
              type="button"
              className="asset-refresh"
              disabled={loading}
              onClick={() => setMeshPages((value) => value + 1)}
            >
              {loading ? "Loading…" : `Load ${Math.min(50, meshTotal - meshGroups.length)} more`}
            </button>
          )}
          {tab !== "skins" && tab !== "local" && prefabs.length < pageTotal && (
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
            {tab === "local"
              ? `${localRows.length.toLocaleString()} of ${localTotal.toLocaleString()} local GLBs. Drag onto the terrain to place.`
              : shownCount < total
                ? `Showing ${shownCount} of ${total}. Drag a card onto the terrain to place it.`
                : "Drag a card onto the terrain to place it. Read-only view of the local index."}
          </span>
        </footer>
      </aside>
      <FolderPicker
        open={folderPickerOpen}
        onClose={() => setFolderPickerOpen(false)}
        onPick={(path) => {
          setFolderPickerOpen(false);
          setBundleRoot(path);
          setLinkedBundleRoot(path);
          setBundleMessage("Bundles linked. Scan to index monuments and render real previews.");
        }}
      />
    </>
  );
}
