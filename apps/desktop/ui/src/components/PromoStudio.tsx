import { useEffect, useMemo, useRef, useState } from "react";

import type { CreatorBranding, WatermarkSettings } from "../lib/branding";
import {
  AUDIO_TYPES,
  PROMO_LENGTHS,
  PROMO_STYLES,
  buildAutoPromo,
  cueTimeline,
  detectBeats,
  isAudioFile,
  promoDuration,
  snapCuesToBeats,
  waveformPeaks,
  type PromoCue,
  type PromoLength,
  type PromoStyle,
} from "../lib/promo";
import { createWatermarkPainter, downloadBlob, videoExtension } from "../lib/snippet";
import type { PromoRequest } from "../lib/appCommands";
import type { PrefabPlacement } from "../wizard/types";

interface AudioState {
  name: string;
  duration: number;
  buffer: AudioBuffer;
  peaks: number[];
  beats: number[];
}

export function PromoStudio({
  open,
  onClose,
  placements,
  sizeMetres,
  branding,
  watermark,
  record,
  request,
  onRequestApplied,
}: {
  open: boolean;
  onClose: () => void;
  placements: PrefabPlacement[];
  sizeMetres: number;
  branding: CreatorBranding;
  watermark: WatermarkSettings;
  /** Prompt-driven generation request from the drawer. */
  request?: (PromoRequest & { id: number }) | null;
  onRequestApplied?: () => void;
  record: (options: {
    shots: { x: number; z: number; radius: number; seconds: number }[];
    draw?: (ctx: CanvasRenderingContext2D, width: number, height: number, progress: number) => void;
    onProgress?: (progress: number) => void;
    audio?: {
      buffer: AudioBuffer;
      volume: number;
      fadeIn: number;
      fadeOut: number;
      trimStart: number;
      trimEnd: number;
    } | null;
  }) => Promise<Blob | null>;
}) {
  const [audio, setAudio] = useState<AudioState | null>(null);
  const [volume, setVolume] = useState(0.8);
  const [fadeIn, setFadeIn] = useState(1.5);
  const [fadeOut, setFadeOut] = useState(1.5);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [length, setLength] = useState<PromoLength>(30);
  const [style, setStyle] = useState<PromoStyle>("orbit");
  const [cues, setCues] = useState<PromoCue[]>([]);
  const [rendering, setRendering] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!request) return;
    setLength(request.length);
    setStyle(request.style);
    if (request.fadeIn !== undefined) setFadeIn(request.fadeIn);
    if (request.fadeOut !== undefined) setFadeOut(request.fadeOut);
    const generated = buildAutoPromo({ placements, sizeMetres }, { length: request.length, style: request.style });
    const next =
      request.beatSync && audio?.beats.length ? snapCuesToBeats(generated, audio.beats) : generated;
    setCues(next);
    setNote(
      request.exportNow
        ? "Prompt shot list is ready — press Export to render it."
        : request.beatSync
          ? "Beat-synced shot list generated from the prompt."
          : "Shot list generated from the prompt.",
    );
    onRequestApplied?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  const timeline = useMemo(() => cueTimeline(cues), [cues]);
  const duration = useMemo(() => promoDuration(cues), [cues]);

  const patchCue = (id: string, patch: Partial<PromoCue>) =>
    setCues((current) => current.map((cue) => (cue.id === id ? { ...cue, ...patch } : cue)));

  const moveCue = (index: number, direction: -1 | 1) =>
    setCues((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });

  const loadAudio = async (file: File | undefined) => {
    if (!file) return;
    if (!isAudioFile(file)) {
      setNote("Use an .mp3, .wav or .ogg file under 24 MB.");
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(buffer.slice(0));
      const peaks = waveformPeaks(decoded.getChannelData(0), 900);
      const bucketSeconds = decoded.duration / Math.max(1, peaks.length);
      setAudio({
        name: file.name,
        duration: decoded.duration,
        buffer: decoded,
        peaks,
        beats: detectBeats(peaks, bucketSeconds),
      });
      setTrimStart(0);
      setTrimEnd(Number(decoded.duration.toFixed(2)));
      await context.close();
      setNote(null);
    } catch {
      setNote("That audio file could not be decoded on this machine.");
    }
  };

  const autoPromo = () => {
    const next = buildAutoPromo({ placements, sizeMetres }, { length, style });
    setCues(next);
    setNote(null);
  };

  const snapToBeats = () => {
    if (!audio?.beats.length) {
      setNote("Load a track with detectable beats first.");
      return;
    }
    setCues((current) => snapCuesToBeats(current, audio.beats));
    setNote(`Cuts snapped to ${audio.beats.length} detected beats.`);
  };

  const exportPromo = async () => {
    if (!cues.length) {
      setNote("Generate a shot list first.");
      return;
    }
    setRendering(0);
    try {
      const painter = await createWatermarkPainter(watermark, branding);
      const blob = await record({
        shots: cues.map((cue) => ({
          x: cue.focus.x,
          z: cue.focus.z,
          radius: cue.radius,
          seconds: cue.seconds / Math.max(0.25, cue.speed),
        })),
        draw: (ctx, width, height) => painter(ctx, width, height),
        onProgress: (progress) => setRendering(progress),
        audio: audio
          ? {
              buffer: audio.buffer,
              volume,
              fadeIn,
              fadeOut,
              trimStart,
              trimEnd: trimEnd || audio.duration,
            }
          : null,
      });
      const sheet = {
        brand: branding.brand,
        author: branding.author,
        style,
        length,
        audio: audio?.name ?? null,
        audioSettings: { volume, fadeIn, fadeOut, trimStart, trimEnd },
        beats: audio?.beats ?? [],
        cues: cues.map((cue, index) => ({
          ...cue,
          start: timeline[index]?.start ?? 0,
          end: timeline[index]?.end ?? 0,
        })),
      };
      downloadBlob(
        new Blob([JSON.stringify(sheet, null, 2)], { type: "application/json" }),
        `koba-promo-cues-${length}s.json`,
      );
      if (!blob) {
        setNote(
          "This browser cannot record video (MediaRecorder or captureStream missing). The cue sheet was downloaded so the edit is not lost.",
        );
        return;
      }
      downloadBlob(blob, `koba-promo-${length}s.${videoExtension(blob)}`);
      setNote(
        `Rendered ${duration.toFixed(1)}s WebM${audio ? " with audio" : ""} and the cue sheet.`,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Promo render failed.");
    } finally {
      setRendering(null);
    }
  };


  // Waveform redraw: trim markers and beat ticks follow every slider change.
  useEffect(() => {
    const node = waveRef.current;
    if (!node || !audio) return;
    const width = node.clientWidth || 320;
    const height = 56;
    node.width = width;
    node.height = height;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    audio.peaks.forEach((peak, index) => {
      const x = (index / audio.peaks.length) * width;
      const bar = Math.max(1, peak * height);
      ctx.fillRect(x, (height - bar) / 2, Math.max(1, width / audio.peaks.length - 0.5), bar);
    });
    ctx.fillStyle = "#f80801";
    const span = Math.max(0.01, audio.duration);
    ctx.fillRect((trimStart / span) * width, 0, 2, height);
    ctx.fillRect(((trimEnd || audio.duration) / span) * width - 2, 0, 2, height);
    audio.beats.forEach((beat) => {
      ctx.fillRect((beat / span) * width, 0, 1, 6);
    });
  }, [audio, trimStart, trimEnd]);

  return (
    <aside
      className={`promo-panel${open ? " is-open" : ""}`}
      aria-label="Promo video studio"
      aria-hidden={!open}
    >
      <header className="promo-head">
        <div>
          <p className="promo-eyebrow">Promo studio</p>
          <h2>Cinematic promo</h2>
        </div>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="promo-body">
        <div className="promo-block">
          <h3>Audio</h3>
          <input
            ref={fileRef}
            type="file"
            accept={`${AUDIO_TYPES.join(",")},.mp3,.wav,.ogg`}
            hidden
            onChange={(event) => void loadAudio(event.target.files?.[0])}
          />
          <div className="promo-row">
            <button type="button" className="link-button" onClick={() => fileRef.current?.click()}>
              Upload audio
            </button>
            <span className="promo-meta">
              {audio ? `${audio.name} · ${audio.duration.toFixed(1)}s` : "No track"}
            </span>
          </div>

          {audio && (
            <>
              <canvas ref={waveRef} className="promo-waveform" aria-label="Audio waveform with beat markers" />
              <div className="promo-sliders">
                <label>
                  Volume {Math.round(volume * 100)}%
                  <input type="range" min={0} max={100} value={volume * 100} onChange={(event) => setVolume(Number(event.target.value) / 100)} />
                </label>
                <label>
                  Fade in {fadeIn.toFixed(1)}s
                  <input type="range" min={0} max={4} step={0.1} value={fadeIn} onChange={(event) => setFadeIn(Number(event.target.value))} />
                </label>
                <label>
                  Fade out {fadeOut.toFixed(1)}s
                  <input type="range" min={0} max={4} step={0.1} value={fadeOut} onChange={(event) => setFadeOut(Number(event.target.value))} />
                </label>
                <label>
                  Trim start {trimStart.toFixed(1)}s
                  <input type="range" min={0} max={audio.duration} step={0.1} value={trimStart} onChange={(event) => setTrimStart(Number(event.target.value))} />
                </label>
                <label>
                  Trim end {trimEnd.toFixed(1)}s
                  <input type="range" min={0} max={audio.duration} step={0.1} value={trimEnd} onChange={(event) => setTrimEnd(Number(event.target.value))} />
                </label>
              </div>
              <p className="promo-meta">{audio.beats.length} beat markers detected for cut timing.</p>
            </>
          )}
        </div>

        <div className="promo-block">
          <h3>Auto promo</h3>
          <div className="promo-row">
            <select value={length} onChange={(event) => setLength(Number(event.target.value) as PromoLength)}>
              {PROMO_LENGTHS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select value={style} onChange={(event) => setStyle(event.target.value as PromoStyle)}>
              {PROMO_STYLES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button type="button" className="link-button" onClick={autoPromo}>
              Generate shots
            </button>
            {audio && audio.beats.length > 0 && (
              <button type="button" className="link-button" onClick={snapToBeats}>
                Snap cuts to beats
              </button>
            )}
          </div>
        </div>

        <div className="promo-block">
          <h3>Timeline · {duration.toFixed(1)}s</h3>
          {cues.length === 0 && <p className="promo-meta">Generate an auto promo to start editing.</p>}
          <ol className="promo-cues">
            {cues.map((cue, index) => (
              <li key={cue.id}>
                <div className="promo-cue-head">
                  <strong>{cue.label}</strong>
                  <span>{(cue.seconds / Math.max(0.25, cue.speed)).toFixed(1)}s</span>
                </div>
                <div className="promo-cue-controls">
                  <button type="button" aria-label="Move shot up" onClick={() => moveCue(index, -1)}>
                    ↑
                  </button>
                  <button type="button" aria-label="Move shot down" onClick={() => moveCue(index, 1)}>
                    ↓
                  </button>
                  <label>
                    Length
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={0.5}
                      value={cue.seconds}
                      onChange={(event) => patchCue(cue.id, { seconds: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Speed {cue.speed.toFixed(2)}×
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={cue.speed}
                      onChange={(event) => patchCue(cue.id, { speed: Number(event.target.value) })}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="promo-export" onClick={() => void exportPromo()} disabled={rendering !== null || !cues.length}>
            {rendering === null ? "Export 1080p WebM + cue sheet" : `Rendering ${Math.round((rendering ?? 0) * 100)}%`}
          </button>
          {note && <p className="promo-note">{note}</p>}
          <p className="promo-meta">
            Recording captures the current viewport resolution. The uploaded track is mixed into the export
            with its trim, volume and fades; if this browser cannot record video, the cue sheet is still saved.
          </p>
        </div>
      </section>
    </aside>
  );
}
