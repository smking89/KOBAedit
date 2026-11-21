export type AutosavePhase = "idle" | "saving" | "saved" | "partial" | "error";

export interface AutosaveState {
  phase: AutosavePhase;
  /** Last successful draft write; retained when a later write fails. */
  savedAt: string | null;
}

export interface AutosaveBadge {
  tone: "neutral" | "ok" | "warn" | "danger";
  label: string;
  title: string;
}

/**
 * Browser drafts keep grids in IndexedDB; desktop drafts have only
 * localStorage, where an omitted grid means the save is partial.
 */
export function autosavePhase({
  ok,
  omittedGrids,
  gridsStored,
  desktop,
}: {
  ok: boolean;
  omittedGrids: boolean;
  gridsStored: boolean;
  desktop: boolean;
}): AutosavePhase {
  if (!ok) return "error";
  const gridsDurable = desktop ? !omittedGrids : gridsStored;
  return gridsDurable ? "saved" : "partial";
}

export function autosaveBadge(autosave: AutosaveState): AutosaveBadge | null {
  switch (autosave.phase) {
    case "idle":
      return null;
    case "saving":
      return { tone: "neutral", label: "Saving draft", title: "Writing the local draft." };
    case "saved": {
      const time = autosave.savedAt
        ? new Date(autosave.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "just now";
      return {
        tone: "ok",
        label: `Autosaved ${time}`,
        title: "The draft autosaves locally. Imported heightmaps and masks are stored separately.",
      };
    }
    case "partial":
      return {
        tone: "warn",
        label: "Draft saved, grids not stored",
        title:
          "The draft saved, but imported heightmaps or masks were left out. Keep this tab open and save a project copy.",
      };
    case "error":
      return {
        tone: "danger",
        label: "Autosave failed",
        title: "Autosave could not write the draft. Keep this tab open and export a project copy.",
      };
  }
}
