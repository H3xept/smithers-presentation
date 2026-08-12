import prices from "../prices.json";

export type TierId = (typeof prices.tiers)[number]["id"];

export type Quote = {
  tier: TierId;
  seats: number;
  /** Total in cents. */
  total: number;
};

const tier = (id: string) => {
  const found = prices.tiers.find((t) => t.id === id);
  if (!found) throw new Error(`unknown tier: ${id}`);
  return found;
};

/**
 * The one public pricing entry point. Two consumers depend on this signature:
 * consumers/checkout.ts and consumers/reporting.ts.
 */
export function quote(tierId: string, seats: number): Quote {
  const t = tier(tierId);
  const overage = Math.max(0, seats - t.includedSeats) * t.overagePerSeat;
  return { tier: t.id, seats, total: t.monthly + overage };
}
