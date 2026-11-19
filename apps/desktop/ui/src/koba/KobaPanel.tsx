import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button } from "../components/ui";
import { demoMode, exportProject } from "../lib/ipc";
import { useWizard } from "../wizard/context";
import { readAttachment, revokeAttachment } from "./attachments";
import { generateProject } from "./generate";
import type { KobaAttachment, KobaMessage } from "./types";

const SUGGESTIONS = [
  "Snowy 4 km island map with 8 monuments and two roads",
  "Monument with a dense forest, one road and tier 2 loot",
  "Red and black AK-47 skin with hazard stripes and heavy wear",
];

const MAX_ATTACHMENTS = 6;

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

export function KobaPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useWizard();
  const [messages, setMessages] = useState<KobaMessage[]>([WELCOME]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<KobaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [autoExport, setAutoExport] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => demoMode(), []);

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

  const send = async () => {
    if (busy || adding) return;
    const text = prompt.trim();
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
      const result = generateProject(text || "Build from the attached files.", sentAttachments, state.draft);
      dispatch({ type: "applyGenerated", draft: result.draft, step: result.step });

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
        exportPath,
        exportBytes,
        error: Boolean(exportError),
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
              </div>
            </div>
          ))}
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
