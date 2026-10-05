import { diff3Merge } from "node-diff3";
import { parse } from "yaml";

export type TextMergeResult =
  | { kind: "merged"; text: string }
  | { kind: "conflict"; textWithMarkers: string };

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const normalized = trailingNewline ? text.slice(0, -1) : text;
  return { lines: normalized.length === 0 ? [] : normalized.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const text = lines.join("\n");
  return trailingNewline ? `${text}\n` : text;
}

function frontMatterIsValid(text: string): boolean {
  if (!text.startsWith("---")) return true;
  const close = text.indexOf("\n---", 3);
  if (close === -1) return true;
  const yamlText = text.slice(text.indexOf("\n") + 1, close);
  try {
    parse(yamlText);
    return true;
  } catch {
    return false;
  }
}

export function mergeText(base: string, local: string, remote: string): TextMergeResult {
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);
  const regions = diff3Merge(localLines.lines, baseLines.lines, remoteLines.lines, {
    excludeFalseConflicts: true,
  });
  const lines: string[] = [];
  let conflicted = false;
  for (const region of regions) {
    const ok = "ok" in region ? region.ok : undefined;
    const conflict = "conflict" in region ? region.conflict : undefined;
    if (ok) {
      lines.push(...ok);
      continue;
    }
    if (!conflict) continue;
    conflicted = true;
    lines.push(
      "<<<<<<< local",
      ...conflict.a,
      "||||||| base",
      ...conflict.o,
      "=======",
      ...conflict.b,
      ">>>>>>> remote",
    );
  }
  const trailingNewline =
    localLines.trailingNewline || remoteLines.trailingNewline || baseLines.trailingNewline;
  const text = joinLines(lines, trailingNewline);
  if (conflicted || !frontMatterIsValid(text)) return { kind: "conflict", textWithMarkers: text };
  return { kind: "merged", text };
}
