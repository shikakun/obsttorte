export type SnapshotDelta = {
  added: string[];
  changed: string[];
  removed: string[];
};

export function diffSnapshot(
  current: ReadonlyArray<{ path: string; sha256: string | null; deleted: boolean }>,
  snapshot: Readonly<Record<string, { sha256: string }>>,
): SnapshotDelta {
  const live = new Map(
    current.filter((file) => !file.deleted && file.sha256).map((file) => [file.path, file.sha256]),
  );
  const added: string[] = [];
  const changed: string[] = [];
  for (const [path, file] of Object.entries(snapshot)) {
    const sha = live.get(path);
    if (!sha) added.push(path);
    else if (sha !== file.sha256) changed.push(path);
    live.delete(path);
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: [...live.keys()].sort(),
  };
}
