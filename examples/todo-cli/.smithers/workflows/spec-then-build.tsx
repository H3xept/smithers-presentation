// smithers-source: example
// smithers-metadata-version: 1
// smithers-display-name: Spec Then Build
// smithers-description: Draft a feature spec, let a human edit it in the browser, then build from the edited text.
// smithers-tags: examples, human-in-the-loop, custom-ui
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, UI, WaitForEvent } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { NODE_IDS, SPEC_CORRELATION_KEY, SPEC_EVENT } from "../ui/spec-then-build-contract";

/**
 * The demo point of this workflow: the spec the implementer builds from is NOT
 * the spec the agent wrote. `draft-spec` proposes markdown, the run parks on
 * `await-edit`, a human rewrites that markdown in the custom UI, and
 * `implement` reads the edited row. The agent drafts; the human decides.
 */

/** One working day. Long enough for a talk, a coffee, and a question. */
const EDIT_WINDOW_MS = 28_800_000;

const inputSchema = z.object({
  featureRequest: z
    .string()
    .default("FEATURE-REQUEST.md")
    .describe("Path to the feature request the spec is drafted from."),
  testCommand: z.string().default("bun test src").describe("Command that proves the implementation works."),
});

// 1 — The drafted spec. `markdown` is what the human edits.
const draftSpecSchema = z.object({
  markdown: z.string().describe("The full spec as markdown. This is the text the human edits in the browser."),
  storeMigration: z.string().describe("How the existing flat JSON todo file migrates to the new shape."),
  newTests: z.array(z.string()).default([]).describe("The test cases the spec says must be added."),
  openQuestions: z
    .array(z.string())
    .default([])
    .describe("Questions from the feature request the agent could not resolve. The human answers these by editing."),
});

// 2 — The human's edited spec, delivered as the signal payload.
const editedSpecSchema = z.object({
  markdown: z.string().describe("The spec markdown after human editing. This is the build contract."),
  editedBy: z.string().default("human").describe("Who submitted the edit."),
});

// 3 — What the implementer changed.
const implementSchema = z.object({
  summary: z.string().describe("What was implemented, in the human's own terms from the spec."),
  filesChanged: z.array(z.string()).default([]).describe("Repo-relative paths that were written."),
  migrationNotes: z.string().describe("What the store migration does to a pre-existing todo file."),
});

// 4 — The test result, verbatim.
const testSchema = z.object({
  command: z.string().describe("The command that was run."),
  output: z.string().describe("Verbatim stdout and stderr from the test run."),
  passed: z.number().default(0).describe("Count of passing tests."),
  failed: z.number().default(0).describe("Count of failing tests."),
  ok: z.boolean().describe("True when the suite ended green."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  draftSpec: draftSpecSchema,
  editedSpec: editedSpecSchema,
  implement: implementSchema,
  test: testSchema,
});

export default smithers((ctx) => {
  const featureRequest = ctx.input.featureRequest ?? "FEATURE-REQUEST.md";
  const testCommand = ctx.input.testCommand ?? "bun test src";

  // The EDITED markdown from the wait node, never the agent's draft. This is
  // the whole point of the demo.
  const edited = ctx.outputMaybe("editedSpec", { nodeId: NODE_IDS.awaitEdit });
  const built = ctx.outputMaybe("implement", { nodeId: NODE_IDS.implement });

  return (
    <Workflow name="spec-then-build">
      <UI entry="../ui/spec-then-build.tsx" title={"Spec Then Build"} />
      <Sequence>
        {/* 1 — Read the repo, propose a spec, and name what it cannot decide. */}
        <Task id={NODE_IDS.draftSpec} output={outputs.draftSpec} agent={agents.planning}>
          {`Read these files before writing anything:
- ${featureRequest} — the ask, including the open questions nobody has answered.
- src/store.ts — persistence. A flat JSON array of { id, title, done }, path resolved from TODO_FILE at call time.
- src/cli.ts — exports run(argv) and dispatches add / list / done.
- src/cli.test.ts — the 6 tests that already pass. They define the current contract.

Write a markdown implementation spec for due dates and recurring todos.

The spec MUST contain:
1. The new Todo shape, and a "Store migration" section stating exactly how load() upgrades a file that
   holds the old { id, title, done } records without losing or renumbering a single todo.
2. The CLI surface: the new add flags, and what list prints for an overdue item.
3. A "New tests" section naming each test case to add to src/cli.test.ts, one line each.
4. An "Open questions" section that restates every question from ${featureRequest} you could not decide
   from the code alone. Do NOT invent an answer. A human will edit this file and answer them.

Return the whole spec in the "markdown" field. Do not write any file.`}
        </Task>

        {/* 2 — Park until a human submits the edited spec. The build contract is
            whatever text comes back, not what the agent drafted. The Sequence
            already holds this behind draft-spec, so it needs no render gate. */}
        <WaitForEvent
          id={NODE_IDS.awaitEdit}
          event={SPEC_EVENT}
          correlationId={SPEC_CORRELATION_KEY}
          output={outputs.editedSpec}
          timeoutMs={EDIT_WINDOW_MS}
          onTimeout="fail"
        />

        {/* 3 — Build from the human's text. */}
        {edited ? (
          <Task id={NODE_IDS.implement} output={outputs.implement} agent={agents.implement} heartbeatTimeoutMs={900_000}>
            {`A human edited the spec below. It is the build contract. Where it disagrees with the drafted
spec, or answers an open question, the text below wins. Follow it literally.

Implement it in src/store.ts and src/cli.ts, and add the tests the spec names to src/cli.test.ts.

Rules:
- load() must migrate an existing todo file in place: an old { id, title, done } record keeps its id,
  its title, and its done flag. Never drop a todo and never renumber.
- Keep resolving the file path from TODO_FILE at call time. The tests depend on it.
- Keep run(argv) as the only CLI entry point.
- The 6 existing tests must still pass unchanged. Do not edit them; only add to them.

--- SPEC (human-edited) ---
${edited.markdown}
--- END SPEC ---`}
          </Task>
        ) : null}

        {/* 4 — Run the suite and report it verbatim, pass or fail. */}
        {built ? (
          <Task id={NODE_IDS.test} output={outputs.test} agent={agents.validate}>
            {`Run \`${testCommand}\` in the repo root, once.

Put the complete stdout and stderr in "output", unedited. Read the pass and fail counts off Bun's
summary line into "passed" and "failed". Set "ok" true only when failed is 0.

Do not fix anything and do not touch a test file. If the suite is red, report it red.`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
