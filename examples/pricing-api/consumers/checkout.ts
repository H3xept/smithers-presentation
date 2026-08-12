import { quote } from "../src/pricing";

/** Blast radius #1: any change to quote()'s shape breaks the checkout total. */
export function checkoutTotal(tier: string, seats: number): string {
  const { total } = quote(tier, seats);
  return `$${(total / 100).toFixed(2)}`;
}
