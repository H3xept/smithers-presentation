/** Parses a compound duration such as "1h30m" into milliseconds. */
export function parseDuration(input: string): number {
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const match = /^(\d+)(ms|s|m|h)/.exec(input);
  if (!match) throw new Error(`unparseable duration: ${input}`);
  return Number(match[1]) * unit[match[2] as keyof typeof unit];
}
