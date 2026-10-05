import { pathBasename } from "@obsttorte/shared";

function isFixedExcluded(path: string, configDir: string, selfId: string): boolean {
  const selfDir = `${configDir}/plugins/${selfId}`;
  if (path === selfDir || path.startsWith(`${selfDir}/`)) return true;
  if (
    path === `${configDir}/workspace.json` ||
    path === `${configDir}/workspace-mobile.json` ||
    path === `${configDir}/workspaces.json`
  ) {
    return true;
  }
  if (path === ".trash" || path.startsWith(".trash/")) return true;
  const base = pathBasename(path);
  if (base === ".DS_Store" || base === "Thumbs.db" || base === "desktop.ini") return true;
  return (
    base.endsWith(".tmp") || base.endsWith(".swp") || base.startsWith("~$") || base.startsWith(".#")
  );
}

type GlobToken =
  | { kind: "any" }
  | { kind: "segment" }
  | { kind: "one" }
  | { kind: "char"; char: string };

function tokenizeGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "?") {
      tokens.push({ kind: "one" });
      continue;
    }
    if (char !== "*") {
      tokens.push({ kind: "char", char });
      continue;
    }
    let end = index;
    while (pattern[end + 1] === "*") end += 1;
    const any = end > index;
    index = any && pattern[end + 1] === "/" ? end + 1 : end;
    tokens.push({ kind: any ? "any" : "segment" });
  }
  return tokens;
}

function matchGlob(pattern: string, path: string): boolean {
  let matched = Array.from({ length: path.length + 1 }, (_, end) => end === 0);
  for (const token of tokenizeGlob(pattern)) {
    const next = new Array<boolean>(path.length + 1).fill(false);
    if (token.kind === "any" || token.kind === "segment") {
      let reachable = false;
      for (let end = 0; end <= path.length; end += 1) {
        const crossesSlash = token.kind === "segment" && path[end - 1] === "/";
        reachable = (matched[end] ?? false) || (reachable && end > 0 && !crossesSlash);
        next[end] = reachable;
      }
    } else {
      for (let end = 0; end < path.length; end += 1) {
        if (!matched[end]) continue;
        const char = path[end];
        next[end + 1] = token.kind === "one" ? char !== "/" : char === token.char;
      }
    }
    matched = next;
  }
  return matched[path.length] ?? false;
}

export function isExcluded(
  path: string,
  configDir: string,
  selfId: string,
  patterns: readonly string[],
): boolean {
  if (isFixedExcluded(path, configDir, selfId)) return true;
  return patterns.some((pattern) => matchGlob(pattern, path));
}
