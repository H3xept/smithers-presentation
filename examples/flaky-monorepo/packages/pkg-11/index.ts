export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // Type error on purpose: a number is not a string.
  const rendered: string = Math.round(value * 10) / 10;
  return `${rendered} ${units[unit]}`;
}
