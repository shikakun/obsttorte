import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("packages/plugin/src");
const banned = [
  "innerHTML",
  "dangerouslySetInnerHTML",
  "console.log",
  "console.debug",
  "console.info",
];

const files = await walk(root);
const failures = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const pattern of banned) {
    if (text.includes(pattern))
      failures.push(`${path.relative(process.cwd(), file)} contains ${pattern}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    }),
  );
  return nested.flat();
}
