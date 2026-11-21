import { WORLD_SIZE_PRESETS } from "../lib/worldSize.ts";
import type { LandmassShape } from "./types";

/**
 * Square world sizes the wizard offers.
 *
 * Rust worlds are always square and the height layer is `size + 1` samples
 * across. These are the stock server sizes; any other size from 1000 m up is
 * typed into the freeform field, so the presets stay a convenience.
 */
export const WORLD_SIZES = WORLD_SIZE_PRESETS;

/** Projects saved before map shapes existed keep the original island shape. */
export const DEFAULT_LANDMASS: LandmassShape = "single-island";

export interface LandmassPreset {
  id: LandmassShape;
  label: string;
  body: string;
}

export const LANDMASS_PRESETS: LandmassPreset[] = [
  {
    id: "single-island",
    label: "Single Island",
    body: "One rounded landmass with a wide coastal shelf",
  },
  {
    id: "archipelago",
    label: "Archipelago",
    body: "Scattered islands over shallow sea",
  },
  {
    id: "atoll",
    label: "Atoll / Lagoon",
    body: "Land ring around a sheltered lagoon",
  },
  {
    id: "twin-continents",
    label: "Twin Continents",
    body: "Two landmasses split by a channel",
  },
];
