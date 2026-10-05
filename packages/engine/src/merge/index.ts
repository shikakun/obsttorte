import { parse, stringify } from "yaml";
import { isUnderConfig } from "../quarantine";
import { mergeCanvas, type StructuredMergeResult } from "./canvas";
import {
  detectJsonStyle,
  mergeCommunityPlugins,
  mergeJson,
  parseVersions,
  stringifyJsonLike,
} from "./json";
import { mergeText } from "./text";

export type FileMergeResult =
  | { kind: "merged"; text: string }
  | { kind: "conflict"; textWithMarkers?: string }
  | { kind: "keep-both" };

const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "markdown",
  "css",
  "js",
  "ts",
  "yml",
  "yaml",
  "json",
  "canvas",
  "base",
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index + 1).toLowerCase();
}

export function isBinaryPath(path: string): boolean {
  return !TEXT_EXTENSIONS.has(extensionOf(path));
}

export function mergeFile(input: {
  path: string;
  configDir: string;
  baseText: string;
  localText: string;
  remoteText: string;
  autoMerge: boolean;
}): FileMergeResult {
  if (isBinaryPath(input.path)) return { kind: "keep-both" };
  if (!input.autoMerge) return { kind: "conflict" };
  const extension = extensionOf(input.path);
  if (extension === "canvas") return mergeCanvas(input.baseText, input.localText, input.remoteText);
  if (extension === "base") return mergeYaml(input.baseText, input.localText, input.remoteText);
  if (extension === "json" && isUnderConfig(input.path, input.configDir)) {
    return mergeConfigJson(input.path, input.baseText, input.localText, input.remoteText);
  }
  return mergeText(input.baseText, input.localText, input.remoteText);
}

function mergeConfigJson(
  path: string,
  baseText: string,
  localText: string,
  remoteText: string,
): FileMergeResult {
  const parsed = parseVersions(JSON.parse, baseText, localText, remoteText);
  if (!parsed) return { kind: "conflict" };
  const result = path.endsWith("/community-plugins.json")
    ? mergeCommunityPlugins(...parsed)
    : mergeJson(...parsed);
  if (result.kind === "ambiguous") return { kind: "conflict" };
  return { kind: "merged", text: stringifyJsonLike(result.value, detectJsonStyle(localText)) };
}

function mergeYaml(baseText: string, localText: string, remoteText: string): StructuredMergeResult {
  const parsed = parseVersions(parse, baseText, localText, remoteText);
  if (!parsed) return { kind: "conflict" };
  const result = mergeJson(...parsed);
  if (result.kind === "ambiguous") return { kind: "conflict" };
  return { kind: "merged", text: stringifyYamlLike(result.value, detectYamlStyle(localText)) };
}

function detectYamlStyle(text: string): { indent: number; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const match = /\n( +)\S/.exec(text);
  const indent = match?.[1]?.length ?? 2;
  return { indent: indent > 0 ? indent : 2, trailingNewline };
}

function stringifyYamlLike(
  value: unknown,
  style: { indent: number; trailingNewline: boolean },
): string {
  const rendered = stringify(value, { indent: style.indent, lineWidth: 0 });
  const body = rendered.replace(/\n$/, "");
  return style.trailingNewline ? `${body}\n` : body;
}

export { detectJsonStyle, mergeJsonWithPreference, stringifyJsonLike } from "./json";
export { mergeText } from "./text";
