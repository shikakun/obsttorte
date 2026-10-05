import type {
  IndexStore,
  JournalEntry,
  JournalStore,
  LocalIndexEntry,
  Rejection,
  StashedRemote,
  SyncPlan,
} from "@obsttorte/engine";

const FILES = "files";
const META = "meta";
const SYNC_PLAN_LIMIT = 20;

export type StoredSyncPlan = {
  at: number;
  plan: SyncPlan;
  rejected: Rejection[];
};

export class IndexedDbIndex implements IndexStore {
  constructor(private readonly installId: string) {}

  async list(): Promise<LocalIndexEntry[]> {
    const db = await this.open();
    return request(store(db, FILES).getAll()) as Promise<LocalIndexEntry[]>;
  }

  async get(path: string): Promise<LocalIndexEntry | null> {
    const db = await this.open();
    const value = (await request(store(db, FILES).get(path))) as unknown;
    if (!value || typeof value !== "object") return null;
    return value as LocalIndexEntry;
  }

  async put(entry: LocalIndexEntry): Promise<void> {
    const db = await this.open();
    await request(store(db, FILES, "readwrite").put(entry));
  }

  async remove(path: string): Promise<void> {
    const db = await this.open();
    await request(store(db, FILES, "readwrite").delete(path));
  }

  async getCursor(): Promise<number> {
    return Number((await this.meta("cursor")) ?? 0);
  }

  async setCursor(seq: number): Promise<void> {
    await this.setMeta("cursor", seq);
  }

  async isInitialized(): Promise<boolean> {
    return (await this.meta("initialized")) === true;
  }

  async setInitialized(value: boolean): Promise<void> {
    await this.setMeta("initialized", value);
  }

  async getStashes(): Promise<Map<string, StashedRemote>> {
    const value = await this.meta("stashes");
    return new Map(Object.entries((value as Record<string, StashedRemote> | undefined) ?? {}));
  }

  async setStashes(stashes: Map<string, StashedRemote>): Promise<void> {
    await this.setMeta("stashes", Object.fromEntries(stashes));
  }

  async approvals(): Promise<Array<{ path: string; sha256: string }>> {
    const value = await this.meta("approvals");
    return Array.isArray(value) ? (value as Array<{ path: string; sha256: string }>) : [];
  }

  async reset(): Promise<void> {
    const name = `obsttorte-${this.installId}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onblocked = () => resolve();
      request.onerror = () => {
        reject(new Error(request.error?.message ?? "IndexedDB request failed"));
      };
    });
  }

  async approve(path: string, sha256: string): Promise<void> {
    const current = (await this.approvals()).filter((item) => item.path !== path);
    current.push({ path, sha256 });
    await this.setMeta("approvals", current);
  }

  async syncPlans(): Promise<StoredSyncPlan[]> {
    const value = await this.meta("syncPlans");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => (isStoredSyncPlan(item) ? [item] : []));
  }

  async saveSyncPlans(plans: readonly StoredSyncPlan[]): Promise<void> {
    await this.setMeta("syncPlans", plans.slice(0, SYNC_PLAN_LIMIT));
  }

  async familiarDevices(): Promise<string[]> {
    const value = await this.meta("familiarDevices");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  }

  async rememberDevices(ids: readonly string[]): Promise<void> {
    const known = new Set(await this.familiarDevices());
    for (const id of ids) if (id.length > 0) known.add(id);
    await this.setMeta("familiarDevices", [...known]);
  }

  private async meta(key: string): Promise<unknown> {
    const db = await this.open();
    return request(store(db, META).get(key));
  }

  private async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    await request(store(db, META, "readwrite").put(value, key));
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`obsttorte-${this.installId}`, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "path" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        reject(new Error(request.error?.message ?? "IndexedDB request failed"));
      };
    });
  }
}

export class DiskJournal implements JournalStore {
  constructor(
    private readonly read: () => Promise<string | null>,
    private readonly write: (value: string) => Promise<void>,
  ) {}

  async list(): Promise<JournalEntry[]> {
    const text = await this.read();
    if (!text) return [];
    const parsed = JSON.parse(text) as JournalEntry[];
    if (!Array.isArray(parsed)) throw new Error("Journal is unreadable");
    return parsed;
  }

  async replace(entries: JournalEntry[]): Promise<void> {
    await this.write(JSON.stringify(entries));
  }
}

function store(
  db: IDBDatabase,
  name: string,
  mode: IDBTransactionMode = "readonly",
): IDBObjectStore {
  return db.transaction(name, mode).objectStore(name);
}

function isStoredSyncPlan(value: unknown): value is StoredSyncPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as { at?: unknown; plan?: unknown; rejected?: unknown };
  return typeof plan.at === "number" && plan.plan !== null && typeof plan.plan === "object";
}

function request<T>(query: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    query.onsuccess = () => resolve(query.result);
    query.onerror = () => {
      reject(new Error(query.error?.message ?? "IndexedDB request failed"));
    };
  });
}
