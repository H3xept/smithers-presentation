import { expect, test } from "bun:test";
import { truncate } from "./index";

test("the result never exceeds max, ellipsis included", () => {
  expect(truncate("durable graphs", 8)).toHaveLength(8);
});

test("a short string is returned untouched", () => {
  expect(truncate("short", 8)).toBe("short");
});
