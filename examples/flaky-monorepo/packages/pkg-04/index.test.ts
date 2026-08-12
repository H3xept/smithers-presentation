import { expect, test } from "bun:test";
import { titleCase } from "./index";

test("title-cases each word", () => {
  expect(titleCase("durable AGENT graphs")).toBe("Durable Agent Graphs");
});

test("an empty string stays empty", () => {
  expect(titleCase("")).toBe("");
});
