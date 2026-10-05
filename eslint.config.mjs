import { defineConfig } from "./packages/plugin-lint/node_modules/eslint/lib/config-api.js";
import obsidianmd from "./packages/plugin-lint/node_modules/eslint-plugin-obsidianmd/dist/lib/index.js";

export default defineConfig([
  { ignores: ["**/node_modules/**", "**/dist/**", "**/bin/**", "**/vite.config.ts"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: new URL("./packages/plugin/", import.meta.url).pathname,
      },
    },
  },
]);
