import { expect, test } from "bun:test";
import { retryDelay } from "./index";

test("grows exponentially", () => {
  expect(retryDelay(3)).toBe(800);
});

test("never exceeds the cap", () => {
  expect(retryDelay(20)).toBe(5_000);
});
