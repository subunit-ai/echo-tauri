import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // The meet.subunit.ai React UI, vendored in-repo at meet-ui/ so this repo builds
  // standalone (CI / Erik's tablet). Canonical source = projects/meet-react/src; re-sync
  // with scripts-sync-meet-ui.sh after meet changes. (Proper shared repo = follow-up.)
  resolve: {
    alias: {
      "@meet": fileURLToPath(new URL("./meet-ui", import.meta.url)),
    },
  },

  // Two windows = two HTML entries: the main hub + the transparent orb overlay.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        overlay: "overlay.html",
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
