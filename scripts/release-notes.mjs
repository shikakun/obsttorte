import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [version, hashesPath] = process.argv.slice(2);
if (!version) throw new Error("Usage: node scripts/release-notes.mjs <version> [SHA256SUMS]");

const sources = [
  { title: "Plugin", changelog: "packages/plugin/CHANGELOG.md" },
  { title: "CLI and server", changelog: "packages/cli/CHANGELOG.md" },
];

const sections = sources.flatMap(({ title, changelog }) => {
  const body = sectionOf(readFileSync(join(root, changelog), "utf8"), version);
  return body ? [`## ${title}\n\n${body}`] : [];
});
if (hashesPath) {
  const hashes = readFileSync(hashesPath, "utf8").trimEnd();
  sections.push(`## Build hashes\n\n\`\`\`\n${hashes}\n\`\`\``);
}
process.stdout.write(`${sections.join("\n\n")}\n`);

function sectionOf(text, target) {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${target}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}
