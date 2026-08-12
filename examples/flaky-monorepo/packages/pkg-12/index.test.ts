import { expect, test } from "bun:test";
import { padLeft } from "./index";

test("pads on the left", () => {
  expect(padLeft("7", 3, "0")).toBe("007");
});

test("a string at or over the width is unchanged", () => {
  expect(padLeft("1234", 3, "0")).toBe("1234");
});
