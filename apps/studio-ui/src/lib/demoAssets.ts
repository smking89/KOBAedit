import type { PrefabAsset } from "../wizard/types";

/**
 * Catalogue shown when the Rust install has not been indexed yet.
 * The Tauri command `list_prefabs` replaces this list once the local SQLite
 * index has rows; ids match Rust prefab asset names so a later index merges
 * cleanly.
 */
export const DEMO_PREFABS: PrefabAsset[] = [
  {
    id: "assets/bundled/prefabs/autospawn/monument/launch_site.prefab",
    name: "Launch Site",
    category: "Monument",
    bounds: { min: [-220, -30, -220], max: [220, 150, 220] },
    flattenRadius: 240,
    hasLoot: true,
    hasIO: true,
    hasNpc: true,
  },
  {
    id: "assets/bundled/prefabs/autospawn/monument/airfield.prefab",
    name: "Airfield",
    category: "Monument",
    bounds: { min: [-180, -20, -140], max: [180, 60, 140] },
    flattenRadius: 200,
    hasLoot: true,
    hasIO: true,
    hasNpc: true,
  },
  {
    id: "assets/bundled/prefabs/autospawn/monument/military_tunnel.prefab",
    name: "Military Tunnel",
    category: "Monument",
    bounds: { min: [-120, -40, -120], max: [120, 80, 120] },
    flattenRadius: 150,
    hasLoot: true,
    hasIO: true,
    hasNpc: true,
  },
  {
    id: "assets/bundled/prefabs/autospawn/monument/bandit_camp.prefab",
    name: "Bandit Camp",
    category: "Monument",
    bounds: { min: [-90, -10, -90], max: [90, 40, 90] },
    flattenRadius: 110,
    hasLoot: true,
    hasIO: true,
    hasNpc: true,
  },
  {
    id: "assets/bundled/prefabs/autospawn/monument/outpost.prefab",
    name: "Outpost",
    category: "Monument",
    bounds: { min: [-80, -10, -80], max: [80, 40, 80] },
    flattenRadius: 100,
    hasLoot: true,
    hasIO: true,
    hasNpc: true,
  },
  {
    id: "assets/bundled/prefabs/autospawn/monument/dome.prefab",
    name: "The Dome",
    category: "Monument",
    bounds: { min: [-60, -10, -60], max: [60, 70, 60] },
    flattenRadius: 80,
    hasLoot: true,
    hasIO: false,
    hasNpc: true,
  },
  {
    id: "assets/bundled/prefabs/autospawn/monument/fishing_village.prefab",
    name: "Fishing Village",
    category: "Monument",
    bounds: { min: [-110, -25, -110], max: [110, 35, 110] },
    flattenRadius: 120,
    hasLoot: true,
    hasIO: true,
    hasNpc: true,
  },
  {
    id: "assets/bundled/prefabs/autospawn/decor/tree_oak.prefab",
    name: "Oak Tree",
    category: "Decor",
    bounds: { min: [-4, -1, -4], max: [4, 14, 4] },
    flattenRadius: 6,
    hasLoot: false,
    hasIO: false,
    hasNpc: false,
  },
  {
    id: "assets/bundled/prefabs/autospawn/decor/rock_large.prefab",
    name: "Large Rock",
    category: "Decor",
    bounds: { min: [-8, -2, -8], max: [8, 9, 8] },
    flattenRadius: 10,
    hasLoot: false,
    hasIO: false,
    hasNpc: false,
  },
  {
    id: "assets/bundled/prefabs/autospawn/decor/bush.prefab",
    name: "Bush",
    category: "Decor",
    bounds: { min: [-2, 0, -2], max: [2, 3, 2] },
    flattenRadius: 3,
    hasLoot: false,
    hasIO: false,
    hasNpc: false,
  },
  {
    id: "assets/bundled/prefabs/autospawn/building/foundation.prefab",
    name: "Foundation",
    category: "Building",
    bounds: { min: [-3, -1, -3], max: [3, 1, 3] },
    flattenRadius: 8,
    hasLoot: false,
    hasIO: false,
    hasNpc: false,
  },
  {
    id: "assets/bundled/prefabs/autospawn/vehicle/modular_car.prefab",
    name: "Modular Car",
    category: "Vehicle",
    bounds: { min: [-2, -1, -4], max: [2, 2, 4] },
    flattenRadius: 6,
    hasLoot: true,
    hasIO: false,
    hasNpc: false,
  },
];

export interface BaseMeshAsset {
  id: string;
  name: string;
  itemKind: "weapon" | "attire" | "deployable";
  uvChannels: number;
  triangles: number;
  hasTangents: boolean;
  materialSlots: string[];
}

export const DEMO_BASE_MESHES: BaseMeshAsset[] = [
  {
    id: "assets/content/weapons/ak47/ak47.glb",
    name: "Assault Rifle (AK-47)",
    itemKind: "weapon",
    uvChannels: 1,
    triangles: 14320,
    hasTangents: true,
    materialSlots: ["metal", "polymer", "wood"],
  },
  {
    id: "assets/content/weapons/lr300/lr300.glb",
    name: "Assault Rifle (LR-300)",
    itemKind: "weapon",
    uvChannels: 1,
    triangles: 12040,
    hasTangents: true,
    materialSlots: ["metal", "polymer"],
  },
  {
    id: "assets/content/weapons/bolt_rifle/bolt_rifle.glb",
    name: "Bolt Action Rifle",
    itemKind: "weapon",
    uvChannels: 1,
    triangles: 18560,
    hasTangents: true,
    materialSlots: ["metal", "wood"],
  },
  {
    id: "assets/content/items/clothing/metal_chest_plate.glb",
    name: "Metal Chest Plate",
    itemKind: "attire",
    uvChannels: 1,
    triangles: 8420,
    hasTangents: false,
    materialSlots: ["metal", "fabric"],
  },
  {
    id: "assets/content/items/clothing/hoodie.glb",
    name: "Hoodie",
    itemKind: "attire",
    uvChannels: 1,
    triangles: 6200,
    hasTangents: false,
    materialSlots: ["fabric"],
  },
  {
    id: "assets/content/items/deployables/wooden_door.glb",
    name: "Wooden Door",
    itemKind: "deployable",
    uvChannels: 1,
    triangles: 1840,
    hasTangents: false,
    materialSlots: ["wood", "metal"],
  },
  {
    id: "assets/content/items/deployables/tool_cupboard.glb",
    name: "Tool Cupboard",
    itemKind: "deployable",
    uvChannels: 1,
    triangles: 3260,
    hasTangents: false,
    materialSlots: ["wood", "metal"],
  },
];
