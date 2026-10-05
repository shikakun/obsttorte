import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "packages/plugin/package.json"), "utf8"));
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = packageJson.version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const versionsPath = join(root, "versions.json");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[packageJson.version] = manifest.minAppVersion;
writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
