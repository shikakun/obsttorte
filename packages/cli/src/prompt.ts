import { open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { CliError } from "./errors";

export type Choice<T> = { value: T; label: string };

export type TextOptions = {
  defaultValue?: string;
  validate?: (value: string) => string | null;
};

export type Prompter = {
  text(label: string, options?: TextOptions): Promise<string>;
  confirm(label: string, defaultYes: boolean): Promise<boolean>;
  choose<T>(label: string, choices: Choice<T>[], defaultIndex?: number): Promise<T>;
};

export type Question = (text: string) => Promise<string>;

export function createPrompter(options: {
  yes: boolean;
  write: (text: string) => void;
  question?: Question;
}): Prompter {
  const { yes, write } = options;
  const question = options.question ?? askTerminal;
  return {
    async text(label, { defaultValue, validate } = {}) {
      if (yes) {
        if (defaultValue === undefined) {
          throw new CliError(
            `${label}\n--yes cannot answer this. Pass the matching option instead.`,
          );
        }
        const problem = validate?.(defaultValue);
        if (problem) throw new CliError(`${label}: ${problem}`);
        return defaultValue;
      }
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      for (;;) {
        const answer = (await question(`  ${label}${suffix}: `)).trim() || defaultValue || "";
        const problem = validate?.(answer);
        if (!problem) return answer;
        write(`  ${problem}`);
      }
    },
    async confirm(label, defaultYes) {
      if (yes) return defaultYes;
      const suffix = defaultYes ? "[Y/n]" : "[y/N]";
      for (;;) {
        const answer = (await question(`  ${label} ${suffix}: `)).trim().toLowerCase();
        if (answer === "") return defaultYes;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
      }
    },
    async choose(label, choices, defaultIndex = 0) {
      const fallback = choices[defaultIndex];
      if (!fallback) throw new Error("The default choice is out of range.");
      if (yes) return fallback.value;
      write(`  ${label}`);
      for (const [index, choice] of choices.entries()) write(`    ${index + 1}. ${choice.label}`);
      for (;;) {
        const answer = (await question(`  Choice [${defaultIndex + 1}]: `)).trim();
        const index = answer === "" ? defaultIndex : Number(answer) - 1;
        const chosen = Number.isInteger(index) ? choices[index] : undefined;
        if (chosen) return chosen.value;
      }
    },
  };
}

async function askTerminal(text: string): Promise<string> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return ask(text, process.stdin, process.stdout);
  }
  const tty = await open("/dev/tty", "r+").catch(() => null);
  if (!tty) {
    throw new CliError(
      `No terminal is available to ask “${text.trim()}”. Pass the matching option instead.`,
    );
  }
  try {
    return await ask(text, tty.createReadStream(), tty.createWriteStream());
  } finally {
    await tty.close();
  }
}

async function ask(
  text: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(text);
  } finally {
    rl.close();
  }
}
