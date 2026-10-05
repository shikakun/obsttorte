export type Writer = { stdout: (text: string) => void };

export function heading(io: Writer, text: string): void {
  io.stdout(`\n${text}\n${"-".repeat(text.length)}`);
}

export function info(io: Writer, text: string): void {
  io.stdout(`  ${text}`);
}

export function blank(io: Writer): void {
  io.stdout("");
}

export function fields(io: Writer, rows: Array<[label: string, value: string]>): void {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) info(io, `${label.padEnd(width)}  ${value}`);
}

export function steps(io: Writer, items: Array<{ text: string; url?: string }>): void {
  const indent = " ".repeat(String(items.length).length + 2);
  for (const [index, item] of items.entries()) {
    info(io, `${String(index + 1).padStart(String(items.length).length)}. ${item.text}`);
    if (item.url) info(io, `${indent}${item.url}`);
  }
}
