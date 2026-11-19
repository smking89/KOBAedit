import { useEffect, useState } from "react";

import { Badge, Button, Field, Panel, SectionLabel, TextInput } from "../../components/ui";
import {
  cacheStats,
  cancelBundleScan,
  findRustInstall,
  indexStats,
  pickBundleFolder,
  pruneCache,
  scanRustBundles,
  syncConfigure,
  syncTest,
  type CacheStats,
  type IndexStats,
  type TaskProgress,
} from "../../lib/ipc";
import { useWizard } from "../context";
import { MAP_STARTERS, matchesStarter } from "../mapPresets";
import type { EntryMode, ProjectKind } from "../types";

const MODES: { id: EntryMode; title: string; body: string; points: string[] }[] = [
  {
    id: "offline",
    title: "Offline local",
    body: "Everything stays on this machine. No account, no network calls.",
    points: ["Local SQLite index", "Full editor feature set", "Exports to disk"],
  },
  {
    id: "online",
    title: "Online sync",
    body: "Edit offline as usual; queued changes sync when a connection is available.",
    points: ["Push/pull project bundles", "Conflict detection by revision", "Token stored in a 0600 local file"],
  },
];

const KINDS: {
  id: ProjectKind;
  title: string;
  body: string;
  meta: string;
}[] = [
  {
    id: "map",
    title: "Full Rust map",
    body: "Terrain, monuments, splines, loot and IO, exported as a server-ready .map.",
    meta: "6 steps",
  },
  {
    id: "monument",
    title: "Monument / prefab",
    body: "A standalone prefab with its own terrain pad, foliage clearing and IO wiring.",
    meta: ".prefab",
  },
  {
    id: "skin",
    title: "Rust item skin",
    body: "PBR layers, projected decals and Workshop channel export for a base item.",
    meta: "6 steps",
  },
];

export function EntryStep() {
  const { state, update, dispatch } = useWizard();
  const draft = state.draft;
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [bundleRoot, setBundleRoot] = useState(() => {
    try {
      return localStorage.getItem("koba.bundles.root") ?? "";
    } catch {
      return "";
    }
  });
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<TaskProgress | null>(null);
  const [syncToken, setSyncToken] = useState("");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [cache, setCache] = useState<CacheStats | null>(null);
  const [cacheLimitMb, setCacheLimitMb] = useState("512");

  useEffect(() => {
    cacheStats()
      .then((next) => {
        setCache(next);
        if (next) setCacheLimitMb(String(Math.round(next.limitBytes / (1024 * 1024))));
      })
      .catch(() => setCache(null));
  }, []);

  useEffect(() => {
    let active = true;
    indexStats()
      .then((value) => active && setStats(value))
      .catch(() => active && setStats(null));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (bundleRoot) return;
    let active = true;
    findRustInstall()
      .then((install) => active && install.found && setBundleRoot(install.root))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bundleRoot]);

  return (
    <div className="stack">
      <Field label="Project name" hint="Used for the workspace folder and export file">
        <TextInput
          value={draft.name}
          onChange={(name) => update({ name, export: { ...draft.export, fileName: slug(name) || draft.export.fileName } })}
          placeholder="Hapis rebuild 2026"
        />
      </Field>

      <Panel title="Working mode" subtitle="Offline is the default; sync is additive.">
        <div className="choice-grid two">
          {MODES.map((mode) => {
            const active = draft.mode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={`choice-card${active ? " is-active" : ""}`}
                onClick={() => update({ mode: mode.id })}
              >
                <div className="choice-head">
                  <span className="choice-title">{mode.title}</span>
                  {active && <Badge tone="accent">Selected</Badge>}
                </div>
                <p>{mode.body}</p>
                <ul className="choice-points">
                  {mode.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        {draft.mode === "online" && (
          <div className="inline-form">
            <Field label="Sync endpoint" hint="Optional until the shell has an account">
              <TextInput
                value={draft.syncEndpoint}
                onChange={(syncEndpoint) => update({ syncEndpoint })}
                placeholder="https://sync.example.net"
                mono
              />
            </Field>
            <Field label="Access token" hint="Written to a 0600 file in app data; never into the project database">
              <TextInput
                password
                value={syncToken}
                onChange={setSyncToken}
                placeholder="Leave blank to keep the saved token"
                mono
              />
            </Field>
            <div className="inline-row">
              <Button
                variant="ghost"
                onClick={() => {
                  setSyncMessage(null);
                  void syncConfigure(draft.syncEndpoint, syncToken)
                    .then((status) => {
                      setSyncToken("");
                      setSyncMessage(
                        `Profile ${status.profile ?? "default"} saved${status.tokenSaved ? " with a local token" : " without a token"}.`,
                      );
                    })
                    .catch((cause) =>
                      setSyncMessage(cause instanceof Error ? cause.message : String(cause)),
                    );
                }}
              >
                Save profile
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSyncMessage(null);
                  void syncTest()
                    .then((message) => setSyncMessage(message))
                    .catch((cause) =>
                      setSyncMessage(cause instanceof Error ? cause.message : String(cause)),
                    );
                }}
              >
                Test connection
              </Button>
            </div>
            <p className="hint-block">
              Projects save locally first. The outbox pushes new revisions when connectivity returns. The generic
              <code> koba-sync/1 </code> contract is documented in the README; HTTPS is required outside localhost.
            </p>
            {syncMessage && <p className="hint-block">{syncMessage}</p>}
          </div>
        )}
      </Panel>

      <Panel title="Project type" subtitle="This selects the wizard branch; it cannot change later.">
        <div className="choice-grid three">
          {KINDS.map((kind) => {
            const active = draft.projectKind === kind.id;
            return (
              <button
                key={kind.id}
                type="button"
                className={`choice-card${active ? " is-active" : ""}`}
                onClick={() => dispatch({ type: "setKind", kind: kind.id })}
              >
                <div className="choice-head">
                  <span className="choice-title">{kind.title}</span>
                  <span className="mono-tag">{kind.meta}</span>
                </div>
                <p>{kind.body}</p>
              </button>
            );
          })}
        </div>
      </Panel>

      {draft.projectKind === "map" && (
        <Panel
          title="New map starter"
          subtitle="Quick-fill the heightmap and ground layers before generating."
        >
          <div className="preset-grid">
            {MAP_STARTERS.map((starter) => {
              const active = matchesStarter(draft.terrain, starter.patch);
              return (
                <button
                  key={starter.id}
                  type="button"
                  className={`preset-card${active ? " is-active" : ""}`}
                  onClick={() => dispatch({ type: "patchTerrain", patch: starter.patch })}
                >
                  <span>
                    {starter.title} <em className="mono-tag">{starter.meta}</em>
                  </span>
                  <em>{starter.body}</em>
                </button>
              );
            })}
          </div>
          <p className="hint-block">
            Ocean and sandbox starters write a flat floor at a fixed elevation; procedural island restores the
            generator. Anything a starter sets can still be changed on the Terrain step.
          </p>
        </Panel>
      )}

      <Panel title="Local index" subtitle="Prefab and mesh metadata available to this project">
        <div className="index-summary">
          <div>
            <SectionLabel>Status</SectionLabel>
            <p className="index-state">
              {stats?.indexed ? (
                <>
                  <Badge tone="ok">Indexed</Badge> {stats.prefabs} prefabs, {stats.baseMeshes} base meshes
                </>
              ) : (
                <>
                  <Badge tone="warn">Not indexed</Badge> Using the built-in catalogue until you ingest a Rust install.
                </>
              )}
            </p>
          </div>
          <div className="index-meta">
            <span>Asset packs: {stats?.packs ?? 0}</span>
            <span>Projects: {stats?.projects ?? 0}</span>
            <span>Queued sync items: {stats?.queuedSync ?? 0}</span>
          </div>
        </div>
        <p className="hint-block">
          Run <code>python engine/scripts/ingest_assets.py &lt;rust-install&gt;</code> to index local prefabs and base
          meshes. The app remains usable without it.
        </p>
        <div className="inline-form">
          <Field label="Rust Bundles folder" hint="steamapps/common/Rust/Bundles or a copy">
            <TextInput
              value={bundleRoot}
              onChange={setBundleRoot}
              placeholder="~/.local/share/Steam/steamapps/common/Rust/Bundles"
              mono
            />
          </Field>
          <div className="inline-row">
            <Button
              variant="ghost"
              onClick={() => {
                setScanMessage(null);
                void pickBundleFolder()
                  .then((path) => {
                    if (!path) return;
                    setBundleRoot(path);
                    try {
                      localStorage.setItem("koba.bundles.root", path);
                    } catch {
                      /* storage can be unavailable in hardened webviews */
                    }
                  })
                  .catch((cause) =>
                    setScanMessage(cause instanceof Error ? cause.message : String(cause)),
                  );
              }}
            >
              Browse...
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void findRustInstall()
                  .then((install) => {
                    setBundleRoot(install.root);
                    try {
                      localStorage.setItem("koba.bundles.root", install.root);
                    } catch {
                      /* storage can be unavailable in hardened webviews */
                    }
                  })
                  .catch(() => setScanMessage("Could not detect a Steam Rust installation."));
              }}
            >
              Auto-detect
            </Button>
            <Button
              variant="primary"
              disabled={scanning}
              onClick={() => {
                setScanning(true);
                setScanMessage(null);
                void (async () => {
                  setScanProgress(null);
                  const install = await findRustInstall(bundleRoot || undefined);
                  if (!install.found) throw new Error("No Rust Bundles folder was found at that path.");
                  const report = await scanRustBundles(install.root, (last) => setScanProgress(last));
                  setBundleRoot(install.root);
                  try {
                    localStorage.setItem("koba.bundles.root", install.root);
                  } catch {
                    /* storage can be unavailable in hardened webviews */
                  }
                  setScanMessage(
                    `${report.prefabs} prefabs and ${report.assets} bundle assets indexed from ${report.bundles} bundles; ${report.extractedMeshes} skin meshes and thumbnails built.`,
                  );
                  const next = await indexStats();
                  setStats(next);
                  cacheStats().then(setCache).catch(() => undefined);
                })()
                  .catch((cause) =>
                    setScanMessage(cause instanceof Error ? cause.message : String(cause)),
                  )
                  .finally(() => {
                    setScanning(false);
                    setScanProgress(null);
                  });
              }}
            >
              {scanning ? "Scanning locally" : "Link & scan"}
            </Button>
            {scanning && (
              <Button variant="ghost" onClick={() => void cancelBundleScan()}>
                Cancel
              </Button>
            )}
          </div>
          {scanning && (
            <p className="hint-block">
              {scanProgress
                ? `${scanProgress.stage}: ${scanProgress.message}${scanProgress.total > 0 ? ` (${scanProgress.current}/${scanProgress.total})` : ""}`
                : "Starting the bundle scanner..."}
            </p>
          )}
          {scanMessage && <p className="hint-block">{scanMessage}</p>}
        </div>
      </Panel>

      <Panel title="Local cache" subtitle="Extracted meshes and thumbnails under ~/.cache/koba-edit">
        <div className="index-meta">
          <span>Meshes: {cache?.meshes.files ?? 0} files / {formatBytes(cache?.meshes.bytes ?? 0)}</span>
          <span>Thumbnails: {cache?.thumbs.files ?? 0} files / {formatBytes(cache?.thumbs.bytes ?? 0)}</span>
          <span>Total: {formatBytes(cache?.totalBytes ?? 0)}</span>
        </div>
        <div className="inline-form">
          <Field
            label="Cache limit (MB)"
            hint="Saved to data/cache-settings.json and enforced after writes; oldest GLB/PNG files are evicted first"
          >
            <TextInput value={cacheLimitMb} onChange={setCacheLimitMb} mono />
          </Field>
          <Button
            variant="ghost"
            onClick={() => {
              const megabytes = Math.max(16, Number(cacheLimitMb) || 512);
              void pruneCache(Math.round(megabytes * 1024 * 1024))
                .then((next) => {
                  setCache(next);
                  setCacheLimitMb(String(Math.round(next.limitBytes / (1024 * 1024))));
                  setScanMessage(`Cache pruned to ${formatBytes(next.totalBytes)}.`);
                })
                .catch((cause) =>
                  setScanMessage(cause instanceof Error ? cause.message : String(cause)),
                );
            }}
          >
            Prune cache
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
