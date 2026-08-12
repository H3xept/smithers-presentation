import { expect, test } from "bun:test";
import { formatBytes } from "./index";

test("uses binary units", () => {
  expect(formatBytes(1024)).toBe("1 KB");
});

test("scales past kilobytes", () => {
  expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
});
