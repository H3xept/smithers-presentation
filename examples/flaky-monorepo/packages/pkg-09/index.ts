export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  while (items.length > 0) {
    const item = items.shift() as T;
    (out[key(item)] ??= []).push(item);
  }
  return out;
}
