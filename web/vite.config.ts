import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  base: "./",
  publicDir: "public",
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    // Three.js is the application runtime; keep the warning threshold above
    // its expected single-entry bundle rather than treating it as accidental bloat.
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
