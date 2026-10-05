import {
  type CommitRequest,
  type CommitResponse,
  type ConflictCreateRequest,
  type ConflictRecord,
  type FileChange,
  type IndexEntry,
  sha256Hex,
  toPathKey,
  validatePath,
} from "@obsttorte/shared";
import { DEFAULT_SHARED_SETTINGS } from "@obsttorte/shared/settings";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api-client";
import { MemoryIndex, MemoryJournal, MemoryVault } from "./memory";
import { runSync } from "./sync";

type StoredFile = {
  path: string;
  sha256: string | null;
  size: number;
  rev: number;
  seq: number;
  deleted: boolean;
  updatedAt: number;
};

class MemoryHub {
  private seq = 0;
  private readonly objects = new Map<string, Uint8Array>();
  private readonly files = new Map<string, StoredFile>();
  private readonly responses = new Map<string, CommitResponse>();
  readonly conflicts: ConflictRecord[] = [];

  async index(since?: number): Promise<{ seq: number; truncated: boolean; entries: IndexEntry[] }> {
    const entries = [...this.files.values()]
      .filter((file) => since === undefined || file.seq > since)
      .sort((left, right) => left.seq - right.seq);
    return { seq: this.seq, truncated: false, entries };
  }

  async existingObjects(sha256s: string[]): Promise<Set<string>> {
    return new Set(sha256s.filter((sha) => this.objects.has(sha)));
  }

  async putObject(sha256: string, body: ArrayBuffer): Promise<void> {
    if ((await sha256Hex(body)) !== sha256) throw new Error("checksum");
    this.objects.set(sha256, new Uint8Array(body));
  }

  async getObject(sha256: string): Promise<ArrayBuffer> {
    const bytes = this.objects.get(sha256);
    if (!bytes) throw new Error("missing object");
    return bytes.slice().buffer;
  }

  async createConflict(request: ConflictCreateRequest): Promise<ConflictRecord> {
    const record: ConflictRecord = {
      id: crypto.randomUUID(),
      path: request.path,
      baseSha: request.baseSha,
      localSha: request.localSha,
      remoteSha: request.remoteSha,
      deviceId: "hub",
      deviceName: "hub",
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedSha: null,
    };
    this.conflicts.push(record);
    return record;
  }

  async createSnapshot(): Promise<{ id: string }> {
    return { id: `${Date.now()}-server` };
  }

  conflictPaths(): string[] {
    return this.conflicts.filter((conflict) => conflict.resolvedAt === null).map((c) => c.path);
  }

  file(path: string): StoredFile | undefined {
    return this.files.get(path);
  }

  async commit(request: CommitRequest): Promise<CommitResponse> {
    const cached = this.responses.get(request.requestId);
    if (cached) return cached;
    const applied: CommitResponse["applied"] = [];
    const rejected: CommitResponse["rejected"] = [];
    for (const change of request.changes) {
      const outcome = await this.applyChange(change);
      if (outcome.kind === "applied") applied.push(outcome.row);
      else rejected.push(outcome.row);
    }
    const response = { seq: this.seq, applied, rejected };
    this.responses.set(request.requestId, response);
    return response;
  }

  private async applyChange(
    change: FileChange,
  ): Promise<
    | { kind: "applied"; row: CommitResponse["applied"][number] }
    | { kind: "rejected"; row: CommitResponse["rejected"][number] }
  > {
    const path = change.path;
    try {
      validatePath(path);
    } catch {
      return {
        kind: "rejected",
        row: { path, reason: "invalidPath", currentRev: null, currentSha256: null },
      };
    }
    const current = this.files.get(path);
    const currentRev = current?.rev ?? 0;
    if (change.expectedRev !== currentRev) {
      return {
        kind: "rejected",
        row: {
          path,
          reason: "revMismatch",
          currentRev: current ? current.rev : null,
          currentSha256: current?.sha256 ?? null,
        },
      };
    }
    const deleted = "deleted" in change;
    if (!deleted) {
      const owner = this.liveOwner(path);
      if (owner) {
        return {
          kind: "rejected",
          row: {
            path,
            reason: "pathCollision",
            currentRev: current?.rev ?? null,
            currentSha256: current?.sha256 ?? null,
          },
        };
      }
      const bytes = this.objects.get(change.sha256);
      if (!bytes || bytes.byteLength !== change.size) {
        return {
          kind: "rejected",
          row: {
            path,
            reason: "missingObject",
            currentRev: current?.rev ?? null,
            currentSha256: current?.sha256 ?? null,
          },
        };
      }
    }
    const rev = currentRev + 1;
    this.seq += 1;
    const next: StoredFile = {
      path,
      sha256: deleted ? null : change.sha256,
      size: deleted ? 0 : change.size,
      rev,
      seq: this.seq,
      deleted,
      updatedAt: this.seq,
    };
    this.files.set(path, next);
    return { kind: "applied", row: { path, rev, seq: this.seq } };
  }

  private liveOwner(path: string): string | null {
    const key = toPathKey(path);
    for (const file of this.files.values()) {
      if (!file.deleted && file.path !== path && toPathKey(file.path) === key) return file.path;
    }
    return null;
  }
}

type Device = {
  name: string;
  vault: MemoryVault;
  index: MemoryIndex;
  journal: MemoryJournal;
};

async function startDevices(...seeds: Array<[path: string, text: string]>): Promise<Device[]> {
  const devices = ["laptop", "phone", "tablet"].map((name) => ({
    name,
    vault: new MemoryVault(),
    index: new MemoryIndex(),
    journal: new MemoryJournal(),
  }));
  for (const [path, text] of seeds) await devices[0]?.vault.seed(path, text);
  return devices;
}

function keepFiles(count: number): Array<[string, string]> {
  return Array.from({ length: count }, (_, index) => [`keep-${index}.md`, "keep"]);
}

async function syncDevice(hub: MemoryHub, current: Device): Promise<void> {
  const initialized = await current.index.isInitialized();
  const result = await runSync({
    vault: current.vault,
    api: hub as unknown as ApiClient,
    index: current.index,
    journal: current.journal,
    settings: DEFAULT_SHARED_SETTINGS,
    mode: "bidirectional",
    configDir: ".obsidian",
    selfId: "obsttorte",
    deviceName: current.name,
    full: true,
    forceRehash: false,
    dirtyPaths: [],
    reloadPending: [],
    unresolvedConflicts: hub.conflictPaths(),
    approved: [],
    knownPluginIds: [],
    acknowledgeGuard: true,
    strategy: initialized ? undefined : "merge",
    now: () => 1_700_000_000_000,
  });
  if (result.status !== "ok" || result.rejected.length > 0 || result.conflicts.length > 0) {
    const pending = result.plan?.items
      .filter((item) => item.action !== "noop" && item.action !== "adoptBase")
      .map((item) => `${item.path}:${item.action}`);
    throw new Error(
      JSON.stringify({
        name: current.name,
        status: result.status,
        rejected: result.rejected,
        conflicts: result.conflicts,
        pending,
      }),
    );
  }
}

async function textOf(vault: MemoryVault): Promise<string[]> {
  const files = (await vault.listFiles()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const lines: string[] = [];
  for (const file of files) {
    lines.push(`${file.path}:${new TextDecoder().decode(await vault.readBinary(file.path))}`);
  }
  return lines;
}

async function tear(hub: MemoryHub, current: Device): Promise<void> {
  const files = await current.vault.listFiles();
  const file = files[0];
  if (!file) return;
  const remote = hub.file(file.path);
  if (!remote?.sha256) return;
  const previous = await sha256Hex(await current.vault.readBinary(file.path));
  current.journal.entries = [
    {
      path: file.path,
      expectedSha256: remote.sha256,
      previousSha256: previous,
      startedAt: 1,
    },
  ];
  await current.vault.seed(file.path, "torn", 9_000_000_000);
}

describe("three devices", () => {
  it("converges after edits, renames, deletions, and a torn write", async () => {
    const hub = new MemoryHub();
    const devices = await startDevices(...keepFiles(10));
    for (const current of devices) await syncDevice(hub, current);

    for (let step = 0; step < 12; step += 1) {
      const current = devices[step % devices.length];
      if (!current) continue;
      const path = "extra.md";
      const mtime = 20_000 + step * 5_000;
      if (step % 5 === 0) {
        if (await current.vault.stat(path)) await current.vault.remove(path);
      } else if (step % 5 === 1) {
        await current.vault.seed(`extra-${step}.md`, `renamed ${step}`, mtime);
        if (await current.vault.stat(path)) await current.vault.remove(path);
      } else {
        await current.vault.seed(path, `version ${step}\n`, mtime);
      }
      await syncDevice(hub, current);
      for (const other of devices) {
        if (other === current) continue;
        if (step % 4 === 0) await tear(hub, other);
        await syncDevice(hub, other);
        const body = new TextDecoder().decode(
          await other.vault.readBinary((await other.vault.listFiles())[0]?.path ?? "keep-0.md"),
        );
        expect(body).not.toBe("torn");
      }
      const snapshots = await Promise.all(devices.map((item) => textOf(item.vault)));
      expect(snapshots[1]).toEqual(snapshots[0]);
      expect(snapshots[2]).toEqual(snapshots[0]);
    }
  });

  it("converges across a seeded sequence of edits and deletions", async () => {
    const hub = new MemoryHub();
    const devices = await startDevices(...keepFiles(8), ["note.md", "start"]);
    for (const current of devices) await syncDevice(hub, current);

    let state = 0x5eed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    for (let step = 0; step < 24; step += 1) {
      const current = devices[Math.floor(next() * devices.length)];
      if (!current) continue;
      const path = next() < 0.35 ? "other.md" : "note.md";
      if (next() < 0.25) {
        if (await current.vault.stat(path)) await current.vault.remove(path);
      } else {
        await current.vault.seed(path, `edit ${step}`, 20_000 + step * 5_000);
      }
      for (let round = 0; round < 2; round += 1) {
        await syncDevice(hub, current);
        for (const item of devices) {
          if (item !== current) await syncDevice(hub, item);
        }
      }
      const snapshots = await Promise.all(devices.map((item) => textOf(item.vault)));
      expect(snapshots[1]).toEqual(snapshots[0]);
      expect(snapshots[2]).toEqual(snapshots[0]);
    }
  });
});
