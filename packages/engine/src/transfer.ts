export function groupByBudget<T>(
  items: readonly T[],
  concurrency: number,
  budget: number,
  size: (item: T) => number,
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const weight = Math.max(size(item), 0);
    const alone = weight > budget;
    const full =
      current.length > 0 && (alone || current.length >= concurrency || bytes + weight > budget);
    if (full) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += weight;
    if (alone || current.length >= concurrency) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
