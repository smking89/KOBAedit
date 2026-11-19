import { useEffect, useState } from "react";

import { Badge, Field, Panel, SectionLabel, TextInput } from "../../components/ui";
import { indexStats, type IndexStats } from "../../lib/ipc";
import { useWizard } from "../context";
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
    points: ["Push/pull project bundles", "Conflict detection by revision", "Token stored in the OS keyring"],
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

  useEffect(() => {
    let active = true;
    indexStats()
      .then((value) => active && setStats(value))
      .catch(() => active && setStats(null));
    return () => {
      active = false;
    };
  }, []);

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
            <p className="hint-block">
              Projects save locally first. The outbox pushes new revisions when connectivity returns; tokens stay in
              the OS keyring, never in the project database.
            </p>
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
      </Panel>
    </div>
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
