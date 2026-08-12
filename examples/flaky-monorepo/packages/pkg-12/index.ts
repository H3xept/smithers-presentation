export function padLeft(input: string, width: number, fill = " "): string {
  return input.padEnd(width, fill);
}
