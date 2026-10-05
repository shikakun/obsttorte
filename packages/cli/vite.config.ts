import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __OBSTTORTE_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
  },
  build: {
    lib: {
      entry: "src/bin.ts",
      formats: ["es"],
      fileName: () => "obsttorte.mjs",
    },
    rolldownOptions: {
      external: ["wrangler", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
    outDir: "bin",
    emptyOutDir: false,
  },
});
