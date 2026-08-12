// smithers-metadata-version: 1
// smithers-display-name: Price Change
// smithers-description: Turn a finance change request into a reviewed, human-approved price change with a SQL migration.
// smithers-tags: approval, human-in-the-loop, billing
/** @jsxImportSource smithers-orchestrator */
import { approvalDecisionSchema, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const DEFAULT_REQUEST = "CHANGE-REQUEST.md";
const MAX_REVISIONS = 3;

const inputSchema = z.object({
  request: z
    .string()
    .default(DEFAULT_REQUEST)
    .describe("Path to the incoming change request markdown file."),
  migrationGate: z
    .boolean()
    .default(false)
    .describe("Add a second human gate on the SQL migration before it is written."),
});

// 1 — Blast radius. What does this request touch, and does it break a caller?
const assessSchema = z.object({
  summary: z.string().describe("What the change request asks for, in two sentences."),
  affectedCallers: z.array(z.string()).default([]).describe("Repo-relative files that call quote()."),
  breaking: z.boolean().describe("True when a caller must change to keep working."),
  riskNote: z.string().describe("The largest open risk, including any undefined behaviour."),
});

// 2 & 4 — A proposal. Text only: nothing is written to the repo at this stage.
const proposalSchema = z.object({
  summary: z.string().describe("One sentence: what this proposal changes."),
  priceDelta: z.string().describe("The price movement in words, for example 'team $49 -> $59 per month'."),
  affectedCallers: z.array(z.string()).default([]).describe("Caller files that must keep working."),
  diff: z.string().describe("Unified diff for src/pricing.ts and prices.json. Proposed, not applied."),
  migrationFile: z.string().describe("Path of the new migration, for example migrations/002_daily_overage.sql."),
  migrationSql: z.string().describe("Full SQL body of the new migration."),
  midCycleDecision: z.string().describe("The explicit rule chosen for accounts already mid-cycle."),
  honoredObjection: z
    .string()
    .nullable()
    .default(null)
    .describe("The reviewer objection this revision answers. Null on the first proposal."),
});

// 5 — Result of writing the approved change and running the test suite.
const applySchema = z.object({
  summary: z.string().describe("What was written."),
  filesWritten: z.array(z.string()).default([]).describe("Repo-relative paths written or created."),
  testCommand: z.string().default("bun test").describe("The command used to verify the change."),
  testsPassed: z.boolean().describe("True when the suite reported zero failures."),
  testReport: z.string().describe("Pass/fail counts as printed by the suite."),
});

const { Workflow, Task, Sequence, Loop, Branch, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  assess: assessSchema,
  proposal: proposalSchema,
  approval: approvalDecisionSchema,
  migrationApproval: approvalDecisionSchema,
  apply: applySchema,
});

export default smithers((ctx) => {
  // Input fields arrive null rather than the zod default when unsupplied.
  const requestFile = ctx.input.request ?? DEFAULT_REQUEST;
  const migrationGate = ctx.input.migrationGate === true;

  const assess = ctx.latest(outputs.assess, "assess") ?? ctx.outputMaybe("assess", { nodeId: "assess" });

  // The live proposal is the newest revision, or the first draft before any revision.
  const firstProposal =
    ctx.latest(outputs.proposal, "propose") ?? ctx.outputMaybe("proposal", { nodeId: "propose" });
  const revisedProposal = ctx.latest(outputs.proposal, "revise");
  const proposal = revisedProposal ?? firstProposal;

  // Rule 3: read the last loop iteration with ctx.latest inside the loop condition.
  const decision = ctx.latest(outputs.approval, "gate");
  const approved = decision?.approved === true;
  const denied = decision?.approved === false;

  const migrationDecision = ctx.latest(outputs.migrationApproval, "gate-migration");
  const migrationBlocked = migrationGate && migrationDecision?.approved === false;
  const migrationCleared = !migrationGate || migrationDecision?.approved === true;

  const gateSummary = [
    proposal?.summary ?? "Review the proposed price change.",
    `Price delta: ${proposal?.priceDelta ?? "unknown"}.`,
    `Callers that must keep working: ${(proposal?.affectedCallers ?? assess?.affectedCallers ?? []).join(", ") || "none found"}.`,
    `Mid-cycle accounts: ${proposal?.midCycleDecision ?? "undecided"}.`,
    `Migration: ${proposal?.migrationFile ?? "none proposed"}.`,
    assess?.breaking ? "Assessment marked this change BREAKING for callers." : "Assessment marked callers unaffected.",
  ].join("\n");

  return (
    <Workflow name="price-change">
      <Sequence>
        {/* 1 — Blast radius: read the request and everything that depends on quote(). */}
        <Task id="assess" output={outputs.assess} agent={agents.research}>
          {`Read ${requestFile}, prices.json, src/pricing.ts, consumers/checkout.ts and consumers/reporting.ts.

Report the blast radius of the request:
- Summarise what finance is asking for.
- List every repo-relative file that calls quote(). Read the consumer files to confirm.
- Set breaking=true only if a caller must change its own code to keep working.
- Name the largest open risk. The request leaves accounts already mid-cycle undefined, so say so.

Read only. Do not edit any file.`}
        </Task>

        {/* 2 — Decide, do not act. The proposal is text; the repo is untouched. */}
        {assess ? (
          <Task id="propose" output={outputs.proposal} agent={agents.implement}>
            {`Draft a proposal for the change in ${requestFile}. DO NOT WRITE ANY FILE. Return text only.

Assessment:
- Summary: ${assess.summary}
- Affected callers: ${(assess.affectedCallers ?? []).join(", ") || "none reported"}
- Breaking: ${assess.breaking}
- Risk: ${assess.riskNote}

Produce:
- A unified diff for src/pricing.ts and prices.json that raises the team tier and bills overage seats per day used.
- A new SQL migration under migrations/ named 002_<slug>.sql, following the style of migrations/001_init.sql, that adds the per-day usage the request needs.
- An explicit rule for accounts already mid-cycle. The request does not state one, so choose the least surprising rule and say it plainly.

Keep the quote() signature usable by consumers/checkout.ts and consumers/reporting.ts.`}
          </Task>
        ) : null}

        {/* 3 & 4 — Human gate. A denial is durable (onDeny="continue"), so revise
            can read it and re-enter the gate on the next iteration. */}
        {proposal ? (
          <Loop id="review-loop" until={approved} maxIterations={MAX_REVISIONS} onMaxReached="return-last">
            <Sequence>
              <Branch
                if={denied}
                then={
                  <Task id="revise" output={outputs.proposal} agent={agents.implement}>
                    {`Your previous proposal was rejected by a human reviewer. Produce a new one that answers the objection. DO NOT WRITE ANY FILE.

Reviewer verdict: rejected${decision?.decidedBy ? ` by ${decision.decidedBy}` : ""}.
Reviewer note: ${decision?.note ?? "(no note given)"}

Previous proposal:
- Summary: ${proposal?.summary ?? ""}
- Price delta: ${proposal?.priceDelta ?? ""}
- Mid-cycle rule: ${proposal?.midCycleDecision ?? ""}
- Migration: ${proposal?.migrationFile ?? ""}

Rules:
- Change what the note objects to. Keep everything else stable.
- Set honoredObjection to the reviewer note you addressed.
- consumers/checkout.ts and consumers/reporting.ts must keep working.`}
                  </Task>
                }
                else={null}
              />
              <Approval
                id="gate"
                onDeny="continue"
                output={outputs.approval}
                request={{
                  title: `Approve price change: ${proposal?.priceDelta ?? "pricing update"}`,
                  summary: gateSummary,
                  metadata: {
                    migrationFile: proposal?.migrationFile ?? null,
                    breaking: assess?.breaking ?? null,
                    affectedCallers: proposal?.affectedCallers ?? [],
                  },
                }}
              />
            </Sequence>
          </Loop>
        ) : null}

        {/* Bonus gate — off by default. Enable with --input '{"migrationGate":true}'. */}
        {approved && migrationGate ? (
          <Approval
            id="gate-migration"
            onDeny="continue"
            output={outputs.migrationApproval}
            request={{
              title: `Approve schema migration ${proposal?.migrationFile ?? "002_*.sql"}`,
              summary: `${proposal?.migrationSql ?? "(no SQL proposed)"}`,
            }}
          />
        ) : null}

        {/* 5 — Act. A separate node from the decision, so the decision stays reversible. */}
        {approved && (migrationCleared || migrationBlocked) ? (
          <Task id="apply" output={outputs.apply} agent={agents.implement} needs={{ decision: "gate" }}>
            {`The proposal below is approved. Write it to the repo now.

Approved by: ${decision?.decidedBy ?? "reviewer"}${decision?.note ? ` — note: ${decision.note}` : ""}
Price delta: ${proposal?.priceDelta ?? ""}
Mid-cycle rule: ${proposal?.midCycleDecision ?? ""}

Apply exactly this diff to src/pricing.ts and prices.json:
${proposal?.diff ?? ""}

${
  migrationBlocked
    ? `The schema migration was REJECTED by a second reviewer. Note: ${migrationDecision?.note ?? "(none)"}
Do NOT create any file under migrations/. Record in summary that the migration is still pending review.`
    : `Then create ${proposal?.migrationFile ?? "migrations/002_daily_overage.sql"} with this SQL:
${proposal?.migrationSql ?? ""}`
}

Then make the suite green. src/pricing.test.ts hard-codes the OLD prices (4900,
4900 + 2 * 900, and a 4900 roll-up), so a correct price change makes those
assertions stale. Update those expectations to the approved prices. Keep every
assertion that is about behaviour rather than a number: the free tier stays free,
an unknown tier still throws, and the quote shape is unchanged.

Then run \`bun test\` until it reports zero failures. Set testsPassed true only when
that is what the suite actually printed, and put the real counts in testReport.
Never weaken or delete a test to get there.

Hard requirement: consumers/checkout.ts and consumers/reporting.ts must keep working unchanged. They both call quote(tierId, seats). If your change breaks either caller, fix your change, not the caller.`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
