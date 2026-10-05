export function newerConflictSide(
  localUpdatedAt: number | null | undefined,
  remoteUpdatedAt: number | null | undefined,
): "local" | "remote" {
  return (remoteUpdatedAt ?? 0) >= (localUpdatedAt ?? 0) ? "remote" : "local";
}
