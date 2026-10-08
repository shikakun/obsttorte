export type SyncMode = "bidirectional" | "push-only" | "pull-only";

export type IndexEntry = {
  path: string;
  sha256: string | null;
  size: number;
  rev: number;
  seq: number;
  deleted: boolean;
  updatedAt: number;
};

export type IndexResponse = {
  seq: number;
  truncated: boolean;
  entries: IndexEntry[];
};

export type FileChange =
  | { path: string; sha256: string; size: number; expectedRev: number }
  | { path: string; deleted: true; expectedRev: number };

export type CommitRequest = {
  requestId: string;
  changes: FileChange[];
};

export type RejectReason = "revMismatch" | "pathCollision" | "missingObject" | "invalidPath";

export type CommitRejection = {
  path: string;
  reason: RejectReason;
  currentRev: number | null;
  currentSha256: string | null;
};

export type CommitResponse = {
  seq: number;
  applied: Array<{ path: string; rev: number; seq: number }>;
  rejected: CommitRejection[];
};

export type ExistsRequest = { sha256s: string[] };
export type ExistsResponse = { sha256s: string[] };

export type UploadCreateRequest = { sha256: string; size: number };
export type UploadCreateResponse = { uploadId: string };

export type HistoryRequest = { path: string; limit: number };

export type HistoryEntry = {
  path: string;
  sha256: string | null;
  size: number;
  rev: number;
  seq: number;
  deleted: boolean;
  changedAt: number;
  deviceId: string;
  deviceName: string;
  requestId: string;
};

export type MaintenanceKind = "integrity" | "gc" | "snapshot" | "storage";

export type MaintenanceReport = {
  kind: MaintenanceKind;
  ranAt: number;
  ok: boolean;
  result: Record<string, unknown>;
};

export type HealthResponse = {
  api: { min: number; max: number };
  reports: MaintenanceReport[];
  accessTokenExpiresAt: string | null;
  accessTokenWarning: boolean;
  deviceId: string;
  deviceName: string;
};

export type DeviceSummary = {
  id: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
  lastApiVersion: number | null;
};

export type SnapshotOrigin = "server" | "device";

export type SnapshotListItem = {
  id: string;
  createdAt: number;
  origin: SnapshotOrigin;
  deviceId: string | null;
};

export type SnapshotFile = { sha256: string; size: number };

export type SnapshotDocument = {
  files: Record<string, SnapshotFile>;
};

export type CreateSnapshotRequest = SnapshotDocument;
export type CreateSnapshotResponse = { id: string };

export type RestoreRequest = { snapshotId: string; paths?: string[] };

export type ConflictCreateRequest = {
  path: string;
  baseSha: string | null;
  localSha: string;
  remoteSha: string;
};

export type ConflictRecord = {
  id: string;
  path: string;
  baseSha: string | null;
  localSha: string;
  remoteSha: string;
  deviceId: string;
  deviceName: string;
  createdAt: number;
  resolvedAt: number | null;
  resolvedSha: string | null;
  localUpdatedAt?: number | null;
  remoteUpdatedAt?: number | null;
};

export type ResolveConflictRequest = { sha256: string; size: number };

export type PurgePrepareRequest = { paths?: string[]; sha256s?: string[] };

export type PurgePrepareResponse = {
  confirmToken: string;
  fileCount: number;
  objectCount: number;
  bytes: number;
};

export type PurgeRequest = { confirmToken: string };

export type PurgeResponse = {
  deletedObjects: number;
  deletedBytes: number;
};

export type LogHighlight = "late-night" | "plugin-path" | "unknown-device";

export type LogEntry = HistoryEntry & {
  highlight: LogHighlight[];
};

export type LogResponse = {
  entries: LogEntry[];
  truncated: boolean;
};

export function isContentChange(change: FileChange): change is {
  path: string;
  sha256: string;
  size: number;
  expectedRev: number;
} {
  return !("deleted" in change);
}
