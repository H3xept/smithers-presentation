import { expect, test } from "bun:test";
import { slugify } from "./index";

test("collapses runs of separators into a single dash", () => {
  expect(slugify("Hello   World -- again")).toBe("hello-world-again");
});

test("does not leave leading or trailing dashes", () => {
  expect(slugify("  !Ship it!  ")).toBe("ship-it");
});
