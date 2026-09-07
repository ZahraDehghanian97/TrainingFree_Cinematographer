import { defineConfig } from "vite";
import * as path from "node:path";
import { cameraPipelineApiPlugin } from "./pipeline-api-plugin";

const webRoot = import.meta.dirname;

export default defineConfig({
  root: webRoot,
  base: "./",
  publicDir: "public",
  plugins: [
    cameraPipelineApiPlugin({
      environmentsDirectory: path.resolve(webRoot, "public/environments"),
    }),
  ],
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
