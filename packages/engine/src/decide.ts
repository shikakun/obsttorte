type Sha256 = string;

export type SyncAction =
  | "noop"
  | "adoptBase"
  | "push"
  | "pull"
  | "deleteLocal"
  | "deleteRemote"
  | "conflict";

export type FileVersions = {
  local: Sha256 | null;
  base: Sha256 | null;
  remote: Sha256 | null;
};

export function decideAction({ local, base, remote }: FileVersions): SyncAction {
  if (local === remote) {
    return local === base ? "noop" : "adoptBase";
  }
  if (local === base) {
    return remote === null ? "deleteLocal" : "pull";
  }
  if (remote === base) {
    return local === null ? "deleteRemote" : "push";
  }
  if (local === null) return "pull";
  if (remote === null) return "push";
  return "conflict";
}

/** 片側にしか残っていない版を、この操作で失うかどうか */
export function losesSurvivor(versions: FileVersions, action: SyncAction): boolean {
  const { local, base, remote } = versions;
  if (local !== null && local !== remote && local !== base) {
    if (action === "deleteLocal" || action === "pull") return true;
  }
  if (remote !== null && remote !== local && remote !== base) {
    if (action === "deleteRemote" || action === "push") return true;
  }
  return false;
}
