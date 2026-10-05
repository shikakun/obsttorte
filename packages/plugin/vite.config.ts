import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig, type Plugin } from "vite";

const OBSIDIAN_PROVIDED_MODULES = ["obsidian", "electron", "@codemirror/state", "@codemirror/view"];

function copyObsidianAssets(): Plugin {
  return {
    name: "copy-obsidian-assets",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: readFileSync("../../manifest.json", "utf8"),
      });
      this.emitFile({
        type: "asset",
        fileName: "styles.css",
        source: readFileSync("styles.css", "utf8"),
      });
    },
  };
}

export default defineConfig({
  plugins: [copyObsidianAssets()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rolldownOptions: {
      external: [
        ...OBSIDIAN_PROVIDED_MODULES,
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
    outDir: "dist",
    emptyOutDir: false,
  },
});
