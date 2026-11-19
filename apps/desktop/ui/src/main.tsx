import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { WizardProvider } from "./wizard/context";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("root element missing");

createRoot(container).render(
  <StrictMode>
    <WizardProvider>
      <App />
    </WizardProvider>
  </StrictMode>,
);

// The splash is plain markup in index.html; hold it for a beat after the first
// paint so a fast machine does not flash it, then fade it out and drop the node.
const splash = document.getElementById("boot-splash");
const dismissSplash = () => {
  if (!splash || splash.classList.contains("is-hidden")) return;
  splash.classList.add("is-hidden");
  window.setTimeout(() => splash.remove(), 420);
};

// A plain timeout rather than requestAnimationFrame: background or minimized
// windows throttle frames, and the splash must never stay stuck on screen.
// Long enough for the wordmark reveal (760 ms) and the tag/bar stagger to play.
window.setTimeout(dismissSplash, 1000);
