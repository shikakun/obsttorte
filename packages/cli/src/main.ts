import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCloudflareClient } from "./cloudflare";
import {
  access,
  type CommandIO,
  deviceAdd,
  deviceList,
  deviceRevoke,
  setup,
  status,
  update,
} from "./commands/install";
import { readBuiltWranglerConfig } from "./deploy-config";
import { CliError } from "./errors";
import { createPrompter } from "./prompt";
import { LOCATION_HINTS } from "./state";
import { stateDirectory } from "./state-store";
import { createWranglerRunner } from "./wrangler";

declare const __OBSTTORTE_VERSION__: string | undefined;

const HELP = `Obsttorte syncs an Obsidian vault through a server on your own Cloudflare account.

Usage
  obsttorte setup                Create the server and register the first device
  obsttorte update               Deploy this version over an existing server
  obsttorte status               Show the servers and their maintenance results
  obsttorte access               Record the Cloudflare Access settings and redeploy
  obsttorte device add           Issue a device token for another device
  obsttorte device list          List the devices
  obsttorte device revoke [id]   Revoke a device by its ID or name

Options
  --name <worker>        Worker name of the server to work on
  --all                  Update every recorded server (update only)
  --domain <host>        Serve from your own domain instead of workers.dev (setup only)
  --database <name>      D1 database name (setup only)
  --location <hint>      Where the D1 database lives: ${LOCATION_HINTS.join(", ")} (setup only)
  --bucket <name>        R2 bucket name (setup only)
  --device-name <name>   Name of the device (setup and device add)
  --force                Update even if a device runs a plugin too old for the server (update only)
  -y, --yes              Accept the defaults, and never take over unrecorded resources
  -h, --help             Show this message
  -v, --version          Show the version
`;

export async function main(argv: string[], io?: Partial<CommandIO>): Promise<number> {
  const write = io?.stdout ?? ((text: string) => console.log(text));
  try {
    const parsed = parseCommandLine(argv);
    if (parsed.help) {
      write(HELP);
      return 0;
    }
    if (parsed.version) {
      write(typeof __OBSTTORTE_VERSION__ === "string" ? __OBSTTORTE_VERSION__ : "0.0.0");
      return 0;
    }
    if (parsed.positionals.length === 0) {
      write(HELP);
      return 0;
    }
    assertKnownCommand(parsed.positionals);
    await dispatch(parsed, createIO(parsed, io));
    return 0;
  } catch (error) {
    console.error("");
    console.error(error instanceof Error ? error.message : "Failed.");
    if (error instanceof CliError && error.details) {
      console.error("");
      console.error(error.details.trimEnd());
    }
    return 1;
  }
}

async function dispatch(parsed: ParsedArgs, io: CommandIO): Promise<void> {
  const [command, sub] = parsed.positionals;
  if (command === "setup") {
    await setup(io, {
      name: parsed.flags.name,
      domain: parsed.flags.domain,
      database: parsed.flags.database,
      location: parsed.flags.location,
      bucket: parsed.flags.bucket,
      deviceName: parsed.flags["device-name"],
    });
    return;
  }
  if (command === "update") {
    await update(io, {
      name: parsed.flags.name,
      all: parsed.boolean.has("all"),
      force: parsed.boolean.has("force"),
    });
    return;
  }
  if (command === "status") {
    await status(io, parsed.flags.name);
    return;
  }
  if (command === "access") {
    await access(io, parsed.flags.name);
    return;
  }
  if (command === "device" && sub === "add") {
    await deviceAdd(io, { name: parsed.flags.name, deviceName: parsed.flags["device-name"] });
    return;
  }
  if (command === "device" && sub === "list") {
    await deviceList(io, parsed.flags.name);
    return;
  }
  if (command === "device" && sub === "revoke") {
    await deviceRevoke(io, parsed.positionals[2], parsed.flags.name);
  }
}

const COMMANDS = ["setup", "update", "status", "access"];
const DEVICE_COMMANDS = ["add", "list", "revoke"];

function assertKnownCommand([command, sub]: string[]): void {
  if (command !== undefined && COMMANDS.includes(command)) return;
  if (command === "device" && sub !== undefined && DEVICE_COMMANDS.includes(sub)) return;
  const name = command === "device" ? `device ${sub ?? ""}`.trim() : command;
  throw new CliError(`Unknown command: ${name}. Run \`obsttorte --help\` to see the commands.`);
}

function createIO(parsed: ParsedArgs, override: Partial<CommandIO> | undefined): CommandIO {
  const runner = createWranglerRunner();
  const stdout = override?.stdout ?? ((text: string) => console.log(text));
  return {
    cloudflare: override?.cloudflare ?? createCloudflareClient(runner),
    prompt: override?.prompt ?? createPrompter({ yes: parsed.boolean.has("yes"), write: stdout }),
    stateDir: override?.stateDir ?? stateDirectory(),
    layout: override?.layout ?? defaultLayout(),
    yes: parsed.boolean.has("yes"),
    fetch: override?.fetch ?? fetch,
    now: override?.now ?? (() => new Date()),
    stdout,
  };
}

function defaultLayout(): CommandIO["layout"] {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const buildDir = path.join(root, "dist/obsttorte");
  return {
    config: readBuiltWranglerConfig(buildDir),
    buildDir,
    migrationsDir: path.join(root, "migrations"),
  };
}

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | undefined>;
  boolean: Set<string>;
  help: boolean;
  version: boolean;
};

const OPTIONS = {
  name: { type: "string" },
  domain: { type: "string" },
  database: { type: "string" },
  location: { type: "string" },
  bucket: { type: "string" },
  "device-name": { type: "string" },
  all: { type: "boolean" },
  force: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

function parseCommandLine(argv: string[]): ParsedArgs {
  const { positionals, tokens } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const flags: Record<string, string | undefined> = {};
  const boolean = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const option = Object.hasOwn(OPTIONS, token.name)
      ? OPTIONS[token.name as keyof typeof OPTIONS]
      : undefined;
    if (!option) {
      throw new CliError(
        `Unknown option: ${token.rawName}. Run \`obsttorte --help\` to see the options.`,
      );
    }
    if (option.type === "boolean") {
      if (token.inlineValue) throw new CliError(`${token.rawName} does not take a value.`);
      boolean.add(token.name);
      continue;
    }
    if (token.value === undefined || (!token.inlineValue && token.value.startsWith("-"))) {
      throw new CliError(`${token.rawName} needs a value.`);
    }
    flags[token.name] = token.value;
  }
  return {
    positionals,
    flags,
    boolean,
    help: boolean.has("help"),
    version: boolean.has("version"),
  };
}
