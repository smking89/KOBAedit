import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";

import App from "./App";
import { isTauri } from "./lib/ipc";
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

// The shell keeps this window hidden behind the splash until the workspace has
// mounted, then closes the splash and shows this window. This runs from module
// code rather than a frame callback: a hidden window throttles animation frames,
// so an rAF-gated signal never arrives and the splash is only dismissed by the
// shell's safety timeout.
if (isTauri()) {
  void invoke("app_ready").catch(() => undefined);
}
