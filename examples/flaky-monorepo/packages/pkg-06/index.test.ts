import { expect, test } from "bun:test";
import { uniqueBy } from "./index";

test("keeps the first occurrence of each key", () => {
  const rows = [
    { id: "a", n: 1 },
    { id: "b", n: 2 },
    { id: "a", n: 3 },
  ];
  expect(uniqueBy(rows, (r) => r.id)).toEqual([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
});
