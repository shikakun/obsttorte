import {
  type ApiClient,
  detectJsonStyle,
  mergeJsonWithPreference,
  newerConflictSide,
  readFullIndex,
  stringifyJsonLike,
  type VaultPort,
} from "@obsttorte/engine";
import { type ConflictRecord, type IndexEntry, sha256Hex } from "@obsttorte/shared";

export type ResolveChoice =
  | "local"
  | "remote"
  | "local-remote"
  | "remote-local"
  | "edit"
  | "json-local-first"
  | "json-remote-first";

export async function resolveConflict(
  api: ApiClient,
  vault: VaultPort,
  conflict: ConflictRecord,
  choice: ResolveChoice,
  editedText?: string,
): Promise<void> {
  const bytes = await bytesForChoice(api, vault, conflict, choice, editedText);
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== conflict.remoteSha) await api.putObject(sha256, bytes);
  await api.resolveConflict(conflict.id, { sha256, size: bytes.byteLength });
}

export async function resolveAll(
  api: ApiClient,
  vault: VaultPort,
  conflicts: ConflictRecord[],
  choice: "local" | "remote" | "newer",
): Promise<{ resolved: number; failed: number }> {
  let resolved = 0;
  let failed = 0;
  for (const conflict of conflicts) {
    const side =
      choice === "newer"
        ? newerConflictSide(conflict.localUpdatedAt, conflict.remoteUpdatedAt)
        : choice;
    try {
      await resolveConflict(api, vault, conflict, side);
      resolved += 1;
    } catch {
      failed += 1;
    }
  }
  return { resolved, failed };
}

export async function approveQuarantine(
  api: ApiClient,
  path: string,
  shownSha256: string,
): Promise<string | null> {
  const remote = await findRemote(api, path);
  if (!remote?.sha256) throw new Error("Remote file was not found");
  return remote.sha256 === shownSha256 ? shownSha256 : null;
}

export async function rejectQuarantine(
  api: ApiClient,
  vault: VaultPort,
  path: string,
): Promise<void> {
  const remote = await findRemote(api, path);
  const bytes = await vault.readBinary(path);
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== remote?.sha256) await api.putObject(sha256, bytes);
  await api.commit({
    requestId: crypto.randomUUID(),
    changes: [{ path, sha256, size: bytes.byteLength, expectedRev: remote?.rev ?? 0 }],
  });
}

async function bytesForChoice(
  api: ApiClient,
  vault: VaultPort,
  conflict: ConflictRecord,
  choice: ResolveChoice,
  editedText?: string,
): Promise<ArrayBuffer> {
  if (choice === "remote") {
    const bytes = await getVerified(api, conflict.remoteSha);
    await vault.writeBinary(conflict.path, bytes);
    return bytes;
  }
  if (choice === "edit") return encodeText(editedText ?? "");
  if (choice === "local") return vault.readBinary(conflict.path);
  const texts = await loadConflictTexts(api, vault, conflict);
  const bytes = encodeText(combinedText(texts, choice));
  await vault.writeBinary(conflict.path, bytes);
  return bytes;
}

function combinedText(
  texts: { base: string; local: string; remote: string },
  choice: "local-remote" | "remote-local" | "json-local-first" | "json-remote-first",
): string {
  if (choice === "local-remote") return `${texts.local}\n${texts.remote}`;
  if (choice === "remote-local") return `${texts.remote}\n${texts.local}`;
  const preferLocal = choice === "json-local-first";
  try {
    const value = mergeJsonWithPreference(
      texts.base ? (JSON.parse(texts.base) as unknown) : null,
      JSON.parse(texts.local) as unknown,
      JSON.parse(texts.remote) as unknown,
      preferLocal ? "local-first" : "remote-first",
    );
    return stringifyJsonLike(value, detectJsonStyle(texts.local));
  } catch {
    return preferLocal ? texts.local : texts.remote;
  }
}

function encodeText(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

export async function loadConflictTexts(
  api: ApiClient,
  vault: VaultPort,
  conflict: ConflictRecord,
): Promise<{ base: string; local: string; remote: string }> {
  const local = new TextDecoder().decode(await vault.readBinary(conflict.path));
  const remote = new TextDecoder().decode(await getVerified(api, conflict.remoteSha));
  const base = conflict.baseSha
    ? new TextDecoder().decode(await getVerified(api, conflict.baseSha))
    : "";
  return { base, local, remote };
}

async function getVerified(api: ApiClient, sha256: string): Promise<ArrayBuffer> {
  const bytes = await api.getObject(sha256);
  if ((await sha256Hex(bytes)) !== sha256) throw new Error("Remote checksum did not match");
  return bytes;
}

export type ManifestFields = {
  id: string;
  name: string;
  version: string;
  author: string;
};

export type QuarantineDetail = {
  path: string;
  sha256: string;
  size: number;
  files: Array<{ path: string; size: number; sha256: string }>;
  manifest: ManifestFields | null;
  previousManifest: ManifestFields | null;
  newPlugin: boolean;
};

export async function describeQuarantine(
  api: ApiClient,
  vault: VaultPort,
  path: string,
  newPluginIds: readonly string[] = [],
): Promise<QuarantineDetail> {
  const { entries: remoteEntries } = await readFullIndex(api);
  const remote = remoteEntries.find((entry) => entry.path === path) ?? null;
  const pluginDir = pluginDirectory(path);
  const pluginId = pluginDir?.split("/").at(-1) ?? "";
  const files = remoteEntries
    .filter((entry) => pluginDir && entry.path.startsWith(`${pluginDir}/`) && !entry.deleted)
    .map((entry) => ({
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256 ?? "",
    }));
  if (files.length === 0 && remote?.sha256) {
    files.push({ path, size: remote.size, sha256: remote.sha256 });
  }
  const manifestPath = manifestPathFor(path);
  let manifestRemote: string | null = null;
  let manifestLocal: string | null = null;
  if (manifestPath) {
    try {
      manifestLocal = new TextDecoder().decode(await vault.readBinary(manifestPath));
    } catch {
      manifestLocal = null;
    }
    const remoteManifest = remoteEntries.find((entry) => entry.path === manifestPath);
    if (remoteManifest?.sha256) {
      manifestRemote = new TextDecoder().decode(await getVerified(api, remoteManifest.sha256));
    }
  }
  return {
    path,
    sha256: remote?.sha256 ?? "",
    size: remote?.size ?? 0,
    files,
    manifest: parseManifest(manifestRemote),
    previousManifest: parseManifest(manifestLocal),
    newPlugin: newPluginIds.includes(pluginId),
  };
}

function parseManifest(text: string | null): ManifestFields | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      id: typeof parsed.id === "string" ? parsed.id : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
      version: typeof parsed.version === "string" ? parsed.version : "",
      author: typeof parsed.author === "string" ? parsed.author : "",
    };
  } catch {
    return null;
  }
}

function pluginDirectory(path: string): string | null {
  const match = /^(.*\/plugins\/[^/]+)\//.exec(path);
  return match?.[1] ?? null;
}

function manifestPathFor(path: string): string | null {
  const match = /^(.*\/plugins\/[^/]+)\/[^/]+$/.exec(path);
  return match ? `${match[1]}/manifest.json` : null;
}

async function findRemote(api: ApiClient, path: string): Promise<IndexEntry | null> {
  const { entries } = await readFullIndex(api);
  return entries.find((entry) => entry.path === path) ?? null;
}
