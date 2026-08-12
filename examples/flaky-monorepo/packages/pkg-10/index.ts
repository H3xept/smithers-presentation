export function retryDelay(attempt: number, baseMs = 100, capMs = 5_000): number {
  return baseMs * 2 ** attempt;
}
