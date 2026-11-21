import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the built assets from a `tauri://localhost` origin; the dev server
// must bind a fixed port so `tauri.conf.json` can point at it. Stay on Tauri's
// default 1420: a checkout that used to live elsewhere leaves WebKit's per-origin
// cache pointing at its old `node_modules` paths, and port 5173 is also the
// default for other Vite projects that may still be running.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
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
    rollupOptions: {
      // The Tauri shell opens `splashscreen.html` in its own 720x320 window.
      input: {
        main: "index.html",
        splashscreen: "splashscreen.html",
      },
    },
  },
});
