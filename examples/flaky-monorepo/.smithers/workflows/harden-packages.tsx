/** @jsxImportSource smithers-orchestrator */
/**
 * harden-packages — the observability demo.
 *
 * Shape: discover -> 12-wide <Parallel> fan-out -> typecheck -> report.
 *
 * Each fan-out lane owns a bounded <Loop> (fix -> verify, up to 3 rounds), so a
 * failed verify retries that one package and leaves the other eleven alone.
 * The loop sits under <Parallel>, never directly under another loop, which is
 * the sanctioned per-item lane shape.
 *
 * Why this shape is the observability demo:
 *   - 12 sibling lanes give Tempo twelve concurrent spans on one trace.
 *   - packages/pkg-07 is wall-clock flaky, so at least one lane shows a nested
 *     retry span instead of a single clean pass.
 *   - packages/pkg-11 also carries a real TypeScript error, so `typecheck`
 *     reports work still outstanding after every lane claims success.
 *   - <Aspects> emits per-node token and latency metrics for the Grafana panels.
 *   - Scorers on `report` give `smithers scores <run>` rows to display.
 *
 * Per-lane rows are correlated by the `pkg` id field, never by array index.
 */
import { createSmithers, Sequence, Parallel, Loop, Aspects } from "smithers-orchestrator";
import { schemaAdherenceScorer, latencyScorer, llmJudge } from "smithers-orchestrator/scorers";
import { z } from "zod";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agents } from "../agents";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "../../packages");

/**
 * The lane set. Read from disk at render time so the graph always shows one
 * lane per real package directory, and so `smithers graph` renders all twelve
 * lanes before `discover` has produced a single row.
 */
const PACKAGE_IDS: string[] = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("pkg-"))
  .map((entry) => entry.name)
  .sort();

/** Lanes run all at once: a wide trace is the point of this demo. */
const LANE_CONCURRENCY = PACKAGE_IDS.length;

/** Rounds of fix -> verify a single lane may spend before it gives up. */
const MAX_LANE_ROUNDS = 3;

const { Workflow, Task, smithers, outputs } = createSmithers({
  discovery: z.object({
    packages: z
      .array(
        z.object({
          pkg: z.string().describe("Directory name under packages/, e.g. pkg-07"),
          failingTests: z.array(z.string()).describe("Exact failing test names"),
        }),
      )
      .describe("One entry per package directory"),
    totalFailing: z.number().describe("Count of failing tests across the monorepo"),
    summary: z.string(),
  }),
  fixAttempt: z.object({
    pkg: z.string().describe("The package this row belongs to"),
    defect: z.string().describe("The one real defect found in index.ts"),
    change: z.string().describe("What was changed, in one sentence"),
    edited: z.boolean().describe("True when index.ts was actually written"),
  }),
  verifyResult: z.object({
    pkg: z.string().describe("The package this row belongs to"),
    passed: z.boolean().describe("True when bun test for this package is green"),
    failingTests: z.array(z.string()).describe("Test names still failing"),
    output: z.string().describe("Last lines of the test output"),
  }),
  typecheckResult: z.object({
    clean: z.boolean(),
    errors: z
      .array(
        z.object({
          pkg: z.string().describe("Owning package, or empty when outside packages/"),
          location: z.string().describe("file(line,col) exactly as tsc printed it"),
          message: z.string(),
        }),
      )
      .describe("Every diagnostic tsc reported"),
    summary: z.string(),
  }),
  hardeningReport: z.object({
    perPackage: z
      .array(
        z.object({
          pkg: z.string(),
          passed: z.boolean(),
          rounds: z.number().describe("Verify attempts this package consumed"),
          note: z.string(),
        }),
      )
      .describe("One row per package, ordered by package id"),
    costliestPkg: z.string().describe("Package that consumed the most attempts"),
    costliestRounds: z.number(),
    totalRounds: z.number(),
    typecheckClean: z.boolean(),
    verdict: z.string().describe("Two or three sentences a human can read aloud"),
  }),
});

/**
 * The judge seat. `llmJudge` takes a single AgentLike, while a seat is an array
 * of a primary plus runtime fallbacks, so hand it the primary.
 */
const judgeAgent = agents.cheapFast[0];

/**
 * Seats the fan-out may repair with. Pick one per run so the same workflow can
 * be run twice and compared on cost and scores:
 *   smithers up .smithers/workflows/harden-packages.tsx -i '{"fixSeat":"cheap"}'
 */
const FIX_SEATS = { strong: agents.implement, cheap: agents.cheapFast } as const;

export default smithers((ctx) => {
  const request = String(ctx.input?.request ?? "Repair every failing package under packages/.");
  const fixSeat = ctx.input?.fixSeat === "cheap" ? "cheap" : "strong";

  // Verify rows grouped by package id. Lane nodes live inside a <Loop>, so
  // their node ids are loop-scoped and ctx.latest(schema, nodeId) cannot see
  // them; correlate on the `pkg` id field instead. Rows arrive oldest first, so
  // the last row a package contributes is its newest attempt, and the row count
  // for that package is the number of rounds the lane has spent.
  const verifyRows = ctx.outputs.verifyResult ?? [];
  type VerifyRow = (typeof verifyRows)[number];
  const laneState = new Map<string, { rounds: number; latest: VerifyRow }>();
  for (const row of verifyRows) {
    const seen = laneState.get(row.pkg);
    laneState.set(row.pkg, { rounds: (seen?.rounds ?? 0) + 1, latest: row });
  }

  const discovery = ctx.latest(outputs.discovery, "discover");

  return (
    <Workflow name="harden-packages">
      <Sequence>
        <Task id="discover" output={outputs.discovery} agent={agents.cheapFast}>
          {`${request}

First, survey the monorepo. Do not fix anything yet.

1. List every directory under packages/. Each holds index.ts, index.test.ts
   and package.json.
2. Run: bun test packages
3. From that output, record the exact failing test names per package.

Report one entry per package directory. Set "pkg" to the directory name
exactly as it appears on disk, for example "pkg-07". Include packages whose
tests currently pass, with an empty failingTests array.

Known fixture properties, so you are not surprised:
- packages/pkg-07 races the wall clock, so its result varies between runs.
- The failures are real defects in index.ts, not broken tests. Never edit a
  test file.`}
        </Task>

        {/*
          Token and latency budgets around the fan-out only. `warn` keeps the
          demo alive when a lane burns context, and still writes the breach to
          the event log where Grafana can see it.
        */}
        <Aspects
          tokenBudget={{ max: 600_000, perTask: 60_000, onExceeded: "warn" }}
          latencySlo={{ maxMs: 25 * 60_000, onExceeded: "warn" }}
          tracking={{ tokens: true, latency: true }}
        >
          <Parallel id="lanes" maxConcurrency={LANE_CONCURRENCY}>
            {PACKAGE_IDS.map((pkg) => (
              <Loop
                key={`${pkg}:lane`}
                id={`${pkg}:lane`}
                until={laneState.get(pkg)?.latest.passed === true}
                maxIterations={MAX_LANE_ROUNDS}
                onMaxReached="return-last"
              >
                <Sequence>
                  <Task id={`${pkg}:fix`} output={outputs.fixAttempt} agent={FIX_SEATS[fixSeat]}>
                    {() => {
                      const known = discovery?.packages?.find((entry) => entry.pkg === pkg);
                      const previous = laneState.get(pkg)?.latest;
                      const failing = (previous?.failingTests ?? known?.failingTests ?? []).join(", ");
                      return `Repair exactly one package: packages/${pkg}

Read packages/${pkg}/index.ts and packages/${pkg}/index.test.ts. The test
asserts the correct behaviour. The exported function has exactly one real
defect. Fix index.ts so the test passes.

${failing ? `Failing tests: ${failing}` : "Reported failing tests: none recorded yet; read the test file."}
${
  previous
    ? `\nYour previous attempt did not pass. Last test output:\n${previous.output}\nDiagnose why that fix was wrong before editing again.`
    : ""
}
Rules:
- Touch packages/${pkg}/index.ts only. Never edit index.test.ts.
- Never touch any other package.
- Keep the exported signature the test imports.
- If the defect is that a dependency is not injectable, add an optional
  parameter with a default so existing callers keep working.

Set "pkg" to "${pkg}". Set "edited" to true only if you wrote the file.`;
                    }}
                  </Task>

                  <Task id={`${pkg}:verify`} output={outputs.verifyResult} agent={agents.validate}>
                    {`Verify one package. Run exactly:

  bun test packages/${pkg}

Report the result. Set "pkg" to "${pkg}". Set "passed" to true only when the
command reports zero failures. List every still-failing test name in
"failingTests" and put the last lines of the command output in "output".

Do not edit any file. Do not run the whole suite. If the run is green but you
suspect timing sensitivity, run the same command once more and report the
second result.`}
                  </Task>
                </Sequence>
              </Loop>
            ))}
          </Parallel>
        </Aspects>

        <Task id="typecheck" output={outputs.typecheckResult} agent={agents.validate}>
          {`Type-check the whole monorepo. Run exactly:

  bunx tsc --noEmit

Report every diagnostic. For each one, set "location" to the file, line and
column exactly as tsc printed them, and set "pkg" to the owning package
directory name when the file sits under packages/, otherwise an empty string.

Set "clean" to true only when tsc reports no errors at all.

Do not edit any file. A green test suite does not imply a clean type-check:
report what tsc says, even when every lane above claimed success.`}
        </Task>

        <Task
          id="report"
          output={outputs.hardeningReport}
          agent={agents.review}
          dependsOn={["typecheck"]}
          scorers={{
            schema: { scorer: schemaAdherenceScorer() },
            latency: { scorer: latencyScorer({ targetMs: 30_000, maxMs: 180_000 }) },
            rollup: {
              scorer: llmJudge({
                id: "rollup-accuracy",
                name: "Roll-up Accuracy",
                description: "Rates whether the roll-up matches the per-package evidence it was given.",
                judge: judgeAgent,
                instructions:
                  "You audit engineering roll-ups. Reward reports that name the costliest package correctly, " +
                  "count attempts consistently, and admit outstanding failures. Penalise any claim the evidence " +
                  "does not support. Respond with JSON only.",
                promptTemplate: ({ input, output }) =>
                  `Rate this roll-up against its evidence.\n\nEvidence given to the reporter:\n${JSON.stringify(input)}\n\nRoll-up produced:\n${JSON.stringify(output)}\n\nRespond with JSON: { "score": <0-1>, "reason": "<one sentence>" }`,
              }),
            },
          }}
        >
          {() => {
            const rows = PACKAGE_IDS.map((pkg) => {
              const lane = laneState.get(pkg);
              return {
                pkg,
                rounds: lane?.rounds ?? 0,
                passed: lane?.latest.passed === true,
                stillFailing: lane?.latest.failingTests ?? [],
              };
            });
            const typecheck = ctx.latest(outputs.typecheckResult, "typecheck");
            const totalRounds = rows.reduce((sum, row) => sum + row.rounds, 0);

            return `Write the roll-up for this hardening run.

Repair seat used by every lane in this run: "${fixSeat}".

Per-package evidence, correlated by package id:
${JSON.stringify(rows, null, 2)}

Type-check result:
${JSON.stringify(typecheck ?? { clean: null, note: "typecheck produced no row" }, null, 2)}

Total verify attempts across all lanes: ${totalRounds}

Produce one perPackage row for every package id listed above, in that order.
Set "rounds" to the verify attempts that package consumed. Set "costliestPkg"
to the package with the highest rounds, breaking a tie by lowest package id.

In "verdict", state plainly: which repair seat ran, how many packages are green,
which package cost the most attempts and why that is expected, and whether the
type-check is clean. Do not claim the run succeeded while any package is red or
any tsc error remains. Do not edit any file.`;
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
