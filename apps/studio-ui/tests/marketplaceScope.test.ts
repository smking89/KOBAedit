import assert from "node:assert/strict";
import test from "node:test";

import { marketItemsFor, type MarketItem } from "../src/lib/marketplaceScope.ts";

const CATALOG: MarketItem[] = [
  { id: "map-harbor", name: "Harbor", kind: "Map", author: "a", price: 0, summary: "" },
  { id: "monument-airfield", name: "Airfield", kind: "Monument", author: "b", price: 0, summary: "" },
  { id: "skin-crimson", name: "Crimson", kind: "Skin", author: "c", price: 0, summary: "" },
];

test("a map hides skins from the marketplace", () => {
  const items = marketItemsFor(CATALOG, "map", "All", "");
  assert.deepEqual(items.map((item) => item.id), ["map-harbor", "monument-airfield"]);
});

test("a linked out-of-scope asset is still shown", () => {
  const items = marketItemsFor(CATALOG, "map", "All", "skin-crimson", "skin-crimson");
  assert.deepEqual(items.map((item) => item.id), ["skin-crimson"]);
});

test("a linked asset survives a stale kind filter", () => {
  const items = marketItemsFor(CATALOG, "map", "Map", "skin-crimson", "skin-crimson");
  assert.deepEqual(items.map((item) => item.id), ["skin-crimson"]);
});
