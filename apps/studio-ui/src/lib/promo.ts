/**
 * Promo Studio maths: beat detection, automatic shot planning and the
 * timeline model. Everything is deterministic and local.
 */

import type { PrefabPlacement } from "../wizard/types";

export type PromoStyle = "orbit" | "flythrough" | "reveal" | "timelapse";
export type PromoLength = 15 | 30 | 60;

export interface PromoCue {
  id: string;
  label: string;
  focus: { x: number; z: number };
  /** Clip length in seconds before speed is applied. */
  seconds: number;
  /** 0.5 (slow-mo) .. 2 (timelapse). */
  speed: number;
  radius: number;
}

export const PROMO_STYLES: { id: PromoStyle; label: string; speed: number }[] = [
  { id: "orbit", label: "Smooth orbit", speed: 1 },
  { id: "flythrough", label: "Action fly-through", speed: 1.35 },
  { id: "reveal", label: "Dramatic reveal", speed: 0.5 },
  { id: "timelapse", label: "Day-to-night timelapse", speed: 2 },
];

export const PROMO_LENGTHS: { value: PromoLength; label: string }[] = [
  { value: 15, label: "15s Short" },
  { value: 30, label: "30s Store promo" },
  { value: 60, label: "60s Server trailer" },
];

export function cueDuration(cue: PromoCue): number {
  return cue.seconds / Math.max(0.25, cue.speed);
}

/** Decoded track plus mix settings handed to the recorder for muxing. */
export interface TourAudio {
  buffer: AudioBuffer;
  /** 0..1 output gain. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  trimStart: number;
  trimEnd: number;
}

/**
 * Moves each cut onto the nearest detected beat inside the tolerance, keeping
 * the requested runtime. Cuts that cannot reach a beat stay where they are.
 */
export function snapCuesToBeats(
  cues: PromoCue[],
  beats: number[],
  options: { tolerance?: number; minSeconds?: number } = {},
): PromoCue[] {
  const tolerance = options.tolerance ?? 0.45;
  const minSeconds = options.minSeconds ?? 1;
  if (!beats.length || cues.length < 2) return cues;
  const snapped: PromoCue[] = [];
  let cursor = 0;
  cues.forEach((cue, index) => {
    const naturalEnd = cursor + cueDuration(cue);
    const isLast = index === cues.length - 1;
    let target = naturalEnd;
    if (!isLast) {
      let best = Number.POSITIVE_INFINITY;
      for (const beat of beats) {
        if (beat <= cursor + minSeconds) continue;
        const distance = Math.abs(beat - naturalEnd);
        if (distance < best && distance <= tolerance) {
          best = distance;
          target = beat;
        }
      }
    }
    const effective = Math.max(minSeconds, target - cursor);
    snapped.push({ ...cue, seconds: Number((effective * Math.max(0.25, cue.speed)).toFixed(3)) });
    cursor += effective;
  });
  return snapped;
}

export function promoDuration(cues: PromoCue[]): number {
  return cues.reduce((total, cue) => total + cueDuration(cue), 0);
}

/** Timeline start times, used by the editor list and the cue sheet export. */
export function cueTimeline(cues: PromoCue[]): { start: number; end: number }[] {
  let cursor = 0;
  return cues.map((cue) => {
    const start = cursor;
    cursor += cueDuration(cue);
    return { start, end: cursor };
  });
}

/**
 * Local peak picker over a normalised waveform. A beat is a bucket louder than
 * the surrounding window and further than `minGap` seconds from the previous
 * beat, which tracks kick/snare transients well enough for camera cuts.
 */
export function detectBeats(
  peaks: number[],
  secondsPerBucket: number,
  options: { sensitivity?: number; minGap?: number } = {},
): number[] {
  const sensitivity = options.sensitivity ?? 1.35;
  const minGap = options.minGap ?? 0.28;
  if (peaks.length < 3 || secondsPerBucket <= 0) return [];
  const beats: number[] = [];
  let last = -Infinity;
  for (let index = 1; index < peaks.length - 1; index += 1) {
    const from = Math.max(0, index - 8);
    const to = Math.min(peaks.length, index + 9);
    let sum = 0;
    for (let window = from; window < to; window += 1) sum += peaks[window];
    const average = sum / (to - from);
    const time = index * secondsPerBucket;
    if (peaks[index] > average * sensitivity && peaks[index] >= peaks[index - 1] && peaks[index] >= peaks[index + 1]) {
      if (time - last >= minGap) {
        beats.push(Number(time.toFixed(3)));
        last = time;
      }
    }
  }
  return beats;
}

/** Downsamples an audio buffer into normalised 0..1 peaks for the waveform. */
export function waveformPeaks(buffer: Float32Array, buckets = 900): number[] {
  if (!buffer.length) return [];
  const size = Math.max(1, Math.floor(buffer.length / buckets));
  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * size;
    if (start >= buffer.length) break;
    const end = Math.min(buffer.length, start + size);
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(buffer[index]);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
  }
  const loudest = Math.max(...peaks, 0.0001);
  return peaks.map((peak) => peak / loudest);
}

export interface PromoCueInput {
  placements: PrefabPlacement[];
  sizeMetres: number;
}

/**
 * Converts the current draft into a shot list. The opening establishing shot is
 * always the island itself; monument entrances follow in map order so the promo
 * tells the same story as the map layout.
 */
export function buildAutoPromo(
  input: PromoCueInput,
  options: { length: PromoLength; style: PromoStyle },
): PromoCue[] {
  const style = PROMO_STYLES.find((entry) => entry.id === options.style) ?? PROMO_STYLES[0];
  const cues: PromoCue[] = [
    {
      id: "cue-establishing",
      label: "Island establishing shot",
      focus: { x: 0, z: 0 },
      seconds: 4,
      speed: style.speed,
      radius: Math.max(400, input.sizeMetres * 0.32),
    },
  ];
  for (const placement of input.placements) {
    cues.push({
      id: `cue-${placement.id}`,
      label: placement.name,
      focus: { x: placement.position.x, z: placement.position.z },
      seconds: options.style === "reveal" ? 5 : 4,
      speed: style.speed,
      radius: Math.max(90, (placement.collisionRadius ?? 12) * 7),
    });
  }

  // Fill the requested runtime by cycling the shots that already exist.
  const desired = options.length;
  let index = 0;
  while (promoDuration(cues) < desired && cues.length < 24) {
    const template = cues[index % cues.length];
    cues.push({ ...template, id: `${template.id}-${cues.length}` });
    index += 1;
  }
  // Trim the tail until the runtime fits the requested length.
  while (cues.length > 1 && promoDuration(cues) > desired) {
    cues.pop();
  }
  return cues;
}

export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
export const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg"];

export function isAudioFile(file: { type: string; name: string; size: number }): boolean {
  if (file.size > MAX_AUDIO_BYTES) return false;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return ["mp3", "wav", "ogg"].includes(extension) || AUDIO_TYPES.includes(file.type);
}
