/**
 * Prefab ids are Unity asset paths (`assets/prefabs/building/door.double.hinged/
 * door.double.hinged.metal.item.prefab`); the index stores the file stem as the
 * name. Cards should read like content, not like filesystem entries.
 */

const ACRONYMS: Record<string, string> = {
  ak47: "AK-47",
  lr300: "LR-300",
  hqm: "HQM",
  io: "IO",
  npc: "NPC",
  tc: "TC",
  dlc: "DLC",
  apc: "APC",
  sam: "SAM",
  rpg: "RPG",
};

export function prettifyPrefabName(value: string): string {
  const stem = value
    .replace(/\.item\.prefab$/i, "")
    .replace(/\.prefab$/i, "")
    .split("/")
    .filter(Boolean)
    .pop() ?? value;
  const words = stem.split(/[._\-\s]+/).filter(Boolean);
  if (!words.length) return value;
  return words
    .map((word) => {
      const known = ACRONYMS[word.toLowerCase()];
      if (known) return known;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}
