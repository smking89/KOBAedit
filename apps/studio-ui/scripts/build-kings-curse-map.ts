/**
 * Build (or rebuild) "The King's Curse" map project from the design plan.
 *
 * The plan lives outside the app (`~/Desktop/icons/kings_curse_site_plan.json`);
 * this script is the reproducible builder so the map can be regenerated after a
 * plan change instead of hand-editing the project.
 *
 * Guarantees it enforces:
 *  - every landmark is a real Facepunch prefab that exists in the catalogue —
 *    an unknown prefab path aborts the build instead of placing a proxy;
 *  - offshore monuments (both oil rigs, the fishing village) are placed over
 *    open water, with their origin on the water plane, never on a beach;
 *  - land monuments sit on land above the water line, and are nudged to the
 *    nearest valid cell instead of drowning when the plan point lands in sea;
 *  - custom-composition sites (no single Facepunch prefab) get a monument-sign
 *    site marker so their footprint is visible and reserved in the editor.
 *
 * Terrain heights come from the app's own generator (`lib/procedural.ts`), so
 * "in water" here means exactly what the viewport draws.
 *
 * Run: npm run map:kings-curse --workspace @koba/studio-ui
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  generateTerrainPreview,
  samplePreviewHeight,
  type TerrainPreview,
} from "../src/lib/procedural.ts";

type Vec2 = { x: number; z: number };

interface PlanSite {
  key: string;
  name: string;
  faction: string;
  role: string;
  origin: Vec2;
  ground_height: number;
  radius: number;
  landmark?: {
    status?: string;
    prefab?: string;
    short_name?: string;
    placements?: number;
  };
  intent?: string;
}

interface PlanFuelPump {
  name: string;
  site: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

interface PlanSpawn {
  key: string;
  faction: string;
  site: string;
  world: { x: number; y: number; z: number };
  yaw?: number;
  prefab?: string;
}

interface Plan {
  map: { key: string; name: string; size: number; seed: number };
  sites: PlanSite[];
  spawns?: PlanSpawn[];
  fuel_pumps?: PlanFuelPump[];
  roads?: {
    name?: string;
    width?: number;
    loop?: (Vec2 & { site?: string })[];
    spurs?: { name: string; sites: string[] }[];
  };
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
const planPath = arg("plan", join(homedir(), "Desktop/icons/kings_curse_site_plan.json"));
const projectName = arg("name", "The King's Curse");
const markerPrefab = "assets/prefabs/misc/monumentsign/monumentsigntext.prefab";

const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
const size = plan.map.size;
const half = size / 2;
// 257 is the highest preview resolution the viewport renders (`lib/quality.ts`)
// and the lattice the engine exports, so sampling here sees the same terrain
// the user sees and the .map will carry.
const terrainResolution = Number(arg("resolution", "257"));

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
    radius: Number.isFinite(width) && Number.isFinite(depth) ? Math.max(2, Math.round(Math.max(width, depth) / 2)) : 12,
    height: Number.isFinite(height) && height > 0 ? Math.max(2, Math.round(height)) : 8,
  });
}

function requirePrefab(path: string | undefined, label: string): Catalogue {
  if (!path) throw new Error(`${label}: the plan names no prefab`);
  const entry = catalogue.get(path);
  if (!entry) throw new Error(`${label}: ${path} is not in the Facepunch catalogue`);
  return entry;
}

// --- terrain ---------------------------------------------------------------

// The template supplies the draft fields this script does not own (export,
// io, loot, walk mode…). Prefer this map's own saved state, then any map
// project — never a skin draft, which has a different shape.
const namedProject = db
  .prepare("SELECT id FROM projects WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
  .get(projectName) as { id: string } | undefined;
const existing = (namedProject
  ? db
      .prepare("SELECT project_id, state_json FROM project_wizard_state WHERE project_id = ?")
      .get(namedProject.id)
  : undefined) as { project_id: string; state_json: string } | undefined;
const existingMap =
  existing ??
  (db
    .prepare(
      `SELECT s.project_id, s.state_json FROM project_wizard_state s
         JOIN projects p ON p.id = s.project_id
        WHERE p.kind = 'map'
        ORDER BY s.updated_at DESC LIMIT 1`,
    )
    .get() as { project_id: string; state_json: string } | undefined);
if (!existingMap) throw new Error("no saved map project to use as a draft template");
const state = JSON.parse(existingMap.state_json) as { draft: Record<string, any>; stepId: string };
const draft = state.draft;

draft.terrain = {
  ...draft.terrain,
  sizeMetres: size,
  seed: plan.map.seed,
  preset: "islands",
  waterLevel: -8,
  floorHeight: null,
};
const waterLevel = Number(draft.terrain.waterLevel);
const preview: TerrainPreview = generateTerrainPreview(draft.terrain, terrainResolution);
const heightAt = (x: number, z: number) => samplePreviewHeight(preview, x, z, size);

// Plan coordinates are Rust world coordinates (0..size); the editor is centred.
const toEditor = (point: Vec2) => ({ x: point.x - half, z: point.z - half });

type Water = "land" | "shoreline" | "offshore" | "coastal";

function classify(site: PlanSite): Water {
  const prefab = site.landmark?.prefab ?? "";
  if (/\/harbor\//.test(prefab)) return "shoreline";
  const offshore = site.key.startsWith("offshore") || /\/offshore\//.test(prefab);
  if (!offshore) return "land";
  // The fishing village is built on stilts in shallow water; the rigs want
  // open sea. Harbors stay on land — they are shoreline monuments.
  return /fishing_village/.test(prefab) ? "coastal" : "offshore";
}

function acceptable(water: Water, height: number): boolean {
  if (water === "offshore") return height <= waterLevel - 6;
  if (water === "coastal") return height >= waterLevel - 3 && height <= waterLevel + 6;
  if (water === "shoreline") return height >= waterLevel + 1 && height <= waterLevel + 25;
  return height >= waterLevel + 2;
}

/** True when open water is within reach, so a harbour can actually face it. */
function nearWater(point: Vec2): boolean {
  for (const distance of [40, 70, 110]) {
    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2;
      if (heightAt(point.x + Math.cos(angle) * distance, point.z + Math.sin(angle) * distance) < waterLevel) {
        return true;
      }
    }
  }
  return false;
}

/** Nearest cell that satisfies the site's water class, searching outward. */
function snapSite(
  site: PlanSite,
  want: Water,
): { x: number; z: number; height: number; moved: number; ok: boolean } {
  const origin = toEditor(site.origin);
  const limit = half - 40;
  const within = (x: number, z: number) => Math.abs(x) <= limit && Math.abs(z) <= limit;
  const start = heightAt(origin.x, origin.z);

  // Offshore rigs keep a wide berth from the shoreline so they read as at sea.
  if (accepted(origin, start, want, site.radius)) return { x: origin.x, z: origin.z, height: start, moved: 0, ok: true };

  const step = 20;
  const maxRadius = 600;
  for (let radius = step; radius <= maxRadius; radius += step) {
    const samples = Math.max(8, Math.round((2 * Math.PI * radius) / step));
    for (let index = 0; index < samples; index += 1) {
      const angle = (index / samples) * Math.PI * 2;
      const x = origin.x + Math.cos(angle) * radius;
      const z = origin.z + Math.sin(angle) * radius;
      if (!within(x, z)) continue;
      const height = heightAt(x, z);
      if (!accepted({ x, z }, height, want, site.radius)) continue;
      return { x, z, height, moved: radius, ok: true };
    }
  }
  // Nothing within reach satisfies the class: keep the plan point and say so.
  return { x: origin.x, z: origin.z, height: start, moved: 0, ok: false };
}

function accepted(point: Vec2, height: number, want: Water, radius: number): boolean {
  if (!acceptable(want, height)) return false;
  if (want === "shoreline" && !nearWater(point)) return false;
  // A rig is ~220 m across: check the whole deck sits over open sea, not just
  // its centre, or half the platform ends up on a beach.
  if (want === "offshore") {
    const reach = Math.min(radius * 0.6, 150);
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      const depth = heightAt(point.x + Math.cos(angle) * reach, point.z + Math.sin(angle) * reach);
      if (depth > waterLevel - 2) return false;
    }
  }
  // Keep the footprint itself clear of the waterline.
  const edge = 30;
  if (want === "land" || want === "shoreline") {
    for (const [dx, dz] of [
      [-edge, 0],
      [edge, 0],
      [0, -edge],
      [0, edge],
    ] as const) {
      if (heightAt(point.x + dx, point.z + dz) < waterLevel + 1) return false;
    }
  }
  return true;
}

/**
 * Ids are derived from the plan key, not from a counter or a clock: a rebuild
 * has to keep the same ids so selection, locks and per-placement `visible`
 * state from a hand-edited draft survive. `previous` is the draft being
 * replaced and is consulted for those user-owned fields.
 */
const stableId = (prefix: string, key: string) =>
  `${prefix}-${key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;

const previousPlacements = new Map<string, Record<string, unknown>>(
  (Array.isArray(draft.placements) ? (draft.placements as Record<string, unknown>[]) : []).map(
    (item) => [String(item.id), item],
  ),
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

function placement(
  entry: Catalogue,
  name: string,
  at: { x: number; z: number },
  options: {
    id: string;
    radius: number;
    y?: number;
    flatten?: boolean;
    noBuildZone?: boolean;
    lootTier?: 1 | 2 | 3;
    rotationY?: number;
  },
): Placement {
  const carried = previousPlacements.get(options.id);
  return {
    id: options.id,
    assetId: entry.assetId,
    name,
    position: { x: round(at.x), y: round(options.y ?? 0, 2), z: round(at.z) },
    rotationEuler: { x: 0, y: Math.round(options.rotationY ?? 0), z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    parentId: null,
    collisionRadius: entry.radius,
    collisionHeight: entry.height,
    flatten: options.flatten ?? true,
    flattenRadius: Math.round(options.radius),
    flattenFalloff: 18,
    clearFoliage: true,
    noBuildZone: options.noBuildZone ?? true,
    lootTier: options.lootTier ?? 2,
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

const report: string[] = [];
const placements: Placement[] = [];
const offsets = new Map<string, Vec2>();
const unresolved: string[] = [];

for (const site of plan.sites) {
  const prefab = site.landmark?.prefab;
  if (!prefab) {
    // Custom native composition: no single Facepunch prefab exists for it yet,
    // so reserve the footprint with a real monument sign.
    const marker = requirePrefab(markerPrefab, "site marker");
    const want = "land" as Water;
    const spot = snapSite(site, want);
    offsets.set(site.key, { x: spot.x - (site.origin.x - half), z: spot.z - (site.origin.z - half) });
    placements.push(
      placement(marker, `${site.name} — site marker`, spot, {
        id: stableId("prefab", `${site.key}-marker`),
        radius: site.radius,
        flatten: false,
        lootTier: 1,
      }),
    );
    report.push(
      `marker  ${site.key.padEnd(24)} ${site.name.padEnd(28)} ground ${spot.height.toFixed(1).padStart(6)} m` +
        (spot.moved ? `  (moved ${spot.moved | 0} m)` : "") +
        (spot.ok ? "" : "  WARNING kept the plan point: no dry cell within 600 m"),
    );
    continue;
  }

  let entry: Catalogue;
  try {
    entry = requirePrefab(prefab, site.key);
  } catch (error) {
    unresolved.push(String(error instanceof Error ? error.message : error));
    continue;
  }

  const want = classify(site);
  const spot = snapSite(site, want);
  const delta = { x: spot.x - (site.origin.x - half), z: spot.z - (site.origin.z - half) };
  offsets.set(site.key, delta);
  const inWater = want === "offshore" || want === "coastal";
  const y = inWater ? round(waterLevel - spot.height, 2) : 0;
  const label =
    site.key === "offshore_oilrig_1"
      ? `${site.name} (large oil rig)`
      : site.key === "offshore_oilrig_2"
        ? `${site.name} (small oil rig)`
        : site.name;
  placements.push(
    placement(entry, label, spot, {
      id: stableId("prefab", site.key),
      radius: site.radius,
      y,
      flatten: !inWater,
      lootTier: want === "offshore" ? 3 : 2,
    }),
  );
  report.push(
    `${want.padEnd(7)} ${site.key.padEnd(24)} ${site.name.padEnd(28)} ground ${spot.height
      .toFixed(1)
      .padStart(6)} m  y ${String(y).padStart(7)}  ${prefab.split("/").pop()}` +
      (Math.abs(delta.x) + Math.abs(delta.z) > 0.5 ? `  (moved ${Math.hypot(delta.x, delta.z).toFixed(0)} m)` : "") +
      (spot.ok ? "" : `  WARNING kept the plan point: no ${want} cell within 600 m`),
  );
}

// The plan's KOBA fuel pumps are deployables: use the real fuel generator
// prefab rather than inventing a prop, and keep them out of the no-build pass.
const fuelPumpPrefab = "assets/prefabs/tools/fuel generator/fuelgenerator.prefab";
for (const pump of plan.fuel_pumps ?? []) {
  const entry = requirePrefab(fuelPumpPrefab, pump.name);
  const offset = offsets.get(pump.site) ?? { x: 0, z: 0 };
  placements.push(
    placement(entry, pump.name, { x: pump.x - half + offset.x, z: pump.z - half + offset.z }, {
      id: stableId("prefab", pump.name),
      radius: pump.radius,
      y: 0,
      flatten: false,
      noBuildZone: false,
      lootTier: 1,
    }),
  );
  report.push(`fuel    ${pump.name.padEnd(24)} ${pump.site}`);
}

// Spawns move with their site.
for (const spawn of plan.spawns ?? []) {
  const entry = spawn.prefab ? catalogue.get(spawn.prefab) : undefined;
  if (!entry) {
    unresolved.push(`${spawn.key}: spawn prefab ${spawn.prefab ?? "(none)"} is not in the catalogue`);
    continue;
  }
  const offset = offsets.get(spawn.site) ?? { x: 0, z: 0 };
  const at = { x: spawn.world.x - half + offset.x, z: spawn.world.z - half + offset.z };
  const height = heightAt(at.x, at.z);
  placements.push(
    placement(entry, `spawn ${spawn.key}`, at, {
      id: stableId("prefab", `spawn-${spawn.key}`),
      radius: 8,
      y: 0,
      flatten: false,
      noBuildZone: false,
      lootTier: 1,
      rotationY: spawn.yaw ?? 0,
    }),
  );
  if (height < waterLevel + 1) report.push(`warning spawn ${spawn.key} sits at ${height.toFixed(1)} m (near or below water)`);
}

// --- roads -----------------------------------------------------------------

const siteAnchor = new Map<string, Vec2>();
for (const site of plan.sites) {
  const offset = offsets.get(site.key) ?? { x: 0, z: 0 };
  siteAnchor.set(site.key, { x: site.origin.x - half + offset.x, z: site.origin.z - half + offset.z });
}

const splines: Record<string, unknown>[] = [];
const spline = (name: string, nodes: Vec2[], closed = false) => {
  splines.push({
    id: stableId("spline", name),
    name,
    kind: "road",
    width: plan.roads?.width ?? 12,
    closed,
    autoRoute: true,
    curve: "catmull-rom",
    tension: 0.5,
    deformTerrain: true,
    paintSplat: true,
    topologyFlag: "path_clear",
    nodes: nodes.map((node) => ({ x: round(node.x), y: 0, z: round(node.z) })),
  });
};

if (plan.roads?.loop?.length) {
  const nodes = plan.roads.loop
    .map((node) => (node.site ? siteAnchor.get(node.site) : toEditor(node)))
    .filter((node): node is Vec2 => Boolean(node));
  spline(plan.roads.name ?? "Faction ring", nodes, true);
}
for (const spur of plan.roads?.spurs ?? []) {
  const nodes = spur.sites.map((key) => siteAnchor.get(key)).filter((node): node is Vec2 => Boolean(node));
  if (nodes.length >= 2) spline(spur.name, nodes);
}

// --- write -----------------------------------------------------------------

draft.name = projectName;
draft.projectKind = "map";
draft.branch = "world";
draft.mode = "offline";
draft.placements = placements;
draft.selectedPlacementId = placements[0]?.id ?? null;
draft.splines = splines;
draft.loot = {
  ...draft.loot,
  noBuildZones: placements.filter((item) => item.noBuildZone).length,
};
draft.export = { ...draft.export, fileName: plan.map.key };

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
    `UPDATE projects SET name = ?, kind = 'map', export_target = 'map', workspace_path = ?,
        wizard_phase = 'monuments', wizard_step_index = 0, is_dirty = 0,
        map_size = ?, map_resolution = ?, seed = ?, updated_at = ? WHERE id = ?`,
  ).run(projectName, `projects/${projectId}`, size, size + 1, plan.map.seed, now, projectId);
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
    "map",
    "map",
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
    plan.map.seed,
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

const counts = placements.reduce<Record<string, number>>((totals, item) => {
  const key = item.name.startsWith("spawn ")
    ? "spawns"
    : item.name.includes("site marker")
      ? "markers"
      : /fuel pump/i.test(item.name)
        ? "fuel pumps"
        : "monuments";
  totals[key] = (totals[key] ?? 0) + 1;
  return totals;
}, {});

console.log(`The King's Curse → ${projectId}`);
console.log(
  `terrain ${size} m · seed ${plan.map.seed} · water ${waterLevel} m · ${placements.length} placements` +
    ` (${counts.monuments ?? 0} monuments, ${counts.markers ?? 0} markers, ${counts["fuel pumps"] ?? 0} fuel pumps, ${counts.spawns ?? 0} spawns) · ${splines.length} splines`,
);
console.log(report.join("\n"));
if (unresolved.length) {
  console.error(`\n${unresolved.length} unresolved plan entries:\n${unresolved.join("\n")}`);
  process.exitCode = 1;
}
