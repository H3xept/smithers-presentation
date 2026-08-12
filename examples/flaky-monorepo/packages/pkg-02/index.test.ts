import { expect, test } from "bun:test";
import { clamp } from "./index";

test("clamps above the maximum", () => {
  expect(clamp(12, 0, 10)).toBe(10);
});

test("clamps below the minimum", () => {
  expect(clamp(-3, 0, 10)).toBe(0);
});
