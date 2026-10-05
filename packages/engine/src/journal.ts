export type JournalEntry = {
  path: string;
  expectedSha256: string;
  previousSha256: string | null;
  startedAt: number;
};

export type JournalState = "complete" | "unchanged" | "partial";

export function classifyJournal(entry: JournalEntry, actualSha256: string | null): JournalState {
  if (actualSha256 === entry.expectedSha256) return "complete";
  if (actualSha256 === entry.previousSha256) return "unchanged";
  return "partial";
}
