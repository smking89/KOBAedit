import { useMemo, useRef, useState } from "react";

import {
  EXIT_ZONE,
  FRAME_MAX,
  FRAME_MAX_BYTES,
  FRAME_MIN,
  FRAME_RECOMMENDED,
  INNER_CUTOUT,
  LOGO_ANCHORS,
  LOGO_ANCHOR_LABELS,
  pixelBox,
  rectStyle,
  type LogoAnchor,
} from "./regions";
import type { CuiFrameImport } from "../wizard/types";

type LoadedFrame = CuiFrameImport;

type Issue = { severity: "error" | "warning"; message: string };

const ALPHA_FLOOR = 8;

function dataUrlFor(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That PNG could not be read."));
    reader.readAsDataURL(file);
  });
}

async function readFrame(file: File): Promise<LoadedFrame> {
  if (!/\.png$/i.test(file.name)) {
    throw new Error("Frames must be PNG files; other formats are not accepted for CUI.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot read image pixels.");
    context.drawImage(bitmap, 0, 0);
    const box = pixelBox(INNER_CUTOUT, bitmap.width, bitmap.height);
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    let interiorOpaque = 0;
    if (width > 0 && height > 0) {
      const pixels = context.getImageData(box.left, box.top, width, height).data;
      const samples = 4096;
      const step = Math.max(1, Math.floor(Math.sqrt((width * height) / samples)));
      let seen = 0;
      let opaque = 0;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          seen += 1;
          if (pixels[(y * width + x) * 4 + 3] >= ALPHA_FLOOR) opaque += 1;
        }
      }
      interiorOpaque = seen ? opaque / seen : 0;
    }
    return {
      dataUrl: await dataUrlFor(file),
      name: file.name,
      width: bitmap.width,
      height: bitmap.height,
      bytes: file.size,
      interiorOpaque,
    };
  } finally {
    bitmap.close();
  }
}

function boxLabel(box: { left: number; top: number; right: number; bottom: number }) {
  return `${box.left}, ${box.top} · ${box.right - box.left}×${box.bottom - box.top}`;
}

export function CuiDesigner({
  open,
  onClose,
  frame,
  onFrame,
}: {
  open: boolean;
  onClose: () => void;
  /** The project's imported frame; the draft owns it, not this dialog. */
  frame: CuiFrameImport | null;
  onFrame: (frame: CuiFrameImport | null) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState<LogoAnchor>("crest");
  const [guides, setGuides] = useState({ cutout: true, exit: true, logos: true });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      const next = await readFrame(file);
      onFrame(next);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "That PNG could not be read.");
    } finally {
      setBusy(false);
    }
  };

  const issues = useMemo<Issue[]>(() => {
    if (!frame) return [];
    const list: Issue[] = [];
    if (frame.width < FRAME_MIN.width || frame.height < FRAME_MIN.height) {
      list.push({
        severity: "error",
        message: `Frame is ${frame.width}x${frame.height}; the minimum is ${FRAME_MIN.width}x${FRAME_MIN.height}.`,
      });
    }
    if (frame.width > FRAME_MAX.width || frame.height > FRAME_MAX.height) {
      list.push({
        severity: "warning",
        message: `Frame is ${frame.width}x${frame.height}; it will be downscaled to ${FRAME_RECOMMENDED.width}x${FRAME_RECOMMENDED.height} on import.`,
      });
    }
    if (Math.abs(frame.width / Math.max(1, frame.height) - 16 / 9) >= 0.01) {
      list.push({
        severity: "warning",
        message: `${frame.width}x${frame.height} is not 16:9; the game canvas is ${FRAME_RECOMMENDED.width}x${FRAME_RECOMMENDED.height}.`,
      });
    }
    if (frame.bytes > FRAME_MAX_BYTES) {
      list.push({
        severity: "warning",
        message: `${(frame.bytes / 1_000_000).toFixed(2)} MB will be compressed under ${FRAME_MAX_BYTES / 1_000_000} MB for ImageLibrary.`,
      });
    }
    if (frame.interiorOpaque > 0) {
      list.push({
        severity: "error",
        message: `${(frame.interiorOpaque * 100).toFixed(1)}% of the inner cutout is opaque; it must be 100% transparent (alpha = 0) between x ${INNER_CUTOUT[0] * 100}-${INNER_CUTOUT[2] * 100}% and y ${INNER_CUTOUT[1] * 100}-${INNER_CUTOUT[3] * 100}%.`,
      });
    }
    return list;
  }, [frame]);

  const errors = issues.filter((issue) => issue.severity === "error").length;

  if (!open) return null;

  return (
    <div className="cui-backdrop" role="presentation" onClick={onClose}>
      <section
        className="cui-designer"
        role="dialog"
        aria-modal="true"
        aria-label="CUI shop and HUD designer"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cui-head">
          <div>
            <p className="cui-eyebrow">Visual CUI</p>
            <h2>Shop and HUD designer</h2>
          </div>
          <div className="cui-head-actions">
            <span className="cui-meta">{FRAME_RECOMMENDED.width} x {FRAME_RECOMMENDED.height} canvas / Rust anchor space</span>
            <button type="button" className="link-button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="cui-body">
          <div className="cui-stage">
            <div
              className={`cui-canvas${frame ? " has-frame" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void load(event.dataTransfer.files?.[0]);
              }}
            >
              {frame ? (
                <img src={frame.dataUrl} alt={`${frame.name} CUI frame preview`} />
              ) : (
                <button
                  type="button"
                  className="cui-empty"
                  onClick={() => fileRef.current?.click()}
                >
                  <strong>Drop a frame PNG here</strong>
                  <span>Or choose a file. PNG-24/32 with alpha, {FRAME_MIN.width}x{FRAME_MIN.height} or larger.</span>
                </button>
              )}

              {frame && guides.cutout && (
                <div className="cui-zone is-cutout" style={rectStyle(INNER_CUTOUT)}>
                  <span className="cui-zone-label">Inner cutout</span>
                </div>
              )}
              {frame && guides.exit && (
                <div className="cui-zone is-exit" style={rectStyle(EXIT_ZONE)}>
                  <span className="cui-zone-label">EXIT</span>
                </div>
              )}
              {frame &&
                guides.logos &&
                (Object.keys(LOGO_ANCHORS) as LogoAnchor[]).map((key) => (
                  <div
                    key={key}
                    className={`cui-zone is-logo${key === anchor ? " is-active" : ""}`}
                    style={rectStyle(LOGO_ANCHORS[key])}
                  >
                    <span className="cui-zone-label">{key}</span>
                  </div>
                ))}

              {busy && <div className="cui-busy">Reading frame</div>}
            </div>

            <div className="cui-canvas-foot">
              <span className="cui-meta">
                {frame
                  ? `${frame.name} / ${frame.width}x${frame.height} / ${Math.round(frame.bytes / 1024)} KiB`
                  : "No frame imported"}
              </span>
              <span className="cui-foot-actions">
                <button type="button" className="link-button" onClick={() => fileRef.current?.click()}>
                  {frame ? "Replace PNG" : "Import PNG"}
                </button>
                {frame && (
                  <button type="button" className="link-button" onClick={() => onFrame(null)}>
                    Clear
                  </button>
                )}
              </span>
            </div>
            {note && <p className="warning-block">{note}</p>}
          </div>

          <aside className="cui-side">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,.png"
              hidden
              onChange={(event) => {
                void load(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />

            <section className="cui-block">
              <h3>Frame rules</h3>
              <ul className="cui-rules">
                <li>PNG-24 or PNG-32 (RGBA)</li>
                <li>Minimum {FRAME_MIN.width}x{FRAME_MIN.height}</li>
                <li>Recommended {FRAME_RECOMMENDED.width}x{FRAME_RECOMMENDED.height}</li>
                <li>Maximum {FRAME_MAX.width}x{FRAME_MAX.height}, downscaled on import</li>
                <li>Under {FRAME_MAX_BYTES / 1_000_000} MB after optimisation</li>
              </ul>
            </section>

            <section className="cui-block">
              <h3>Validation</h3>
              {!frame && <p className="rail-empty">Import a PNG to check it against the frame rules.</p>}
              {frame && issues.length === 0 && (
                <p className="text-ok">Frame passes every check and is ImageLibrary ready.</p>
              )}
              <ul className="cui-issues">
                {issues.map((issue) => (
                  <li key={issue.message} className={issue.severity === "error" ? "text-danger" : "text-warn"}>
                    {issue.message}
                  </li>
                ))}
              </ul>
              {frame && (
                <p className={`cui-verdict ${errors ? "text-danger" : "text-ok"}`}>
                  {errors ? `${errors} blocking ${errors === 1 ? "error" : "errors"}` : "No blocking errors"}
                </p>
              )}
            </section>

            <section className="cui-block">
              <h3>Safe zones</h3>
              <div className="cui-guides">
                {([
                  ["cutout", "Inner transparent cutout"],
                  ["exit", "Reserved EXIT zone"],
                  ["logos", "Logo placement anchors"],
                ] as const).map(([key, label]) => (
                  <label key={key} className="cui-guide-row">
                    <input
                      type="checkbox"
                      checked={guides[key]}
                      onChange={(event) =>
                        setGuides((current) => ({ ...current, [key]: event.target.checked }))
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>

              <label className="cui-anchor-row">
                <span>Logo anchor</span>
                <select value={anchor} onChange={(event) => setAnchor(event.target.value as LogoAnchor)}>
                  {(Object.keys(LOGO_ANCHORS) as LogoAnchor[]).map((key) => (
                    <option key={key} value={key}>
                      {LOGO_ANCHOR_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>

              {frame && (
                <dl className="cui-bounds">
                  <div>
                    <dt>frame_anchor</dt>
                    <dd>{boxLabel({ left: 0, top: 0, right: frame.width, bottom: frame.height })}</dd>
                  </div>
                  <div>
                    <dt>inner_content_anchor</dt>
                    <dd>{boxLabel(pixelBox(INNER_CUTOUT, frame.width, frame.height))}</dd>
                  </div>
                  <div>
                    <dt>{anchor}_anchor</dt>
                    <dd>{boxLabel(pixelBox(LOGO_ANCHORS[anchor], frame.width, frame.height))}</dd>
                  </div>
                </dl>
              )}
            </section>

            <p className="cui-note">
              Cutout, compression and logo compositing run in the offline engine:
              <code>koba-engine cui-frame frame.png --out optimized.png</code>
              <code>koba-engine cui-logo frame.png logo.png --anchor {anchor}</code>
            </p>
          </aside>
        </div>
      </section>
    </div>
  );
}
