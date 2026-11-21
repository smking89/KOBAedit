import { useEffect, useMemo, useState } from "react";

import {
  KINDS_BY_PROJECT,
  marketItemsFor,
  type MarketItem,
  type MarketKind,
} from "../lib/marketplaceScope";
import type { ProjectKind } from "../wizard/types";
import { Badge, Button } from "./ui";

/** Catalogue shipped with the app so the drawer works with no network. */
const CATALOG: MarketItem[] = [
  {
    id: "map-harbor-ridge",
    name: "Harbor Ridge",
    kind: "Map",
    author: "koba.games",
    price: 0,
    summary: "4500 m coastal map with a working harbor and three monuments.",
  },
  {
    id: "map-red-dunes",
    name: "Red Dunes",
    kind: "Map",
    author: "sandline",
    price: 400,
    summary: "Arid 6000 m map with canyon roads and two underground labs.",
  },
  {
    id: "monument-airfield",
    name: "Airfield Rebuild",
    kind: "Monument",
    author: "koba.games",
    price: 250,
    summary: "Updated airfield with hangar sockets and a paved apron.",
  },
  {
    id: "monument-oil-rig",
    name: "Deep Water Rig",
    kind: "Monument",
    author: "northstar",
    price: 300,
    summary: "Offshore rig with crane pads, loot rooms and a helipad.",
  },
  {
    id: "prefab-bridge-kit",
    name: "Modular Bridge Kit",
    kind: "Prefab",
    author: "spanworks",
    price: 150,
    summary: "Twelve snap-together bridge spans with collision proxies.",
  },
  {
    id: "prefab-cliff-set",
    name: "Cliff Set",
    kind: "Prefab",
    author: "stonecold",
    price: 120,
    summary: "Rock walls and arches sized for the cliff brush.",
  },
  {
    id: "skin-crimson-carbon",
    name: "Crimson Carbon",
    kind: "Skin",
    author: "atelier",
    price: 200,
    summary: "2048 px carbon-weave skin with emissive edge trim.",
  },
  {
    id: "skin-arctic-wrap",
    name: "Arctic Wrap",
    kind: "Skin",
    author: "atelier",
    price: 200,
    summary: "Winter camo with frost wear and a matte finish.",
  },
  {
    id: "plugin-raid-alerts",
    name: "Raid Alerts",
    kind: "Plugin",
    author: "oxideworks",
    price: 0,
    summary: "Oxide plugin that announces raid starts with branded chat lines.",
  },
  {
    id: "plugin-welcome-banner",
    name: "Welcome Banner",
    kind: "Plugin",
    author: "oxideworks",
    price: 100,
    summary: "Carbon plugin with a configurable join banner and prefix.",
  },
];

const OWNED_KEY = "koba:marketplace-owned";

function readOwned(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(OWNED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * In-app koba.games drawer. When the network is unavailable the same grid is
 * served from the local catalogue and the user's installed library, so nothing
 * in a project depends on being online.
 */
export function MarketplaceDrawer({
  open,
  onClose,
  focusAssetId,
  projectKind,
}: {
  open: boolean;
  onClose: () => void;
  focusAssetId?: string | null;
  projectKind: ProjectKind;
}) {
  const allowedKinds = KINDS_BY_PROJECT[projectKind];
  const [kind, setKind] = useState<MarketKind | "All">("All");
  const [query, setQuery] = useState("");
  const [owned, setOwned] = useState<string[]>(readOwned);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? false : navigator.onLine));

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!focusAssetId) return;
    // A linked asset may be in another kind; show it without an empty filter.
    setKind("All");
    setQuery(focusAssetId);
  }, [focusAssetId]);

  useEffect(() => {
    // Leaving Skin for Map must not keep the Skin filter selected.
    setKind((current) => (allowedKinds.includes(current) ? current : "All"));
  }, [projectKind, allowedKinds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
    } catch {
      // A full or disabled store must not break browsing.
    }
  }, [owned]);

  const install = (id: string) => {
    setOwned((current) => (current.includes(id) ? current : [...current, id]));
  };

  const items = useMemo(
    () => marketItemsFor(CATALOG, projectKind, kind, query, focusAssetId),
    [focusAssetId, kind, projectKind, query],
  );
  const linkedItem = focusAssetId
    ? CATALOG.find((item) => item.id === focusAssetId && !allowedKinds.includes(item.kind))
    : undefined;
  // Explain the scope exception only while the linked card is on screen.
  const linkedOutOfScope =
    linkedItem && items.some((item) => item.id === linkedItem.id) ? linkedItem : null;

  if (!open) return null;

  return (
    <div className="marketplace-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="marketplace-drawer"
        aria-label="koba.games marketplace"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="marketplace-head">
          <div>
            <span className="eyebrow">koba.games</span>
            <h2>Marketplace</h2>
            <p className="marketplace-scope">
              {projectKind === "skin"
                ? "Skins for the active skin project"
                : projectKind === "monument"
                  ? "Monuments and prefabs for this monument"
                  : "Maps, monuments, prefabs and plugins for this map"}
            </p>
          </div>
          <div className="marketplace-head-actions">
            <Badge tone={online ? "ok" : "warn"}>{online ? "Connected" : "Offline library"}</Badge>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>

        <div className="marketplace-tools">
          <input
            className="text-input"
            type="search"
            value={query}
            placeholder={`Search ${allowedKinds.filter((entry) => entry !== "All").join(", ").toLowerCase()}`}
            aria-label="Search marketplace"
            onChange={(event) => setQuery(event.target.value)}
          />
          {linkedOutOfScope && (
            <p className="marketplace-scope" role="status">
              Linked {linkedOutOfScope.kind.toLowerCase()} asset shown outside this {projectKind}{" "}
              project's scope.
            </p>
          )}
          <div className="chip-row">
            {allowedKinds.map((entry) => (
              <button
                key={entry}
                type="button"
                className={`chip${kind === entry ? " is-active" : ""}`}
                aria-pressed={kind === entry}
                onClick={() => setKind(entry)}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>

        <div className="marketplace-grid">
          {items.map((item) => {
            const installed = owned.includes(item.id);
            return (
              <article key={item.id} className="marketplace-card">
                <div className="marketplace-card-head">
                  <strong>{item.name}</strong>
                  <Badge tone="neutral">{item.kind}</Badge>
                </div>
                <p>{item.summary}</p>
                <div className="marketplace-card-foot">
                  <span className="marketplace-author">{item.author}</span>
                  <span className="marketplace-price">{item.price ? `${item.price} credits` : "Free"}</span>
                </div>
                <Button variant={installed ? "ghost" : "primary"} disabled={installed} onClick={() => install(item.id)}>
                  {installed ? "In local library" : "Install"}
                </Button>
              </article>
            );
          })}
          {items.length === 0 && (
            <p className="marketplace-empty">No items match that filter. Installed assets remain usable offline.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
