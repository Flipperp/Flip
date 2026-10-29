import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const shim = (f: string) => path.resolve(__dirname, "src/demo/shims", f);

// Self-contained Practice demo: the server runs in the page. `npm run build:demo` -> dist-demo/
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { "process.env": {}, "import.meta.env.VITE_DEMO": JSON.stringify("true") },
  resolve: {
    alias: [
      { find: "better-sqlite3", replacement: shim("better-sqlite3.ts") },
      { find: /^fastify$/, replacement: shim("fastify.ts") },
      { find: /^@fastify\/.*/, replacement: shim("noop-plugin.ts") },
      { find: "dotenv/config", replacement: shim("dotenv-config.ts") },
      { find: /^node:fs$/, replacement: shim("node-stubs.ts") },
      { find: /^node:path$/, replacement: shim("node-stubs.ts") },
      { find: /^node:events$/, replacement: shim("events.ts") },
    ],
  },
  server: { fs: { allow: [".."] } },
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, "demo.html"), output: { inlineDynamicImports: true } },
    chunkSizeWarningLimit: 5000,
  },
});
