/**
 * Slash-command completion for the prompt composer.
 *
 * Pure string handling: given the composer text and caret, return the token
 * being completed, the replacement range and ranked suggestions. The drawer
 * owns focus and acceptance; this module owns the matching rules.
 */

import { COMMAND_REGISTRY } from "./commands.ts";

export interface SlashSuggestion {
  /** Text inserted for the token (already includes `/` or `=`). */
  value: string;
  label: string;
  detail: string;
  kind: "command" | "slot";
}

export interface SlashCompletion {
  items: SlashSuggestion[];
  /** Replacement range in the composer text. */
  from: number;
  to: number;
}

const SLOTS: Record<string, { key: string; hint: string }[]> = {
  "map.generate": [
    { key: "size", hint: "terrain size in metres" },
    { key: "biome", hint: "temperate, arctic, arid, jungle" },
    { key: "seed", hint: "integer seed" },
  ],
  "map.placeMonument": [
    { key: "type", hint: "airfield, harbor, launch site…" },
    { key: "count", hint: "1–12" },
    { key: "location", hint: "center, coast, north, south, east, west" },
  ],
  "map.connectRoads": [
    { key: "ringRoad", hint: "true / false" },
    { key: "type", hint: "road, river, rail" },
  ],
  "monument.assemble": [{ key: "preset", hint: "small, medium, large" }],
  "cave.extrudeSpline": [
    { key: "direction", hint: "north, south, east, west" },
    { key: "length", hint: "metres" },
    { key: "preset", hint: "mineshaft, natural, bunker" },
  ],
  "skin.applyBase": [
    { key: "finish", hint: "matte, gloss, metallic" },
    { key: "tint", hint: "colour name or hex" },
  ],
  "skin.setLighting": [{ key: "preset", hint: "studio, dusk, midnight" }],
};

export function slashSlots(commandId: string): { key: string; hint: string }[] {
  return SLOTS[commandId] ?? [];
}

export function slashCompletion(text: string, caret = text.length): SlashCompletion | null {
  const head = text.slice(0, caret);
  if (!head.trimStart().startsWith("/") || head.includes("\n")) return null;

  const from = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\t"), head.lastIndexOf("\n")) + 1;
  const token = head.slice(from);
  const isFirstToken = head.slice(0, from).trim() === "";

  if (isFirstToken) {
    const needle = token.replace(/^\//, "").toLowerCase();
    const items = COMMAND_REGISTRY.filter(
      (command) =>
        command.id.toLowerCase().includes(needle) || command.label.toLowerCase().includes(needle),
    ).map((command) => ({
      value: `/${command.id} `,
      label: `/${command.id}`,
      detail: command.label,
      kind: "command" as const,
    }));
    return { items, from, to: caret };
  }

  const commandId = head.slice(0, from).trim().split(/\s+/)[0]?.replace(/^\//, "") ?? "";
  const [key, value] = token.split("=");
  const needle = (key ?? "").toLowerCase();
  const used = new Set(
    head
      .slice(0, from)
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((part) => part.split("=")[0]?.toLowerCase()),
  );
  const items = slashSlots(commandId)
    .filter((slot) => !used.has(slot.key.toLowerCase()))
    .filter((slot) => slot.key.toLowerCase().startsWith(needle))
    .map((slot) => ({
      value: `${slot.key}=${value ?? ""}`,
      label: slot.key,
      detail: slot.hint,
      kind: "slot" as const,
    }));
  return items.length ? { items, from, to: caret } : null;
}

export function applyCompletion(
  text: string,
  completion: SlashCompletion,
  suggestion: SlashSuggestion,
): { text: string; caret: number } {
  const next = text.slice(0, completion.from) + suggestion.value + text.slice(completion.to);
  return { text: next, caret: completion.from + suggestion.value.length };
}
