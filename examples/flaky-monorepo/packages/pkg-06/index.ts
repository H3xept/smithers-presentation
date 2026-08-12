export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(key(item), item);
  return [...seen.values()];
}
