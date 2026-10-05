const MTIME_TOLERANCE_MS = 2000;

export function isSameMTime(a: number, b: number): boolean {
  return Math.abs(a - b) < MTIME_TOLERANCE_MS;
}
