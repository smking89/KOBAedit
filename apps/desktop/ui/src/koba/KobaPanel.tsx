import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button } from "../components/ui";
import { demoMode, exportProject, listBaseMeshes, listPrefabs } from "../lib/ipc";
import { useWizard } from "../wizard/context";
import { readAttachment, revokeAttachment } from "./attachments";
import { refreshProjectThumbnail } from "../utils/thumbnailQueue";
import { generateProject } from "./generate";
import type { KobaAttachment, KobaMessage } from "./types";
import type { PrefabAsset, WizardDraft } from "../wizard/types";

/** Stages of a live prompt build: terrain → surfaces → monuments → roads. */
function buildStages(draft: WizardDraft): { label: string; draft: WizardDraft }[] {
  if (draft.branch !== "world") return [{ label: "Draft", draft }];
  const bareTerrain = {
    ...draft.terrain,
    strokes: [],
    layers: draft.terrain.layers.map((layer) => ({ ...layer, strokes: [] })),
  };
  return [
    { label: "Terrain", draft: { ...draft, placements: [], splines: [], terrain: bareTerrain } },
    { label: "Surfaces", draft: { ...draft, placements: [], splines: [] } },
    { label: "Monuments", draft: { ...draft, splines: [] } },
    { label: "Roads", draft },
  ];
}

const SUGGESTIONS = [
  "Snowy 4 km island map with 8 monuments and two roads",
  "Monument with a dense forest, one road and tier 2 loot",
  "Red and black AK-47 skin with hazard stripes and heavy wear",
];

const MAX_ATTACHMENTS = 6;

const COMMAND_SUGGESTIONS = [
  "generate 4.5k island with snow mountain north and river through center",
  "paint cliff topology on slopes > 35",
  "place 4 bandit vending machines along road_01",
  "wire green card reader to door_01",
  "enter walk mode",
  "lock map with password local-secret",
  "set wear 0.35",
];

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `msg-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const WELCOME: KobaMessage = {
  id: "welcome",
  role: "assistant",
  text: "Describe the map, monument or skin you need. Attach a ZIP project or reference images and KOBA EDIT will build the draft and export it.",
  lines: [
    "ZIP files restore a saved project.json or draft.json when present.",
    "Images contribute a sampled palette; project archives can include .map and .prefab files.",
    "Everything runs locally. No prompt leaves this machine.",
  ],
};

export function KobaPanel({
  open,
  onClose,
  onStageFocus,
}: {
  open: boolean;
  onClose: () => void;
  /** Camera framing hook for each live-build stage (App owns the viewport). */
  onStageFocus?: (draft: WizardDraft, stage: number) => void;
}) {
  const {
    state,
    dispatch,
    undo,
    canUndo,
    beginStagedBuild,
    applyStagedDraft,
    finishStagedBuild,
    cancelStagedBuild,
  } = useWizard();
  const [building, setBuilding] = useState<{
    steps: { label: string; status: "pending" | "running" | "done" }[];
    paused: boolean;
  } | null>(null);
  const buildRun = useRef<{ cancelled: boolean; paused: boolean } | null>(null);
  const [messages, setMessages] = useState<KobaMessage[]>([WELCOME]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<KobaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [autoExport, setAutoExport] = useState(true);
  const [catalog, setCatalog] = useState<PrefabAsset[]>([]);
  const [meshNames, setMeshNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => demoMode(), []);
  const autocomplete = useMemo(() => {
    const needle = prompt.trim().toLowerCase();
    if (needle.length < 2) return [];
    const tokens = needle
      .split(/\s+/)
      .filter((token) => token.length > 1 && !/^\d+$/.test(token));
    if (!tokens.length) return [];
    return [
      ...COMMAND_SUGGESTIONS,
      ...catalog.slice(0, 400).map((prefab) => `place ${prefab.name} on road_01`),
      ...meshNames.slice(0, 80).map((name) => `apply matte black finish on ${name}`),
    ]
      .filter((suggestion) => {
        const lower = suggestion.toLowerCase();
        return tokens.every((token) => lower.includes(token));
      })
      .slice(0, 5);
  }, [prompt, catalog, meshNames]);

  const append = (message: Omit<KobaMessage, "id">) => {
    setMessages((current) => [...current, { ...message, id: uid() }]);
  };

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => textRef.current?.focus(), 180);
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
    void Promise.all([listPrefabs(), listBaseMeshes()])
      .then(([prefabs, meshes]) => {
        if (cancelled) return;
        setCatalog(prefabs);
        setMeshNames(meshes.map((mesh) => mesh.name));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, busy]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      append({
        role: "assistant",
        error: true,
        text: `At most ${MAX_ATTACHMENTS} attachments can be used per build.`,
      });
      return;
    }
    setAdding(true);
    const accepted: KobaAttachment[] = [];
    const errors: string[] = [];
    for (const file of files.slice(0, room)) {
      try {
        accepted.push(await readAttachment(file));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (accepted.length) setAttachments((current) => [...current, ...accepted]);
    if (files.length > room) {
      errors.push(`Only ${room} more attachment(s) fit in this build.`);
    }
    if (errors.length) {
      append({ role: "assistant", error: true, text: errors.join(" ") });
    }
    setAdding(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const removeAttachment = (attachment: KobaAttachment) => {
    revokeAttachment(attachment);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
  };

  const toggleBuildPause = () => {
    const run = buildRun.current;
    if (!run) return;
    run.paused = !run.paused;
    setBuilding((current) => (current ? { ...current, paused: run.paused } : current));
  };

  const stopBuild = () => {
    if (buildRun.current) buildRun.current.cancelled = true;
  };

  /** Sleeps between stages, honouring pause and stop. */
  const waitStage = async (milliseconds: number): Promise<boolean> => {
    let remaining = milliseconds;
    while (remaining > 0) {
      const run = buildRun.current;
      if (!run || run.cancelled) return false;
      if (run.paused) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        continue;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      remaining -= 60;
    }
    return !buildRun.current?.cancelled;
  };

  const send = async (override?: string) => {
    if (busy || adding) return;
    const text = (override ?? prompt).trim();
    if (!text && attachments.length === 0) return;
    const sentAttachments = attachments;
    const names = sentAttachments.map((attachment) => attachment.name);

    append({
      role: "user",
      text: text || "Build from the attached files.",
      attachments: names.length ? names : undefined,
    });
    setPrompt("");
    setBusy(true);
    await new Promise((resolve) => window.setTimeout(resolve, 180));

    try {
      const result = generateProject(
        text || "Build from the attached files.",
        sentAttachments,
        state.draft,
        catalog,
      );
      // Live build: animate each stage, then commit one undoable draft.
      const stages = buildStages(result.draft);
      beginStagedBuild();
      buildRun.current = { cancelled: false, paused: false };
      setBuilding({
        steps: stages.map((stage, index) => ({
          label: stage.label,
          status: index === 0 ? "running" : "pending",
        })),
        paused: false,
      });
      let cancelled = false;
      for (let stage = 0; stage < stages.length; stage += 1) {
        setBuilding((current) =>
          current
            ? {
                ...current,
                steps: current.steps.map((step, index) => ({
                  ...step,
                  status: index < stage ? "done" : index === stage ? "running" : "pending",
                })),
              }
            : current,
        );
        applyStagedDraft(stages[stage].draft, result.step);
        onStageFocus?.(stages[stage].draft, stage);
        const proceed = await waitStage(stage === 0 ? 320 : 480);
        if (!proceed) {
          cancelled = true;
          break;
        }
      }
      buildRun.current = null;
      setBuilding(null);
      if (cancelled) {
        cancelStagedBuild();
        append({
          role: "assistant",
          text: "Build stopped. The project is back to how it was before this prompt.",
        });
        setBusy(false);
        return;
      }
      finishStagedBuild(result.draft, result.step);
      void refreshProjectThumbnail(result.draft).catch(() => {
        // Cards still fall back to proxy art when the real GLB cache is empty.
      });

      let exportPath: string | undefined;
      let exportBytes: number | undefined;
      let exportError: string | null = null;
      if (autoExport) {
        try {
          const report = await exportProject(result.draft);
          dispatch({ type: "markSaved", at: new Date().toISOString(), report });
          exportPath = report.path;
          exportBytes = report.bytes;
        } catch (error) {
          exportError = error instanceof Error ? error.message : String(error);
        }
      }

      append({
        role: "assistant",
        text: `${result.name} is loaded in the wizard. ${
          exportPath
            ? "The export is already written."
            : autoExport
              ? "The draft is ready; export failed."
              : "The draft is ready; export is manual."
        }`,
        lines: result.summary,
        chips: result.chips,
        exportPath,
        exportBytes,
        error: Boolean(exportError),
        undo: true,
      });
      if (exportError) {
        append({
          role: "assistant",
          error: true,
          text: `Export error: ${exportError}`,
        });
      }
      sentAttachments.forEach(revokeAttachment);
      setAttachments([]);
    } catch (error) {
      append({
        role: "assistant",
        error: true,
        text: `Generation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      setPrompt(text);
    } finally {
      setBusy(false);
    }
  };

  const canSend = Boolean(prompt.trim() || attachments.length) && !busy && !adding;

  return (
    <>
      {open && <div className="koba-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside
        className={`koba-panel${open ? " is-open" : ""}`}
        aria-label="KOBA EDIT prompt builder"
        aria-hidden={!open}
      >
        <header className="koba-head">
          <div className="koba-identity">
            <span className="koba-mark" aria-hidden="true">
              K
            </span>
            <div>
              <p className="koba-eyebrow">Prompt build / local engine</p>
              <h2>KOBA EDIT</h2>
              <p className="koba-sub">One prompt. Draft, placement and export handled.</p>
            </div>
          </div>
          <button type="button" className="koba-close" onClick={onClose} aria-label="Close KOBA EDIT">
            Close
          </button>
        </header>

        <div className="koba-context">
          <span>
            Current draft <strong>{state.draft.name}</strong>
          </span>
          <Badge tone={preview ? "warn" : "neutral"}>{preview ? "Preview bridge" : "Desktop bridge"}</Badge>
        </div>

        <div className="koba-messages" ref={scrollRef}>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`koba-msg is-${message.role}${message.error ? " is-error" : ""}`}
            >
              <span className="koba-avatar" aria-hidden="true">
                {message.role === "user" ? "You" : "K"}
              </span>
              <div className="koba-bubble">
                <p>{message.text}</p>
                {message.lines && message.lines.length > 0 && (
                  <ul>
                    {message.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {message.attachments && message.attachments.length > 0 && (
                  <div className="koba-msg-files">
                    {message.attachments.map((name) => (
                      <span key={name}>{name}</span>
                    ))}
                  </div>
                )}
                {message.exportPath && (
                  <div className="koba-export">
                    <span>Export written</span>
                    <code>{message.exportPath}</code>
                    {typeof message.exportBytes === "number" && (
                      <em>{formatBytes(message.exportBytes)}</em>
                    )}
                  </div>
                )}
                {message.undo && canUndo && (
                  <div className="koba-chips">
                    <button type="button" onClick={undo}>
                      Undo build
                    </button>
                  </div>
                )}
                {message.chips && message.chips.length > 0 && (
                  <div className="koba-chips">
                    {message.chips.map((chip, index) => (
                      <button
                        key={`${chip.label}-${index}`}
                        type="button"
                        onClick={() => void send(chip.prompt)}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {building && (
            <div className="koba-build" aria-live="polite">
              <header>
                <span className={`koba-build-pill${building.paused ? " is-paused" : ""}`}>
                  {building.paused ? "Paused" : "Building live"}
                </span>
                <button type="button" onClick={toggleBuildPause}>
                  {building.paused ? "Resume" : "Pause"}
                </button>
                <button type="button" onClick={stopBuild}>
                  Stop
                </button>
              </header>
              <ol>
                {building.steps.map((step) => (
                  <li key={step.label} className={`is-${step.status}`}>
                    <span className="koba-build-dot" aria-hidden="true" />
                    {step.label}
                    <em>{step.status === "done" ? "Done" : step.status === "running" ? "Running" : "Queued"}</em>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {busy && (
            <div className="koba-working" aria-live="polite">
              <span className="koba-spinner" aria-hidden="true" />
              Building the draft and writing the export
            </div>
          )}
        </div>

        <div className="koba-compose">
          {messages.length === 1 && (
            <div className="koba-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setPrompt(suggestion);
                    textRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="koba-files">
              {attachments.map((attachment) => (
                <div className="koba-file" key={attachment.id}>
                  {attachment.previewUrl ? (
                    <img src={attachment.previewUrl} alt="" />
                  ) : (
                    <span className="koba-file-zip">ZIP</span>
                  )}
                  <span className="koba-file-copy">
                    <strong>{attachment.name}</strong>
                    <em>
                      {attachment.kind === "zip" && attachment.zip
                        ? `${attachment.zip.entries} files${attachment.zip.projectDraft ? " / project restored" : ""}`
                        : attachment.image
                          ? `${attachment.image.width}x${attachment.image.height} / ${attachment.image.dominant}`
                          : formatBytes(attachment.bytes)}
                    </em>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment)}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            className={`koba-drop${dragging ? " is-dragging" : ""}${adding ? " is-busy" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void addFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".zip,image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
            />
            <button
              type="button"
              className="koba-attach"
              onClick={() => inputRef.current?.click()}
              disabled={adding}
            >
              {adding ? "Reading file" : "Attach ZIP or image"}
            </button>
            <span>Drop files here. Project ZIPs restore their saved draft.</span>
          </div>

          <textarea
            ref={textRef}
            value={prompt}
            rows={3}
            placeholder="Build a foggy 3 km mountain map with six monuments, two roads and tier 3 loot."
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />

          {autocomplete.length > 0 && (
            <div className="koba-autocomplete" role="listbox" aria-label="Command suggestions">
              {autocomplete.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    role="option"
                    onClick={() => {
                      setPrompt(suggestion);
                      textRef.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
              ))}
            </div>
          )}

          <div className="koba-actions">
            <label className="koba-auto">
              <input
                type="checkbox"
                checked={autoExport}
                onChange={(event) => setAutoExport(event.target.checked)}
              />
              <span>Auto-export</span>
              <em>{preview ? "simulated in browser" : "writes immediately"}</em>
            </label>
            <Button variant="primary" onClick={() => void send()} disabled={!canSend}>
              {busy ? "Generating" : "Generate"}
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
