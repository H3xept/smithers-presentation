export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}
