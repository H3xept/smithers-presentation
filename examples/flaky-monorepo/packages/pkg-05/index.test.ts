import { expect, test } from "bun:test";
import { parseDuration } from "./index";

test("reads a single unit", () => {
  expect(parseDuration("500ms")).toBe(500);
});

test("sums every unit in a compound duration", () => {
  expect(parseDuration("1h30m")).toBe(5_400_000);
});
