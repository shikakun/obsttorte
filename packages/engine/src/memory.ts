import { sha256Hex } from "@obsttorte/shared";
import type { JournalEntry } from "./journal";
import type { LocalFileStat, VaultPort } from "./vault-port";

export type StashedRemote = {
  sha256: string | null;
  size: number;
  rev: number;
  seq: number;
  deleted: boolean;
};

export type LocalIndexEntry = {
  path: string;
  localPath: string;
  mtime: number;
  size: number;
  sha256: string;
  baseSha256: string | null;
  baseRev: number;
  remoteSize?: number;
  heldRemoteSha256?: string;
  stashedRemote?: StashedRemote;
};

export interface IndexStore {
  list(): Promise<LocalIndexEntry[]>;
  get(path: string): Promise<LocalIndexEntry | null>;
  put(entry: LocalIndexEntry): Promise<void>;
  remove(path: string): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  isInitialized(): Promise<boolean>;
  setInitialized(value: boolean): Promise<void>;
  getStashes(): Promise<Map<string, StashedRemote>>;
  setStashes(stashes: Map<string, StashedRemote>): Promise<void>;
}

export interface JournalStore {
  list(): Promise<JournalEntry[]>;
  replace(entries: JournalEntry[]): Promise<void>;
}

export class MemoryVault implements VaultPort {
  private readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  private clock = 1;
  listError: Error | null = null;

  async listFiles(): Promise<LocalFileStat[]> {
    if (this.listError) throw this.listError;
    return [...this.files.entries()].map(([path, file]) => ({
      path,
      localPath: path,
      mtime: file.mtime,
      size: file.bytes.byteLength,
    }));
  }

  async stat(path: string): Promise<LocalFileStat | null> {
    const file = this.files.get(path);
    if (!file) return null;
    return { path, localPath: path, mtime: file.mtime, size: file.bytes.byteLength };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file: ${path}`);
    return file.bytes.slice().buffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.clock += 1;
    this.files.set(path, { bytes: new Uint8Array(data), mtime: this.clock });
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async removeEmptyFolder(path: string): Promise<void> {
    if (!path) return;
    for (const file of this.files.keys()) {
      if (file.startsWith(`${path}/`)) return;
    }
  }

  async seed(path: string, text: string, mtime = 1): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    this.files.set(path, { bytes, mtime });
    return sha256Hex(bytes);
  }

  overwrite(path: string, text: string): void {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file: ${path}`);
    file.bytes = new TextEncoder().encode(text);
  }
}

export class MemoryIndex implements IndexStore {
  readonly entries = new Map<string, LocalIndexEntry>();
  readonly stashes = new Map<string, StashedRemote>();
  cursor = 0;
  initialized = false;

  async list(): Promise<LocalIndexEntry[]> {
    return [...this.entries.values()];
  }

  async get(path: string): Promise<LocalIndexEntry | null> {
    return this.entries.get(path) ?? null;
  }

  async put(entry: LocalIndexEntry): Promise<void> {
    this.entries.set(entry.path, entry);
  }

  async remove(path: string): Promise<void> {
    this.entries.delete(path);
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(seq: number): Promise<void> {
    this.cursor = seq;
  }

  async isInitialized(): Promise<boolean> {
    return this.initialized;
  }

  async setInitialized(value: boolean): Promise<void> {
    this.initialized = value;
  }

  async getStashes(): Promise<Map<string, StashedRemote>> {
    return new Map(this.stashes);
  }

  async setStashes(stashes: Map<string, StashedRemote>): Promise<void> {
    this.stashes.clear();
    for (const [path, stash] of stashes) this.stashes.set(path, stash);
  }
}

export class MemoryJournal implements JournalStore {
  entries: JournalEntry[] = [];

  async list(): Promise<JournalEntry[]> {
    return [...this.entries];
  }

  async replace(entries: JournalEntry[]): Promise<void> {
    this.entries = [...entries];
  }
}
