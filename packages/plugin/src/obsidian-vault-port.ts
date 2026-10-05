import type { LocalFileStat, VaultPort } from "@obsttorte/engine";
import { normalizePath, parentPath } from "@obsttorte/shared";
import { type App, type DataAdapter, type ListedFiles, Platform, type TFile } from "obsidian";

type NodeFs = {
  lstatSync: (path: string) => { isSymbolicLink: () => boolean };
};

export class ObsidianVaultPort implements VaultPort {
  constructor(
    private readonly app: App,
    private readonly selfWrites: Set<string>,
  ) {}

  async listFiles(): Promise<LocalFileStat[]> {
    const files = this.app.vault.getFiles().flatMap((file) => this.statFromFile(file) ?? []);
    const configDir = this.app.vault.configDir;
    const configFiles = await listConfigFiles(this.app.vault.adapter, configDir);
    for (const localPath of configFiles) {
      if (isSymlink(this.app, localPath)) continue;
      const stat = await this.app.vault.adapter.stat(localPath);
      if (stat?.type !== "file") continue;
      files.push({
        path: normalizePath(localPath),
        localPath,
        mtime: stat.mtime,
        size: stat.size,
      });
    }
    return files;
  }

  async stat(path: string): Promise<LocalFileStat | null> {
    const file = this.app.vault.getFileByPath(path);
    if (file) return this.statFromFile(file);
    const stat = await this.app.vault.adapter.stat(path);
    if (stat?.type !== "file" || isSymlink(this.app, path)) return null;
    return { path: normalizePath(path), localPath: path, mtime: stat.mtime, size: stat.size };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.app.vault.getFileByPath(path);
    if (file) return this.app.vault.readBinary(file);
    return this.app.vault.adapter.readBinary(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.selfWrites.add(path);
    await ensureParent(this.app.vault.adapter, path);
    const file = this.app.vault.getFileByPath(path);
    if (file) {
      await this.app.vault.modifyBinary(file, data);
      return;
    }
    if (path.startsWith(`${this.app.vault.configDir}/`)) {
      await this.app.vault.adapter.writeBinary(path, data);
      return;
    }
    await this.app.vault.createBinary(path, data);
  }

  async remove(path: string): Promise<void> {
    this.selfWrites.add(path);
    const file = this.app.vault.getFileByPath(path);
    if (file) {
      await this.app.fileManager.trashFile(file);
      return;
    }
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }

  async removeEmptyFolder(path: string): Promise<void> {
    if (!path || path === this.app.vault.configDir) return;
    const listed = await this.app.vault.adapter.list(path);
    if (listed.files.length > 0 || listed.folders.length > 0) return;
    await this.app.vault.adapter.rmdir(path, false);
  }

  private statFromFile(file: TFile): LocalFileStat | null {
    if (isSymlink(this.app, file.path)) return null;
    return {
      path: normalizePath(file.path),
      localPath: file.path,
      mtime: file.stat.mtime,
      size: file.stat.size,
    };
  }
}

async function listConfigFiles(adapter: DataAdapter, dir: string): Promise<string[]> {
  let listed: ListedFiles;
  try {
    listed = await adapter.list(dir);
  } catch (error) {
    throw new Error(`Could not list ${dir}`, { cause: error });
  }
  const nested = await Promise.all(
    listed.folders.map((folder) => listConfigFiles(adapter, folder)),
  );
  return [...listed.files, ...nested.flat()];
}

async function ensureParent(adapter: DataAdapter, path: string): Promise<void> {
  const parent = parentPath(path);
  if (!parent) return;
  if (!(await adapter.exists(parent))) {
    await ensureParent(adapter, parent);
    await adapter.mkdir(parent);
  }
}

function isSymlink(app: App, localPath: string): boolean {
  if (!Platform.isDesktopApp) return false;
  const nodeRequire = (window as { require?: (id: string) => NodeFs }).require;
  if (!nodeRequire) return false;
  try {
    const fs = nodeRequire("fs");
    const base = (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
    if (!base) return false;
    return fs.lstatSync(`${base}/${localPath}`).isSymbolicLink();
  } catch {
    return false;
  }
}
