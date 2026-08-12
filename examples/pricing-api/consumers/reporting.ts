import { quote } from "../src/pricing";

/** Blast radius #2: monthly revenue roll-up, same signature dependency. */
export function projectedMrr(accounts: Array<{ tier: string; seats: number }>): number {
  return accounts.reduce((sum, a) => sum + quote(a.tier, a.seats).total, 0);
}
