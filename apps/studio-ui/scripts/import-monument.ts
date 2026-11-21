/**
 * Import a monument package (RMPF) into a KOBA Studios monument project.
 *
 * A monument package is a binary header plus a JSON body that lists every
 * Facepunch prefab the monument is made from, with its offset from the
 * monument origin. This script turns that list into a real monument project —
 * 24 real prefabs on a flat testing stage — so the monument can be opened,
 * inspected and edited in the editor instead of only shipped to a server.
 *
 * Guarantees it enforces:
 *  - every prefab in the package must exist in the Facepunch catalogue, so a
 *    bad path aborts the import instead of placing a proxy;
 *  - the monument is grouped under one root marker, so it reads as a single
 *    object in the outliner;
 *  - rebuilds keep their ids (`prefab-<monument>-<part>`), so a re-import does
 *    not drop selection, locks or visibility.
 *
 * Run: npm run monument:import --workspace @koba/studio-ui
 *   or: npm run monument:import --workspace @koba/studio-ui -- \
 *         --package "$HOME/Desktop/dome monument test"
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { generateTerrainPreview, samplePreviewHeight } from "../src/lib/procedural.ts";

interface PackagePlacement {
  key: string;
  prefab: string;
  short_name?: string;
  category?: string;
  group?: string;
  tag?: string;
  position: { x: number; y: number; z: number };
  yaw?: number;
  scale?: number;
}

interface MonumentPackage {
  key: string;
  name: string;
  kind: string;
  footprint_radius: number;
  placements: PackagePlacement[];
}

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

/** Walk up from the package directory to the workspace that owns `data/`. */
function findWorkspaceRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      readFileSync(join(current, "data/rust-studio.db"));
      return current;
    } catch {
      current = resolve(current, "..");
    }
  }
  return resolve(process.cwd(), "../..");
}

const projectRoot = findWorkspaceRoot();
const dbPath = arg("db", join(projectRoot, "data/rust-studio.db"));
const dataDir = arg("data-dir", join(projectRoot, "data"));
const packageDir = resolve(arg("package", join(homedir(), "Desktop/dome monument test")));
const markerPrefab = "assets/prefabs/misc/monumentsign/monumentsigntext.prefab";

/** The monument body is JSON behind a 16-byte RMPF header. */
function readPackage(path: string): MonumentPackage {
  const raw = readFileSync(path);
  const magic = raw.subarray(0, 4).toString("latin1");
  if (magic !== "RMPF") throw new Error(`${path} is not an RMPF monument package (header ${magic})`);
  const start = raw.indexOf(0x7b); // "{"
  if (start < 0) throw new Error(`${path} has no JSON body`);
  return JSON.parse(raw.subarray(start).toString("utf8")) as MonumentPackage;
}

function findPackage(preferred: string | undefined): string {
  if (preferred) return resolve(preferred);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full, depth + 1);
      else if (name.endsWith(".prefab") && info.size > 16) {
        const head = readFileSync(full).subarray(0, 4).toString("latin1");
        if (head === "RMPF") found.push(full);
      }
    }
  };
  walk(packageDir, 0);
  if (!found.length) throw new Error(`no RMPF monument package under ${packageDir}`);
  return found[0];
}

const packagePath = findPackage(arg("prefab", ""));
const monument = readPackage(packagePath);
const projectName = arg("name", monument.name);
const size = Number(arg("size", "4500"));
const half = size / 2;

const db = new DatabaseSync(dbPath);

interface Catalogue {
  assetId: string;
  radius: number;
  height: number;
}

const catalogue = new Map<string, Catalogue>();
for (const row of db
  .prepare(
    `SELECT asset_path, bounds_min_x, bounds_min_y, bounds_min_z,
            bounds_max_x, bounds_max_y, bounds_max_z
       FROM prefabs`,
  )
  .all() as Record<string, number | string>[]) {
  const width = Math.abs(Number(row.bounds_max_x) - Number(row.bounds_min_x));
  const depth = Math.abs(Number(row.bounds_max_z) - Number(row.bounds_min_z));
  const height = Math.abs(Number(row.bounds_max_y) - Number(row.bounds_min_y));
  catalogue.set(String(row.asset_path), {
    assetId: String(row.asset_path),
    radius: Number.isFinite(width) && Number.isFinite(depth) ? Math.max(1, Math.round(Math.max(width, depth) / 2)) : 6,
    height: Number.isFinite(height) && height > 0 ? Math.max(1, Math.round(height)) : 3,
  });
}

// --- terrain ---------------------------------------------------------------

// The flat sand stage is what a monument project starts on (`MONUMENT_FLOORS`).
// Take the draft fields this script does not own from a saved project.
const named = db
  .prepare("SELECT id FROM projects WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
  .get(projectName) as { id: string } | undefined;
const template =
  (named
    ? (db
        .prepare("SELECT project_id, state_json FROM project_wizard_state WHERE project_id = ?")
        .get(named.id) as { project_id: string; state_json: string } | undefined)
    : undefined) ??
  (db
    .prepare(
      `SELECT s.project_id, s.state_json FROM project_wizard_state s
         JOIN projects p ON p.id = s.project_id
        WHERE p.kind = 'monument'
        ORDER BY s.updated_at DESC LIMIT 1`,
    )
    .get() as { project_id: string; state_json: string } | undefined) ??
  (db
    .prepare(
      `SELECT s.project_id, s.state_json FROM project_wizard_state s
         JOIN projects p ON p.id = s.project_id
        WHERE p.kind = 'map'
        ORDER BY s.updated_at DESC LIMIT 1`,
    )
    .get() as { project_id: string; state_json: string } | undefined);
if (!template) throw new Error("no saved project to use as a draft template");
const state = JSON.parse(template.state_json) as { draft: Record<string, any>; stepId: string };
const draft = state.draft;

draft.terrain = {
  ...draft.terrain,
  sizeMetres: size,
  preset: "flat",
  floorHeight: 20,
  floorSplat: "sand",
  floorBiome: "arid",
  waterLevel: -40,
  mountainScale: 0.1,
  detail: 0.1,
  treeDensity: 0.1,
  biomeWeights: [0.6, 0.25, 0.1, 0.05],
  heightmap: undefined,
  masks: [],
  layers: [],
  activeLayerId: null,
};
const preview = generateTerrainPreview(draft.terrain, 257);
const groundAt = (x: number, z: number) => samplePreviewHeight(preview, x, z, size);

// --- placements ------------------------------------------------------------

const previous = new Map<string, Record<string, unknown>>(
  (Array.isArray(draft.placements) ? (draft.placements as Record<string, unknown>[]) : []).map((item) => [
    String(item.id),
    item,
  ]),
);

interface Placement {
  id: string;
  assetId: string;
  name: string;
  position: { x: number; y: number; z: number };
  rotationEuler: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  parentId: string | null;
  collisionRadius: number;
  collisionHeight: number;
  flatten: boolean;
  flattenRadius: number;
  flattenFalloff: number;
  clearFoliage: boolean;
  noBuildZone: boolean;
  lootTier: 1 | 2 | 3;
  lootProfile: string;
  ioWiring: string;
  npcCount: number;
  locked: boolean;
  visible?: boolean;
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const monumentKey = slug(monument.key || monument.name);
const floor = groundAt(0, 0);

function place(
  entry: Catalogue,
  name: string,
  id: string,
  x: number,
  z: number,
  y: number,
  yaw: number,
  scale: number,
  parentId: string | null,
  lootTier: 1 | 2 | 3,
): Placement {
  const carried = previous.get(id);
  return {
    id,
    assetId: entry.assetId,
    name,
    position: { x: round(x), y: round(y, 2), z: round(z) },
    rotationEuler: { x: 0, y: Math.round(yaw), z: 0 },
    scale: { x: scale, y: scale, z: scale },
    parentId,
    collisionRadius: entry.radius,
    collisionHeight: entry.height,
    flatten: false,
    flattenRadius: Math.max(6, Math.round(entry.radius)),
    flattenFalloff: 12,
    clearFoliage: true,
    noBuildZone: true,
    lootTier,
    lootProfile: "",
    ioWiring: "",
    npcCount: 0,
    locked: Boolean(carried?.locked),
    ...(typeof carried?.visible === "boolean" ? { visible: carried.visible } : {}),
  };
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const rootId = `prefab-${monumentKey}-root`;
const marker = catalogue.get(markerPrefab);
if (!marker) throw new Error(`${markerPrefab} is not in the Facepunch catalogue`);
const placements: Placement[] = [
  place(
    marker,
    `${monument.name} — measure ${monument.footprint_radius} m`,
    rootId,
    0,
    0,
    floor + 1,
    0,
    1,
    null,
    1,
  ),
];

const unresolved: string[] = [];
for (const part of monument.placements) {
  const entry = catalogue.get(part.prefab);
  if (!entry) {
    unresolved.push(`${part.key}: ${part.prefab} is not in the Facepunch catalogue`);
    continue;
  }
  const yaw = part.yaw ?? 0;
  const scale = part.scale ?? 1;
  placements.push(
    place(
      entry,
      `${part.key}${part.group ? ` · ${part.group}` : ""}`,
      `prefab-${monumentKey}-${slug(part.key)}`,
      part.position.x,
      part.position.z,
      floor + part.position.y,
      yaw,
      scale,
      rootId,
      part.group === "loot" ? 2 : 1,
    ),
  );
}

draft.name = projectName;
draft.projectKind = "monument";
draft.branch = "world";
draft.mode = "offline";
draft.placements = placements;
draft.selectedPlacementId = placesRoot(placements);
draft.splines = [];
draft.loot = {
  ...draft.loot,
  noBuildZones: placements.filter((item) => item.noBuildZone).length,
};
draft.export = { ...draft.export, fileName: monumentKey };

function placesRoot(items: Placement[]) {
  return items[0]?.id ?? null;
}

// --- write -----------------------------------------------------------------

const now = new Date().toISOString();
const payload = { draft, stepId: "monuments", savedAt: now };
const requestedId = arg("project-id", "");
const target =
  (requestedId
    ? (db.prepare("SELECT id FROM projects WHERE id = ?").get(requestedId) as { id: string } | undefined)
    : undefined) ??
  (db.prepare("SELECT id FROM projects WHERE name = ? ORDER BY updated_at DESC LIMIT 1").get(projectName) as
    | { id: string }
    | undefined);

// `--project-id` defaults to "", which `??` would happily keep as the id.
const projectId = target?.id || requestedId || crypto.randomUUID();
if (target) {
  db.prepare(
    `UPDATE projects SET name = ?, kind = 'monument', export_target = 'prefab', workspace_path = ?,
        wizard_phase = 'monuments', wizard_step_index = 0, is_dirty = 0,
        map_size = ?, map_resolution = ?, seed = ?, updated_at = ? WHERE id = ?`,
  ).run(projectName, `projects/${projectId}`, size, size + 1, Number(draft.terrain.seed), now, projectId);
  db.prepare("UPDATE project_wizard_state SET state_json = ?, updated_at = ? WHERE project_id = ?").run(
    JSON.stringify(payload),
    now,
    projectId,
  );
} else {
  db.prepare(
    `INSERT INTO projects (id, name, kind, export_target, base_mesh_id, schema_version, workspace_path,
        wizard_phase, wizard_step_index, studio_mode, is_dirty, thumbnail_path, map_size, map_resolution, seed,
        created_at, updated_at, last_exported_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    projectId,
    projectName,
    "monument",
    "prefab",
    null,
    1,
    `projects/${projectId}`,
    "monuments",
    0,
    0,
    0,
    null,
    size,
    size + 1,
    Number(draft.terrain.seed),
    now,
    now,
    null,
  );
  db.prepare("INSERT INTO project_wizard_state (project_id, state_json, updated_at) VALUES (?,?,?)").run(
    projectId,
    JSON.stringify(payload),
    now,
  );
}

const workspace = join(dataDir, "projects", projectId);
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "project.json"), `${JSON.stringify(payload, null, 2)}\n`);

const groups = monument.placements.reduce<Record<string, number>>((totals, part) => {
  const key = part.group ?? "ungrouped";
  totals[key] = (totals[key] ?? 0) + 1;
  return totals;
}, {});

console.log(`${monument.name} (${monument.kind}) → ${projectId}`);
console.log(`package ${packagePath.replace(projectRoot, ".")}`);
console.log(
  `flat stage ${size} m at ${floor.toFixed(1)} m · ${placements.length} placements ` +
    `(${placements.length - 1} parts in ${Object.keys(groups).length} groups: ` +
    `${Object.entries(groups)
      .map(([group, count]) => `${group} ${count}`)
      .join(", ")})`,
);
if (unresolved.length) {
  console.error(`\n${unresolved.length} unresolved prefabs:\n${unresolved.join("\n")}`);
  process.exitCode = 1;
}
