import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.resolve(root, "../server/dist/obsttorte");
const migrations = path.resolve(root, "../server/migrations");

await rm(path.join(root, "dist/obsttorte"), { recursive: true, force: true });
await cp(worker, path.join(root, "dist/obsttorte"), { recursive: true });
await rm(path.join(root, "migrations"), { recursive: true, force: true });
await cp(migrations, path.join(root, "migrations"), { recursive: true });
await rm(path.join(root, "dist/obsttorte/.dev.vars"), { force: true });
await rm(path.join(root, "dist/obsttorte/.vite"), { recursive: true, force: true });
