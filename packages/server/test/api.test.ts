import { sha256Hex } from "@obsttorte/shared/hash";
import { MULTIPART_PART_BYTES, SINGLE_PUT_MAX_BYTES } from "@obsttorte/shared/limits";
import { beforeEach, describe, expect, it } from "vitest";
import {
  call,
  commit,
  env,
  insertFile,
  insertHistory,
  post,
  resetStorage,
  SHA,
  seedDevice,
  seedObject,
} from "./helpers";

beforeEach(resetStorage);

const note = (path: string, expectedRev = 0, sha256 = SHA) => ({
  path,
  sha256,
  size: 3,
  expectedRev,
});

describe("authentication", () => {
  it("rejects a request that did not come through Access", async () => {
    await seedDevice();
    const response = await call("/api/health", { access: false });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "access_required" } });
  });

  it("does not answer a path outside the API without Access", async () => {
    const response = await call("/", { access: false, token: "", api: "" });
    expect(response.status).toBe(403);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("rejects an unknown device token and stops after repeated failures", async () => {
    expect((await call("/api/health", { token: "nope" })).status).toBe(401);
    let last: Response | null = null;
    for (let index = 0; index < 12; index += 1) {
      last = await call("/api/health", {
        token: "nope",
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      });
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBe("60");
  });

  it("names the authenticated device from health", async () => {
    const id = await seedDevice();
    const response = await call("/api/health");
    expect(await response.json()).toMatchObject({ deviceId: id, deviceName: "laptop" });
  });

  it("rejects an API version outside the supported range after recording the device", async () => {
    const id = await seedDevice();
    const response = await call("/api/health", { api: "99" });
    expect(response.status).toBe(426);
    expect(response.headers.get("X-Obsttorte-Api-Range")).toBe("1-1");
    const row = await env.DB.prepare("SELECT last_api_version FROM devices WHERE id = ?")
      .bind(id)
      .first<{ last_api_version: number | null }>();
    expect(row?.last_api_version).toBe(99);
  });
});

describe("audit log", () => {
  it("highlights a late-night burst, plugin paths, and a device with no name", async () => {
    const device = await seedDevice();
    const night = Date.UTC(2026, 0, 2, 3, 0, 0);
    const noon = Date.UTC(2026, 0, 2, 12, 0, 0);
    const rows = [
      ...Array.from({ length: 50 }, (_, index) => ({
        path: `notes/night-${index}.md`,
        changedAt: night,
        device,
      })),
      { path: "notes/quiet.md", changedAt: Date.UTC(2026, 0, 3, 3, 0, 0), device },
      { path: ".obsidian/plugins/foo/data.json", changedAt: noon, device },
      { path: "notes/orphan.md", changedAt: noon, device: "missing-device" },
    ];
    for (const [index, row] of rows.entries()) {
      await insertHistory(row.path, SHA, {
        rev: 1,
        seq: index + 1,
        changedAt: row.changedAt,
        device: row.device,
        requestId: crypto.randomUUID(),
      });
    }
    const body = await (await call("/api/log?since=0&limit=200")).json<{
      entries: Array<{ path: string; highlight: string[] }>;
    }>();
    const highlight = (path: string) =>
      body.entries.find((entry) => entry.path === path)?.highlight ?? [];
    expect(highlight("notes/night-0.md")).toContain("late-night");
    expect(highlight("notes/quiet.md")).not.toContain("late-night");
    expect(highlight(".obsidian/plugins/foo/data.json")).toEqual(["plugin-path"]);
    expect(highlight("notes/orphan.md")).toContain("unknown-device");
  });
});

describe("commit and index", () => {
  it("creates, rejects stale or invalid changes, and applies a rename in one request", async () => {
    await seedDevice();
    await seedObject();
    const created = await (await commit([note("Note.md")])).json<{ applied: unknown[] }>();
    expect(created.applied).toHaveLength(1);

    const reason = async (changes: unknown[]) =>
      (await (await commit(changes)).json<{ rejected: Array<{ reason: string }> }>()).rejected[0]
        ?.reason;
    expect(await reason([note("Note.md")])).toBe("revMismatch");
    expect(await reason([note("NOTE.md")])).toBe("pathCollision");
    expect(await reason([note("Missing.md", 0, "a".repeat(64))])).toBe("missingObject");
    expect(await reason([{ ...note("Sized.md"), size: 4 }])).toBe("missingObject");
    expect(await reason([note("../secret.md")])).toBe("invalidPath");

    const renamed = await commit([
      { path: "Note.md", deleted: true, expectedRev: 1 },
      note("note.md"),
    ]);
    const renamedBody = await renamed.json<{ applied: Array<{ path: string }> }>();
    expect(renamedBody.applied.map((row) => row.path).sort()).toEqual(["Note.md", "note.md"]);

    const index = await (await call("/api/index")).json<{
      seq: number;
      entries: Array<{ path: string; deleted: boolean }>;
    }>();
    expect(index.entries.map((entry) => `${entry.path}:${entry.deleted}`)).toEqual([
      "Note.md:true",
      "note.md:false",
    ]);
  });

  it("replays the stored response for a retried request and refuses another device", async () => {
    await seedDevice();
    await seedObject();
    const replayed = async (changes: unknown[]) => {
      const requestId = crypto.randomUUID();
      const first = await (await commit(changes, requestId)).json();
      expect(await (await commit(changes, requestId)).json()).toEqual(first);
      return requestId;
    };
    const applied = await replayed([note("A.md")]);
    await replayed([note("../secret.md")]);
    await seedDevice("other-token", "phone");
    expect((await commit([note("A.md")], applied, { token: "other-token" })).status).toBe(409);
  });

  it("reconstructs a lost commit response and reports the rest as rev mismatches", async () => {
    const device = await seedDevice();
    await seedObject();
    const requestId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO requests (id, device, created_at, response) VALUES (?, ?, ?, NULL)",
    )
      .bind(requestId, device, Date.now())
      .run();
    await insertHistory("A.md", SHA, { device, requestId });
    const replay = await commit([note("A.md"), note("B.md")], requestId);
    expect(replay.status).toBe(200);
    const body = await replay.json<{
      applied: Array<{ path: string }>;
      rejected: Array<{ path: string; reason: string }>;
    }>();
    expect(body.applied.map((row) => row.path)).toEqual(["A.md"]);
    expect(body.rejected).toEqual([
      { path: "B.md", reason: "revMismatch", currentRev: null, currentSha256: null },
    ]);
  });

  it("commits during maintenance and rejects an object GC already removed", async () => {
    await seedDevice();
    await seedObject();
    await env.DB.prepare("UPDATE counters SET value = ? WHERE name = 'maintenance'")
      .bind(Date.now())
      .run();
    const committed = await commit([note("A.md")]);
    expect((await committed.json<{ applied: unknown[] }>()).applied).toHaveLength(1);
    await env.DB.prepare("DELETE FROM objects WHERE sha256 = ?").bind(SHA).run();
    const afterGc = await commit([note("B.md")]);
    const body = await afterGc.json<{ rejected: Array<{ reason: string }> }>();
    expect(body.rejected[0]?.reason).toBe("missingObject");
  });

  it("stays within twice the estimated D1 cost of an index read and a commit", async () => {
    await seedDevice();
    await seedObject();
    const costOf = async (send: () => Promise<Response>) => {
      const lines: string[] = [];
      const original = console.log;
      console.log = (message?: unknown) => lines.push(String(message));
      try {
        expect((await send()).status).toBe(200);
      } finally {
        console.log = original;
      }
      return lines
        .map((line) => JSON.parse(line) as { rowsRead?: number; rowsWritten?: number })
        .find((line) => "rowsRead" in line);
    };
    // §13.1の見積もりは、indexが10行前後の読み取り、commitが10行の読み取りと8行の書き込み。その2倍を上限にする
    expect((await costOf(() => call("/api/index")))?.rowsRead).toBeLessThanOrEqual(20);
    const commitCost = await costOf(() => commit([note("A.md")]));
    expect(commitCost?.rowsRead).toBeLessThanOrEqual(20);
    expect(commitCost?.rowsWritten).toBeLessThanOrEqual(16);
  });

  it("returns server timestamps so a newer conflict side can be chosen", async () => {
    await seedDevice();
    const local = "aa".repeat(32);
    const remote = "bb".repeat(32);
    const createdAt = 1_600_000_000_000;
    await seedObject(local, new TextEncoder().encode("local-side"), createdAt);
    await seedObject(remote, new TextEncoder().encode("remote-side"));
    await insertFile("Fresh.md", remote, { updatedAt: createdAt + 10_000 });
    await insertHistory("Committed.md", local, { changedAt: createdAt + 50_000 });
    await insertFile("Committed.md", remote, { rev: 2, seq: 2, updatedAt: createdAt + 10_000 });
    for (const path of ["Fresh.md", "Committed.md"]) {
      const created = await post("/api/conflicts", {
        path,
        baseSha: null,
        localSha: local,
        remoteSha: remote,
      });
      expect(created.status).toBe(200);
    }
    const listed = await (await call("/api/conflicts")).json<
      Array<{ path: string; localUpdatedAt: number | null; remoteUpdatedAt: number | null }>
    >();
    const times = Object.fromEntries(
      listed.map((item) => [item.path, [item.localUpdatedAt, item.remoteUpdatedAt]]),
    );
    expect(times).toEqual({
      "Fresh.md": [createdAt, createdAt + 10_000],
      "Committed.md": [createdAt + 50_000, createdAt + 10_000],
    });
  });
});

describe("purge", () => {
  const purge = async (target: { paths?: string[]; sha256s?: string[] }) => {
    const preview = await (await post("/api/purge/prepare", target)).json<{
      confirmToken: string;
      fileCount: number;
      objectCount: number;
      bytes: number;
    }>();
    const result = await (await post("/api/purge", { confirmToken: preview.confirmToken })).json<{
      deletedObjects: number;
      deletedBytes: number;
    }>();
    return { preview, result };
  };
  const fileSha = async (path: string) =>
    (
      await env.DB.prepare("SELECT sha256 FROM files WHERE path = ?")
        .bind(path)
        .first<{ sha256: string }>()
    )?.sha256 ?? null;

  it("keeps an object that another path still references and deletes a unique one", async () => {
    await seedDevice();
    await seedObject();
    await commit([note("Note.md")]);
    await commit([note("Copy.md")]);

    const byPath = await purge({ paths: ["Note.md"] });
    expect(byPath.preview).toMatchObject({ fileCount: 1, objectCount: 0, bytes: 0 });
    expect(byPath.result).toEqual({ deletedObjects: 0, deletedBytes: 0 });
    expect(await fileSha("Note.md")).toBeNull();
    expect(await fileSha("Copy.md")).toBe(SHA);

    const bySha = await purge({ sha256s: [SHA] });
    expect(bySha.preview).toMatchObject({ fileCount: 1, bytes: 3 });
    expect(bySha.result).toEqual({ deletedObjects: 1, deletedBytes: 3 });
    expect(await fileSha("Copy.md")).toBeNull();
    expect(await env.BUCKET.get(`objects/${SHA}`)).toBeNull();
  });

  it("leaves a live file in place when only its history used the purged content", async () => {
    const device = await seedDevice();
    await seedObject();
    const otherBytes = new TextEncoder().encode("xyz");
    const other = await sha256Hex(otherBytes);
    await seedObject(other, otherBytes);
    await commit([note("Note.md")]);
    await commit([note("Copy.md", 0, other)]);
    await insertHistory("Copy.md", SHA, { rev: 0, seq: 0, device, requestId: "old" });
    const { preview } = await purge({ sha256s: [SHA] });
    expect(preview.fileCount).toBe(1);
    expect(await fileSha("Copy.md")).toBe(other);
    expect(await fileSha("Note.md")).toBeNull();
  });
});

describe("objects", () => {
  const putAbc = (sha: string) =>
    call(`/api/objects/${sha}`, {
      method: "PUT",
      body: new TextEncoder().encode("abc"),
      headers: { "Content-Length": "3" },
    });

  async function uploadMultipart(sha: string, bytes: Uint8Array): Promise<Response> {
    const opened = await post("/api/uploads", { sha256: sha, size: bytes.byteLength });
    const { uploadId } = await opened.json<{ uploadId: string }>();
    const ticket = encodeURIComponent(uploadId);
    for (let start = 0; start < bytes.byteLength; start += MULTIPART_PART_BYTES) {
      const chunk = bytes.subarray(start, start + MULTIPART_PART_BYTES);
      const part = start / MULTIPART_PART_BYTES + 1;
      const uploaded = await call(`/api/uploads/${ticket}/parts/${part}`, {
        method: "PUT",
        body: chunk,
        headers: { "Content-Length": String(chunk.byteLength) },
      });
      expect(uploaded.status).toBe(204);
    }
    return call(`/api/uploads/${ticket}/complete`, { method: "POST" });
  }

  it("stores a single put only when the checksum matches", async () => {
    await seedDevice();
    expect((await putAbc(SHA)).status).toBe(204);
    expect((await call(`/api/objects/${SHA}`, { method: "HEAD" })).status).toBe(200);
    expect((await putAbc("b".repeat(64))).status).toBe(422);
  });

  it("checks the sha256 after a multipart upload completes and serves ranges", async () => {
    await seedDevice();
    const bytes = new Uint8Array(SINGLE_PUT_MAX_BYTES + 1);
    bytes[bytes.length - 1] = 2;
    const sha = await sha256Hex(bytes);
    expect((await uploadMultipart(sha, bytes)).status).toBe(204);
    const last = bytes.length - 1;
    const tail = await call(`/api/objects/${sha}`, { headers: { Range: `bytes=${last}-${last}` } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-type")).toBe("application/octet-stream");
    expect(tail.headers.get("content-range")).toBe(`bytes ${last}-${last}/${bytes.length}`);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(new Uint8Array([2]));

    const wrong = "ab".repeat(32);
    expect((await uploadMultipart(wrong, bytes)).status).toBe(422);
    expect((await call(`/api/objects/${wrong}`, { method: "HEAD" })).status).toBe(404);
  });

  it("keeps a verified object when a multipart upload claims its sha256 with other content", async () => {
    await seedDevice();
    const bytes = new Uint8Array(SINGLE_PUT_MAX_BYTES + 1);
    const sha = await sha256Hex(bytes);
    expect((await uploadMultipart(sha, bytes)).status).toBe(204);
    const reopened = await post("/api/uploads", { sha256: sha, size: bytes.byteLength });
    expect(reopened.status).toBe(409);

    const other = "cd".repeat(32);
    const opened = await post("/api/uploads", { sha256: other, size: bytes.byteLength });
    const ticket = encodeURIComponent((await opened.json<{ uploadId: string }>()).uploadId);
    for (let start = 0; start < bytes.byteLength; start += MULTIPART_PART_BYTES) {
      const chunk = bytes.subarray(start, start + MULTIPART_PART_BYTES);
      await call(`/api/uploads/${ticket}/parts/${start / MULTIPART_PART_BYTES + 1}`, {
        method: "PUT",
        body: chunk,
        headers: { "Content-Length": String(chunk.byteLength) },
      });
    }
    await env.BUCKET.put(`objects/${other}`, "abc");
    await env.DB.prepare("UPDATE objects SET status = 'verified', size = 3 WHERE sha256 = ?")
      .bind(other)
      .run();
    expect((await call(`/api/uploads/${ticket}/complete`, { method: "POST" })).status).toBe(422);
    const kept = await call(`/api/objects/${other}`);
    expect(kept.status).toBe(200);
    expect(await kept.text()).toBe("abc");
    expect((await call(`/api/objects/${sha}`, { method: "HEAD" })).status).toBe(200);
    expect((await env.BUCKET.list({ prefix: "staging/" })).objects).toHaveLength(0);
  });

  it("ignores a rewritten ticket and sizes parts from the server state", async () => {
    await seedDevice();
    const size = SINGLE_PUT_MAX_BYTES + 1;
    const opened = await post("/api/uploads", { sha256: "ef".repeat(32), size });
    const { uploadId } = await opened.json<{ uploadId: string }>();
    const rewrite = (fields: Record<string, unknown>) => {
      const ticket = JSON.parse(atob(uploadId.replaceAll("-", "+").replaceAll("_", "/")));
      return encodeURIComponent(btoa(JSON.stringify({ ...ticket, ...fields })));
    };
    const part = (ticket: string, partNumber: number, length: number) =>
      call(`/api/uploads/${ticket}/parts/${partNumber}`, {
        method: "PUT",
        body: new Uint8Array(length),
        headers: { "Content-Length": String(length) },
      });
    expect((await part(rewrite({ sha256: "../state" }), 1, MULTIPART_PART_BYTES)).status).toBe(400);
    const partCount = Math.ceil(size / MULTIPART_PART_BYTES);
    expect((await part(rewrite({ size: size * 2 }), partCount + 1, 1)).status).toBe(400);
  });

  it("pauses uploads while a fresh maintenance sweep is running", async () => {
    await seedDevice();
    const setMaintenance = (at: number) =>
      env.DB.prepare("UPDATE counters SET value = ? WHERE name = 'maintenance'").bind(at).run();
    await setMaintenance(Date.now());
    const paused = await putAbc(SHA);
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("300");
    await setMaintenance(Date.now() - 31 * 60 * 1000);
    expect((await putAbc(SHA)).status).toBe(204);
  });
});
