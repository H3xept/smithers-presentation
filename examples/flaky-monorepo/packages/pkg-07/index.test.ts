// FIXTURE: this test is deliberately wall-clock dependent. It is the flake the
// demo workflow has to diagnose, so the sleeps are the defect, not an accident.
// The intended fix is an injectable clock in index.ts plus a deterministic test.
import { expect, test } from "bun:test";
import { withinWindow } from "./index";

test("a timestamp inside the window is accepted", async () => {
  const at = Date.now();
  await Bun.sleep(1 + Math.floor(Math.random() * 5));
  expect(withinWindow(at, 3)).toBe(true);
});

test("a timestamp outside the window is rejected", async () => {
  const at = Date.now();
  await Bun.sleep(10);
  expect(withinWindow(at, 3)).toBe(false);
});
