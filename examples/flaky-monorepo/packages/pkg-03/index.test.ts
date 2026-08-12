import { expect, test } from "bun:test";
import { chunk } from "./index";

test("keeps the trailing partial chunk", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});

test("an exact multiple has no partial chunk", () => {
  expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
});
