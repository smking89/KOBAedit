import { useEffect, useRef, useState } from "react";

import type { CreatorBranding } from "../lib/branding";

type Panel = "none" | "shop" | "skins" | "trade";

interface Notice {
  id: number;
  text: string;
  tone: "info" | "warn" | "ok";
}

const SHOP_ITEMS = [
  { id: "kit", name: "Salvaged tools", price: 120 },
  { id: "med", name: "Medical syringe", price: 45 },
  { id: "skin", name: "Account-bound skin", price: 400 },
];

const SKINS = ["Crimson Carbon", "Arctic Wrap", "Rust Patina"];

let noticeId = 0;

/**
 * Simulated in-game overlay for Walk Mode: chat commands, notices, scrap shop
 * and the two-player trade handshake. Pure UI, no server and no engine calls.
 */
export function WalkHud({ branding }: { branding: CreatorBranding }) {
  const prefix = /^\[.*\]$/.test(branding.chatPrefix) ? branding.chatPrefix : `[${branding.chatPrefix}]`;
  const [log, setLog] = useState<string[]>([`${prefix} Welcome to the test server.`]);
  const [notices, setNotices] = useState<Notice[]>([
    { id: noticeId++, text: "Safe Zone Active", tone: "ok" },
  ]);
  const [input, setInput] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [scrap, setScrap] = useState(250);
  const [pending, setPending] = useState(0);
  const [applied, setApplied] = useState<string | null>(null);
  const [trade, setTrade] = useState<{ offered: boolean; locked: boolean; done: boolean }>({
    offered: false,
    locked: false,
    done: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const notify = (text: string, tone: Notice["tone"] = "info") => {
    const id = noticeId++;
    setNotices((current) => [...current.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setNotices((current) => current.filter((item) => item.id !== id)), 4200);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && event.target === inputRef.current) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = () => {
    const command = input.trim();
    if (!command) return;
    setInput("");
    setLog((current) => [...current.slice(-5), `> ${command}`]);
    if (command === "/shop") {
      setPanel("shop");
      notify("Shop terminal opened");
      return;
    }
    if (command === "/skin" || command === "/skins") {
      setPanel("skins");
      notify("Account-bound skins");
      return;
    }
    if (command === "/trade") {
      setPanel("trade");
      notify("Trade handshake started", "warn");
      return;
    }
    if (command === "/safe") {
      notify("Safe Zone Active", "ok");
      return;
    }
    if (command === "/radio") {
      notify("Radiation Zone Entered", "warn");
      return;
    }
    if (command === "/help") {
      setLog((current) => [...current, "Commands: /shop /skin /trade /safe /radio"]);
      return;
    }
    setLog((current) => [...current, `Unknown command: ${command}`]);
  };

  return (
    <div className="walk-hud" aria-label="In-game preview overlay">
      <div className="walk-notices">
        {notices.map((notice) => (
          <span key={notice.id} className={`walk-notice is-${notice.tone}`}>
            {notice.text}
          </span>
        ))}
      </div>

      <div className="walk-wallet">
        <span>Scrap {scrap}</span>
        {pending > 0 && <span className="walk-pending">Payout pending · {pending}</span>}
      </div>

      {panel !== "none" && (
        <section className="walk-panel" aria-label={`${panel} preview`}>
          <header>
            <strong>
              {panel === "shop" ? "Shop & Marketplace" : panel === "skins" ? "Player Skins" : "Trade Handshake"}
              <em className="walk-demo">Demo data</em>
            </strong>
            <button type="button" onClick={() => setPanel("none")}>
              Close
            </button>
          </header>

          {panel === "shop" && (
            <ul>
              {SHOP_ITEMS.map((item) => (
                <li key={item.id}>
                  <span>{item.name}</span>
                  <button
                    type="button"
                    disabled={scrap < item.price}
                    onClick={() => {
                      setScrap((value) => value - item.price);
                      notify(`Purchased ${item.name}`, "ok");
                    }}
                  >
                    {item.price} scrap
                  </button>
                </li>
              ))}
              <li>
                <span>List a skin on the marketplace</span>
                <button
                  type="button"
                  disabled={!applied}
                  onClick={() => {
                    setPending((value) => value + 150);
                    notify("Listing posted · payout pending", "warn");
                  }}
                >
                  List
                </button>
              </li>
            </ul>
          )}

          {panel === "skins" && (
            <ul>
              {SKINS.map((skin) => (
                <li key={skin}>
                  <span>{skin}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setApplied(skin);
                      notify(`${skin} applied`, "ok");
                    }}
                  >
                    {applied === skin ? "Applied" : "Apply"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {panel === "trade" && (
            <div className="walk-trade">
              <p>Partner bot: {trade.done ? "trade complete" : trade.locked ? "locked in" : "waiting"}</p>
              <button
                type="button"
                disabled={!applied || trade.done}
                onClick={() => {
                  setTrade((state) => ({ ...state, offered: true }));
                  notify("Skin offered to partner", "warn");
                }}
              >
                Offer {applied ?? "a skin"}
              </button>
              <button
                type="button"
                disabled={!trade.offered || trade.done}
                onClick={() => {
                  setTrade((state) => ({ ...state, locked: true }));
                  notify("Both sides locked in", "warn");
                }}
              >
                Lock both sides
              </button>
              <button
                type="button"
                disabled={!trade.locked || trade.done}
                onClick={() => {
                  setTrade({ offered: true, locked: true, done: true });
                  setApplied(null);
                  setPending((value) => value + 200);
                  notify("Ownership transferred · payout pending", "ok");
                }}
              >
                Confirm handshake
              </button>
            </div>
          )}
        </section>
      )}

      <div className="walk-chat">
        <div className="walk-chat-log">
          {log.slice(-4).map((line, index) => (
            <span key={`${line}-${index}`}>{line}</span>
          ))}
        </div>
        <input
          ref={inputRef}
          value={input}
          placeholder="/shop, /skin, /trade, /safe, /radio"
          aria-label="In-game command"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              run();
            }
            if (event.key === "Escape") {
              event.stopPropagation();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </div>
  );
}
