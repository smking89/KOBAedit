import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the built assets from a `tauri://localhost` origin; the dev server
// must bind a fixed port so `tauri.conf.json` can point at it.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
