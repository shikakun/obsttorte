export type DiffPart = { type: "equal" | "insert" | "delete"; text: string };

export type DiffLine = {
  type: "equal" | "insert" | "delete";
  text: string;
  words: DiffPart[];
};

export type DiffHunk = {
  beforeStart: number;
  afterStart: number;
  lines: DiffLine[];
};

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

function segmentWords(text: string): string[] {
  return [...segmenter.segment(text)].map((part) => part.segment);
}

type Op = { type: DiffPart["type"]; text: string };

function align(before: string[], after: string[]): Op[] {
  if (before.length * after.length > 250_000) {
    return [
      ...before.map((text) => ({ type: "delete" as const, text })),
      ...after.map((text) => ({ type: "insert" as const, text })),
    ];
  }
  const scores: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      const current = scores[row];
      const next = scores[row + 1];
      if (!current || !next) continue;
      current[column] =
        before[row] === after[column]
          ? (next[column + 1] ?? 0) + 1
          : Math.max(next[column] ?? 0, current[column + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      ops.push({ type: "equal", text: before[row] ?? "" });
      row += 1;
      column += 1;
    } else if ((scores[row + 1]?.[column] ?? 0) >= (scores[row]?.[column + 1] ?? 0)) {
      ops.push({ type: "delete", text: before[row] ?? "" });
      row += 1;
    } else {
      ops.push({ type: "insert", text: after[column] ?? "" });
      column += 1;
    }
  }
  while (row < before.length) ops.push({ type: "delete", text: before[row++] ?? "" });
  while (column < after.length) ops.push({ type: "insert", text: after[column++] ?? "" });
  return ops;
}

function diffTokens(before: string[], after: string[]): DiffPart[] {
  const ops = align(before, after);
  const parts: DiffPart[] = [];
  for (const op of ops) {
    const last = parts.at(-1);
    if (last && last.type === op.type) last.text += op.text;
    else parts.push({ type: op.type, text: op.text });
  }
  return parts;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** 変更の前後に添える、変わっていない行の数 */
const CONTEXT_LINES = 3;

export function diffLines(before: string, after: string): DiffHunk[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = align(beforeLines, afterLines);
  const hunks: DiffHunk[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let current: DiffHunk | null = null;
  let leading: DiffLine[] = [];
  let equalRun = 0;
  const flush = () => {
    if (!current) return;
    const hidden = current.lines.splice(
      current.lines.length - Math.max(0, equalRun - CONTEXT_LINES),
    );
    hunks.push(current);
    current = null;
    leading = hidden.slice(-CONTEXT_LINES);
    equalRun = 0;
  };
  for (const op of ops) {
    const line: DiffLine = {
      type: op.type,
      text: op.text,
      words: [{ type: op.type, text: op.text }],
    };
    if (op.type === "equal") {
      beforeIndex += 1;
      afterIndex += 1;
      if (!current) {
        leading = [...leading, line].slice(-CONTEXT_LINES);
        continue;
      }
      current.lines.push(line);
      equalRun += 1;
      // 次の変更との間が狭ければ、1つの塊にまとめて同じ行を二度見せない
      if (equalRun > CONTEXT_LINES * 2) flush();
      continue;
    }
    equalRun = 0;
    if (!current) {
      current = {
        beforeStart: beforeIndex - leading.length,
        afterStart: afterIndex - leading.length,
        lines: leading,
      };
      leading = [];
    }
    current.lines.push(line);
    if (op.type === "delete") beforeIndex += 1;
    else afterIndex += 1;
  }
  flush();
  for (const hunk of hunks) {
    for (let index = 0; index < hunk.lines.length - 1; index += 1) {
      const deleted = hunk.lines[index];
      const inserted = hunk.lines[index + 1];
      if (!deleted || !inserted || deleted.type !== "delete" || inserted.type !== "insert")
        continue;
      const words = diffTokens(segmentWords(deleted.text), segmentWords(inserted.text));
      deleted.words = words.filter((part) => part.type !== "insert");
      inserted.words = words.filter((part) => part.type !== "delete");
    }
  }
  return hunks;
}
