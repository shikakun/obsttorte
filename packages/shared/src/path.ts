const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
const utf8 = new TextEncoder();

export class InvalidPathError extends Error {
  constructor(readonly path: string) {
    super("Invalid path");
    this.name = "InvalidPathError";
  }
}

export function normalizePath(input: string): string {
  return input.normalize("NFC").replace(/\\/g, "/");
}

export function validatePath(path: string): void {
  if (path.length === 0) throw new InvalidPathError(path);
  if (utf8.encode(path).byteLength > MAX_PATH_BYTES) throw new InvalidPathError(path);
  if (path.startsWith("/")) throw new InvalidPathError(path);
  if (WINDOWS_DRIVE_PREFIX.test(path)) throw new InvalidPathError(path);
  if (FORBIDDEN_CHARACTERS.test(path)) throw new InvalidPathError(path);
  if (path !== path.normalize("NFC")) throw new InvalidPathError(path);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new InvalidPathError(path);
    if (utf8.encode(segment).byteLength > MAX_SEGMENT_BYTES) throw new InvalidPathError(path);
  }
}

export function isPortablePath(path: string): boolean {
  return path.split("/").every((segment) => {
    if (WINDOWS_FORBIDDEN_CHARACTERS.test(segment)) return false;
    if (segment.endsWith(".") || segment.endsWith(" ")) return false;
    const stem = segment.split(".")[0]?.trimEnd() ?? "";
    return !WINDOWS_RESERVED_NAMES.test(stem);
  });
}

export function isValidPath(path: string): boolean {
  try {
    validatePath(path);
    return true;
  } catch (error) {
    if (error instanceof InvalidPathError) return false;
    throw error;
  }
}

/** APFS の大文字小文字無視に近似させる。toUpperCase を挟むことで ß → SS → ss のような展開も吸収する */
export function toPathKey(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase();
}

export function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

export function pathBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}
