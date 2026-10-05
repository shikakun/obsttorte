import {
  API_VERSION,
  type CommitRequest,
  type CommitResponse,
  type ConflictCreateRequest,
  type ConflictRecord,
  type CreateSnapshotRequest,
  type CreateSnapshotResponse,
  type DeviceSummary,
  EXISTS_MAX_SHA256S,
  type ExistsResponse,
  type HealthResponse,
  type HistoryEntry,
  type HistoryRequest,
  type IndexEntry,
  type IndexResponse,
  isApiErrorBody,
  isSha256,
  type LogResponse,
  MAX_RETRY_WINDOW_MS,
  MAX_SYNC_ATTEMPTS,
  type PurgePrepareRequest,
  type PurgePrepareResponse,
  type PurgeRequest,
  type PurgeResponse,
  type ResolveConflictRequest,
  type RestoreRequest,
  type SnapshotDocument,
  type SnapshotListItem,
  type UploadCreateResponse,
} from "@obsttorte/shared";

export type HttpResult = {
  status: number;
  headers: Headers;
  body: ArrayBuffer;
};

export type Transport = (input: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: ArrayBuffer | string;
}) => Promise<HttpResult>;

export type ApiFailureKind =
  | "invalid"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "length"
  | "too-large"
  | "checksum"
  | "version"
  | "rate-limited"
  | "maintenance"
  | "not-found"
  | "unknown";

export class ApiRequestError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const RETRYABLE = new Set<ApiFailureKind>(["unknown", "rate-limited", "maintenance"]);

function kindForStatus(status: number): ApiFailureKind {
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 411:
      return "length";
    case 413:
      return "too-large";
    case 422:
      return "checksum";
    case 426:
      return "version";
    case 429:
      return "rate-limited";
    case 503:
      return "maintenance";
    default:
      return status >= 500 ? "unknown" : "invalid";
  }
}

function errorMessage(body: ArrayBuffer): string {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return isApiErrorBody(parsed) ? parsed.error.message : "Request failed";
  } catch {
    return "Request failed";
  }
}

function retryAfter(headers: Headers): number | null {
  const value = headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
}

function objectPath(sha256: string): string {
  if (!isSha256(sha256)) throw new ApiRequestError("invalid", 0, null, "sha256 is invalid");
  return `/api/objects/${sha256}`;
}

export class ApiClient {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly options: {
      transport: Transport;
      headers: Record<string, string>;
      apiVersion?: number;
      timeoutMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  health(): Promise<HealthResponse> {
    return this.json("GET", "/api/health");
  }

  index(since?: number): Promise<IndexResponse> {
    const query = since === undefined ? "" : `?since=${since}`;
    return this.json("GET", `/api/index${query}`);
  }

  async headObject(sha256: string): Promise<boolean> {
    const response = await this.send("HEAD", objectPath(sha256));
    if (response.status === 404) return false;
    if (response.status >= 400) throw this.failure(response);
    return true;
  }

  async existingObjects(sha256s: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (sha256s.length > 10) {
      for (let index = 0; index < sha256s.length; index += EXISTS_MAX_SHA256S) {
        const chunk = sha256s.slice(index, index + EXISTS_MAX_SHA256S);
        const response = await this.json<ExistsResponse>("POST", "/api/objects/exists", {
          sha256s: chunk,
        });
        for (const sha256 of response.sha256s) found.add(sha256);
      }
      return found;
    }
    for (const sha256 of sha256s) {
      if (await this.headObject(sha256)) found.add(sha256);
    }
    return found;
  }

  async getObject(sha256: string, range?: { start: number; end: number }): Promise<ArrayBuffer> {
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
    const response = await this.send("GET", objectPath(sha256), { headers });
    if (response.status >= 400) throw this.failure(response);
    return response.body;
  }

  async putObject(sha256: string, body: ArrayBuffer): Promise<void> {
    return this.empty("PUT", objectPath(sha256), body);
  }

  createUpload(sha256: string, size: number): Promise<UploadCreateResponse> {
    return this.json("POST", "/api/uploads", { sha256, size });
  }

  uploadPart(uploadId: string, partNumber: number, body: ArrayBuffer): Promise<void> {
    return this.empty(
      "PUT",
      `/api/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
      body,
    );
  }

  completeUpload(uploadId: string): Promise<void> {
    return this.empty("POST", `/api/uploads/${encodeURIComponent(uploadId)}/complete`);
  }

  commit(request: CommitRequest): Promise<CommitResponse> {
    return this.json("POST", "/api/commit", request);
  }

  history(request: HistoryRequest): Promise<HistoryEntry[]> {
    return this.json("POST", "/api/history", request);
  }

  snapshots(): Promise<SnapshotListItem[]> {
    return this.json("GET", "/api/snapshots");
  }

  snapshot(id: string): Promise<SnapshotDocument> {
    return this.json("GET", `/api/snapshots/${encodeURIComponent(id)}`);
  }

  createSnapshot(request: CreateSnapshotRequest): Promise<CreateSnapshotResponse> {
    return this.json("POST", "/api/snapshots", request, { retry: false });
  }

  restore(request: RestoreRequest): Promise<CommitResponse> {
    return this.json("POST", "/api/restore", request, { retry: false });
  }

  conflicts(): Promise<ConflictRecord[]> {
    return this.json("GET", "/api/conflicts");
  }

  createConflict(request: ConflictCreateRequest): Promise<ConflictRecord> {
    return this.json("POST", "/api/conflicts", request, { retry: false });
  }

  resolveConflict(id: string, request: ResolveConflictRequest): Promise<CommitResponse> {
    return this.json("POST", `/api/conflicts/${encodeURIComponent(id)}/resolve`, request, {
      retry: false,
    });
  }

  preparePurge(request: PurgePrepareRequest): Promise<PurgePrepareResponse> {
    return this.json("POST", "/api/purge/prepare", request, { retry: false });
  }

  purge(request: PurgeRequest): Promise<PurgeResponse> {
    return this.json("POST", "/api/purge", request, { retry: false });
  }

  log(since: number, limit: number): Promise<LogResponse> {
    return this.json("GET", `/api/log?since=${since}&limit=${limit}`);
  }

  devices(): Promise<DeviceSummary[]> {
    return this.json("GET", "/api/devices");
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { retry?: boolean },
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await this.send(method, path, {
      body: payload,
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      retry: options?.retry,
    });
    if (response.status >= 400) throw this.failure(response);
    if (response.body.byteLength === 0) {
      throw new ApiRequestError("unknown", response.status, null, "Empty response");
    }
    try {
      return JSON.parse(new TextDecoder().decode(response.body)) as T;
    } catch {
      throw new ApiRequestError("unknown", response.status, null, "Unreadable response");
    }
  }

  private async empty(method: string, path: string, body?: ArrayBuffer | string): Promise<void> {
    const response = await this.send(method, path, { body });
    if (response.status >= 400) throw this.failure(response);
  }

  private failure(response: HttpResult): ApiRequestError {
    return new ApiRequestError(
      kindForStatus(response.status),
      response.status,
      retryAfter(response.headers),
      errorMessage(response.body),
    );
  }

  private async send(
    method: string,
    path: string,
    init?: { body?: ArrayBuffer | string; headers?: Record<string, string>; retry?: boolean },
  ): Promise<HttpResult> {
    const retry = init?.retry !== false;
    const started = this.now();
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(method, path, init);
      } catch (error) {
        attempt += 1;
        if (!(error instanceof ApiRequestError) || !retry || !RETRYABLE.has(error.kind))
          throw error;
        if (attempt >= MAX_SYNC_ATTEMPTS || this.now() - started >= MAX_RETRY_WINDOW_MS)
          throw error;
        const backoff =
          error.retryAfterSeconds !== null
            ? error.retryAfterSeconds * 1000
            : 1000 * 2 ** (attempt - 1);
        const remaining = MAX_RETRY_WINDOW_MS - (this.now() - started);
        await this.sleep(Math.min(backoff, Math.max(remaining, 0)));
      }
    }
  }

  private async once(
    method: string,
    path: string,
    init?: { body?: ArrayBuffer | string; headers?: Record<string, string> },
  ): Promise<HttpResult> {
    const headers = {
      ...this.options.headers,
      "X-Obsttorte-Api": String(this.options.apiVersion ?? API_VERSION),
      ...init?.headers,
    };
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HttpResult>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ApiRequestError("unknown", 0, null, "Timed out"));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.options.transport({ method, path, headers, body: init?.body }),
        timeout,
      ]);
      if (response.status >= 500 || response.status === 429) {
        throw this.failure(response);
      }
      return response;
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      throw new ApiRequestError("unknown", 0, null, "Network error");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function readFullIndex(
  api: Pick<ApiClient, "index">,
  since?: number,
): Promise<IndexResponse> {
  const entries: IndexEntry[] = [];
  let cursor = since;
  for (;;) {
    const page = await api.index(cursor);
    entries.push(...page.entries);
    if (!page.truncated) return { seq: page.seq, truncated: false, entries };
    const last = page.entries.at(-1);
    if (!last) throw new ApiRequestError("unknown", 200, null, "Truncated index had no cursor");
    cursor = last.seq;
  }
}
