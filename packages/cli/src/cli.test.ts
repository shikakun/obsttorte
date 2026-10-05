import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CloudflareClient, createCloudflareClient } from "./cloudflare";
import { validateDeviceName } from "./commands/device";
import {
  type CommandIO,
  formatMaintenance,
  setup,
  update,
  validateTokenExpiration,
} from "./commands/install";
import { buildDeployConfig, readBuiltWranglerConfig } from "./deploy-config";
import { CliError } from "./errors";
import { formatTable } from "./format";
import { main } from "./main";
import { createPrompter } from "./prompt";
import { findWorkersDevUrl, type InstallationState } from "./state";
import { parseWranglerJson } from "./wrangler";

const layout = {
  config: {
    name: "obsttorte",
    main: "index.js",
    access: { dev: { aud: "local-development-only" } },
    d1_databases: [
      {
        binding: "DB",
        database_name: "obsttorte",
        database_id: "local-development-only",
        migrations_dir: "migrations",
      },
    ],
    r2_buckets: [{ binding: "BUCKET", bucket_name: "obsttorte" }],
    vars: { ACCESS_AUD: "" },
  },
  buildDir: "/tmp/obsttorte-build",
  migrationsDir: "/tmp/obsttorte-migrations",
};

function fakeCloudflare(
  overrides: Partial<CloudflareClient> = {},
): CloudflareClient & { calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => {
    calls.push(name);
  };
  return {
    calls,
    whoami: async () => ({ email: "me@example.com" }),
    login: async () => note("login"),
    workerExists: async () => false,
    findDatabase: async () => null,
    createDatabase: async (name) => {
      note(`createDatabase:${name}`);
      return { id: "db-id" };
    },
    bucketExists: async () => false,
    createBucket: async (name) => note(`createBucket:${name}`),
    applyMigrations: async () => note("migrate"),
    deploy: async () => {
      note("deploy");
      return "Deployed obsttorte triggers\n  https://obsttorte.example.workers.dev\n";
    },
    execute: async () => {
      note("execute");
      return [{ results: [] }];
    },
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(states: InstallationState[] = []): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "obsttorte-test-"));
  tempDirs.push(dir);
  for (const state of states) {
    await writeFile(path.join(dir, `${state.worker}.json`), JSON.stringify(state));
  }
  return dir;
}

function commandIO(
  cloudflare: CloudflareClient,
  stateDir: string,
  stdout: CommandIO["stdout"] = () => {},
): CommandIO {
  return {
    cloudflare,
    prompt: createPrompter({
      yes: true,
      write: stdout,
      question: async (text) => {
        throw new Error(`Unexpected question: ${text}`);
      },
    }),
    stateDir,
    layout,
    yes: true,
    fetch: async () => new Response(null, { status: 403 }),
    now: () => new Date("2026-10-04T00:00:00.000Z"),
    stdout,
  };
}

const baseState: InstallationState = {
  version: 1,
  worker: "obsttorte",
  domain: null,
  database: { name: "obsttorte", id: "db-id", location: null },
  bucket: { name: "obsttorte" },
  access: null,
  url: "https://obsttorte.workers.dev",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

describe("buildDeployConfig", () => {
  it("removes local access, makes paths absolute, and keeps the build's runtime settings", () => {
    const config = buildDeployConfig(
      {
        ...layout.config,
        limits: { cpu_ms: 10000 },
        triggers: { crons: ["17 3 * * *", "41 4 * * 1"] },
        ratelimits: [
          { name: "AUTH_FAILURE_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } },
        ],
      },
      {
        ...baseState,
        domain: "notes.example.com",
        access: { aud: "aud", clientId: "id", tokenExpiresAt: "2027-01-01T00:00:00Z" },
      },
      { buildDir: layout.buildDir, migrationsDir: layout.migrationsDir },
    );
    expect(config).toMatchObject({
      main: path.resolve(layout.buildDir, "index.js"),
      d1_databases: [{ migrations_dir: layout.migrationsDir }],
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: "notes.example.com", custom_domain: true }],
      vars: { ACCESS_AUD: "aud" },
      limits: { cpu_ms: 10000 },
      triggers: { crons: ["17 3 * * *", "41 4 * * 1"] },
      ratelimits: [{ name: "AUTH_FAILURE_LIMITER" }],
    });
    expect(config.access).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("local-development-only");
  });

  it("reads the bundled wrangler.json instead of a hardcoded stub", async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "wrangler.json"),
      JSON.stringify({ ...layout.config, limits: { cpu_ms: 10000 } }),
    );
    expect(readBuiltWranglerConfig(dir).limits).toEqual({ cpu_ms: 10000 });
  });
});

describe("findWorkersDevUrl", () => {
  it("picks the URL of this Worker from the deploy output", () => {
    const output = [
      "Uploaded obsttorte-2",
      "  https://obsttorte.example.workers.dev",
      "  https://obsttorte-2.example.workers.dev",
    ].join("\n");
    expect(findWorkersDevUrl(output, "obsttorte-2")).toBe(
      "https://obsttorte-2.example.workers.dev",
    );
    expect(findWorkersDevUrl("Deployed to notes.example.com", "obsttorte")).toBeNull();
  });
});

describe("validateDeviceName", () => {
  it("rejects empty names and control characters", () => {
    expect(validateDeviceName("")).toBe("Enter a name.");
    expect(validateDeviceName("lap\ntop")).toMatch(/control characters/);
    expect(validateDeviceName("laptop")).toBeNull();
  });
});

describe("parseWranglerJson", () => {
  it("starts at the first JSON value after log lines", () => {
    expect(parseWranglerJson('info: hello\n[{"name":"obsttorte"}]')).toEqual([
      { name: "obsttorte" },
    ]);
    expect(parseWranglerJson('log {"msg":1}\n[{"name":"obsttorte"}]')).toEqual([
      { name: "obsttorte" },
    ]);
    expect(parseWranglerJson('ready\n{"ok":true}')).toEqual({ ok: true });
  });
});

describe("createCloudflareClient", () => {
  it("creates a D1 database without --json and reads its ID from the list", async () => {
    const calls: string[][] = [];
    const client = createCloudflareClient(async (args) => {
      calls.push(args);
      if (args[1] === "create")
        return { code: 0, stdout: "Created your new D1 database.", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify([{ name: "obsttorte-preview", uuid: "db-id" }]),
        stderr: "",
      };
    });
    await expect(client.createDatabase("obsttorte-preview", "apac")).resolves.toEqual({
      id: "db-id",
    });
    expect(calls).toEqual([
      ["d1", "create", "obsttorte-preview", "--location", "apac"],
      ["d1", "list", "--json"],
    ]);
  });
});

describe("formatMaintenance", () => {
  it("summarizes integrity problems and storage in units", () => {
    const lines = formatMaintenance([
      {
        results: [
          { kind: "snapshot", ran_at: 1, ok: 1, result: JSON.stringify({ count: 13 }) },
          {
            kind: "integrity",
            ran_at: 1,
            ok: 0,
            result: JSON.stringify({ missingInR2: 2, orphanInR2: 0 }),
          },
          {
            kind: "storage",
            ran_at: 1,
            ok: 1,
            result: JSON.stringify({
              d1Bytes: 1_500_000,
              r2Bytes: 999,
              d1Level: "notice",
              r2Level: "ok",
              snapshotOnlyBytes: 12,
              historyOnlyBytes: 34_000,
            }),
          },
        ],
      },
    ]);
    expect(lines[0]).toMatch(/^Server snapshot \(.+\): 13 files$/);
    expect(lines[1]).toMatch(/^Integrity check \(.+\): 2 objects missing from R2$/);
    expect(lines[2]).toMatch(/: D1 1\.5 MB \(notice\), R2 999 B$/);
    expect(lines[3]).toBe("  Only in snapshots: 12 B, only in history: 34.0 KB");
  });

  it("tells why snapshot thinning stopped and lists other failed steps", () => {
    const lines = formatMaintenance([
      {
        results: [
          {
            kind: "retention",
            ran_at: 1,
            ok: 0,
            result: JSON.stringify({ reason: "shared-settings-unreadable" }),
          },
          { kind: "gc", ran_at: 1, ok: 0, result: JSON.stringify({ reason: "failed" }) },
        ],
      },
    ]);
    expect(lines[0]).toMatch(/^Retention \(.+\): stopped, obsttorte\.json .+ could not be read$/);
    expect(lines[1]).toMatch(/^gc \(.+\): failed$/);
  });

  it("says so when maintenance has not run", () => {
    expect(formatMaintenance([{ results: [] }])).toEqual(["No maintenance has run yet."]);
  });
});

describe("formatTable", () => {
  it("pads every column but the last", () => {
    expect(
      formatTable(
        ["ID", "NAME"],
        [
          ["a", "laptop"],
          ["abc", "phone"],
        ],
      ),
    ).toEqual(["ID   NAME", "a    laptop", "abc  phone"]);
  });
});

describe("setup", () => {
  it("does not adopt an unrecorded resource when --yes is set", async () => {
    const cloudflare = fakeCloudflare({ workerExists: async () => true });
    const options = {
      name: "obsttorte",
      domain: "",
      database: "obsttorte",
      location: "",
      bucket: "obsttorte",
      deviceName: "laptop",
    };
    await expect(setup(commandIO(cloudflare, await tempDir()), options)).rejects.toBeInstanceOf(
      CliError,
    );
    expect(cloudflare.calls).not.toContain("deploy");
  });

  it("keeps the record when registering the device fails, so a rerun can adopt the resources", async () => {
    const dir = await tempDir();
    const cloudflare = fakeCloudflare({
      execute: async () => {
        throw new CliError("D1 is unavailable");
      },
    });
    const options = { name: "obsttorte", domain: "", location: "", deviceName: "laptop" };
    await expect(setup(commandIO(cloudflare, dir), options)).rejects.toBeInstanceOf(CliError);
    const written = JSON.parse(
      await readFile(path.join(dir, "obsttorte.json"), "utf8"),
    ) as InstallationState;
    expect(written.database.id).toBe("db-id");
  });

  it("prints every value the plugin needs", async () => {
    const messages: string[] = [];
    const io = commandIO(fakeCloudflare(), await tempDir(), (text) => messages.push(text));
    await setup(io, { name: "obsttorte", domain: "", location: "", deviceName: "laptop" });
    const output = messages.join("\n");
    for (const label of ["Server URL", "Access Client ID", "Access Client Secret", "Device token"])
      expect(output).toMatch(new RegExp(`^  ${label} +\\S`, "m"));
    expect(output).toContain("obsttorte access");
    expect(output).toContain("Signed in to Cloudflare as me@example.com.");
    expect(output).toMatch(/^ {2}Server URL +https:\/\/obsttorte\.example\.workers\.dev$/m);
  });

  it("starts the login flow when wrangler is not signed in", async () => {
    let signedIn = false;
    const cloudflare = fakeCloudflare({
      whoami: async () => (signedIn ? { email: null } : null),
      login: async () => {
        signedIn = true;
        cloudflare.calls.push("login");
      },
    });
    await setup(commandIO(cloudflare, await tempDir()), {
      name: "obsttorte",
      domain: "",
      location: "",
      deviceName: "laptop",
    });
    expect(cloudflare.calls[0]).toBe("login");
  });
});

describe("update", () => {
  it("stops when a device is below the minimum API version unless forced", async () => {
    const dir = await tempDir([baseState]);
    const cloudflare = fakeCloudflare({
      execute: async () => [{ results: [{ name: "phone", last_seen_at: 1, last_api_version: 0 }] }],
    });
    const io = commandIO(cloudflare, dir);
    await expect(update(io, { name: "obsttorte" })).rejects.toBeInstanceOf(CliError);
    expect(cloudflare.calls).not.toContain("deploy");
    await update(io, { name: "obsttorte", force: true });
    expect(cloudflare.calls).toContain("deploy");
    const written = JSON.parse(
      await readFile(path.join(dir, "obsttorte.json"), "utf8"),
    ) as InstallationState;
    expect(written.updatedAt).toBe("2026-10-04T00:00:00.000Z");
  });

  it("keeps going through --all and fails if one install fails", async () => {
    const dir = await tempDir([
      { ...baseState, worker: "alpha" },
      { ...baseState, worker: "beta" },
    ]);
    let deploys = 0;
    const cloudflare = fakeCloudflare({
      deploy: async () => {
        deploys += 1;
        if (deploys === 1) throw new Error("deploy failed");
        return "";
      },
    });
    const messages: string[] = [];
    const io = commandIO(cloudflare, dir, (text: string) => messages.push(text));
    await expect(update(io, { all: true })).rejects.toBeInstanceOf(CliError);
    expect(deploys).toBe(2);
    expect(messages).toContain("  Failed   alpha");
    expect(messages).toContain("  Updated  beta");
  });
});

describe("main", () => {
  it("names an unknown command or option instead of only printing the help", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (text: string) => errors.push(text);
    try {
      expect(await main(["deploy"])).toBe(1);
      expect(await main(["setup", "--devicename", "phone"])).toBe(1);
      expect(await main(["setup", "--name", "--yes"])).toBe(1);
      expect(await main(["update", "--all=1"])).toBe(1);
    } finally {
      console.error = original;
    }
    const output = errors.join("\n");
    expect(output).toContain("Unknown command: deploy.");
    expect(output).toContain("Unknown option: --devicename.");
    expect(output).toContain("--name needs a value.");
    expect(output).toContain("--all does not take a value.");
  });

  it("shows the help when no command is given", async () => {
    const messages: string[] = [];
    expect(await main([], { stdout: (text) => messages.push(text) })).toBe(0);
    expect(messages[0]).toMatch(/^Obsttorte syncs/);
  });
});

describe("createPrompter", () => {
  function scripted(answers: string[]) {
    const asked: string[] = [];
    const written: string[] = [];
    const prompt = createPrompter({
      yes: false,
      write: (text) => written.push(text),
      question: async (text) => {
        asked.push(text);
        return answers.shift() ?? "";
      },
    });
    return { prompt, asked, written };
  }

  it("shows the default and asks again until the answer is valid", async () => {
    const { prompt, asked, written } = scripted(["Bad", "good"]);
    const answer = await prompt.text("Worker name", {
      defaultValue: "obsttorte",
      validate: (value) => (/^[a-z]+$/.test(value) ? null : "Use lowercase letters."),
    });
    expect(answer).toBe("good");
    expect(asked[0]).toBe("  Worker name [obsttorte]: ");
    expect(written).toEqual(["  Use lowercase letters."]);
  });

  it("takes y, yes, n, and no in any case, and an empty answer as the default", async () => {
    const { prompt, asked } = scripted(["", "YES", "maybe", "n"]);
    expect(await prompt.confirm("Continue?", true)).toBe(true);
    expect(await prompt.confirm("Continue?", false)).toBe(true);
    expect(await prompt.confirm("Continue?", true)).toBe(false);
    expect(asked).toEqual([
      "  Continue? [Y/n]: ",
      "  Continue? [y/N]: ",
      "  Continue? [Y/n]: ",
      "  Continue? [Y/n]: ",
    ]);
  });

  it("lists numbered choices and ignores answers outside them", async () => {
    const { prompt, written } = scripted(["0", "1.5", "2"]);
    const choices = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ];
    expect(await prompt.choose("Which one?", choices, 0)).toBe("b");
    expect(written).toEqual(["  Which one?", "    1. Alpha", "    2. Beta"]);
  });

  it("uses the defaults with --yes and refuses questions without one", async () => {
    const prompt = createPrompter({ yes: true, write: () => {} });
    expect(await prompt.text("Name", { defaultValue: "laptop" })).toBe("laptop");
    expect(await prompt.confirm("Revoke it?", false)).toBe(false);
    await expect(prompt.text("Domain")).rejects.toBeInstanceOf(CliError);
  });
});

describe("validateTokenExpiration", () => {
  const now = new Date("2026-10-04T00:00:00.000Z");
  it("accepts a future ISO 8601 date and rejects anything else", () => {
    expect(validateTokenExpiration("2027-10-04", now)).toBeNull();
    expect(validateTokenExpiration("2027-10-04T00:00:00Z", now)).toBeNull();
    expect(validateTokenExpiration("2027/10/04", now)).not.toBeNull();
    expect(validateTokenExpiration("next year", now)).not.toBeNull();
    expect(validateTokenExpiration("2026-10-03", now)).not.toBeNull();
  });
});
