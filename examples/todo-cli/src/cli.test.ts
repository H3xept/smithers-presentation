import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "todo-cli-"));
  process.env.TODO_FILE = join(dir, "todos.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("add then list shows the todo", () => {
  expect(run(["add", "write", "the", "spec"])).toBe("added #1 write the spec");
  expect(run(["list"])).toBe("  #1 write the spec");
});

test("done marks the todo complete", () => {
  run(["add", "ship it"]);
  expect(run(["done", "1"])).toBe("completed #1 ship it");
  expect(run(["list"])).toBe("x #1 ship it");
});

test("ids keep incrementing after a completion", () => {
  run(["add", "first"]);
  run(["done", "1"]);
  expect(run(["add", "second"])).toBe("added #2 second");
});

test("an empty list says so", () => {
  expect(run(["list"])).toBe("nothing to do");
});

test("add without a title is rejected", () => {
  expect(() => run(["add", "   "])).toThrow("add needs a title");
});

test("completing an unknown id is rejected", () => {
  expect(() => run(["done", "9"])).toThrow("no todo with id 9");
});
