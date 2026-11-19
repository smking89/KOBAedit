/**
 * Offline prompt parser. Turns a plain-English sentence (or a `/command` line)
 * into registry commands. Deterministic: keyword and slot rules only.
 */

import { COMMAND_REGISTRY, commandIds, type ParsedCommand } from "./commands.ts";
import type { ProjectKind } from "../wizard/types";

export interface PromptClarification {
  text: string;
  chips: string[];
}

export interface PromptParseResult {
  commands: ParsedCommand[];
  unmatched: string[];
  clarification?: PromptClarification;
}

const BIOMES: { words: string[]; biome: string }[] = [
  { words: ["snow", "snowy", "winter", "ice", "arctic", "tundra"], biome: "arctic" },
  { words: ["desert", "sand", "arid", "dune"], biome: "arid" },
  { words: ["jungle", "tropical", "rainforest"], biome: "jungle" },
  { words: ["ocean", "water", "sea"], biome: "ocean" },
  { words: ["forest", "green", "temperate", "grass"], biome: "temperate" },
];

const LANDMARKS = [
  "harbor",
  "harbour",
  "port",
  "dock",
  "airfield",
  "airport",
  "runway",
  "dome",
  "sphere tank",
  "launch site",
  "launch",
  "military tunnel",
  "bandit camp",
  "outpost",
  "fishing village",
  "gas station",
  "supermarket",
  "trainyard",
  "water treatment",
];

const LOCATIONS = ["north", "south", "east", "west", "center", "centre", "coast", "coastal"];

const COLORS: Record<string, string> = {
  red: "#F80801",
  black: "#141414",
  white: "#FFFFFF",
  grey: "#B8BDC2",
  gray: "#B8BDC2",
  silver: "#B8BDC2",
  tan: "#C2A887",
  sand: "#C2A887",
  green: "#1E241E",
};

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const MATERIALS = ["wood", "stone", "brick", "metal", "concrete"];

function numberIn(text: string): number | null {
  const scaled = text.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (scaled) return Math.round(Number(scaled[1]) * 1000);
  const metres = text.match(/(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)\b/i);
  if (metres) return Math.round(Number(metres[1]));
  return null;
}

function countIn(text: string): number | null {
  const digit = text.match(/\b(\d{1,2})\b/);
  if (digit) {
    const value = Number(digit[1]);
    if (value >= 1 && value <= 24) return value;
  }
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return value;
  }
  return null;
}

function colorIn(text: string): string | null {
  const hex = text.match(/#[0-9a-f]{6}\b/i);
  if (hex) return hex[0].toUpperCase();
  for (const [word, hexValue] of Object.entries(COLORS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return hexValue;
  }
  return null;
}

export function splitSegments(input: string): string[] {
  return input
    .split(/(?:,|;|\n|\s+and\s+|\s+then\s+|\s*\.\s+)/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** `/map.generate size=4500 biome=arctic` */
function parseShortcut(segment: string): ParsedCommand | null {
  const match = segment.match(/^\/([a-z]+(?:\.[a-zA-Z]+)+)\s*(.*)$/);
  if (!match) return null;
  const id = match[1];
  if (!commandIds().includes(id)) return null;
  const args: Record<string, unknown> = {};
  for (const token of match[2].split(/\s+/).filter(Boolean)) {
    const [key, raw] = token.split("=");
    if (!key || raw === undefined) continue;
    args[key] = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return { id, args, raw: segment };
}

/** Parses one already-split segment; exported so the drawer can mix app and draft commands. */
export function parsePromptSegment(segment: string, mode: ProjectKind): ParsedCommand | null {
  const shortcut = parseShortcut(segment);
  if (shortcut) return shortcut;

  const text = segment.toLowerCase();
  const lower = ` ${text} `;
  const has = (words: string[]) => words.some((word) => lower.includes(` ${word}`) || lower.includes(`${word} `));

  // Tunnels and caves.
  if (/(tunnel|cave|mineshaft|mine shaft)/.test(text)) {
    const direction = ["north", "south", "east", "west"].find((word) => text.includes(word)) ?? "north";
    const preset = /sewer/.test(text) ? "sewer" : /natural|cave/.test(text) ? "natural" : "mineshaft";
    return {
      id: "cave.extrudeSpline",
      args: { direction, preset, length: numberIn(text) ?? 80 },
      raw: segment,
    };
  }

  // Compounds and modular monuments.
  if (/(compound|modular|foundations?|build a|assemble)/.test(text)) {
    const footprint = /3x3|three by three/.test(text) ? "3x3" : /2x2|two by two/.test(text) ? "2x2" : "2x2";
    const material = MATERIALS.find((word) => text.includes(word)) ?? "stone";
    return {
      id: "monument.assemble",
      args: { footprint, material },
      raw: segment,
    };
  }

  // Roads, rails and ring roads.
  if (/(ring road|road|highway|path|rail|train loop|train)/.test(text)) {
    return {
      id: "map.connectRoads",
      args: {
        ringRoad: /ring|loop/.test(text),
        type: /rail|train/.test(text) ? "rail" : "road",
      },
      raw: segment,
    };
  }

  // Landmark placement.
  const landmark = LANDMARKS.find((word) => text.includes(word));
  if (landmark && /(place|add|drop|spawn|put|with)/.test(text)) {
    const location = LOCATIONS.find((word) => text.includes(word)) ?? "center";
    return {
      id: "map.placeMonument",
      args: {
        type: landmark === "harbour" ? "harbor" : landmark,
        count: countIn(text) ?? 1,
        location: location === "centre" ? "center" : location === "coastal" ? "coast" : location,
      },
      raw: segment,
    };
  }

  // Lighting works in both workspaces (the preview lighting is shared).
  if (/(noon|sunset|midnight|interior)\b/.test(text) && /(lighting|light|time of day|preview)/.test(text)) {
    const preset = /midnight/.test(text)
      ? "midnight"
      : /sunset/.test(text)
        ? "sunset"
        : /interior/.test(text)
          ? "interior"
          : "noon";
    return { id: "skin.setLighting", args: { preset }, raw: segment };
  }

  // Skin finish and lighting.
  if (mode === "skin" || /(skin|finish|camo|matte|steel|carbon|rust|glow|scratches)/.test(text)) {
    if (/(noon|sunset|midnight|interior|lighting|preview)/.test(text)) {
      const preset = /midnight/.test(text)
        ? "midnight"
        : /sunset/.test(text)
          ? "sunset"
          : /interior/.test(text)
            ? "interior"
            : "noon";
      return { id: "skin.setLighting", args: { preset }, raw: segment };
    }
    if (/(skin|finish|matte|steel|carbon|rust|glow|camo|apply)/.test(text)) {
      const preset = /steel|metal|brushed/.test(text)
        ? "metal"
        : /carbon|camo/.test(text)
          ? "carbon"
          : /wood/.test(text)
            ? "wood"
            : "polymer";
      return {
        id: "skin.applyBase",
        args: { base: preset, color: colorIn(text) ?? COLORS.black },
        raw: segment,
      };
    }
  }

  // Terrain generation.
  if (/(island|terrain|map|world|generate|make|create)/.test(text)) {
    const biome = BIOMES.find((entry) => entry.words.some((word) => text.includes(word)))?.biome ?? "temperate";
    return {
      id: "map.generate",
      args: { size: numberIn(text) ?? 4500, biome },
      raw: segment,
    };
  }

  return null;
}

export function parsePrompt(input: string, mode: ProjectKind = "map"): PromptParseResult {
  const text = input.trim();
  if (!text) return { commands: [], unmatched: [] };

  const commands: ParsedCommand[] = [];
  const unmatched: string[] = [];
  for (const segment of splitSegments(text)) {
    const command = parsePromptSegment(segment, mode);
    if (command) commands.push(command);
    else unmatched.push(segment);
  }

  if (!commands.length) {
    return {
      commands,
      unmatched,
      clarification: {
        text: "I could not find a command in that sentence. Try one of these:",
        chips: [
          "Make a 4.5k arctic island",
          "Place 2 harbors on the coast and connect a ring road",
          "Dig an 80 m mineshaft tunnel heading north",
          "Apply matte black finish and preview at midnight",
        ],
      },
    };
  }

  // De-duplicate identical commands produced by overlapping keywords.
  const seen = new Set<string>();
  const unique = commands.filter((command) => {
    const key = `${command.id}:${JSON.stringify(command.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { commands: unique, unmatched };
}

/** Serialises a parsed command back into an editable `/command key=value` line. */
export function commandToPrompt(command: ParsedCommand): string {
  const slots = Object.entries(command.args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `/${command.id}${slots ? ` ${slots}` : ""}`;
}

export function commandLabel(id: string): string {
  return COMMAND_REGISTRY.find((command) => command.id === id)?.label ?? id;
}
