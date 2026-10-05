export type LocalFileStat = {
  path: string;
  localPath: string;
  mtime: number;
  size: number;
};

export interface VaultPort {
  listFiles(): Promise<LocalFileStat[]>;
  stat(path: string): Promise<LocalFileStat | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  removeEmptyFolder(path: string): Promise<void>;
}
