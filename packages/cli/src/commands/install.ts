import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MIN_SUPPORTED_API_VERSION } from "@obsttorte/shared/version";
import { type CloudflareClient, isRecord, resultRows } from "../cloudflare";
import { buildDeployConfig, type WranglerConfig } from "../deploy-config";
import { CliError } from "../errors";
import { formatBytes, formatTable, formatTime } from "../format";
import { blank, fields, heading, info, steps } from "../output";
import type { Choice, Prompter } from "../prompt";
import {
  customDomainUrl,
  type D1LocationHint,
  findWorkersDevUrl,
  HOSTNAME_PATTERN,
  type InstallationState,
  LOCATION_HINTS,
  LOCATION_LABELS,
  WORKER_NAME_PATTERN,
} from "../state";
import { installationFile, readInstallations, writeInstallation } from "../state-store";
import { addDevice, type DeviceRow, listDevices, revokeDevice, validateDeviceName } from "./device";

export type CommandIO = {
  cloudflare: CloudflareClient;
  prompt: Prompter;
  stateDir: string;
  layout: { config: WranglerConfig; buildDir: string; migrationsDir: string };
  yes: boolean;
  fetch: typeof fetch;
  now: () => Date;
  stdout: (text: string) => void;
};

const LOCATION_CHOICES: Choice<D1LocationHint | null>[] = [
  { value: null, label: "No preference" },
  ...LOCATION_HINTS.map((hint) => ({ value: hint, label: LOCATION_LABELS[hint] })),
];

export async function setup(
  io: CommandIO,
  options: {
    name?: string;
    domain?: string;
    database?: string;
    location?: string;
    bucket?: string;
    deviceName?: string;
  },
): Promise<void> {
  heading(io, "Obsttorte");
  await signIn(io);

  heading(io, "Configuration");
  const existing = await readInstallations(io.stateDir);
  const worker =
    options.name ??
    (await io.prompt.text("Worker name", {
      defaultValue: suggestWorkerName(existing.map((item) => item.worker)),
      validate: validateWorkerName,
    }));
  const workerProblem = validateWorkerName(worker);
  if (workerProblem)
    throw new CliError(`${worker} cannot be used as a Worker name. ${workerProblem}`);
  blank(io);
  const domain = await askDomain(io, options.domain);
  blank(io);
  const databaseName =
    options.database ?? (await io.prompt.text("D1 database name", { defaultValue: worker }));
  const location =
    options.location === undefined
      ? await io.prompt.choose("Where should the D1 database live?", LOCATION_CHOICES, 0)
      : parseLocation(options.location);
  const bucketName =
    options.bucket ?? (await io.prompt.text("R2 bucket name", { defaultValue: worker }));

  heading(io, "Summary");
  fields(io, [
    ["Worker", worker],
    ["Domain", domain ?? "workers.dev"],
    ["Database", location ? `${databaseName} (${LOCATION_LABELS[location]})` : databaseName],
    ["Bucket", bucketName],
  ]);
  blank(io);
  if (!(await io.prompt.confirm("Create these on Cloudflare?", true))) {
    throw new CliError("Nothing was changed.");
  }

  heading(io, "Resources");
  const recorded = existing.find((item) => item.worker === worker) ?? null;
  await ensureAbsentOrRecorded(
    io,
    `A Worker named ${worker}`,
    await io.cloudflare.workerExists(worker),
    recorded !== null,
  );
  const database = await io.cloudflare.findDatabase(databaseName);
  if (database && recorded && database.id !== recorded.database.id) {
    await confirmAdopt(
      io,
      `A D1 database named ${databaseName} exists, but its ID differs from the record.`,
    );
  } else {
    await ensureAbsentOrRecorded(
      io,
      `A D1 database named ${databaseName}`,
      database !== null,
      recorded !== null,
    );
  }
  const bucketExists = await io.cloudflare.bucketExists(bucketName);
  await ensureAbsentOrRecorded(
    io,
    `An R2 bucket named ${bucketName}`,
    bucketExists,
    recorded !== null,
  );
  let databaseId = database?.id;
  if (databaseId) {
    info(io, `Using the existing D1 database ${databaseName}.`);
  } else {
    databaseId = (await io.cloudflare.createDatabase(databaseName, location)).id;
    info(io, `Created the D1 database ${databaseName}.`);
  }
  if (bucketExists) {
    info(io, `Using the existing R2 bucket ${bucketName}.`);
  } else {
    await io.cloudflare.createBucket(bucketName);
    info(io, `Created the R2 bucket ${bucketName}.`);
  }
  const now = io.now().toISOString();
  const state: InstallationState = {
    version: 1,
    access: null,
    createdAt: now,
    ...recorded,
    worker,
    domain,
    database: { name: databaseName, id: databaseId, location },
    bucket: { name: bucketName },
    url: customDomainUrl(domain),
    updatedAt: now,
  };
  // 途中で失敗しても、再実行で作ったリソースを引き継げるように先に記録する
  await writeInstallation(io.stateDir, state);
  await deployState(io, state);

  heading(io, "Cloudflare Access");
  printAccessSteps(io, worker);
  blank(io);
  const aud = await io.prompt.text(
    "Access AUD tag (leave blank to record it later with `obsttorte access`)",
    { defaultValue: "" },
  );
  if (aud) {
    const clientId = await io.prompt.text("Access Client ID", { validate: required("Client ID") });
    const tokenExpiresAt = await askTokenExpiration(io);
    state.access = { aud, clientId, tokenExpiresAt };
    await writeInstallation(io.stateDir, state);
    await deployState(io, state);
    await warnIfAccessMissing(io, state.url);
  }

  heading(io, "First device");
  const deviceName = await askDeviceName(io, options.deviceName, "laptop");
  const token = await withDeployConfig(io, state, (configPath) =>
    addDevice(io.cloudflare, configPath, deviceName),
  );
  printPluginValues(io, state, deviceName, token);
  blank(io);
  info(io, `Settings saved to ${installationFile(io.stateDir, worker)}.`);
}

export async function update(
  io: CommandIO,
  options: { name?: string; all?: boolean; force?: boolean },
): Promise<void> {
  if (options.all && options.name) throw new CliError("Pass either --name or --all, not both.");
  const all = options.all ?? false;
  const targets = await selectInstallations(io, options.name, all, "Which installation?");
  heading(io, all ? "Obsttorte" : `Obsttorte ${targets[0]?.worker}`);
  await signIn(io);
  const failed: string[] = [];
  for (const state of targets) {
    if (all) heading(io, `Obsttorte ${state.worker}`);
    try {
      await assertCompatible(io, state, options.force ?? false);
      await deployState(io, state);
      state.updatedAt = io.now().toISOString();
      await writeInstallation(io.stateDir, state);
      heading(io, "Done");
      info(io, `${state.worker} is up to date at ${state.url}.`);
      info(io, "Devices, Access settings, and vault data were left untouched.");
    } catch (error) {
      if (!all) throw error;
      failed.push(state.worker);
      blank(io);
      printError(io, error);
    }
  }
  if (all) {
    heading(io, "Summary");
    for (const state of targets) {
      info(io, `${failed.includes(state.worker) ? "Failed " : "Updated"}  ${state.worker}`);
    }
  }
  if (failed.length > 0) throw new CliError("Some installations could not be updated.");
}

export async function status(io: CommandIO, name?: string): Promise<void> {
  const targets = name
    ? await selectInstallations(io, name, false, "Which installation?")
    : await readInstallations(io.stateDir);
  if (targets.length === 0) {
    heading(io, "No installation is recorded");
    info(io, `Nothing was found in ${io.stateDir}. Run \`obsttorte setup\` to set one up.`);
    return;
  }
  heading(io, "Obsttorte");
  await signIn(io);
  for (const state of targets) {
    heading(io, state.worker);
    const rows: Array<[string, string]> = [
      ["URL", state.url ?? "Unknown. Run `obsttorte update` to find it."],
      ["Domain", state.domain ?? "workers.dev"],
      ["Database", state.database.name],
      ["Bucket", state.bucket.name],
      ["Access", state.access ? "Recorded" : "Not set up. Run `obsttorte access`."],
    ];
    if (state.access) rows.push(["Token expires", state.access.tokenExpiresAt.slice(0, 10)]);
    rows.push(["Updated", formatTime(Date.parse(state.updatedAt))]);
    fields(io, rows);
    blank(io);
    try {
      const reports = await withDeployConfig(io, state, (configPath) =>
        io.cloudflare.execute(
          configPath,
          "SELECT kind, ran_at, ok, result FROM maintenance_reports",
        ),
      );
      for (const line of formatMaintenance(reports)) info(io, line);
    } catch (error) {
      printError(io, error);
    }
  }
}

export async function access(io: CommandIO, name?: string): Promise<void> {
  const state = await selectInstallation(io, name);
  heading(io, `Obsttorte ${state.worker}`);
  await signIn(io);

  heading(io, "Cloudflare Access");
  printAccessSteps(io, state.worker);
  blank(io);
  const aud = await io.prompt.text("Access AUD tag", {
    defaultValue: state.access?.aud,
    validate: required("AUD tag"),
  });
  const clientId = await io.prompt.text("Access Client ID", {
    defaultValue: state.access?.clientId,
    validate: required("Client ID"),
  });
  const tokenExpiresAt = await askTokenExpiration(io, state.access?.tokenExpiresAt);
  state.access = { aud, clientId, tokenExpiresAt };
  state.updatedAt = io.now().toISOString();
  await deployState(io, state);
  await writeInstallation(io.stateDir, state);
  heading(io, "Done");
  info(io, `${state.worker} now accepts only requests that pass Cloudflare Access.`);
  await warnIfAccessMissing(io, state.url);
}

export async function deviceAdd(
  io: CommandIO,
  options: { name?: string; deviceName?: string },
): Promise<void> {
  const state = await selectInstallation(io, options.name);
  heading(io, `Obsttorte ${state.worker}`);
  await signIn(io);
  blank(io);
  const deviceName = await askDeviceName(io, options.deviceName);
  const token = await withDeployConfig(io, state, (configPath) =>
    addDevice(io.cloudflare, configPath, deviceName),
  );
  printPluginValues(io, state, deviceName, token);
}

export async function deviceList(io: CommandIO, name?: string): Promise<void> {
  const state = await selectInstallation(io, name);
  heading(io, `Obsttorte ${state.worker}`);
  await signIn(io);
  const devices = await withDeployConfig(io, state, (configPath) =>
    listDevices(io.cloudflare, configPath),
  );
  blank(io);
  if (devices.length === 0) {
    info(io, "No devices are registered yet.");
    return;
  }
  const rows = devices.map((device) => [
    device.id,
    device.revoked_at ? `Revoked ${formatTime(device.revoked_at)}` : "Active",
    formatTime(device.created_at),
    formatTime(device.last_seen_at),
    device.last_api_version === null ? "-" : String(device.last_api_version),
    device.name,
  ]);
  for (const line of formatTable(["ID", "Status", "Created", "Last seen", "API", "Name"], rows))
    info(io, line);
}

export async function deviceRevoke(
  io: CommandIO,
  id: string | undefined,
  name?: string,
): Promise<void> {
  const state = await selectInstallation(io, name);
  heading(io, `Obsttorte ${state.worker}`);
  await signIn(io);
  const devices = await withDeployConfig(io, state, (configPath) =>
    listDevices(io.cloudflare, configPath),
  );
  const device = await chooseDevice(io, devices, id);
  blank(io);
  info(
    io,
    `Revoke “${device.name}” (last seen ${formatTime(device.last_seen_at)})? It can no longer sync until you add it again.`,
  );
  if (!io.yes && !(await io.prompt.confirm("Revoke it?", false))) {
    throw new CliError("Nothing was changed.");
  }
  await withDeployConfig(io, state, (configPath) =>
    revokeDevice(io.cloudflare, configPath, device.id),
  );
  blank(io);
  info(io, `Revoked “${device.name}”.`);
}

async function chooseDevice(
  io: CommandIO,
  devices: DeviceRow[],
  id: string | undefined,
): Promise<DeviceRow> {
  const active = devices.filter((device) => !device.revoked_at);
  if (id !== undefined) {
    const device =
      devices.find((item) => item.id === id) ?? devices.find((item) => item.name === id);
    if (!device) {
      throw new CliError(
        `No device has the ID or name ${id}. Run \`obsttorte device list\` to see them.`,
      );
    }
    if (device.revoked_at) throw new CliError(`“${device.name}” is already revoked.`);
    return device;
  }
  if (active.length === 0) throw new CliError("There are no active devices to revoke.");
  if (io.yes) throw new CliError("Pass the ID or name of the device to revoke.");
  blank(io);
  return io.prompt.choose(
    "Which device should be revoked?",
    active.map((device) => ({
      value: device,
      label: `${device.name} (last seen ${formatTime(device.last_seen_at)})`,
    })),
    0,
  );
}

function printPluginValues(
  io: CommandIO,
  state: InstallationState,
  deviceName: string,
  token: string,
): void {
  heading(io, `Plugin settings for ${deviceName}`);
  info(io, "On that device, enter these under Connection in the Obsttorte settings.");
  blank(io);
  fields(io, [
    ["Server URL", state.url ?? "Unknown. Use the workers.dev URL shown under Deploy."],
    ["Access Client ID", state.access?.clientId || "Not recorded yet"],
    ["Access Client Secret", "The value you kept when you created the service token"],
    ["Device token", token],
  ]);
  blank(io);
  info(io, "The device token is shown only once. Keep it until you enter it in the plugin.");
  if (!state.access) {
    info(
      io,
      "Access is not set up yet, so the server refuses every request. Run `obsttorte access` once you have the AUD tag.",
    );
  }
}

async function signIn(io: CommandIO): Promise<void> {
  const account = await io.cloudflare.whoami();
  if (account) {
    info(
      io,
      account.email ? `Signed in to Cloudflare as ${account.email}.` : "Signed in to Cloudflare.",
    );
    return;
  }
  info(io, "Not signed in to Cloudflare. Starting the login flow.");
  await io.cloudflare.login();
  const signedIn = await io.cloudflare.whoami();
  if (!signedIn) throw new CliError("Could not sign in to Cloudflare.");
  info(
    io,
    signedIn.email ? `Signed in to Cloudflare as ${signedIn.email}.` : "Signed in to Cloudflare.",
  );
}

async function askDomain(io: CommandIO, given: string | undefined): Promise<string | null> {
  if (given !== undefined) {
    const trimmed = given.trim();
    if (trimmed === "") return null;
    if (!HOSTNAME_PATTERN.test(trimmed)) throw new CliError(`${trimmed} is not a valid hostname.`);
    return trimmed;
  }
  const wants = await io.prompt.confirm(
    "Serve Obsttorte from your own domain instead of workers.dev?",
    false,
  );
  if (!wants) return null;
  return io.prompt.text("Domain", {
    validate: (value) =>
      HOSTNAME_PATTERN.test(value) ? null : "Enter a hostname, such as notes.example.com.",
  });
}

async function askDeviceName(
  io: CommandIO,
  given: string | undefined,
  fallback?: string,
): Promise<string> {
  if (given !== undefined) {
    const problem = validateDeviceName(given);
    if (problem) throw new CliError(`${given} cannot be used as a device name. ${problem}`);
    return given;
  }
  return io.prompt.text("Device name", { defaultValue: fallback, validate: validateDeviceName });
}

async function ensureAbsentOrRecorded(
  io: CommandIO,
  subject: string,
  exists: boolean,
  recorded: boolean,
): Promise<void> {
  if (!exists || recorded) return;
  await confirmAdopt(io, `${subject} already exists, but this computer has no record of it.`);
}

async function confirmAdopt(io: CommandIO, message: string): Promise<void> {
  if (io.yes) {
    throw new CliError(
      `${message} Run setup without --yes to take it over, or choose another name.`,
    );
  }
  info(io, message);
  if (!(await io.prompt.confirm("Take it over?", false))) {
    throw new CliError("Nothing else was changed. Choose another name and run setup again.");
  }
}

async function askTokenExpiration(io: CommandIO, current?: string): Promise<string> {
  const now = io.now();
  return io.prompt.text("Service token expiration (YYYY-MM-DD)", {
    defaultValue: current || oneYearLater(now),
    validate: (value) => validateTokenExpiration(value, now),
  });
}

export function validateTokenExpiration(value: string, now: Date): string | null {
  const isIsoDate = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
  const time = Date.parse(value);
  if (!isIsoDate || !Number.isFinite(time)) return "Enter the date as YYYY-MM-DD.";
  return time <= now.getTime() ? "That date has already passed." : null;
}

function oneYearLater(now: Date): string {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

function validateWorkerName(value: string): string | null {
  return WORKER_NAME_PATTERN.test(value) ? null : "Use lowercase letters, digits, and hyphens.";
}

function required(label: string): (value: string) => string | null {
  return (value) => (value === "" ? `Enter the ${label}.` : null);
}

async function assertCompatible(
  io: CommandIO,
  state: InstallationState,
  force: boolean,
): Promise<void> {
  const output = await withDeployConfig(io, state, (configPath) =>
    io.cloudflare.execute(
      configPath,
      "SELECT name, last_seen_at, last_api_version FROM devices WHERE revoked_at IS NULL",
    ),
  );
  const stale = resultRows(output).filter(
    (row) =>
      typeof row.last_api_version === "number" && row.last_api_version < MIN_SUPPORTED_API_VERSION,
  );
  if (stale.length === 0) return;
  blank(io);
  info(io, "These devices use a plugin that this version of the server no longer supports:");
  for (const row of stale) {
    info(io, `  ${String(row.name)} (last seen ${formatTime(row.last_seen_at)})`);
  }
  if (!force) {
    throw new CliError(
      "Update the plugin on those devices first, or pass --force to update the server anyway.",
    );
  }
}

async function deployState(io: CommandIO, state: InstallationState): Promise<void> {
  await withDeployConfig(io, state, async (configPath) => {
    heading(io, "Migrations");
    await io.cloudflare.applyMigrations(configPath);
    heading(io, "Deploy");
    const output = await io.cloudflare.deploy(configPath);
    state.url =
      customDomainUrl(state.domain) ?? findWorkersDevUrl(output, state.worker) ?? state.url;
  });
}

async function withDeployConfig<T>(
  io: CommandIO,
  state: InstallationState,
  action: (configPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "obsttorte-"));
  const configPath = path.join(dir, "wrangler.json");
  try {
    const config = buildDeployConfig(io.layout.config, state, {
      buildDir: io.layout.buildDir,
      migrationsDir: io.layout.migrationsDir,
    });
    await writeFile(configPath, JSON.stringify(config, null, 2));
    return await action(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function selectInstallation(io: CommandIO, name: string | undefined) {
  const [state] = await selectInstallations(io, name, false, "Which installation?");
  if (!state) throw new CliError("No installation is recorded yet. Run `obsttorte setup` first.");
  return state;
}

async function selectInstallations(
  io: CommandIO,
  name: string | undefined,
  all: boolean,
  question: string,
): Promise<InstallationState[]> {
  const states = await readInstallations(io.stateDir);
  if (name) {
    const found = states.find((state) => state.worker === name);
    if (!found) throw new CliError(`No installation named ${name} is recorded in ${io.stateDir}.`);
    return [found];
  }
  if (states.length === 0) {
    throw new CliError("No installation is recorded yet. Run `obsttorte setup` first.");
  }
  if (all || states.length === 1) return states;
  if (io.yes) {
    const names = states.map((state) => state.worker).join(", ");
    throw new CliError(`Several installations are recorded (${names}). Pick one with --name.`);
  }
  blank(io);
  const choice = await io.prompt.choose(
    question,
    states.map((state) => ({
      value: state,
      label: state.url ? `${state.worker} (${state.url})` : state.worker,
    })),
    0,
  );
  return [choice];
}

async function warnIfAccessMissing(io: CommandIO, url: string | null): Promise<void> {
  if (!url) return;
  const response = await io.fetch(`${url}/api/health`).catch(() => null);
  if (response?.headers.get("X-Obsttorte-Api-Range")) {
    blank(io);
    info(
      io,
      "Warning: Access may not be protecting the Worker. It answered a request that had no service token.",
    );
  }
}

function printError(io: CommandIO, error: unknown): void {
  info(io, error instanceof Error ? error.message : "Failed.");
  if (error instanceof CliError && error.details) {
    for (const line of error.details.trimEnd().split("\n")) info(io, `  ${line}`);
  }
}

function suggestWorkerName(used: string[]): string {
  if (!used.includes("obsttorte")) return "obsttorte";
  let index = 2;
  while (used.includes(`obsttorte-${index}`)) index += 1;
  return `obsttorte-${index}`;
}

function parseLocation(value: string): D1LocationHint | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!(LOCATION_HINTS as readonly string[]).includes(trimmed)) {
    throw new CliError(
      `${trimmed} is not one of the D1 location hints: ${LOCATION_HINTS.join(", ")}.`,
    );
  }
  return trimmed as D1LocationHint;
}

function printAccessSteps(io: CommandIO, worker: string): void {
  info(io, "Set up Cloudflare Access in the dashboard. The CLI never stores the Client Secret.");
  blank(io);
  steps(io, [
    {
      text: "If you have not, open Zero Trust and create an organization on the Free plan.",
      url: "https://dash.cloudflare.com/?to=/:account/one",
    },
    {
      text: "In Zero Trust > Access controls > Service credentials > Service Tokens, create a service token with a duration of 1 year. Keep its Client ID and Client Secret. The Client Secret is shown only once. If you copy a header line such as CF-Access-Client-Secret: ..., keep only the value after the colon.",
      url: "https://dash.cloudflare.com/?to=/:account/one/access-controls/service-credentials/service-tokens",
    },
    {
      text: "In Zero Trust > Access controls > Policies, add a policy with the action Service Auth, and include only that service token with the Service Token selector.",
      url: "https://dash.cloudflare.com/?to=/:account/one/access-controls/policies",
    },
    {
      text: `In Workers & Pages > ${worker} > Access, select Protect this Worker behind Access, and choose All traffic. Under Authentication policy, select only the policy you added, and apply it. This also protects workers.dev and any custom domain.`,
      url: `https://dash.cloudflare.com/?to=/:account/workers/services/view/${worker}/production/access`,
    },
    {
      text: "On the same Access tab, copy the AUD tag.",
    },
    {
      text: "If Zero Trust > Access controls > Access settings shows Strict service token authentication, turn it on. Organizations created on or after 2026-10-05 always have it on.",
      url: "https://dash.cloudflare.com/?to=/:account/one/access-controls/settings",
    },
    {
      text: "In Notifications, add an Expiring Access Service Token Alert.",
      url: "https://dash.cloudflare.com/?to=/:account/notifications",
    },
    {
      text: "In Manage Account > Billing > Billable Usage, select Set Budget Alert, and create one for 1 USD.",
      url: "https://dash.cloudflare.com/?to=/:account/billing",
    },
  ]);
}

const INTEGRITY_PROBLEMS: Record<string, string> = {
  missingInLedger: "objects missing from the ledger",
  missingInR2: "objects missing from R2",
  orphanInR2: "unreferenced objects in R2",
  duplicatePathKeys: "duplicate paths",
  duplicateSeq: "duplicate sequence numbers",
  seqRegression: "sequence regressions",
  missingHistory: "files missing history",
};

export function formatMaintenance(reports: unknown): string[] {
  const rows = resultRows(reports);
  const lines: string[] = [];
  const succeeded = (row: Record<string, unknown>) => row.ok !== 0 && row.ok !== false;
  const snapshot = rows.find((row) => row.kind === "snapshot");
  if (snapshot) {
    const count = parseJsonRecord(snapshot.result).count;
    const files = typeof count === "number" ? `${count} files` : "done";
    lines.push(
      `Server snapshot (${formatTime(snapshot.ran_at)}): ${succeeded(snapshot) ? files : "failed"}`,
    );
  }
  const retention = rows.find((row) => row.kind === "retention");
  if (retention) {
    const result = parseJsonRecord(retention.result);
    const removed = typeof result.deletedSnapshots === "number" ? result.deletedSnapshots : 0;
    const summary = succeeded(retention)
      ? `${removed} snapshots removed`
      : result.reason === "shared-settings-unreadable"
        ? "stopped, obsttorte.json in the config folder could not be read"
        : "failed";
    lines.push(`Retention (${formatTime(retention.ran_at)}): ${summary}`);
  }
  const integrity = rows.find((row) => row.kind === "integrity");
  if (integrity) {
    const result = parseJsonRecord(integrity.result);
    const problems = Object.entries(INTEGRITY_PROBLEMS).flatMap(([key, label]) => {
      const count = result[key];
      return typeof count === "number" && count > 0 ? [`${count} ${label}`] : [];
    });
    const summary = succeeded(integrity) ? "no problems" : problems.join(", ") || "problems found";
    lines.push(`Integrity check (${formatTime(integrity.ran_at)}): ${summary}`);
  }
  const storage = rows.find((row) => row.kind === "storage");
  if (storage) {
    const result = parseJsonRecord(storage.result);
    const level = (value: unknown) =>
      value === "notice" || value === "warning" ? ` (${value})` : "";
    lines.push(
      `Storage (${formatTime(storage.ran_at)}): D1 ${formatBytes(result.d1Bytes)}${level(result.d1Level)}, R2 ${formatBytes(result.r2Bytes)}${level(result.r2Level)}`,
      `  Only in snapshots: ${formatBytes(result.snapshotOnlyBytes)}, only in history: ${formatBytes(result.historyOnlyBytes)}`,
    );
  }
  const summarized = new Set(["snapshot", "retention", "integrity", "storage"]);
  for (const row of rows) {
    if (summarized.has(String(row.kind)) || succeeded(row)) continue;
    lines.push(`${String(row.kind)} (${formatTime(row.ran_at)}): failed`);
  }
  return lines.length > 0 ? lines : ["No maintenance has run yet."];
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
