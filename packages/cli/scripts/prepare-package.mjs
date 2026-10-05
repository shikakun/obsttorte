import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "bin/obsttorte.mjs",
  "dist/obsttorte/index.js",
  "dist/obsttorte/wrangler.json",
  "migrations",
];

for (const relative of required) {
  await stat(path.join(root, relative));
}

const repositoryRoot = path.resolve(root, "../..");
const blobUrl = "https://github.com/shikakun/obsttorte/blob/main/";
const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
await writeFile(
  path.join(root, "README.md"),
  readme.replaceAll(/\]\(\.\/([^)]+)\)/g, (_, target) => `](${blobUrl}${target})`),
);
await copyFile(path.join(repositoryRoot, "LICENSE"), path.join(root, "LICENSE"));

await rm(path.join(root, "dist/obsttorte/.dev.vars"), { force: true });
await rm(path.join(root, "dist/obsttorte/.vite"), { recursive: true, force: true });
await mkdir(path.join(root, "migrations"), { recursive: true });

const secret = /obsttorte_[a-z2-7]{52}|cfast_[A-Za-z0-9_-]{8,}/;
async function assertNoSecrets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoSecrets(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = await readFile(full, "utf8");
    if (secret.test(text)) {
      throw new Error(`Refusing to pack a secret found in ${path.relative(root, full)}`);
    }
  }
}

await assertNoSecrets(path.join(root, "bin"));
await assertNoSecrets(path.join(root, "dist"));
