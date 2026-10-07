import { DEFAULT_SHARED_SETTINGS, type IndexEntry, sha256Hex } from "@obsttorte/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ApiClient, ApiRequestError } from "./api-client";
import { newerConflictSide } from "./conflict-choice";
import { decideAction, losesSurvivor } from "./decide";
import { diffLines } from "./diff";
import { isExcluded } from "./exclusions";
import { type LocalIndexEntry, MemoryIndex, MemoryJournal, MemoryVault } from "./memory";
import { mergeFile } from "./merge";
import { deepEqual, mergeJson } from "./merge/json";
import { mergeText } from "./merge/text";
import { buildSyncPlan, type PlanInput, type PlanItem } from "./plan";
import { createQuarantineMatcher, findNewPluginIds } from "./quarantine";
import { diffSnapshot } from "./snapshot-diff";
import { runSync, type SyncRequest } from "./sync";
import { groupByBudget } from "./transfer";

const sha = fc.stringMatching(/^[a-f0-9]{64}$/);
const shaOrNull = fc.option(sha, { nil: null });

function remote(path: string, sha256: string | null, rev = 1, seq = rev): IndexEntry {
  return { path, sha256, size: sha256 ? 4 : 0, rev, seq, deleted: sha256 === null, updatedAt: seq };
}

function remoteIndex(seq: number, entries: IndexEntry[]) {
  return {
    async index() {
      return { seq, truncated: false, entries };
    },
  };
}

async function knownIndex(
  ...entries: Array<Partial<LocalIndexEntry> & { path: string; sha256: string }>
): Promise<MemoryIndex> {
  const index = new MemoryIndex();
  index.initialized = true;
  index.cursor = 1;
  for (const entry of entries) {
    await index.put({
      localPath: entry.path,
      mtime: 1,
      size: 0,
      baseSha256: entry.sha256,
      baseRev: 1,
      ...entry,
    });
  }
  return index;
}

function syncRequest(
  vault: MemoryVault,
  index: MemoryIndex,
  api: object,
  extra: Partial<SyncRequest> = {},
): SyncRequest {
  return {
    vault,
    api: api as ApiClient,
    index,
    journal: new MemoryJournal(),
    settings: DEFAULT_SHARED_SETTINGS,
    mode: "bidirectional",
    configDir: ".obsidian",
    selfId: "obsttorte",
    deviceName: "laptop",
    full: true,
    forceRehash: false,
    dirtyPaths: [],
    reloadPending: [],
    unresolvedConflicts: [],
    approved: [],
    knownPluginIds: [],
    acknowledgeGuard: true,
    now: () => 1_700_000_000_000,
    ...extra,
  };
}

function actions(items: PlanItem[]): string[] {
  return items.map((item) => `${item.path}:${item.action}`).sort();
}

describe("decideAction", () => {
  it("follows the 3-way table", () => {
    expect(decideAction({ local: "a", base: "a", remote: "a" })).toBe("noop");
    expect(decideAction({ local: "b", base: "a", remote: "a" })).toBe("push");
    expect(decideAction({ local: "a", base: "a", remote: "b" })).toBe("pull");
    expect(decideAction({ local: "b", base: "a", remote: "b" })).toBe("adoptBase");
    expect(decideAction({ local: "b", base: "a", remote: "c" })).toBe("conflict");
    expect(decideAction({ local: null, base: "a", remote: "a" })).toBe("deleteRemote");
    expect(decideAction({ local: "a", base: "a", remote: null })).toBe("deleteLocal");
    expect(decideAction({ local: null, base: "a", remote: "b" })).toBe("pull");
    expect(decideAction({ local: "b", base: "a", remote: null })).toBe("push");
  });

  it("never deletes when base is missing", () => {
    fc.assert(
      fc.property(shaOrNull, shaOrNull, (local, remote) => {
        const action = decideAction({ local, base: null, remote });
        return action !== "deleteLocal" && action !== "deleteRemote";
      }),
    );
  });

  it("never discards the only surviving version", () => {
    fc.assert(
      fc.property(shaOrNull, shaOrNull, shaOrNull, (local, base, remote) => {
        const versions = { local, base, remote };
        return !losesSurvivor(versions, decideAction(versions));
      }),
    );
  });
});

describe("diffLines", () => {
  const numbered = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`);

  it("surrounds a change with three unchanged lines on each side", () => {
    const before = numbered(1, 10);
    const after = before.map((line) => (line === "line 5" ? "line five" : line));
    const [hunk, ...rest] = diffLines(before.join("\n"), after.join("\n"));
    expect(rest).toEqual([]);
    expect(hunk?.beforeStart).toBe(1);
    expect(hunk?.afterStart).toBe(1);
    expect(hunk?.lines.map((line) => [line.type, line.text])).toEqual([
      ["equal", "line 2"],
      ["equal", "line 3"],
      ["equal", "line 4"],
      ["delete", "line 5"],
      ["insert", "line five"],
      ["equal", "line 6"],
      ["equal", "line 7"],
      ["equal", "line 8"],
    ]);
  });

  it("joins changes close together and never repeats a line across hunks", () => {
    const before = numbered(1, 30);
    for (const gap of [5, 6, 7, 8, 12]) {
      const second = 2 + gap;
      const after = before.filter((line) => line !== "line 2" && line !== `line ${second}`);
      const hunks = diffLines(before.join("\n"), after.join("\n"));
      expect(hunks.length).toBe(gap - 1 <= 6 ? 1 : 2);
      const shown = hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
      expect(new Set(shown).size).toBe(shown.length);
      for (const hunk of hunks) {
        expect(before[hunk.beforeStart]).toBe(hunk.lines[0]?.text);
      }
    }
  });
});

describe("merge", () => {
  it("keeps the side that changed when the other matches base", () => {
    const json = fc.letrec((tie) => ({
      value: fc.oneof(
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie("value") as fc.Arbitrary<unknown>, { maxLength: 2 }),
        fc.dictionary(fc.stringMatching(/^[a-z]{1,4}$/), tie("value") as fc.Arbitrary<unknown>, {
          maxKeys: 3,
        }),
      ),
    })).value as fc.Arbitrary<unknown>;
    fc.assert(
      fc.property(json, json, (base, other) => {
        const localUnchanged = mergeJson(base, base, other);
        const remoteUnchanged = mergeJson(base, other, base);
        return (
          localUnchanged.kind === "merged" &&
          remoteUnchanged.kind === "merged" &&
          deepEqual(localUnchanged.value, other) &&
          deepEqual(remoteUnchanged.value, other)
        );
      }),
    );
  });

  it("merges independent JSON keys and rejects a shared key", () => {
    expect(mergeJson({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({
      kind: "merged",
      value: { a: 2, b: 3 },
    });
    expect(mergeJson({ a: 1 }, { a: 2 }, { a: 3 }).kind).toBe("ambiguous");
    expect(mergeJson({ tags: ["a"] }, { tags: ["a", "b"] }, { tags: ["a", "c"] }).kind).toBe(
      "ambiguous",
    );
  });

  it("keeps the local indent and trailing newline when merging a base file", () => {
    const base = "view:\n    type: table\n";
    const remoteText = "view:\n    type: table\n    order: 1\n";
    const merge = (localText: string) =>
      mergeFile({
        path: "notes.base",
        configDir: ".obsidian",
        baseText: base,
        localText,
        remoteText,
        autoMerge: true,
      });
    expect(merge("view:\n    type: table\n    name: Local\n")).toEqual({
      kind: "merged",
      text: "view:\n    type: table\n    name: Local\n    order: 1\n",
    });
    expect(merge("view:\n    type: table\n    name: Local")).toEqual({
      kind: "merged",
      text: "view:\n    type: table\n    name: Local\n    order: 1",
    });
  });

  it("merges non-overlapping lines and rejects broken front matter", () => {
    const base = "---\ntitle: hello\n---\nalpha\n";
    const local = "---\ntitle: hello\n---\nALPHA\n";
    expect(mergeText(base, local, "---\ntitle: world\n---\nalpha\n").kind).toBe("merged");
    expect(mergeText(base, local, "---\ntitle: [\n---\nalpha\n").kind).toBe("conflict");
  });
});

describe("quarantine and exclusions", () => {
  it("holds plugin code and the sync settings", () => {
    const match = createQuarantineMatcher({
      configDir: ".obsidian",
      codeConfiguredPluginIds: ["dataview"],
    });
    expect(match(".obsidian/plugins/foo/main.js")).toBe(true);
    expect(match(".obsidian/plugins/dataview/data.json")).toBe(true);
    expect(match(".obsidian/obsttorte.json")).toBe(true);
    expect(match(".obsidian/plugins/foo/styles.css")).toBe(false);
    expect(match(".obsidian/plugins/foo/data.json")).toBe(false);
    expect(match(".obsidian/plugins/foo/worker.js")).toBe(true);
    expect(match(".obsidian/plugins/foo/engine.wasm")).toBe(true);
    expect(match(".obsidian/plugins/foo/lib/data.json")).toBe(true);
    expect(findNewPluginIds([".obsidian/plugins/new/main.js"], ".obsidian", ["foo"])).toEqual([
      "new",
    ]);
  });

  it("excludes the plugin directory and OS junk without hardcoding the config name", () => {
    expect(
      isExcluded("vault-config/plugins/obsttorte/data.json", "vault-config", "obsttorte", []),
    ).toBe(true);
    expect(isExcluded("notes/.DS_Store", "vault-config", "obsttorte", [])).toBe(true);
    expect(isExcluded("notes/chapter.tmp", "vault-config", "obsttorte", [])).toBe(true);
    expect(isExcluded("secret/draft.md", ".obsidian", "obsttorte", ["secret/**"])).toBe(true);
  });

  it("matches exclusion globs within segments and across them", () => {
    const excluded = (pattern: string, path: string) =>
      isExcluded(path, ".obsidian", "obsttorte", [pattern]);
    expect(excluded("*.pdf", "a.pdf")).toBe(true);
    expect(excluded("*.pdf", "dir/a.pdf")).toBe(false);
    expect(excluded("**/*.pdf", "dir/sub/a.pdf")).toBe(true);
    expect(excluded("**/*.pdf", "a.pdf")).toBe(true);
    expect(excluded("draft?.md", "draft1.md")).toBe(true);
    expect(excluded("draft?.md", "draft/.md")).toBe(false);
    expect(excluded("a.(md)", "a.(md)")).toBe(true);
    expect(excluded("a.md", "aXmd")).toBe(false);
  });

  it("matches a pattern full of stars in linear time", () => {
    const path = `${"a".repeat(2000)}/${"a".repeat(2000)}`;
    const started = performance.now();
    expect(isExcluded(path, ".obsidian", "obsttorte", [`${"*a".repeat(40)}b`])).toBe(false);
    expect(isExcluded(path, ".obsidian", "obsttorte", [`${"*".repeat(40)}b`])).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("buildSyncPlan", () => {
  const plan = (input: Partial<PlanInput>) =>
    buildSyncPlan({
      local: [],
      remote: [],
      base: [],
      undetermined: [],
      mode: "bidirectional",
      thresholds: DEFAULT_SHARED_SETTINGS.bulkGuard,
      indexedCount: 0,
      fullScan: true,
      fullIndex: true,
      hasBase: input.base !== undefined && input.base.length > 0,
      configDir: ".obsidian",
      selfId: "obsttorte",
      exclusionPatterns: [],
      knownPluginIds: [],
      codeConfiguredPluginIds: [],
      approved: [],
      pluginDataSync: {},
      reloadPending: [],
      unresolvedConflicts: [],
      repairPull: [],
      ...input,
    });

  it("does not delete a file that is excluded", () => {
    const result = plan({
      exclusionPatterns: ["Secret.md"],
      local: [{ path: "Secret.md", sha256: "local", size: 3 }],
      remote: [remote("Secret.md", null, 2)],
      base: [{ path: "Secret.md", sha256: "local", rev: 1 }],
    });
    expect(result.items).toEqual([]);
    expect(result.skipped).toContainEqual({ path: "Secret.md", reason: "excluded" });
  });

  it("does not turn an unreadable file into a deletion", () => {
    const result = plan({
      remote: [remote("Note.md", "abc", 2)],
      base: [{ path: "Note.md", sha256: "abc", rev: 2 }],
      undetermined: [{ path: "Note.md", reason: "read-failed" }],
    });
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual([{ path: "Note.md", reason: "read-failed" }]);
  });

  it("leaves a name that another platform cannot store untouched on every side", () => {
    const result = plan({
      local: [{ path: "a:b.md", sha256: "local", size: 3 }],
      remote: [remote("CON.md", "abc", 1)],
      base: [{ path: "trailing.", sha256: "abc", rev: 1 }],
    });
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "a:b.md", reason: "unportable-name" },
        { path: "CON.md", reason: "unportable-name" },
        { path: "trailing.", reason: "unportable-name" },
      ]),
    );
  });

  it("does not count a remote rename as a deletion", () => {
    const result = plan({
      thresholds: { maxDeletions: 0, maxDeletionRatio: 1, maxChangeRatio: 1, maxShrinkToZero: 100 },
      local: [{ path: "Note.md", sha256: "same", size: 4 }],
      remote: [remote("Note.md", null, 2, 2), remote("note.md", "same", 2, 3)],
      base: [{ path: "Note.md", sha256: "same", rev: 1 }],
      indexedCount: 1,
    });
    expect(actions(result.items)).toEqual(["Note.md:deleteLocal", "note.md:pull"]);
    expect(result.guard.kind).toBe("ok");
  });

  it("cancels a local rename before counting deletions", () => {
    const rest = Array.from({ length: 8 }, (_, index) => `file-${index}.md`);
    const result = plan({
      local: [
        { path: "note.md", sha256: "same", size: 4 },
        ...rest.map((path) => ({ path, sha256: path, size: 4 })),
      ],
      remote: [remote("Note.md", "same"), ...rest.map((path) => remote(path, path))],
      base: [
        { path: "Note.md", sha256: "same", rev: 1 },
        ...rest.map((path) => ({ path, sha256: path, rev: 1 })),
      ],
      indexedCount: 9,
    });
    expect(actions(result.items)).toEqual(
      expect.arrayContaining(["note.md:push", "Note.md:deleteRemote"]),
    );
    expect(result.guard.kind).toBe("ok");
  });

  it("merges a copied vault without deleting either side", () => {
    const result = plan({
      local: [{ path: "Local.md", sha256: "local", size: 3 }],
      remote: [remote("Remote.md", "remote")],
    });
    expect(actions(result.items)).toEqual(["Local.md:push", "Remote.md:pull"]);
  });

  it("holds two live paths that differ only by case", () => {
    const result = plan({
      local: [{ path: "note.md", sha256: "local", size: 3 }],
      remote: [remote("Note.md", "remote")],
    });
    expect(result.items).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["path-collision", "path-collision"]);
  });

  it("quarantines a new plugin instead of applying it", () => {
    const result = plan({ remote: [remote(".obsidian/plugins/unknown/main.js", "code")] });
    expect(result.items).toEqual([]);
    expect(result.newPluginIds).toEqual(["unknown"]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["quarantine"]);
  });

  it("does not delete a file while an unapproved remote version is held", () => {
    const path = ".obsidian/plugins/dataview/main.js";
    const result = plan({
      local: [{ path, sha256: "local", size: 4 }],
      remote: [remote(path, null, 3)],
      base: [{ path, sha256: "local", rev: 2 }],
      held: [{ path, sha256: "remote-code" }],
    });
    expect(result.items).toEqual([]);
    expect(result.skipped).toContainEqual({ path, reason: "quarantine" });
  });

  it("leaves a settings file waiting for reload untouched", () => {
    const path = ".obsidian/appearance.json";
    const result = plan({
      local: [{ path, sha256: "local", size: 4 }],
      remote: [remote(path, "remote", 2)],
      base: [{ path, sha256: "base", rev: 1 }],
      reloadPending: [path],
    });
    expect(result.items).toEqual([]);
    expect(result.skipped).toContainEqual({ path, reason: "reload-pending" });
  });

  it("aborts when a full scan shrinks far below the index", () => {
    const result = plan({
      local: [{ path: "a.md", sha256: "a", size: 1 }],
      indexedCount: 10,
      hasBase: true,
    });
    expect(result.guard).toEqual({ kind: "abort", reason: "local-shrunk" });
  });
});

describe("runSync", () => {
  it("forgets a stored base when a path becomes excluded", async () => {
    const vault = new MemoryVault();
    const local = await vault.seed("Secret.md", "local");
    const index = await knownIndex({ path: "Secret.md", sha256: local });
    const result = await runSync(
      syncRequest(vault, index, remoteIndex(2, [remote("Secret.md", null, 2)]), {
        settings: { ...DEFAULT_SHARED_SETTINGS, exclusions: ["Secret.md"] },
      }),
    );
    expect(result.plan?.items).toEqual([]);
    expect(await vault.stat("Secret.md")).not.toBeNull();
    expect(await index.get("Secret.md")).toMatchObject({ baseSha256: null, baseRev: 0 });
  });

  it("records a journal before an automatic settings merge and waits for reload", async () => {
    const path = ".obsidian/appearance.json";
    const base = '{\n  "theme": "moonstone"\n}\n';
    const local = '{\n  "theme": "moonstone",\n  "cssTheme": "Local"\n}\n';
    const remoteText = '{\n  "theme": "moonstone",\n  "baseFontSize": 16\n}\n';
    const objects = new Map<string, ArrayBuffer>();
    for (const text of [base, remoteText]) {
      objects.set(await sha256Hex(text), new TextEncoder().encode(text).buffer);
    }
    const vault = new MemoryVault();
    const index = await knownIndex({
      path,
      sha256: await vault.seed(path, local),
      baseSha256: await sha256Hex(base),
    });
    const journal = new MemoryJournal();
    let journaledBeforeWrite = false;
    const writeBinary = vault.writeBinary.bind(vault);
    vault.writeBinary = async (writtenPath, data) => {
      journaledBeforeWrite = journal.entries.some((entry) => entry.path === writtenPath);
      await writeBinary(writtenPath, data);
    };
    const api = {
      ...remoteIndex(2, [remote(path, await sha256Hex(remoteText), 2)]),
      async getObject(sha256: string) {
        return objects.get(sha256);
      },
      async existingObjects() {
        return new Set<string>();
      },
      async putObject() {},
      async commit(request: { changes: Array<{ path: string }> }) {
        return {
          seq: 3,
          applied: request.changes.map((change) => ({ path: change.path, rev: 3, seq: 3 })),
          rejected: [],
        };
      },
    };
    const result = await runSync(syncRequest(vault, index, api, { journal }));
    expect(journaledBeforeWrite).toBe(true);
    expect(journal.entries).toEqual([]);
    expect(result.status).toBe("ok");
    expect(result.reloadPending).toEqual([path]);
    const written = new TextDecoder().decode(await vault.readBinary(path));
    expect(written).toContain("cssTheme");
    expect(written).toContain("baseFontSize");
  });

  it("does not write anything for an index entry with an invalid path or sha256", async () => {
    const vault = new MemoryVault();
    const local = await vault.seed("Note.md", "local");
    const index = await knownIndex({ path: "Note.md", sha256: local });
    const content = await sha256Hex("payload");
    const requested: string[] = [];
    const api = {
      ...remoteIndex(3, [
        remote("../../.bashrc", content, 1),
        remote(".obsidian/plugins/x/../../community-plugins.json", content, 2),
        remote("Note.md", "../objects", 3),
      ]),
      async getObject(sha256: string) {
        requested.push(sha256);
        return new TextEncoder().encode("payload").buffer;
      },
    };
    const result = await runSync(syncRequest(vault, index, api));
    expect(result.status).toBe("ok");
    expect(result.plan?.items).toEqual([]);
    expect(result.plan?.skipped).toEqual(
      expect.arrayContaining([
        { path: "../../.bashrc", reason: "invalid-remote" },
        { path: ".obsidian/plugins/x/../../community-plugins.json", reason: "invalid-remote" },
        { path: "Note.md", reason: "invalid-remote" },
      ]),
    );
    expect(requested).toEqual([]);
    expect(await vault.listFiles()).toEqual([expect.objectContaining({ path: "Note.md" })]);
    const stashes = await index.getStashes();
    expect([...stashes.keys()]).toEqual(["Note.md"]);
    expect(stashes.get("Note.md")?.sha256).toBe(local);
  });

  it("keeps syncing other files when one file cannot be written locally", async () => {
    const vault = new MemoryVault();
    const writeBinary = vault.writeBinary.bind(vault);
    vault.writeBinary = async (path, data) => {
      if (path === "Locked.md") throw new Error("EBUSY");
      await writeBinary(path, data);
    };
    const objects = new Map<string, ArrayBuffer>();
    for (const text of ["locked", "open"]) {
      objects.set(await sha256Hex(text), new TextEncoder().encode(text).buffer);
    }
    const api = {
      ...remoteIndex(2, [
        remote("Locked.md", await sha256Hex("locked"), 2),
        remote("Open.md", await sha256Hex("open"), 2),
      ]),
      async getObject(sha256: string) {
        return objects.get(sha256);
      },
    };
    const index = await knownIndex();
    const result = await runSync(syncRequest(vault, index, api));
    expect(result.status).toBe("ok");
    expect(result.rejected).toEqual([
      { path: "Locked.md", reason: "writeFailed", detail: "EBUSY" },
    ]);
    expect(result.applied).toContain("Open.md");
    expect(await vault.stat("Locked.md")).toBeNull();
    expect(await index.get("Locked.md")).toBeNull();
  });

  it("keeps the server revision for files that already match on a server takeover", async () => {
    const vault = new MemoryVault();
    const same = await vault.seed("Same.md", "same");
    const index = new MemoryIndex();
    const api = {
      ...remoteIndex(4, [remote("Same.md", same, 3), remote("Gone.md", null, 4)]),
      async existingObjects(hashes: string[]) {
        return new Set(hashes);
      },
      async createSnapshot() {
        return { id: "1-device-test" };
      },
    };
    const result = await runSync(syncRequest(vault, index, api, { strategy: "server" }));
    expect(result.status).toBe("ok");
    expect(await index.get("Same.md")).toMatchObject({ baseSha256: same, baseRev: 3 });
    expect(await index.get("Gone.md")).toMatchObject({ baseSha256: null, baseRev: 4 });
  });

  it("asks before a server takeover that crosses the bulk-change guard", async () => {
    const vault = new MemoryVault();
    await vault.seed("Note.md", "local");
    const index = new MemoryIndex();
    const api = remoteIndex(2, [remote("Note.md", "b".repeat(64), 2)]);
    const result = await runSync(
      syncRequest(vault, index, api, { strategy: "server", acknowledgeGuard: false }),
    );
    expect(result.status).toBe("needs-guard-confirm");
    expect(await vault.stat("Note.md")).not.toBeNull();
    expect(await index.isInitialized()).toBe(false);
  });

  it("rehashes unchanged mtimes on a partial sync when a full rehash is due", async () => {
    const vault = new MemoryVault();
    const original = await vault.seed("Note.md", "old", 10);
    vault.overwrite("Note.md", "new");
    const index = await knownIndex({ path: "Note.md", sha256: original, mtime: 10, size: 3 });
    const commits: string[] = [];
    const api = {
      ...remoteIndex(1, []),
      async existingObjects() {
        return new Set<string>();
      },
      async putObject() {},
      async commit(body: { changes: Array<{ path: string }> }) {
        commits.push(...body.changes.map((change) => change.path));
        return {
          seq: 2,
          applied: body.changes.map((change) => ({ path: change.path, rev: 2, seq: 2 })),
          rejected: [],
        };
      },
    };
    await runSync(syncRequest(vault, index, api, { full: false }));
    expect(commits).toEqual([]);
    await runSync(syncRequest(vault, index, api, { full: false, forceRehash: true }));
    expect(commits).toEqual(["Note.md"]);
  });

  describe("upload failures", () => {
    async function pushingVault() {
      const vault = new MemoryVault();
      const localSha = await vault.seed("Note.md", "local-body", 10);
      const baseSha = await sha256Hex("base-body");
      const index = await knownIndex({ path: "Note.md", sha256: baseSha });
      return { vault, index, localSha, baseSha };
    }

    it("rereads a file once after a checksum mismatch", async () => {
      const { vault, index, localSha, baseSha } = await pushingVault();
      let puts = 0;
      let committed = "";
      const api = {
        ...remoteIndex(1, [remote("Note.md", baseSha)]),
        async existingObjects() {
          return new Set<string>();
        },
        async putObject() {
          puts += 1;
          if (puts === 1) throw new ApiRequestError("checksum", 422, null, "mismatch");
        },
        async commit(request: { changes: Array<{ sha256?: string }> }) {
          committed = request.changes[0]?.sha256 ?? "";
          return { seq: 2, applied: [{ path: "Note.md", rev: 2, seq: 2 }], rejected: [] };
        },
      };
      const result = await runSync(syncRequest(vault, index, api));
      expect(result.status).toBe("ok");
      expect(puts).toBe(2);
      expect(committed).toBe(localSha);
    });

    it("leaves an oversized upload undetermined", async () => {
      const { vault, index, baseSha } = await pushingVault();
      let committed = false;
      const api = {
        ...remoteIndex(1, [remote("Note.md", baseSha)]),
        async existingObjects() {
          return new Set<string>();
        },
        async putObject() {
          throw new ApiRequestError("too-large", 413, null, "too large");
        },
        async commit() {
          committed = true;
          return { seq: 2, applied: [], rejected: [] };
        },
      };
      const result = await runSync(syncRequest(vault, index, api));
      expect(result.status).toBe("ok");
      expect(committed).toBe(false);
      expect(result.plan?.skipped).toContainEqual({ path: "Note.md", reason: "oversize" });
    });
  });
});

describe("groupByBudget", () => {
  it("processes an oversized file alone and stops a group at the concurrency cap", () => {
    const items = [
      { path: "big", size: 100 },
      { path: "a", size: 10 },
      { path: "b", size: 10 },
      { path: "c", size: 10 },
      { path: "d", size: 40 },
    ];
    expect(
      groupByBudget(items, 3, 50, (item) => item.size).map((group) =>
        group.map((item) => item.path),
      ),
    ).toEqual([["big"], ["a", "b", "c"], ["d"]]);
  });
});

describe("diffSnapshot", () => {
  it("lists files a snapshot would add, change, or remove", () => {
    expect(
      diffSnapshot(
        [
          { path: "a.md", sha256: "1", deleted: false },
          { path: "b.md", sha256: "2", deleted: false },
          { path: "gone.md", sha256: null, deleted: true },
        ],
        { "b.md": { sha256: "9" }, "c.md": { sha256: "3" } },
      ),
    ).toEqual({ added: ["c.md"], changed: ["b.md"], removed: ["a.md"] });
  });
});

describe("newerConflictSide", () => {
  it("picks the version with the later server timestamp", () => {
    expect(newerConflictSide(1, 2)).toBe("remote");
    expect(newerConflictSide(3, 2)).toBe("local");
  });
});
