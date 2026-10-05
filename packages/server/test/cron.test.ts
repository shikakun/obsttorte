import { beforeEach, describe, expect, it } from "vitest";
import {
  applyRetentionPolicy,
  runGarbageCollection,
  runIntegrityCheck,
  runMaintenance,
} from "../src/cron";
import { DAY, env, insertFile, insertHistory, resetStorage, SHA, seedObject } from "./helpers";

beforeEach(resetStorage);

const objectRow = () =>
  env.DB.prepare("SELECT sha256 FROM objects WHERE sha256 = ?").bind(SHA).first();

async function report(kind: string): Promise<{ ok: number; result: Record<string, unknown> }> {
  const row = await env.DB.prepare("SELECT ok, result FROM maintenance_reports WHERE kind = ?")
    .bind(kind)
    .first<{ ok: number; result: string }>();
  return { ok: row?.ok ?? -1, result: JSON.parse(row?.result ?? "{}") };
}

const integrityReport = () => report("integrity");

describe("garbage collection", () => {
  it("marks an unreferenced object and deletes it on the next run, even after an interrupted sweep", async () => {
    await seedObject(SHA, undefined, Date.now() - 8 * DAY);
    await runGarbageCollection(env);
    expect(await objectRow()).not.toBeNull();
    await env.DB.prepare("UPDATE counters SET value = ? WHERE name = 'maintenance'")
      .bind(Date.now())
      .run();
    await runGarbageCollection(env);
    expect(await objectRow()).toBeNull();
    expect(await env.BUCKET.get(`objects/${SHA}`)).toBeNull();
    const flag = await env.DB.prepare(
      "SELECT value FROM counters WHERE name = 'maintenance'",
    ).first<{ value: number }>();
    expect(flag?.value).toBe(0);
  });

  it("deletes an R2 object that no longer has a ledger row", async () => {
    await env.BUCKET.put(`objects/${SHA}`, new TextEncoder().encode("orphan"));
    await runGarbageCollection(env, Date.now() + 2 * 60 * 60 * 1000);
    expect(await env.BUCKET.get(`objects/${SHA}`)).toBeNull();
  });

  it("keeps a fresh R2 object whose ledger row may still be on its way", async () => {
    await env.BUCKET.put(`objects/${SHA}`, new TextEncoder().encode("uploading"));
    await runGarbageCollection(env);
    expect(await env.BUCKET.get(`objects/${SHA}`)).not.toBeNull();
  });

  it("keeps an object that a live file still references", async () => {
    const old = Date.now() - 8 * DAY;
    await seedObject(SHA, undefined, old);
    await insertFile("A.md", SHA, { updatedAt: old });
    await runGarbageCollection(env);
    await runGarbageCollection(env);
    expect(await objectRow()).not.toBeNull();
  });

  it("does not mark an object that only a snapshot references", async () => {
    const old = Date.now() - 8 * DAY;
    await seedObject(SHA, undefined, old);
    await env.BUCKET.put(
      `snapshots/${old}-server.json`,
      JSON.stringify({ files: { "A.md": { sha256: SHA, size: 3 } } }),
    );
    await runGarbageCollection(env);
    const candidate = await env.DB.prepare("SELECT sha256 FROM gc_candidates WHERE sha256 = ?")
      .bind(SHA)
      .first();
    expect(candidate).toBeNull();
  });
});

describe("retention", () => {
  it("drops history that is older than a year and outside the latest 100 revisions", async () => {
    const now = Date.now();
    for (let rev = 1; rev <= 101; rev += 1) {
      await insertHistory("A.md", SHA, { rev, changedAt: rev === 1 ? now - 400 * DAY : now });
    }
    await applyRetentionPolicy(env, now);
    const remaining = await env.DB.prepare(
      "SELECT MIN(rev) AS oldest, COUNT(*) AS n FROM history",
    ).first<{ oldest: number; n: number }>();
    expect(remaining).toEqual({ oldest: 2, n: 100 });
  });

  it("does not thin snapshots when the shared settings object is missing", async () => {
    const now = Date.now();
    const key = `snapshots/${now - 800 * DAY}-server.json`;
    await env.BUCKET.put(key, JSON.stringify({ files: {} }));
    await insertFile(".obsidian/obsttorte.json", "ab".repeat(32));
    await applyRetentionPolicy(env, now);
    expect(await env.BUCKET.get(key)).not.toBeNull();
  });

  it("stops thinning and reports it when the shared settings cannot be parsed", async () => {
    const now = Date.now();
    const key = `snapshots/${now - 800 * DAY}-server.json`;
    await env.BUCKET.put(key, JSON.stringify({ files: {} }));
    await seedObject(SHA, new TextEncoder().encode("{ not json"));
    await insertFile(".obsidian/obsttorte.json", SHA);
    await applyRetentionPolicy(env, now);
    expect(await env.BUCKET.get(key)).not.toBeNull();
    expect(await report("retention")).toEqual({
      ok: 0,
      result: { reason: "shared-settings-unreadable" },
    });
  });

  it("reads the shared settings only from a config folder at the top of the vault", async () => {
    const now = Date.now();
    const key = `snapshots/${now - 800 * DAY}-server.json`;
    await env.BUCKET.put(key, JSON.stringify({ files: {} }));
    await seedObject(SHA, new TextEncoder().encode("{ not json"));
    await insertFile("notes/obsttorte.json", SHA);
    await insertFile(".obsidian/plugins/x/obsttorte.json", SHA);
    await applyRetentionPolicy(env, now);
    expect(await env.BUCKET.get(key)).toBeNull();
    expect((await report("retention")).ok).toBe(1);
  });
});

describe("maintenance", () => {
  it("runs the remaining steps after one fails and records the failure", async () => {
    const ran: string[] = [];
    const run = runMaintenance(env, [
      {
        kind: "retention",
        run: async () => {
          throw new TypeError("boom");
        },
      },
      {
        kind: "gc",
        run: async () => {
          ran.push("gc");
        },
      },
    ]);
    await expect(run).rejects.toThrow("Maintenance failed: retention");
    expect(ran).toEqual(["gc"]);
    expect(await report("retention")).toEqual({
      ok: 0,
      result: { reason: "failed", error: "TypeError" },
    });
  });
});

describe("integrity", () => {
  it("reports a seq that moves backward as time moves forward", async () => {
    await insertFile("A.md", SHA, { seq: 10, updatedAt: 1 });
    await insertFile("B.md", SHA, { seq: 5, updatedAt: 2 });
    await runIntegrityCheck(env);
    expect((await integrityReport()).result).toMatchObject({ seqRegression: 1, complete: true });
  });

  it("does not report a pending upload as missing from R2", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO objects (sha256, size, status, created_at, last_referenced_at) VALUES (?, 3, 'pending', ?, ?)",
    )
      .bind(SHA, now, now)
      .run();
    await runIntegrityCheck(env);
    const report = await integrityReport();
    expect(report.ok).toBe(1);
    expect(report.result).toMatchObject({ missingInR2: 0, orphanInR2: 0 });
  });

  it("reports a file whose object is missing from the ledger", async () => {
    await insertFile("A.md", SHA);
    await insertHistory("A.md", SHA);
    await runIntegrityCheck(env);
    const report = await integrityReport();
    expect(report.ok).toBe(0);
    expect(report.result).toMatchObject({ missingInLedger: 1 });
  });

  it("records a partial scan and finishes it on the next run", async () => {
    await runIntegrityCheck(env, Date.now(), 0);
    expect((await integrityReport()).result).toMatchObject({ complete: false });
    await runIntegrityCheck(env);
    const report = await integrityReport();
    expect(report.ok).toBe(1);
    expect(report.result).toMatchObject({ complete: true });
  });
});
