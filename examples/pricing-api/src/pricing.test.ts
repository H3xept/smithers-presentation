import { expect, test } from "bun:test";
import { quote } from "./pricing";
import { checkoutTotal } from "../consumers/checkout";
import { projectedMrr } from "../consumers/reporting";

test("included seats cost nothing extra", () => {
  expect(quote("team", 5).total).toBe(4900);
});

test("overage is charged per seat above the included count", () => {
  expect(quote("team", 7).total).toBe(4900 + 2 * 900);
});

test("free tier stays free", () => {
  expect(quote("free", 1).total).toBe(0);
});

test("unknown tier is rejected", () => {
  expect(() => quote("enterprise", 1)).toThrow("unknown tier: enterprise");
});

test("consumers still read the same quote shape", () => {
  expect(checkoutTotal("scale", 25)).toBe("$249.00");
  expect(projectedMrr([{ tier: "team", seats: 5 }, { tier: "free", seats: 1 }])).toBe(4900);
});
