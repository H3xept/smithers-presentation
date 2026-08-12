import { expect, test } from "bun:test";
import { groupBy } from "./index";

test("does not mutate the input array", () => {
  const rows = [{ k: "a" }, { k: "b" }];
  groupBy(rows, (r) => r.k);
  expect(rows).toHaveLength(2);
});
