import type { WizardDraft, WizardStepId } from "../wizard/types";

export interface ImageProfile {
  width: number;
  height: number;
  dominant: string;
  accent: string;
  luminance: number;
  colors: string[];
}

export interface ZipSummary {
  entries: number;
  names: string[];
  mapFiles: string[];
  prefabFiles: string[];
  projectDraft: WizardDraft | null;
}

export interface KobaAttachment {
  id: string;
  name: string;
  kind: "image" | "zip";
  bytes: number;
  previewUrl?: string;
  image?: ImageProfile;
  zip?: ZipSummary;
  /** Unity AssetBundle summary when the attachment was a real .bundle. */
  unity?: {
    format: string;
    unityVersion: string;
    compression: string;
    assetBytes: number;
  };
}

export interface KobaGeneration {
  draft: WizardDraft;
  kind: "map" | "monument" | "skin";
  step: WizardStepId;
  name: string;
  summary: string[];
  chips?: { label: string; prompt: string }[];
}

export type KobaRole = "user" | "assistant";

export interface KobaMessage {
  id: string;
  role: KobaRole;
  text: string;
  lines?: string[];
  attachments?: string[];
  exportPath?: string;
  exportBytes?: number;
  error?: boolean;
  chips?: { label: string; prompt: string }[];
  /** Prompt-build receipt: one-click undo for the whole animated build. */
  undo?: boolean;
  /** Human name of the batch, e.g. "Place 3 harbors". */
  undoLabel?: string;
}
