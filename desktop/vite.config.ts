import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// One frontend, two targets: `--mode app` builds the desktop app's window (host + client modes),
// `--mode web` builds the browser client that the relay Worker serves.
export default defineConfig(({ mode }) => {
  const app = mode === "web" ? "web" : "app";
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        // The relay serves the web client at "/", so its page must be index.html.
        name: "web-index",
        closeBundle() {
          const from = path.resolve(import.meta.dirname, "dist/web/web.html");
          if (app === "web" && fs.existsSync(from)) fs.renameSync(from, path.resolve(import.meta.dirname, "dist/web/index.html"));
        },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    publicDir: app === "web" ? "public-web" : false,
    clearScreen: false,
    // In development the web client talks to a local relay (`cd relay && npm run dev`).
    server: { proxy: { "/v1": "http://127.0.0.1:8787" } },
    build: {
      outDir: `dist/${app}`,
      emptyOutDir: true,
      target: "es2022",
      chunkSizeWarningLimit: 2000,
      rollupOptions: { input: { index: path.resolve(import.meta.dirname, `${app}.html`) } },
    },
  };
});
